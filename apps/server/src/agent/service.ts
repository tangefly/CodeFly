import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentToolCall,
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
} from "./tools.js";

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
  contextBudgetChars: number;
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

    this.deps.lock.acquire(session.id, "agent");
    const startedAt = Date.now();
    const config = this.deps.llmConfig.getInternal();
    const settings = this.deps.agentConfig.getInternal();
    const toolDefinitions = this.deps.tools.definitions(settings.enabledTools);
    const prior = this.deps.messages.list(session.id);
    const history = trimTurns(prior, this.deps.contextBudgetChars);
    const system = buildSystemPrompt(settings, session);
    const conversation: LlmChatMessage[] = [
      { role: "system", content: system },
      ...recordsToLlmMessages(history),
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
        if (clientSignal.aborted) {
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

        const timeoutController = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
        }, config.timeoutMs);
        timer.unref?.();

        const signal = AbortSignal.any([clientSignal, timeoutController.signal]);
        let contentSoFar = "";
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
            signal,
            { tools: toolDefinitions, toolChoice: toolDefinitions.length > 0 ? "auto" : "none" },
          );
        } catch (error) {
          clearTimeout(timer);
          const aborted = clientSignal.aborted;
          const code = timedOut
            ? "LLM_TIMEOUT"
            : aborted
              ? "AGENT_ABORTED"
              : error instanceof LlmError
                ? error.code
                : "LLM_ERROR";
          const message = timedOut
            ? `模型响应超时（${config.timeoutMs} ms）。`
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

        for (const call of toolCalls) {
          if (clientSignal.aborted) {
            outcome = "cancelled";
            break;
          }

          const toolNow = new Date().toISOString();
          const toolMessage: ChatMessageRecord = {
            id: `m_${randomUUID()}`,
            sessionId: session.id,
            role: "tool",
            content: "",
            status: "streaming",
            toolCallId: call.id,
            toolName: call.name,
            toolArguments: call.arguments,
            createdAt: toolNow,
            updatedAt: toolNow,
          };
          await this.deps.messages.appendMany(session.id, [toolMessage]);
          emit({
            type: "agent.tool.started",
            message: toolMessage,
            toolCall: call,
          });

          const toolStartedAt = Date.now();
          let toolResult;
          if (!settings.enabledTools.includes(call.name as AgentToolName)) {
            toolResult = {
              content: `Tool "${call.name}" is not enabled for this agent session.`,
              status: "error" as const,
              meta: { kind: "error" as const },
            };
          } else {
            const toolContext: ToolExecutionContext = {
              session,
              dataDir: this.deps.dataDir,
              maxReadBytes: this.deps.maxReadBytes,
              maxWriteBytes: this.deps.maxWriteBytes,
              commandTimeoutMs: settings.commandTimeoutMs,
              exec: this.deps.exec,
              audit: this.deps.audit,
              signal: clientSignal,
              emit,
              toolCallId: call.id,
            };
            try {
              toolResult = await this.deps.tools.execute(
                call.name,
                call.arguments,
                toolContext,
              );
            } catch (error) {
              toolResult = {
                content: `Tool execution failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                status: "error" as const,
                meta: { kind: "error" as const },
              };
            }
          }

          toolExecutions += 1;
          const finalTool = await this.deps.messages.update(
            session.id,
            toolMessage.id,
            {
              content: toolResult.content,
              status: toolResult.status,
              meta: toolResult.meta,
            },
          );
          emit({
            type: "agent.tool.finished",
            message:
              finalTool ?? {
                ...toolMessage,
                content: toolResult.content,
                status: toolResult.status,
                meta: toolResult.meta,
              },
          });

          conversation.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResult.content,
          });

          void this.deps.audit.append({
            type: "agent.tool",
            sessionId: session.id,
            toolName: call.name,
            toolCallId: call.id,
            status: toolResult.status,
            durationMs: Date.now() - toolStartedAt,
            command: toolResult.meta?.command,
            path: toolResult.meta?.path,
          });

          if (toolResult.status === "cancelled") {
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
}

function buildSystemPrompt(
  settings: AgentInternalSettings,
  session: Session,
): string {
  const base = settings.systemPrompt.trim() || DEFAULT_AGENT_PROMPT;
  return `${base}

工作区: ${session.workspaceRoot}
当前权限: ${session.mode}
可用工具: ${settings.enabledTools.length > 0 ? settings.enabledTools.join(", ") : "(无工具，仅可对话)"}`;
}

function groupTurns(records: ChatMessageRecord[]): ChatMessageRecord[][] {
  const turns: ChatMessageRecord[][] = [];
  for (const record of records) {
    if (record.role === "system") continue;
    if (record.role === "user") {
      turns.push([record]);
    } else if (turns.length > 0) {
      turns[turns.length - 1]!.push(record);
    }
  }
  return turns;
}

function trimTurns(records: ChatMessageRecord[], budgetChars: number): ChatMessageRecord[] {
  const turns = groupTurns(records);
  const selected: ChatMessageRecord[][] = [];
  let used = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const chars = turn.reduce(
      (total, record) =>
        total + record.content.length + (record.toolArguments?.length ?? 0),
      0,
    );
    if (selected.length > 0 && used + chars > budgetChars) break;
    selected.unshift(turn);
    used += chars;
  }

  return selected.flat();
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
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });
      } else if (record.content.trim() !== "") {
        messages.push({ role: "assistant", content: record.content });
      }
      continue;
    }

    if (record.role === "tool" && record.toolCallId) {
      if (!includedCallIds.has(record.toolCallId)) continue;
      messages.push({
        role: "tool",
        tool_call_id: record.toolCallId,
        content: record.content,
      });
    }
  }

  return messages;
}
