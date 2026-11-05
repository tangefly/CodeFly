import { randomUUID } from "node:crypto";
import type {
  ChatEvent,
  ChatMessageRecord,
  ChatUsage,
  LlmTestInput,
  LlmTestResult,
  Session,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import { LlmError, redactSecret, type LlmChatMessage, type LlmClientLike } from "./client.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  normalizeBaseUrl,
  type LlmConfigStore,
  type LlmInternalConfig,
} from "./config-store.js";
import type { MessageStore } from "./messages.js";
import type { SessionRunLock } from "./run-lock.js";

export interface ChatServiceOptions {
  testMaxTokens: number;
}

export interface ChatServiceDeps {
  messages: MessageStore;
  llmConfig: LlmConfigStore;
  audit: AuditLog;
  client: LlmClientLike;
  lock: SessionRunLock;
  options: ChatServiceOptions;
}

/**
 * Builds the outgoing chat context with the full session history. The model
 * server enforces its own context window; there is no local character budget.
 */
function buildContext(
  systemPrompt: string,
  prior: ChatMessageRecord[],
  userContent: string,
): LlmChatMessage[] {
  const baseSystem = systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  const picked: LlmChatMessage[] = [];

  for (const message of prior) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.content.trim() === "") continue;
    picked.push({ role: message.role, content: message.content });
  }

  // Some providers require the first non-system message to be a user turn.
  while (picked[0]?.role === "assistant") picked.shift();

  return [
    { role: "system", content: baseSystem },
    ...picked,
    { role: "user", content: userContent },
  ];
}

function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name?: unknown }).name === "TimeoutError" ||
      (error as { name?: unknown }).name === "AbortError")
  );
}

/**
 * Chat orchestration for the OpenAI-compatible provider. This is chat only:
 * the model receives text, never tools or command execution.
 */
export class ChatService {
  private readonly deps: ChatServiceDeps;

  constructor(deps: ChatServiceDeps) {
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

  async chat(
    session: Session,
    content: string,
    clientSignal: AbortSignal,
    emit: (event: ChatEvent) => void,
  ): Promise<void> {
    this.assertReady(session.id);
    if (clientSignal.aborted) return;

    const runSignal = this.deps.lock.acquire(session.id, "chat");
    // The run stops when the client disconnects or when it is cancelled
    // explicitly through the session cancel endpoint.
    const signal = AbortSignal.any([clientSignal, runSignal]);
    const startedAt = Date.now();
    const config = this.deps.llmConfig.getInternal();
    const prior = this.deps.messages.list(session.id);
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
    const assistantMessage: ChatMessageRecord = {
      id: `m_${randomUUID()}`,
      sessionId: session.id,
      role: "assistant",
      content: "",
      status: "streaming",
      model: config.model,
      createdAt: now,
      updatedAt: now,
    };

    let assistantContent = "";
    let assistantReasoning = "";

    try {
      await this.deps.messages.appendMany(session.id, [userMessage, assistantMessage]);
      emit({ type: "chat.started", userMessage, assistantMessage });

      const context = buildContext(config.systemPrompt, prior, content);

      // Inactivity timeout: re-arm whenever the provider produces output, so
      // a long thinking phase that keeps streaming is never cut off.
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

      const streamSignal = AbortSignal.any([signal, timeoutController.signal]);
      let usage: ChatUsage | undefined;

      try {
        const result = await this.deps.client.streamChat(
          config,
          context,
          (delta) => {
            assistantContent += delta;
            emit({
              type: "chat.delta",
              messageId: assistantMessage.id,
              data: delta,
            });
          },
          streamSignal,
          {
            onReasoningDelta: (delta) => {
              assistantReasoning += delta;
              emit({
                type: "chat.reasoning",
                messageId: assistantMessage.id,
                data: delta,
              });
            },
            onActivity: armTimeout,
          },
        );

        if (result.content !== "" && result.content.length >= assistantContent.length) {
          assistantContent = result.content;
        }
        usage = result.usage;

        const final = await this.deps.messages.update(session.id, assistantMessage.id, {
          content: assistantContent,
          status: "complete",
          error: undefined,
          model: config.model,
          ...(assistantReasoning !== "" ? { reasoning: assistantReasoning } : {}),
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
          ...(result.durationMs !== undefined
            ? { durationMs: result.durationMs }
            : {}),
          ...(result.firstTokenMs !== undefined
            ? { firstTokenMs: result.firstTokenMs }
            : {}),
        });

        emit({
          type: "chat.done",
          message:
            final ?? {
              ...assistantMessage,
              content: assistantContent,
              status: "complete",
              ...(assistantReasoning !== "" ? { reasoning: assistantReasoning } : {}),
              usage: result.usage,
              durationMs: result.durationMs,
              firstTokenMs: result.firstTokenMs,
            },
          usage,
        });

        void this.deps.audit.append({
          type: "llm.chat",
          sessionId: session.id,
          model: config.model,
          outcome: "complete",
          durationMs: Date.now() - startedAt,
          promptChars: context.reduce(
            (total, message) => total + (message.content?.length ?? 0),
            0,
          ),
          responseChars: assistantContent.length,
          reasoningChars: assistantReasoning.length,
          usage,
        });
      } catch (error) {
        // `!timedOut` keeps a timeout an error even though the combined
        // signal is aborted in that case too.
        const aborted = !timedOut && signal.aborted;
        const code = timedOut
          ? "LLM_TIMEOUT"
          : aborted
            ? "CHAT_ABORTED"
            : error instanceof LlmError
              ? error.code
              : "LLM_ERROR";
        const message = timedOut
          ? `模型超过 ${config.timeoutMs} ms 没有输出，已停止。`
          : aborted
            ? "生成已取消。"
            : redactSecret(
                error instanceof Error ? error.message : String(error),
                config.apiKey,
              );
        const status = aborted ? "cancelled" : "error";

        const final = await this.deps.messages.update(session.id, assistantMessage.id, {
          content: assistantContent,
          status,
          error: status === "error" ? message : undefined,
          model: config.model,
          ...(assistantReasoning !== "" ? { reasoning: assistantReasoning } : {}),
        });

        if (!aborted) {
          emit({
            type: "chat.error",
            messageId: assistantMessage.id,
            code,
            message,
          });
        }

        void this.deps.audit.append({
          type: "llm.chat",
          sessionId: session.id,
          model: config.model,
          outcome: aborted ? "cancelled" : "error",
          code,
          durationMs: Date.now() - startedAt,
          promptChars: context.reduce(
            (total, message) => total + (message.content?.length ?? 0),
            0,
          ),
          responseChars: final?.content.length ?? assistantContent.length,
        });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.deps.lock.release(session.id);
    }
  }

  async test(input: LlmTestInput): Promise<LlmTestResult> {
    const stored = this.deps.llmConfig.getInternal();
    const baseUrl =
      input.baseUrl !== undefined && input.baseUrl.trim() !== ""
        ? normalizeBaseUrl(input.baseUrl)
        : stored.baseUrl;
    const model =
      input.model !== undefined && input.model.trim() !== ""
        ? input.model.trim()
        : stored.model;

    if (baseUrl === "" || model === "") {
      throw new AppError(
        "LLM_NOT_CONFIGURED",
        "请先填写 Base URL 与 Model。",
        400,
      );
    }

    let apiKey = stored.apiKey;
    if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
      apiKey = input.apiKey.trim();
    }

    const config: LlmInternalConfig = {
      ...stored,
      baseUrl,
      model,
      apiKey,
      temperature:
        input.temperature === undefined ? stored.temperature : input.temperature,
      maxTokens:
        input.maxTokens === undefined ? stored.maxTokens : input.maxTokens,
      timeoutMs: input.timeoutMs ?? stored.timeoutMs,
      // Keep the connection probe small and predictable: reasoning tokens
      // would count against testMaxTokens.
      thinking: false,
    };

    const startedAt = Date.now();
    // A connection probe still needs a bound even when streaming timeouts
    // are disabled (0).
    const probeTimeoutMs = config.timeoutMs > 0 ? config.timeoutMs : 30_000;
    try {
      const result = await this.deps.client.complete(
        config,
        [
          {
            role: "user",
            content: "Reply with exactly: OK",
          },
        ],
        AbortSignal.timeout(probeTimeoutMs),
        this.deps.options.testMaxTokens,
      );
      return {
        ok: true,
        message: result.content.trim() || "(empty response)",
        latencyMs: result.latencyMs,
        model: result.model,
      };
    } catch (error) {
      const message = isTimeoutError(error)
        ? `连接模型 API 超时（${probeTimeoutMs} ms）。`
        : redactSecret(
            error instanceof Error ? error.message : String(error),
            config.apiKey,
          );
      return {
        ok: false,
        message,
        latencyMs: Date.now() - startedAt,
        model: config.model,
      };
    }
  }
}
