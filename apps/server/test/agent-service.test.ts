import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_TOOL_NAMES,
  type AgentEvent,
  type AgentSession,
  type AgentToolName,
  type AuditEvent,
} from "@codefly/protocol";
import type { AuditLog } from "../src/audit/log.js";
import type { ExecService } from "../src/exec/service.js";
import {
  LlmError,
  type LlmChatMessage,
  type LlmClientLike,
  type LlmCompleteResult,
  type LlmStreamResult,
  type LlmToolDefinition,
  type StreamChatOptions,
} from "../src/llm/client.js";
import { LlmConfigStore, type LlmInternalConfig } from "../src/llm/config-store.js";
import { MessageStore } from "../src/llm/messages.js";
import { SessionRunLock } from "../src/llm/run-lock.js";
import { AgentConfigStore } from "../src/agent/config-store.js";
import { AgentService } from "../src/agent/service.js";
import type {
  AgentToolExecutorLike,
  ToolExecutionContext,
  ToolResult,
} from "../src/agent/tools.js";

class FakeAgentClient implements LlmClientLike {
  mode: "two-step" | "always-tool" | "error" | "abort" | "multi-read" | "image" =
    "two-step";
  reasoning = "";
  calls: LlmChatMessage[][] = [];
  toolSets: LlmToolDefinition[][] = [];
  private count = 0;

  async streamChat(
    _config: LlmInternalConfig,
    messages: LlmChatMessage[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
    options?: StreamChatOptions,
  ): Promise<LlmStreamResult> {
    this.calls.push(messages);
    this.toolSets.push(options?.tools ?? []);

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

    if (this.mode === "always-tool") {
      this.count += 1;
      onDelta("checking…");
      return {
        content: "checking…",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `call_${this.count}`,
            name: "run_command",
            arguments: '{"command":"echo hi"}',
          },
        ],
      };
    }

    if (this.mode === "image" && this.count === 0) {
      this.count += 1;
      onDelta("looking");
      return {
        content: "looking",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call_img", name: "read_image", arguments: '{"path":"shot.png"}' },
        ],
      };
    }

    if (this.mode === "multi-read" && this.count === 0) {
      this.count += 1;
      onDelta("reading");
      return {
        content: "reading",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call_r1", name: "read_file", arguments: '{"path":"a.txt"}' },
          { id: "call_r2", name: "read_file", arguments: '{"path":"b.txt"}' },
          { id: "call_r3", name: "read_file", arguments: '{"path":"c.txt"}' },
        ],
      };
    }

    if (this.count === 0) {
      this.count += 1;
      onDelta("working");
      return {
        content: "working",
        reasoningContent: this.reasoning !== "" ? this.reasoning : undefined,
        finishReason: "tool_calls",
        usage: {
          promptTokens: 100,
          completionTokens: 5,
          totalTokens: 105,
          cachedTokens: 60,
        },
        durationMs: 42,
        firstTokenMs: 10,
        toolCalls: [
          {
            id: "call_1",
            name: "run_command",
            arguments: '{"command":"echo hi"}',
          },
        ],
      };
    }

    onDelta("done");
    return {
      content: "done",
      reasoningContent: this.reasoning !== "" ? this.reasoning : undefined,
      finishReason: "stop",
      usage: {
        promptTokens: 120,
        completionTokens: 8,
        totalTokens: 128,
        cachedTokens: 90,
      },
      toolCalls: [],
    };
  }

  async complete(): Promise<LlmCompleteResult> {
    return { content: "OK", latencyMs: 1, model: "test-model" };
  }
}

class FakeTools implements AgentToolExecutorLike {
  executed: Array<{ name: string; args: string }> = [];
  emitApproval = false;
  delayMs = 0;
  active = 0;
  maxActive = 0;

  definitions(enabledTools: AgentToolName[]): LlmToolDefinition[] {
    return enabledTools.map((name) => ({
      type: "function",
      function: {
        name,
        description: `fake ${name}`,
        parameters: { type: "object", properties: {} },
      },
    }));
  }

  async execute(
    name: string,
    rawArguments: string,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    this.executed.push({ name, args: rawArguments });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.emitApproval) {
        ctx.emit({
          type: "agent.approval_required",
          approvalId: "a_fake",
          execId: "e_fake",
          toolCallId: ctx.toolCallId,
          command: "echo hi",
          currentMode: "workspace-write",
          requestedMode: "danger-full-access",
          justification: "test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (name === "read_image") {
        return {
          content: "Read image shot.png (image/png, 1x1, 70 bytes).",
          status: "complete",
          meta: {
            kind: "image",
            path: "shot.png",
            mime: "image/png",
            width: 1,
            height: 1,
            imageDataUrl: "data:image/png;base64,AAAA",
          },
        };
      }
      return {
        content: "tool output",
        status: "complete",
        meta: { kind: "command", command: "echo hi", exitCode: 0 },
      };
    } finally {
      this.active -= 1;
    }
  }
}

const audit = (events: AuditEvent[]): AuditLog =>
  ({
    append: async (event: AuditEvent) => {
      events.push({ ...event, ts: new Date().toISOString() });
    },
    recent: async () => [],
  }) as unknown as AuditLog;

function makeSession(): AgentSession {
  return {
    id: "s_agent",
    kind: "agent",
    title: "agent",
    workspaceRoot: "/tmp",
    mode: "workspace-write",
    approvalPolicy: "ask",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDenial: null,
  };
}

describe("AgentService", () => {
  let dir: string;
  let messageStore: MessageStore;
  let agentConfig: AgentConfigStore;
  let client: FakeAgentClient;
  let tools: FakeTools;
  let lock: SessionRunLock;
  let auditEvents: AuditEvent[];
  let service: AgentService;
  let session: AgentSession;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-agent-"));
    const llmConfig = new LlmConfigStore(path.join(dir, "llm.json"));
    await llmConfig.init();
    await llmConfig.update({
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "key",
    });
    agentConfig = new AgentConfigStore(path.join(dir, "agent.json"));
    await agentConfig.init();
    messageStore = new MessageStore(path.join(dir, "messages.json"));
    await messageStore.init();
    client = new FakeAgentClient();
    tools = new FakeTools();
    lock = new SessionRunLock();
    auditEvents = [];
    service = new AgentService({
      messages: messageStore,
      llmConfig,
      agentConfig,
      audit: audit(auditEvents),
      client,
      tools,
      lock,
      exec: {} as ExecService,
      dataDir: path.join(dir, "data"),
      maxReadBytes: 2 * 1024 * 1024,
      maxWriteBytes: 5 * 1024 * 1024,
    });
    session = makeSession();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a tool-call step and then a final answer", async () => {
    const events: AgentEvent[] = [];
    await service.run(session, "please check", new AbortController().signal, (event) =>
      events.push(event),
    );

    const records = messageStore.list(session.id);
    expect(records.map((record) => record.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(records[0]).toMatchObject({ content: "please check" });
    expect(records[1]).toMatchObject({ content: "working", status: "complete" });
    expect(records[1]!.usage).toEqual({
      promptTokens: 100,
      completionTokens: 5,
      totalTokens: 105,
      cachedTokens: 60,
    });
    expect(records[1]!.durationMs).toBe(42);
    expect(records[1]!.firstTokenMs).toBe(10);
    expect(records[1]!.toolCalls).toEqual([
      {
        id: "call_1",
        name: "run_command",
        arguments: '{"command":"echo hi"}',
      },
    ]);
    expect(records[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      toolName: "run_command",
      content: "tool output",
      status: "complete",
    });
    expect(records[3]).toMatchObject({ content: "done", status: "complete" });
    expect(records[3]!.usage).toEqual({
      promptTokens: 120,
      completionTokens: 8,
      totalTokens: 128,
      cachedTokens: 90,
    });

    expect(tools.executed).toEqual([
      { name: "run_command", args: '{"command":"echo hi"}' },
    ]);
    expect(client.toolSets[0]?.map((tool) => tool.function.name)).toEqual([
      ...AGENT_TOOL_NAMES,
    ]);

    const secondCall = client.calls[1]!;
    const assistantToolCall = secondCall.find(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    );
    expect(assistantToolCall?.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "run_command", arguments: '{"command":"echo hi"}' },
    });
    expect(
      secondCall.find((message) => message.role === "tool"),
    ).toMatchObject({ tool_call_id: "call_1", content: "tool output" });

    expect(events.map((event) => event.type)).toEqual([
      "agent.started",
      "agent.step",
      "agent.delta",
      "agent.message",
      "agent.tool.started",
      "agent.tool.finished",
      "agent.step",
      "agent.delta",
      "agent.message",
      "agent.done",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "agent.done" });
    expect(lock.isBusy(session.id)).toBe(false);
    expect(auditEvents.some((event) => event.type === "agent.run")).toBe(true);
    expect(auditEvents.some((event) => event.type === "agent.tool")).toBe(true);
  });

  it("streams reasoning and echoes it back when tools are present", async () => {
    client.reasoning = "check first";
    const events: AgentEvent[] = [];
    await service.run(session, "please check", new AbortController().signal, (event) =>
      events.push(event),
    );

    expect(events.some((event) => event.type === "agent.reasoning")).toBe(true);
    const records = messageStore.list(session.id);
    expect(records[1]).toMatchObject({
      content: "working",
      reasoning: "check first",
    });

    const secondCall = client.calls[1]!;
    const assistantToolCall = secondCall.find(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    );
    expect(assistantToolCall?.reasoning_content).toBe("check first");
  });

  it("stops at max steps and keeps the executed tool results", async () => {
    await agentConfig.update({ maxSteps: 2 });
    client.mode = "always-tool";

    const events: AgentEvent[] = [];
    await service.run(session, "loop", new AbortController().signal, (event) =>
      events.push(event),
    );

    expect(tools.executed).toHaveLength(2);
    expect(
      events.find(
        (event) =>
          event.type === "agent.error" && event.code === "AGENT_MAX_STEPS",
      ),
    ).toBeDefined();
    expect(lock.isBusy(session.id)).toBe(false);

    const records = messageStore.list(session.id);
    expect(records.map((record) => record.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
  });

  it("persists an LLM error and emits agent.error", async () => {
    client.mode = "error";
    const events: AgentEvent[] = [];
    await service.run(session, "fail", new AbortController().signal, (event) =>
      events.push(event),
    );

    const records = messageStore.list(session.id);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ role: "assistant", status: "error" });
    expect(records[1]!.error).toContain("upstream failed");
    expect(
      events.some(
        (event) => event.type === "agent.error" && event.code === "LLM_HTTP_ERROR",
      ),
    ).toBe(true);
    expect(lock.isBusy(session.id)).toBe(false);
  });

  it("cancels on client abort and releases the lock", async () => {
    client.mode = "abort";
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const pending = service.run(session, "cancel", controller.signal, (event) =>
      events.push(event),
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (events.some((event) => event.type === "agent.delta")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await pending;

    const records = messageStore.list(session.id);
    expect(records[1]).toMatchObject({ status: "cancelled" });
    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(lock.isBusy(session.id)).toBe(false);
  });

  it("cancels when the run is cancelled server-side", async () => {
    client.mode = "abort";
    const events: AgentEvent[] = [];
    const pending = service.run(
      session,
      "cancel",
      new AbortController().signal,
      (event) => events.push(event),
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (events.some((event) => event.type === "agent.delta")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(lock.cancel(session.id)).toBe("agent");
    await pending;

    const records = messageStore.list(session.id);
    expect(records[1]).toMatchObject({ status: "cancelled" });
    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(lock.isBusy(session.id)).toBe(false);
  });

  it("runs read-only tool calls in parallel while preserving order", async () => {
    client.mode = "multi-read";
    tools.delayMs = 40;
    const events: AgentEvent[] = [];
    await service.run(session, "read files", new AbortController().signal, (event) =>
      events.push(event),
    );

    expect(tools.maxActive).toBeGreaterThan(1);
    expect(tools.executed.map((entry) => entry.args)).toEqual([
      '{"path":"a.txt"}',
      '{"path":"b.txt"}',
      '{"path":"c.txt"}',
    ]);

    const records = messageStore.list(session.id);
    expect(records.map((record) => record.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(records.slice(2, 5).map((record) => record.toolCallId)).toEqual([
      "call_r1",
      "call_r2",
      "call_r3",
    ]);

    const finished = events
      .filter(
        (event): event is Extract<AgentEvent, { type: "agent.tool.finished" }> =>
          event.type === "agent.tool.finished",
      )
      .map((event) => event.message.toolCallId);
    expect(finished).toEqual(["call_r1", "call_r2", "call_r3"]);
  });

  it("sends read_image tool results as text+image content parts", async () => {
    client.mode = "image";
    await service.run(session, "look at the screenshot", new AbortController().signal, () =>
      undefined,
    );

    const records = messageStore.list(session.id);
    expect(records.map((record) => record.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(records[2]).toMatchObject({
      toolName: "read_image",
      meta: { kind: "image", mime: "image/png" },
    });

    const toolMessage = client.calls[1]!.find((message) => message.role === "tool");
    expect(toolMessage?.content).toEqual([
      { type: "text", text: "Read image shot.png (image/png, 1x1, 70 bytes)." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("forwards approval events from tools", async () => {
    tools.emitApproval = true;
    const events: AgentEvent[] = [];
    await service.run(session, "approve", new AbortController().signal, (event) =>
      events.push(event),
    );

    const approval = events.find(
      (event) => event.type === "agent.approval_required",
    );
    expect(approval).toMatchObject({
      type: "agent.approval_required",
      approvalId: "a_fake",
      toolCallId: "call_1",
      requestedMode: "danger-full-access",
    });
  });
});
