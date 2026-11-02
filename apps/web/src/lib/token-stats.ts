import type { ChatMessage } from "./store.js";

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** Reasoning tokens reported by the provider (included in completionTokens). */
  reasoningTokens: number;
  /**
   * Prompt tokens of the most recent request. This is the context size that
   * was actually sent (history + tools + system prompt), unlike the cumulative
   * promptTokens total. Null before the first usage report.
   */
  contextTokens: number | null;
  /** Output tokens per second, weighted by the generation time of each reply. */
  speed: number | null;
  /** Share of prompt tokens served from the provider cache. */
  cacheHitRate: number | null;
}

export interface ConversationSize {
  /** Number of persisted user/assistant/tool messages in the session. */
  messages: number;
  /** Total characters across message text, reasoning, and tool arguments/output. */
  chars: number;
  /** Rough token estimate from the character count. */
  tokens: number;
}

/**
 * Current session conversation length: every persisted message (user,
 * assistant, tool), excluding UI-only system notices and provider overhead
 * (system prompt / tool definitions).
 */
export function computeConversationSize(
  messages: ChatMessage[],
): ConversationSize {
  let chars = 0;
  let count = 0;

  for (const message of messages) {
    if (message.kind === "system") continue;
    count += 1;
    if (message.kind === "user") {
      chars += message.text.length;
    } else if (message.kind === "assistant") {
      chars += message.text.length + (message.reasoning?.length ?? 0);
    } else if (message.kind === "tool") {
      chars += message.content.length + message.arguments.length;
    }
  }

  return { messages: count, chars, tokens: Math.ceil(chars / 3) };
}

export function formatTokens(value: number): string {
  return value >= 10_000
    ? `${(value / 1000).toFixed(1)}k`
    : value.toLocaleString("en-US");
}

export function formatSpeed(speed: number): string {
  return speed >= 100 ? String(Math.round(speed)) : speed.toFixed(1);
}

/** Aggregates provider-reported usage across all assistant messages. */
export function computeSessionUsage(
  messages: ChatMessage[],
): SessionUsage | null {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let contextTokens: number | null = null;
  let cachePromptTokens = 0;
  let generationMs = 0;
  let timedCompletionTokens = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasTotal = false;
  let hasCache = false;

  for (const message of messages) {
    if (message.kind !== "assistant" || !message.usage) continue;
    const usage = message.usage;

    if (usage.promptTokens !== undefined) {
      promptTokens += usage.promptTokens;
      // Messages are chronological, so the last reported request wins.
      contextTokens = usage.promptTokens;
      hasInput = true;
    }
    if (usage.completionTokens !== undefined) {
      completionTokens += usage.completionTokens;
      hasOutput = true;
      if (message.durationMs !== undefined) {
        generationMs += Math.max(
          1,
          message.durationMs - (message.firstTokenMs ?? 0),
        );
        timedCompletionTokens += usage.completionTokens;
      }
    }
    if (usage.totalTokens !== undefined) {
      totalTokens += usage.totalTokens;
      hasTotal = true;
    }
    if (usage.reasoningTokens !== undefined) {
      reasoningTokens += usage.reasoningTokens;
    }
    if (
      usage.cachedTokens !== undefined &&
      usage.promptTokens !== undefined
    ) {
      // Only count replies that report both so the rate stays well-defined.
      cachedTokens += usage.cachedTokens;
      cachePromptTokens += usage.promptTokens;
      hasCache = true;
    }
  }

  if (!hasInput && !hasOutput && !hasTotal) return null;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
    contextTokens,
    speed:
      timedCompletionTokens > 0 && generationMs > 0
        ? timedCompletionTokens / (generationMs / 1000)
        : null,
    cacheHitRate:
      hasCache && cachePromptTokens > 0
        ? cachedTokens / cachePromptTokens
        : null,
  };
}
