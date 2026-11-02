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
  contextBudgetChars: number;
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

interface BuiltContext {
  messages: LlmChatMessage[];
  trimmed: boolean;
}

function buildContext(
  systemPrompt: string,
  prior: ChatMessageRecord[],
  userContent: string,
  budgetChars: number,
): BuiltContext {
  const baseSystem = systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  let used = baseSystem.length + userContent.length;
  const picked: LlmChatMessage[] = [];

  for (let index = prior.length - 1; index >= 0; index -= 1) {
    const message = prior[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.content.trim() === "") continue;
    if (picked.length > 0 && used + message.content.length > budgetChars) break;
    picked.unshift({ role: message.role, content: message.content });
    used += message.content.length;
  }

  // Some providers require the first non-system message to be a user turn.
  while (picked[0]?.role === "assistant") picked.shift();

  const trimmed = picked.length < prior.length;
  const system = trimmed
    ? `${baseSystem}\n\n[Earlier conversation messages were omitted to fit the context window.]`
    : baseSystem;

  return {
    messages: [
      { role: "system", content: system },
      ...picked,
      { role: "user", content: userContent },
    ],
    trimmed,
  };
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

    this.deps.lock.acquire(session.id, "chat");
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

    try {
      await this.deps.messages.appendMany(session.id, [userMessage, assistantMessage]);
      emit({ type: "chat.started", userMessage, assistantMessage });

      const context = buildContext(
        config.systemPrompt,
        prior,
        content,
        this.deps.options.contextBudgetChars,
      );

      const timeoutController = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, config.timeoutMs);
      timer.unref?.();

      const signal = AbortSignal.any([clientSignal, timeoutController.signal]);
      let usage: ChatUsage | undefined;

      try {
        const result = await this.deps.client.streamChat(
          config,
          context.messages,
          (delta) => {
            assistantContent += delta;
            emit({
              type: "chat.delta",
              messageId: assistantMessage.id,
              data: delta,
            });
          },
          signal,
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
        });

        emit({
          type: "chat.done",
          message:
            final ?? {
              ...assistantMessage,
              content: assistantContent,
              status: "complete",
            },
          usage,
        });

        void this.deps.audit.append({
          type: "llm.chat",
          sessionId: session.id,
          model: config.model,
          outcome: "complete",
          durationMs: Date.now() - startedAt,
          promptChars: context.messages.reduce(
            (total, message) => total + (message.content?.length ?? 0),
            0,
          ),
          responseChars: assistantContent.length,
          contextTrimmed: context.trimmed,
          usage,
        });
      } catch (error) {
        const aborted = clientSignal.aborted;
        const code = timedOut
          ? "LLM_TIMEOUT"
          : aborted
            ? "CHAT_ABORTED"
            : error instanceof LlmError
              ? error.code
              : "LLM_ERROR";
        const message = timedOut
          ? `模型响应超时（${config.timeoutMs} ms）。`
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
          promptChars: context.messages.reduce(
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
    };

    const startedAt = Date.now();
    try {
      const result = await this.deps.client.complete(
        config,
        [
          {
            role: "user",
            content: "Reply with exactly: OK",
          },
        ],
        AbortSignal.timeout(config.timeoutMs),
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
        ? `连接模型 API 超时（${config.timeoutMs} ms）。`
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
