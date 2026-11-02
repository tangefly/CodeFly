import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessageRecord, Session } from "@codefly/protocol";
import type { AuditLog } from "../src/audit/log.js";
import {
  LlmError,
  type LlmChatMessage,
  type LlmClientLike,
  type LlmCompleteResult,
  type LlmStreamResult,
  type StreamChatOptions,
} from "../src/llm/client.js";
import {
  LlmConfigStore,
  type LlmInternalConfig,
} from "../src/llm/config-store.js";
import { MessageStore } from "../src/llm/messages.js";
import { ChatService } from "../src/llm/service.js";
import { SessionRunLock } from "../src/llm/run-lock.js";

const audit = {
  append: async () => undefined,
  recent: async () => [],
} as unknown as AuditLog;

class FakeClient implements LlmClientLike {
  mode: "ok" | "error" | "abort" = "ok";
  reasoning = "";
  calls: Array<{ config: LlmInternalConfig; messages: LlmChatMessage[] }> = [];

  async streamChat(
    config: LlmInternalConfig,
    messages: LlmChatMessage[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
    options?: StreamChatOptions,
  ): Promise<LlmStreamResult> {
    this.calls.push({ config, messages });
    if (this.mode === "error") {
      throw new LlmError("LLM_HTTP_ERROR", "upstream failed", 502);
    }
    if (this.reasoning !== "") {
      options?.onReasoningDelta?.(this.reasoning);
    }
    if (this.mode === "abort") {
      onDelta("partial");
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new LlmError("LLM_ABORTED", "aborted", 499));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new LlmError("LLM_ABORTED", "aborted", 499)),
          { once: true },
        );
      });
    }
    onDelta("Hello");
    onDelta(" world");
    return {
      content: "Hello world",
      reasoningContent: this.reasoning !== "" ? this.reasoning : undefined,
      finishReason: "stop",
      usage: { totalTokens: 3 },
      toolCalls: [],
    };
  }

  async complete(
    config: LlmInternalConfig,
    _messages: LlmChatMessage[],
    _signal: AbortSignal,
    _maxTokens?: number,
  ): Promise<LlmCompleteResult> {
    if (this.mode === "error") {
      throw new LlmError("LLM_HTTP_ERROR", "upstream failed", 502);
    }
    return { content: "OK", latencyMs: 5, model: config.model };
  }
}

function makeSession(id = "s_test"): Session {
  return {
    id,
    title: "test",
    workspaceRoot: "/tmp",
    mode: "workspace-write",
    approvalPolicy: "ask",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDenial: null,
  };
}

function priorRecord(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  index: number,
): ChatMessageRecord {
  const now = new Date().toISOString();
  return {
    id: `m_prior_${index}`,
    sessionId,
    role,
    content,
    status: "complete",
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ChatService", () => {
  let dir: string;
  let configStore: LlmConfigStore;
  let messageStore: MessageStore;
  let client: FakeClient;
  let service: ChatService;
  let session: Session;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-chat-"));
    configStore = new LlmConfigStore(path.join(dir, "llm.json"));
    await configStore.init();
    await configStore.update({
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "test-key",
    });
    messageStore = new MessageStore(path.join(dir, "messages.json"));
    await messageStore.init();
    client = new FakeClient();
    service = new ChatService({
      messages: messageStore,
      llmConfig: configStore,
      audit,
      client,
      lock: new SessionRunLock(),
      options: { contextBudgetChars: 5000, testMaxTokens: 16 },
    });
    session = makeSession();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("streams deltas and persists the completed turn", async () => {
    const events: ChatEvent[] = [];
    await service.chat(session, "hi", new AbortController().signal, (event) =>
      events.push(event),
    );

    const history = messageStore.list(session.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      role: "user",
      content: "hi",
      status: "complete",
    });
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: "Hello world",
      status: "complete",
      model: "test-model",
      usage: { totalTokens: 3 },
    });

    expect(events.map((event) => event.type)).toEqual([
      "chat.started",
      "chat.delta",
      "chat.delta",
      "chat.done",
    ]);
    const started = events[0];
    if (!started || started.type !== "chat.started") {
      throw new Error("missing started");
    }
    expect(history[0]!.id).toBe(started.userMessage.id);
    expect(history[1]!.id).toBe(started.assistantMessage.id);

    const sent = client.calls[0]!;
    expect(sent.messages[0]).toMatchObject({ role: "system" });
    expect(sent.messages.at(-1)).toMatchObject({ role: "user", content: "hi" });
  });

  it("streams and persists reasoning", async () => {
    client.reasoning = "let me think";
    const events: ChatEvent[] = [];
    await service.chat(session, "hi", new AbortController().signal, (event) =>
      events.push(event),
    );

    expect(events.map((event) => event.type)).toEqual([
      "chat.started",
      "chat.reasoning",
      "chat.delta",
      "chat.delta",
      "chat.done",
    ]);
    const history = messageStore.list(session.id);
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: "Hello world",
      reasoning: "let me think",
      status: "complete",
    });
  });

  it("includes prior turns in the next request", async () => {
    await service.chat(session, "first", new AbortController().signal, () => undefined);
    await service.chat(session, "second", new AbortController().signal, () => undefined);

    const second = client.calls[1]!;
    expect(second.messages).toContainEqual({ role: "user", content: "first" });
    expect(second.messages).toContainEqual({
      role: "assistant",
      content: "Hello world",
    });
    expect(second.messages.at(-1)).toEqual({ role: "user", content: "second" });
  });

  it("persists an error and emits chat.error", async () => {
    client.mode = "error";
    const events: ChatEvent[] = [];
    await service.chat(session, "hi", new AbortController().signal, (event) =>
      events.push(event),
    );

    const history = messageStore.list(session.id);
    expect(history[1]).toMatchObject({ status: "error", content: "" });
    expect(history[1]!.error).toContain("upstream failed");
    expect(
      events.some((event) => event.type === "chat.error" && event.code === "LLM_HTTP_ERROR"),
    ).toBe(true);
  });

  it("persists a cancelled partial response on abort", async () => {
    client.mode = "abort";
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    const pending = service.chat(session, "hi", controller.signal, (event) =>
      events.push(event),
    );

    await waitFor(() =>
      events.some((event) => event.type === "chat.delta"),
    );
    controller.abort();
    await pending;

    const history = messageStore.list(session.id);
    expect(history[1]).toMatchObject({ status: "cancelled", content: "partial" });
    expect(events.some((event) => event.type === "chat.error")).toBe(false);
  });

  it("trims old context and drops a leading assistant turn", async () => {
    const trimmedService = new ChatService({
      messages: messageStore,
      llmConfig: configStore,
      audit,
      client,
      lock: new SessionRunLock(),
      options: { contextBudgetChars: 220, testMaxTokens: 16 },
    });

    let index = 0;
    for (let turn = 0; turn < 4; turn += 1) {
      await messageStore.appendMany(session.id, [
        priorRecord(session.id, "user", "u".repeat(100), index++),
        priorRecord(session.id, "assistant", "a".repeat(100), index++),
      ]);
    }

    await trimmedService.chat(
      session,
      "new question",
      new AbortController().signal,
      () => undefined,
    );

    const sent = client.calls[0]!;
    expect(sent.messages[0]?.content).toContain("omitted");
    expect(sent.messages[1]?.role).toBe("user");
    expect(sent.messages.at(-1)).toEqual({
      role: "user",
      content: "new question",
    });
    expect(sent.messages.length).toBeLessThan(5);
  });

  it("tests the provider with the stored configuration", async () => {
    const ok = await service.test({});
    expect(ok).toMatchObject({ ok: true, message: "OK", model: "test-model" });

    client.mode = "error";
    const failed = await service.test({});
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("upstream failed");
  });

  it("refuses when no provider is configured", async () => {
    const emptyStore = new LlmConfigStore(path.join(dir, "empty-llm.json"));
    await emptyStore.init();
    const emptyService = new ChatService({
      messages: messageStore,
      llmConfig: emptyStore,
      audit,
      client,
      lock: new SessionRunLock(),
      options: { contextBudgetChars: 5000, testMaxTokens: 16 },
    });

    expect(() => emptyService.assertReady(session.id)).toThrowError();
    try {
      emptyService.assertReady(session.id);
    } catch (error) {
      expect(error).toMatchObject({ code: "LLM_NOT_CONFIGURED" });
    }
  });
});
