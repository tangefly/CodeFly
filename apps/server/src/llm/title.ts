import type { Session } from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import type { SessionStore } from "../session/store.js";
import type { LlmClientLike } from "./client.js";
import type { LlmConfigStore } from "./config-store.js";
import type { MessageStore } from "./messages.js";

const TITLE_SYSTEM_PROMPT = `你是会话标题生成器。根据这段对话的开头写一个简短、具体的会话标题。
要求：
- 使用用户的语言
- 中文不超过 16 个字，英文不超过 8 个单词
- 概括用户想做的事情，不要照抄原句
- 不加引号、句号、冒号或 Markdown
只输出标题本身。`;

const TITLE_MAX_TOKENS = 48;
const USER_EXCERPT_CHARS = 1200;
const ASSISTANT_EXCERPT_CHARS = 1200;
const TITLE_MAX_CHARS = 60;
/** How long the SSE route waits for a title before closing the stream. */
const TITLE_WAIT_MS = 3000;

export interface SessionTitlerDeps {
  sessions: SessionStore;
  messages: MessageStore;
  llmConfig: LlmConfigStore;
  client: LlmClientLike;
  audit: AuditLog;
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** Strips model chatter around the title (quotes, "标题：" prefix, trailing punctuation). */
export function sanitizeTitle(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  title = title.replace(/^\*\*(.*)\*\*$/, "$1").trim();
  title = title
    .replace(/^["'“”‘’「」『』《》]+/, "")
    .replace(/["'“”‘’「」『』《》]+$/, "")
    .trim();
  title = title.replace(/^(标题|title)\s*[:：\-—]\s*/i, "").trim();
  title = title.replace(/[。.!！？?；;，,、：:…]+$/u, "").trim();
  if (title.length > TITLE_MAX_CHARS) {
    title = title.slice(0, TITLE_MAX_CHARS).trimEnd();
  }
  return title;
}

/**
 * Names a session after its first exchange once the first turn finishes.
 * Best effort: a failed or slow title request leaves the folder-name default
 * in place, and the next turn tries again.
 */
export class SessionTitler {
  private readonly pending = new Map<string, Promise<Session | null>>();

  constructor(private readonly deps: SessionTitlerDeps) {}

  /**
   * Resolves to the retitled session, or null when the session is already
   * named, has nothing to summarize, or the model call failed.
   */
  maybeTitle(sessionId: string, fallbackUserText = ""): Promise<Session | null> {
    const existing = this.pending.get(sessionId);
    if (existing !== undefined) return existing;

    const promise = this.generate(sessionId, fallbackUserText).finally(() => {
      this.pending.delete(sessionId);
    });
    this.pending.set(sessionId, promise);
    return promise;
  }

  private async generate(
    sessionId: string,
    fallbackUserText: string,
  ): Promise<Session | null> {
    const session = this.deps.sessions.get(sessionId);
    // A user-chosen or already generated title is never replaced.
    if (!session || session.titleSource !== "default") return null;

    const config = this.deps.llmConfig.getInternal();
    if (config.baseUrl === "" || config.model === "") return null;

    const exchange = this.firstExchange(sessionId, fallbackUserText);
    if (exchange.user === "") return null;

    const prompt =
      exchange.assistant === ""
        ? `用户的第一条消息：\n${truncate(exchange.user, USER_EXCERPT_CHARS)}`
        : `用户的第一条消息：\n${truncate(exchange.user, USER_EXCERPT_CHARS)}\n\n助手的第一条回复：\n${truncate(exchange.assistant, ASSISTANT_EXCERPT_CHARS)}`;

    try {
      // Qwen's template enables thinking by default; a tiny title budget
      // would otherwise be spent on reasoning before any visible answer.
      const chatTemplateKwargs = /qwen/i.test(config.model)
        ? { enable_thinking: false }
        : undefined;
      const result = await this.deps.client.complete(
        { ...config, temperature: 0.2, thinking: false },
        [
          { role: "system", content: TITLE_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        AbortSignal.timeout(Math.min(config.timeoutMs, 15_000)),
        TITLE_MAX_TOKENS,
        chatTemplateKwargs === undefined
          ? undefined
          : { chatTemplateKwargs },
      );
      const title = sanitizeTitle(result.content);
      if (title === "") return null;

      const updated = await this.deps.sessions.updateTitle(sessionId, title);
      void this.deps.audit.append({
        type: "session.titled",
        sessionId,
        title: updated.title,
      });
      return updated;
    } catch {
      // Leave the default title; the next turn can retry.
      return null;
    }
  }

  /** First user message plus the final assistant text of that first turn. */
  private firstExchange(
    sessionId: string,
    fallbackUserText: string,
  ): { user: string; assistant: string } {
    const records = this.deps.messages.list(sessionId);
    const firstUserIndex = records.findIndex(
      (record) => record.role === "user" && record.content.trim() !== "",
    );
    if (firstUserIndex < 0) {
      return { user: fallbackUserText.trim(), assistant: "" };
    }

    const user = records[firstUserIndex]!.content;
    let assistant = "";
    for (let index = firstUserIndex + 1; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.role === "user") break;
      if (record.role === "assistant" && record.content.trim() !== "") {
        assistant = record.content;
      }
    }
    return { user, assistant };
  }
}

/**
 * Waits a bounded time for the title so an unusually slow model call cannot
 * hold the SSE stream open; the call keeps running and still persists.
 */
export function waitForTitle(
  promise: Promise<Session | null>,
): Promise<Session | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), TITLE_WAIT_MS);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
