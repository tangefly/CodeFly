import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentToolCall,
  AgentToolMeta,
  AgentToolName,
  ChatMessageRecord,
  ChatUsage,
  Session,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import type { ExecService } from "../exec/service.js";
import {
  LlmError,
  redactSecret,
  type LlmChatMessage,
  type LlmClientLike,
  type LlmContentPart,
  type LlmStreamResult,
} from "../llm/client.js";
import {
  DEFAULT_AGENT_PROMPT,
  type AgentConfigStore,
  type AgentInternalSettings,
} from "./config-store.js";
import type { LlmConfigStore } from "../llm/config-store.js";
import type { MessageStore } from "../llm/messages.js";
import type { SessionRunLock } from "../llm/run-lock.js";
import type {
  AgentToolExecutorLike,
  ToolExecutionContext,
  ToolResult,
} from "./tools.js";

/** Tools that only read state and can safely run concurrently. */
const READ_ONLY_TOOL_NAMES = new Set<string>([
  "read_file",
  "read_image",
  "list_files",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
]);

interface ToolRunOptions {
  session: Session;
  settings: AgentInternalSettings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}

interface ToolRunOutcome {
  call: AgentToolCall;
  result: ToolResult;
  durationMs: number;
}

export interface AgentServiceDeps {
  messages: MessageStore;
  llmConfig: LlmConfigStore;
  agentConfig: AgentConfigStore;
  audit: AuditLog;
  client: LlmClientLike;
  tools: AgentToolExecutorLike;
  lock: SessionRunLock;
  exec: ExecService;
  dataDir: string;
  maxReadBytes: number;
  maxWriteBytes: number;
}

export class AgentService {
  private readonly deps: AgentServiceDeps;

  constructor(deps: AgentServiceDeps) {
    this.deps = deps;
  }

  assertReady(sessionId: string): void {
    if (!this.deps.llmConfig.isConfigured()) {
      throw new AppError(
        "LLM_NOT_CONFIGURED",
        "尚未配置模型 API。请先填写 Base URL 与 Model。",
        400,
      );
    }
    if (this.deps.lock.isBusy(sessionId)) {
      throw new AppError(
        "SESSION_BUSY",
        "当前会话正在执行回合，请等待结束或先停止。",
        409,
      );
    }
  }

  isBusy(sessionId: string): boolean {
    return this.deps.lock.isBusy(sessionId);
  }

  async run(
    session: Session,
    content: string,
    clientSignal: AbortSignal,
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    this.assertReady(session.id);
    if (clientSignal.aborted) return;

    const runSignal = this.deps.lock.acquire(session.id, "agent");
    // The run stops when the client disconnects or when it is cancelled
    // explicitly through the session cancel endpoint.
    const signal = AbortSignal.any([clientSignal, runSignal]);
    const startedAt = Date.now();
    const config = this.deps.llmConfig.getInternal();
    const settings = this.deps.agentConfig.getInternal();
    const toolDefinitions = this.deps.tools.definitions(settings.enabledTools);
    const prior = this.deps.messages.list(session.id);
    const system = buildSystemPrompt(
      settings,
      session,
      toolDefinitions.map((definition) => definition.function.name),
    );
    // The full history is sent; the model server enforces its context window.
    const conversation: LlmChatMessage[] = [
      { role: "system", content: system },
      ...recordsToLlmMessages(prior),
    ];

    const now = new Date().toISOString();
    const userMessage: ChatMessageRecord = {
      id: `m_${randomUUID()}`,
      sessionId: session.id,
      role: "user",
      content,
      status: "complete",
      createdAt: now,
      updatedAt: now,
    };

    let outcome: "complete" | "error" | "cancelled" | "max-steps" = "complete";
    let steps = 0;
    let toolExecutions = 0;
    let finalMessage: ChatMessageRecord | null = null;

    try {
      await this.deps.messages.appendMany(session.id, [userMessage]);
      emit({ type: "agent.started", userMessage });
      conversation.push({ role: "user", content });

      for (let step = 0; step < settings.maxSteps; step += 1) {
        steps = step + 1;
        if (signal.aborted) {
          outcome = "cancelled";
          break;
        }

        const stepNow = new Date().toISOString();
        const assistantMessage: ChatMessageRecord = {
          id: `m_${randomUUID()}`,
          sessionId: session.id,
          role: "assistant",
          content: "",
          status: "streaming",
          model: config.model,
          createdAt: stepNow,
          updatedAt: stepNow,
        };
        await this.deps.messages.appendMany(session.id, [assistantMessage]);
        emit({ type: "agent.step", message: assistantMessage });

        // Inactivity timeout, re-armed on every provider chunk.
        const timeoutController = new AbortController();
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const armTimeout = (): void => {
          if (config.timeoutMs <= 0) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
          }, config.timeoutMs);
          timer.unref?.();
        };
        armTimeout();

        const streamSignal = AbortSignal.any([
          signal,
          timeoutController.signal,
        ]);
        let contentSoFar = "";
        let reasoningSoFar = "";
        let result: LlmStreamResult;

        try {
          result = await this.deps.client.streamChat(
            config,
            conversation,
            (delta) => {
              contentSoFar += delta;
              emit({
                type: "agent.delta",
                messageId: assistantMessage.id,
                data: delta,
              });
            },
            streamSignal,
            {
              tools: toolDefinitions,
              toolChoice: toolDefinitions.length > 0 ? "auto" : "none",
              onReasoningDelta: (delta) => {
                reasoningSoFar += delta;
                emit({
                  type: "agent.reasoning",
                  messageId: assistantMessage.id,
                  data: delta,
                });
              },
              onActivity: armTimeout,
            },
          );
        } catch (error) {
          clearTimeout(timer);
          // `!timedOut` keeps a timeout an error even though the combined
          // signal is aborted in that case too.
          const aborted = !timedOut && signal.aborted;
          const code = timedOut
            ? "LLM_TIMEOUT"
            : aborted
              ? "AGENT_ABORTED"
              : error instanceof LlmError
                ? error.code
                : "LLM_ERROR";
          const message = timedOut
            ? `模型超过 ${config.timeoutMs} ms 没有输出，已停止。`
            : aborted
              ? "Agent 已取消。"
              : redactSecret(
                  error instanceof Error ? error.message : String(error),
                  config.apiKey,
                );

          const finalAssistant = await this.deps.messages.update(
            session.id,
            assistantMessage.id,
            {
              content: contentSoFar,
              status: aborted ? "cancelled" : "error",
              error: aborted ? undefined : message,
              model: config.model,
              ...(reasoningSoFar !== "" ? { reasoning: reasoningSoFar } : {}),
            },
          );

          if (!aborted) {
            emit({
              type: "agent.error",
              code,
              message,
              messageId: assistantMessage.id,
            });
          } else if (finalAssistant) {
            emit({ type: "agent.message", message: finalAssistant });
          }
          outcome = aborted ? "cancelled" : "error";
          break;
        }
        clearTimeout(timer);

        const finalContent = result.content !== "" ? result.content : contentSoFar;
        const toolCalls: AgentToolCall[] = result.toolCalls
          .filter((call) => call.name.trim() !== "")
          .map((call) => ({
            id: call.id !== "" ? call.id : `call_${step}_${randomUUID().slice(0, 8)}`,
            name: call.name,
            arguments: call.arguments,
          }));

        const finalAssistant = await this.deps.messages.update(
          session.id,
          assistantMessage.id,
          {
            content: finalContent,
            status: "complete",
            model: config.model,
            ...(reasoningSoFar !== "" ? { reasoning: reasoningSoFar } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            ...(result.durationMs !== undefined
              ? { durationMs: result.durationMs }
              : {}),
            ...(result.firstTokenMs !== undefined
              ? { firstTokenMs: result.firstTokenMs }
              : {}),
          },
        );
        const assistantRecord: ChatMessageRecord =
          finalAssistant ?? {
            ...assistantMessage,
            content: finalContent,
            status: "complete",
            ...(reasoningSoFar !== "" ? { reasoning: reasoningSoFar } : {}),
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: result.usage,
            durationMs: result.durationMs,
            firstTokenMs: result.firstTokenMs,
          };

        emit({
          type: "agent.message",
          message: assistantRecord,
          usage: result.usage,
        });

        conversation.push({
          role: "assistant",
          content: finalContent !== "" ? finalContent : null,
          ...(reasoningSoFar !== "" ? { reasoning_content: reasoningSoFar } : {}),
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        });

        if (toolCalls.length === 0) {
          finalMessage = assistantRecord;
          outcome = "complete";
          emit({ type: "agent.done", message: assistantRecord });
          break;
        }

        const toolOptions: ToolRunOptions = {
          session,
          settings,
          signal,
          emit,
        };
        const canRunParallel = (call: AgentToolCall): boolean =>
          settings.enabledTools.includes(call.name as AgentToolName) &&
          READ_ONLY_TOOL_NAMES.has(call.name);

        let toolIndex = 0;
        while (toolIndex < toolCalls.length) {
          if (signal.aborted) {
            outcome = "cancelled";
            break;
          }

          const call = toolCalls[toolIndex]!;
          if (canRunParallel(call)) {
            // Execute a maximal run of read-only calls concurrently, keeping
            // transcript and SSE ordering identical to the model's call order.
            const batch: AgentToolCall[] = [];
            while (
              toolIndex < toolCalls.length &&
              canRunParallel(toolCalls[toolIndex]!)
            ) {
              batch.push(toolCalls[toolIndex]!);
              toolIndex += 1;
            }
            const results = await this.runToolCalls(batch, toolOptions, true);
            toolExecutions += results.length;
            for (const item of results) {
              conversation.push({
                role: "tool",
                tool_call_id: item.call.id,
                content: toolContentForModel(item.result.content, item.result.meta),
              });
            }
            if (results.some((item) => item.result.status === "cancelled")) {
              outcome = "cancelled";
              break;
            }
          } else {
            const results = await this.runToolCalls([call], toolOptions, false);
            toolIndex += 1;
            toolExecutions += results.length;
            for (const item of results) {
              conversation.push({
                role: "tool",
                tool_call_id: item.call.id,
                content: toolContentForModel(item.result.content, item.result.meta),
              });
            }
            if (results.some((item) => item.result.status === "cancelled")) {
              outcome = "cancelled";
              break;
            }
          }

          if (signal.aborted) {
            outcome = "cancelled";
            break;
          }
        }

        if (outcome === "cancelled") break;

        if (step + 1 >= settings.maxSteps) {
          outcome = "max-steps";
          emit({
            type: "agent.error",
            code: "AGENT_MAX_STEPS",
            message: `已达到最大步数（${settings.maxSteps}），Agent 已停止。`,
          });
          break;
        }
      }

      void this.deps.audit.append({
        type: "agent.run",
        sessionId: session.id,
        model: config.model,
        outcome,
        steps,
        toolExecutions,
        durationMs: Date.now() - startedAt,
        maxSteps: settings.maxSteps,
        enabledTools: settings.enabledTools,
        finalMessageId: finalMessage?.id,
      });
    } finally {
      this.deps.lock.release(session.id);
    }
  }

  /**
   * Persists and executes one or more tool calls. Read-only batches pass
   * `parallel: true`; messages, events, and audit entries are still recorded
   * in the model's call order.
   */
  private async runToolCalls(
    calls: AgentToolCall[],
    options: ToolRunOptions,
    parallel: boolean,
  ): Promise<ToolRunOutcome[]> {
    const now = new Date().toISOString();
    const entries = calls.map((call) => ({
      call,
      record: {
        id: `m_${randomUUID()}`,
        sessionId: options.session.id,
        role: "tool" as const,
        content: "",
        status: "streaming" as const,
        toolCallId: call.id,
        toolName: call.name,
        toolArguments: call.arguments,
        createdAt: now,
        updatedAt: now,
      },
    }));

    await this.deps.messages.appendMany(
      options.session.id,
      entries.map((entry) => entry.record),
    );
    for (const entry of entries) {
      options.emit({
        type: "agent.tool.started",
        message: entry.record,
        toolCall: entry.call,
      });
    }

    const execute = async (
      entry: (typeof entries)[number],
    ): Promise<{ result: ToolResult; durationMs: number }> => {
      const startedAt = Date.now();
      const result = await this.executeToolCall(entry.call, options);
      return { result, durationMs: Date.now() - startedAt };
    };

    const executed: Array<{ result: ToolResult; durationMs: number }> = [];
    if (parallel) {
      executed.push(...(await Promise.all(entries.map(execute))));
    } else {
      for (const entry of entries) executed.push(await execute(entry));
    }

    const outcomes: ToolRunOutcome[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const outcome = executed[index]!;
      const finalTool = await this.deps.messages.update(
        options.session.id,
        entry.record.id,
        {
          content: outcome.result.content,
          status: outcome.result.status,
          meta: outcome.result.meta,
        },
      );
      const message: ChatMessageRecord =
        finalTool ?? {
          ...entry.record,
          content: outcome.result.content,
          status: outcome.result.status,
          meta: outcome.result.meta,
        };

      options.emit({ type: "agent.tool.finished", message });
      void this.deps.audit.append({
        type: "agent.tool",
        sessionId: options.session.id,
        toolName: entry.call.name,
        toolCallId: entry.call.id,
        status: outcome.result.status,
        durationMs: outcome.durationMs,
        command: outcome.result.meta?.command,
        path: outcome.result.meta?.path,
        query: outcome.result.meta?.query,
      });

      outcomes.push({
        call: entry.call,
        result: outcome.result,
        durationMs: outcome.durationMs,
      });
    }

    return outcomes;
  }

  private async executeToolCall(
    call: AgentToolCall,
    options: ToolRunOptions,
  ): Promise<ToolResult> {
    if (!options.settings.enabledTools.includes(call.name as AgentToolName)) {
      return {
        content: `Tool "${call.name}" is not enabled for this agent session.`,
        status: "error",
        meta: { kind: "error" },
      };
    }

    const toolContext: ToolExecutionContext = {
      session: options.session,
      dataDir: this.deps.dataDir,
      maxReadBytes: this.deps.maxReadBytes,
      maxWriteBytes: this.deps.maxWriteBytes,
      commandTimeoutMs: options.settings.commandTimeoutMs,
      exec: this.deps.exec,
      audit: this.deps.audit,
      signal: options.signal,
      emit: options.emit,
      toolCallId: call.id,
    };

    try {
      return await this.deps.tools.execute(
        call.name,
        call.arguments,
        toolContext,
      );
    } catch (error) {
      return {
        content: `Tool execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        status: "error",
        meta: { kind: "error" },
      };
    }
  }
}

function buildSystemPrompt(
  settings: AgentInternalSettings,
  session: Session,
  availableTools: string[],
): string {
  const base = settings.systemPrompt.trim() || DEFAULT_AGENT_PROMPT;
  return `${base}

工作区: ${session.workspaceRoot}
当前权限: ${session.mode}
可用工具: ${availableTools.length > 0 ? availableTools.join(", ") : "(无工具，仅可对话)"}`;
}

/**
 * Converts persisted records to OpenAI messages while keeping tool_call /
 * tool_result pairs consistent. Orphan tool results or calls without results
 * would make the next API request invalid.
 */
function recordsToLlmMessages(records: ChatMessageRecord[]): LlmChatMessage[] {
  const toolResults = new Set<string>();
  for (const record of records) {
    if (record.role === "tool" && record.toolCallId) {
      toolResults.add(record.toolCallId);
    }
  }

  const includedCallIds = new Set<string>();
  for (const record of records) {
    if (record.role !== "assistant" || !record.toolCalls) continue;
    for (const call of record.toolCalls) {
      if (toolResults.has(call.id)) includedCallIds.add(call.id);
    }
  }

  const messages: LlmChatMessage[] = [];
  for (const record of records) {
    if (record.role === "user") {
      if (record.content.trim() !== "") {
        messages.push({ role: "user", content: record.content });
      }
      continue;
    }

    if (record.role === "assistant") {
      const calls = (record.toolCalls ?? []).filter((call) =>
        includedCallIds.has(call.id),
      );
      if (calls.length > 0) {
        messages.push({
          role: "assistant",
          content: record.content !== "" ? record.content : null,
          ...(record.reasoning ? { reasoning_content: record.reasoning } : {}),
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });
      } else if (record.content.trim() !== "") {
        messages.push({
          role: "assistant",
          content: record.content,
          ...(record.reasoning ? { reasoning_content: record.reasoning } : {}),
        });
      }
      continue;
    }

    if (record.role === "tool" && record.toolCallId) {
      if (!includedCallIds.has(record.toolCallId)) continue;
      messages.push({
        role: "tool",
        tool_call_id: record.toolCallId,
        content: toolContentForModel(record.content, record.meta),
      });
    }
  }

  return messages;
}

/**
 * Tool results are text unless the tool attached an image (read_image); the
 * provider then receives a text+image content array so the model can see it.
 */
function toolContentForModel(
  content: string,
  meta: AgentToolMeta | undefined,
): string | LlmContentPart[] {
  const dataUrl = meta?.imageDataUrl;
  if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
    return [
      { type: "text", text: content },
      { type: "image_url", image_url: { url: dataUrl } },
    ];
  }
  return content;
}
