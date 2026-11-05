import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "@codefly/protocol";
import type { AuditLog } from "../src/audit/log.js";
import {
  LlmError,
  type LlmChatMessage,
  type LlmClientLike,
  type LlmCompleteResult,
  type LlmStreamResult,
} from "../src/llm/client.js";
import { LlmConfigStore, type LlmInternalConfig } from "../src/llm/config-store.js";
import { MessageStore } from "../src/llm/messages.js";
import { SessionTitler, sanitizeTitle } from "../src/llm/title.js";
import { SessionStore } from "../src/session/store.js";

const audit = {
  append: async () => undefined,
  recent: async () => [],
} as unknown as AuditLog;

class FakeTitleClient implements LlmClientLike {
  title = "修复日志解析";
  fail = false;
  readonly prompts: string[] = [];
  readonly options: Array<{ chatTemplateKwargs?: Record<string, unknown> } | undefined> =
    [];

  async streamChat(): Promise<LlmStreamResult> {
    throw new Error("not used");
  }

  async complete(
    _config: LlmInternalConfig,
    messages: LlmChatMessage[],
    _signal: AbortSignal,
    _maxTokens?: number,
    options?: { chatTemplateKwargs?: Record<string, unknown> },
  ): Promise<LlmCompleteResult> {
    this.prompts.push(String(messages.at(-1)?.content ?? ""));
    this.options.push(options);
    if (this.fail) throw new LlmError("LLM_NETWORK_ERROR", "offline", 502);
    return { content: this.title, latencyMs: 5, model: "test-model" };
  }
}

function message(
  sessionId: string,
  role: ChatMessageRecord["role"],
  content: string,
): ChatMessageRecord {
  const now = new Date().toISOString();
  return {
    id: `m_${role}_${Math.random().toString(16).slice(2)}`,
    sessionId,
    role,
    content,
    status: "complete",
    createdAt: now,
    updatedAt: now,
  };
}

describe("SessionTitler", () => {
  let dir: string;
  let workspace: string;
  let sessions: SessionStore;
  let messages: MessageStore;
  let llmConfig: LlmConfigStore;
  let client: FakeTitleClient;
  let titler: SessionTitler;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-title-"));
    workspace = path.join(dir, "my-project");
    await mkdir(workspace, { recursive: true });
    sessions = new SessionStore(path.join(dir, "sessions.json"));
    await sessions.init();
    messages = new MessageStore(path.join(dir, "messages.json"));
    await messages.init();
    llmConfig = new LlmConfigStore(path.join(dir, "llm.json"));
    await llmConfig.init();
    await llmConfig.update({
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "test-key",
    });
    client = new FakeTitleClient();
    titler = new SessionTitler({
      sessions,
      messages,
      llmConfig,
      client,
      audit,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names a default-titled session after its first exchange", async () => {
    const session = await sessions.create(workspace, undefined, "workspace-write");
    expect(session.title).toBe("my-project");
    expect(session.titleSource).toBe("default");

    await messages.appendMany(session.id, [
      message(session.id, "user", "帮我修一下日志解析的报错"),
      message(session.id, "assistant", "问题出在分隔符上……"),
    ]);

    const titled = await titler.maybeTitle(session.id);
    expect(titled?.title).toBe("修复日志解析");
    expect(titled?.titleSource).toBe("auto");
    expect(client.prompts[0]).toContain("帮我修一下日志解析的报错");
    expect(client.prompts[0]).toContain("问题出在分隔符上");

    // Persisted, and a second turn does not rename again.
    const reloaded = new SessionStore(path.join(dir, "sessions.json"));
    await reloaded.init();
    expect(reloaded.get(session.id)?.title).toBe("修复日志解析");
    expect(await titler.maybeTitle(session.id)).toBeNull();
    expect(client.prompts).toHaveLength(1);
  });

  it("falls back to the first user message before it is persisted", async () => {
    const session = await sessions.create(workspace, undefined, "workspace-write");
    const titled = await titler.maybeTitle(session.id, "给登录页加个记住我选项");
    expect(titled?.title).toBe("修复日志解析");
    expect(client.prompts[0]).toContain("给登录页加个记住我选项");
  });

  it("never overwrites a user-provided title", async () => {
    const session = await sessions.create(workspace, "我的会话", "workspace-write");
    await messages.appendMany(session.id, [
      message(session.id, "user", "随便聊聊"),
    ]);

    expect(await titler.maybeTitle(session.id)).toBeNull();
    expect(sessions.get(session.id)?.title).toBe("我的会话");
    expect(client.prompts).toHaveLength(0);
  });

  it("leaves the default in place when the model call fails", async () => {
    client.fail = true;
    const session = await sessions.create(workspace, undefined, "workspace-write");
    const titled = await titler.maybeTitle(session.id, "你好");
    expect(titled).toBeNull();
    expect(sessions.get(session.id)?.title).toBe("my-project");
    expect(sessions.get(session.id)?.titleSource).toBe("default");
  });

  it("disables Qwen thinking for the title request", async () => {
    await llmConfig.update({
      baseUrl: "https://api.example.com/v1",
      model: "Qwen3.8-27B-FP8",
      apiKey: "test-key",
    });
    const session = await sessions.create(workspace, undefined, "workspace-write");
    await titler.maybeTitle(session.id, "总结一下这段代码");

    expect(client.options[0]).toEqual({
      chatTemplateKwargs: { enable_thinking: false },
    });

    client.options.length = 0;
    const other = await sessions.create(workspace, undefined, "workspace-write");
    await llmConfig.update({
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "test-key",
    });
    await titler.maybeTitle(other.id, "另一个话题");
    expect(client.options[0]).toBeUndefined();
  });

  it("sanitizes quotes, prefixes, and trailing punctuation", () => {
    expect(sanitizeTitle('「修复登录问题。」')).toBe("修复登录问题");
    expect(sanitizeTitle('**标题：排查构建失败**')).toBe("排查构建失败");
    expect(sanitizeTitle("  Fix   the   parser. ")).toBe("Fix the parser");
  });
});
