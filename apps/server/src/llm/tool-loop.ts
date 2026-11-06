import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentToolCall,
  AgentToolMeta,
  ChatMessageRecord,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import {
  LlmError,
  redactSecret,
  type LlmChatMessage,
  type LlmClientLike,
  type LlmContentPart,
  type LlmStreamResult,
  type LlmToolDefinition,
} from "./client.js";
import type { LlmInternalConfig } from "./config-store.js";
import type { MessageStore } from "./messages.js";
import type { RunKind, SessionRunLock } from "./run-lock.js";
import type { ToolResult } from "../agent/tools.js";

/** Everything a tool-calling turn needs from a concrete session kind. */
export interface ToolLoopProfile {
  /** "agent" or "paper"; never "chat" (chat has no tools). */
  runKind: Extract<RunKind, "agent" | "paper">;
  sessionId: string;
  config: LlmInternalConfig;
  maxSteps: number;
  systemPrompt: string;
  toolDefinitions: LlmToolDefinition[];
  messages: MessageStore;
  lock: SessionRunLock;
  audit: AuditLog;
  client: LlmClientLike;
  /** Prior records converted to provider messages, excluding the system prompt. */
  priorMessages: LlmChatMessage[];
  /** Read-only tools may run concurrently; writes stay ordered. */
  isParallelTool: (name: string) => boolean;
  executeTool: (
    call: AgentToolCall,
    context: ToolCallContext,
  ) => Promise<ToolResult>;
  auditType: "agent.run" | "paper.run";
  auditExtra?: Record<string, unknown>;
}

export interface ToolCallContext {
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** Transient progress for long-running tools; not persisted. */
  progress: (text: string) => void;
  toolCallId: string;
  messageId: string;
}

interface ToolRunOptions {
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}

interface ToolRunOutcome {
  call: AgentToolCall;
  result: ToolResult;
  durationMs: number;
}

/**
 * Runs one user turn of the tool-calling loop: model step, tool execution,
 * repeat until the model stops or `maxSteps` is reached. The concrete agent
 * and paper services supply their prompts, tools, and history conversion.
 */
export async function runToolLoop(
  profile: ToolLoopProfile,
  content: string,
  clientSignal: AbortSignal,
  emit: (event: AgentEvent) => void,
): Promise<void> {
  if (clientSignal.aborted) return;

  const runSignal = profile.lock.acquire(profile.sessionId, profile.runKind);
  const signal = AbortSignal.any([clientSignal, runSignal]);
  const startedAt = Date.now();
  const conversation: LlmChatMessage[] = [
    { role: "system", content: profile.systemPrompt },
    ...profile.priorMessages,
  ];

  const now = new Date().toISOString();
  const userMessage: ChatMessageRecord = {
    id: `m_${randomUUID()}`,
    sessionId: profile.sessionId,
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
    await profile.messages.appendMany(profile.sessionId, [userMessage]);
    emit({ type: "agent.started", userMessage });
    conversation.push({ role: "user", content });

    for (let step = 0; step < profile.maxSteps; step += 1) {
      steps = step + 1;
      if (signal.aborted) {
        outcome = "cancelled";
        break;
      }

      const stepNow = new Date().toISOString();
      const assistantMessage: ChatMessageRecord = {
        id: `m_${randomUUID()}`,
        sessionId: profile.sessionId,
        role: "assistant",
        content: "",
        status: "streaming",
        model: profile.config.model,
        createdAt: stepNow,
        updatedAt: stepNow,
      };
      await profile.messages.appendMany(profile.sessionId, [assistantMessage]);
      emit({ type: "agent.step", message: assistantMessage });

      // Inactivity timeout, re-armed on every provider chunk.
      const timeoutController = new AbortController();
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const armTimeout = (): void => {
        if (profile.config.timeoutMs <= 0) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
        }, profile.config.timeoutMs);
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
        result = await profile.client.streamChat(
          profile.config,
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
            tools: profile.toolDefinitions,
            toolChoice: profile.toolDefinitions.length > 0 ? "auto" : "none",
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
            ? profile.runKind === "paper"
              ? "PAPER_ABORTED"
              : "AGENT_ABORTED"
            : error instanceof LlmError
              ? error.code
              : "LLM_ERROR";
        const message = timedOut
          ? `模型超过 ${profile.config.timeoutMs} ms 没有输出，已停止。`
          : aborted
            ? profile.runKind === "paper"
              ? "论文助手已取消。"
              : "Code 已取消。"
            : redactSecret(
                error instanceof Error ? error.message : String(error),
                profile.config.apiKey,
              );

        const finalAssistant = await profile.messages.update(
          profile.sessionId,
          assistantMessage.id,
          {
            content: contentSoFar,
            status: aborted ? "cancelled" : "error",
            error: aborted ? undefined : message,
            model: profile.config.model,
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

      const finalAssistant = await profile.messages.update(
        profile.sessionId,
        assistantMessage.id,
        {
          content: finalContent,
          status: "complete",
          model: profile.config.model,
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

      const toolOptions: ToolRunOptions = { signal, emit };

      let toolIndex = 0;
      while (toolIndex < toolCalls.length) {
        if (signal.aborted) {
          outcome = "cancelled";
          break;
        }

        const call = toolCalls[toolIndex]!;
        if (profile.isParallelTool(call.name)) {
          // Execute a maximal run of read-only calls concurrently, keeping
          // transcript and SSE ordering identical to the model's call order.
          const batch: AgentToolCall[] = [];
          while (
            toolIndex < toolCalls.length &&
            profile.isParallelTool(toolCalls[toolIndex]!.name)
          ) {
            batch.push(toolCalls[toolIndex]!);
            toolIndex += 1;
          }
          const results = await runToolCalls(profile, batch, toolOptions, true);
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
          const results = await runToolCalls(profile, [call], toolOptions, false);
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

      if (step + 1 >= profile.maxSteps) {
        outcome = "max-steps";
        emit({
          type: "agent.error",
          code: "AGENT_MAX_STEPS",
          message: `已达到最大步数（${profile.maxSteps}），已停止。`,
        });
        break;
      }
    }

    void profile.audit.append({
      type: profile.auditType,
      sessionId: profile.sessionId,
      model: profile.config.model,
      outcome,
      steps,
      toolExecutions,
      durationMs: Date.now() - startedAt,
      maxSteps: profile.maxSteps,
      ...profile.auditExtra,
      finalMessageId: finalMessage?.id,
    });
  } finally {
    profile.lock.release(profile.sessionId);
  }
}

/**
 * Persists and executes one or more tool calls. Read-only batches pass
 * `parallel: true`; messages, events, and audit entries are still recorded
 * in the model's call order.
 */
async function runToolCalls(
  profile: ToolLoopProfile,
  calls: AgentToolCall[],
  options: ToolRunOptions,
  parallel: boolean,
): Promise<ToolRunOutcome[]> {
  const now = new Date().toISOString();
  const entries = calls.map((call) => ({
    call,
    record: {
      id: `m_${randomUUID()}`,
      sessionId: profile.sessionId,
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

  await profile.messages.appendMany(
    profile.sessionId,
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
    const result = await profile.executeTool(entry.call, {
      signal: options.signal,
      emit: options.emit,
      progress: (text) => {
        if (options.signal.aborted) return;
        options.emit({
          type: "agent.tool.progress",
          messageId: entry.record.id,
          data: text,
        });
      },
      toolCallId: entry.call.id,
      messageId: entry.record.id,
    });
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
    const meta = {
      ...outcome.result.meta,
      durationMs: outcome.durationMs,
    };
    const finalTool = await profile.messages.update(
      profile.sessionId,
      entry.record.id,
      {
        content: outcome.result.content,
        status: outcome.result.status,
        meta,
      },
    );
    const message: ChatMessageRecord =
      finalTool ?? {
        ...entry.record,
        content: outcome.result.content,
        status: outcome.result.status,
        meta,
      };

    options.emit({ type: "agent.tool.finished", message });
    void profile.audit.append({
      type: "agent.tool",
      sessionId: profile.sessionId,
      toolName: entry.call.name,
      toolCallId: entry.call.id,
      status: outcome.result.status,
      durationMs: outcome.durationMs,
      command: outcome.result.meta?.command,
      path: outcome.result.meta?.path,
      query: outcome.result.meta?.query,
      paperId: outcome.result.meta?.paperId,
      arxivId: outcome.result.meta?.arxivId,
    });

    outcomes.push({
      call: entry.call,
      result: outcome.result,
      durationMs: outcome.durationMs,
    });
  }

  return outcomes;
}

export interface HistoryOptions {
  /**
   * Rewrites the model-facing content of one tool result. Paper sessions use
   * this to drop stale full-text reads while keeping the UI records intact.
   */
  toolContent?: (record: ChatMessageRecord) => string | LlmContentPart[];
}

/**
 * Converts persisted records to OpenAI messages while keeping tool_call /
 * tool_result pairs consistent. Orphan tool results or calls without results
 * would make the next API request invalid.
 */
export function recordsToLlmMessages(
  records: ChatMessageRecord[],
  options: HistoryOptions = {},
): LlmChatMessage[] {
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
        content: options.toolContent
          ? options.toolContent(record)
          : toolContentForModel(record.content, record.meta),
      });
    }
  }

  return messages;
}

/**
 * Tool results are text unless the tool attached an image (read_image); the
 * provider then receives a text+image content array so the model can see it.
 */
export function toolContentForModel(
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
