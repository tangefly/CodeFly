import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SCHEDULE_TOOL_NAMES,
  type AgentEvent,
  type AuditEvent,
  type ScheduleSession,
} from "@codefly/protocol";
import type { AuditLog } from "../src/audit/log.js";
import type {
  LlmChatMessage,
  LlmClientLike,
  LlmCompleteResult,
  LlmStreamResult,
  LlmToolDefinition,
  StreamChatOptions,
} from "../src/llm/client.js";
import {
  LlmConfigStore,
  type LlmInternalConfig,
} from "../src/llm/config-store.js";
import { MessageStore } from "../src/llm/messages.js";
import { SessionRunLock } from "../src/llm/run-lock.js";
import { SessionStore } from "../src/session/store.js";
import { ScheduleService } from "../src/schedule/service.js";
import { ScheduleStore } from "../src/schedule/store.js";
import { ScheduleToolExecutor } from "../src/schedule/tools.js";

class FakeScheduleClient implements LlmClientLike {
  calls: LlmChatMessage[][] = [];
  toolSets: LlmToolDefinition[][] = [];
  private count = 0;

  async streamChat(
    _config: LlmInternalConfig,
    messages: LlmChatMessage[],
    onDelta: (text: string) => void,
    _signal: AbortSignal,
    options?: StreamChatOptions,
  ): Promise<LlmStreamResult> {
    this.calls.push(messages);
    this.toolSets.push(options?.tools ?? []);
    if (this.count === 0) {
      this.count += 1;
      onDelta("adding");
      return {
        content: "adding",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_1",
            name: "task_upsert",
            arguments: JSON.stringify({
              title: "写论文初稿",
              estimated_minutes: 120,
              estimate_confidence: "high",
              priority: "high",
            }),
          },
        ],
      };
    }
    onDelta("done");
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }

  async complete(): Promise<LlmCompleteResult> {
    return { content: "OK", latencyMs: 1, model: "test-model" };
  }
}

function fakeAudit(events: AuditEvent[]): AuditLog {
  return {
    append: async (event: AuditEvent) => {
      events.push({ ...event, ts: new Date().toISOString() });
    },
    recent: async () => [],
  } as unknown as AuditLog;
}

describe("ScheduleService", () => {
  let dir: string;
  let store: ScheduleStore;
  let sessions: SessionStore;
  let messages: MessageStore;
  let service: ScheduleService;
  let client: FakeScheduleClient;
  let session: ScheduleSession;
  let auditEvents: AuditEvent[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-schedule-service-"));
    store = new ScheduleStore(dir);
    await store.init();
    await store.upsertMemory({
      key: "scheduling_preferences",
      category: "preference",
      title: "排期偏好",
      data: {
        timezone: "Asia/Shanghai",
        workdays: [1, 2, 3, 4, 5],
        workStart: "09:00",
        workEnd: "18:00",
      },
    });

    sessions = new SessionStore(path.join(dir, "sessions.json"));
    await sessions.init();
    session = (await sessions.create(
      undefined,
      "schedule test",
      "read-only",
      "schedule",
    )) as ScheduleSession;

    const llmConfig = new LlmConfigStore(path.join(dir, "llm.json"));
    await llmConfig.init();
    await llmConfig.update({
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "key",
    });
    messages = new MessageStore(path.join(dir, "messages.json"));
    await messages.init();
    client = new FakeScheduleClient();
    auditEvents = [];
    const tools = new ScheduleToolExecutor({
      store,
      audit: fakeAudit(auditEvents),
      email: { sendPlan: async () => ({ to: "me@example.com", messageId: null }) } as never,
    });

    service = new ScheduleService({
      messages,
      llmConfig,
      audit: fakeAudit(auditEvents),
      client,
      lock: new SessionRunLock(),
      sessions,
      store,
      email: { isConfigured: () => false } as never,
      tools,
      questions: {
        ask: async () => ({ answers: [], outcome: "skipped" as const }),
      },
      maxSteps: 10,
      historyBudgetChars: 60_000,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the tool loop and injects a schedule runtime context", async () => {
    await store.createFixedEvent({
      title: "线上会议 A",
      kind: "weekly",
      weekday: 1,
      start: "16:00",
      end: "17:30",
    });
    const events: AgentEvent[] = [];
    await service.run(
      session,
      "帮我添加一个写论文的任务",
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(events.map((event) => event.type)).toContain("agent.tool.finished");
    expect(events.at(-1)).toMatchObject({ type: "agent.done" });
    expect(client.calls).toHaveLength(2);

    const context = client.calls[0]!.find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("<runtime_context>"),
    );
    expect(context).toBeDefined();
    const contextText =
      typeof context?.content === "string" ? context.content : "";
    expect(contextText).toContain("Scheduling preferences: configured");
    expect(contextText).toContain("breaks 午休12:00-13:00");
    expect(contextText).toContain("Rolling window (today → +6 days):");
    expect(contextText).toContain("Fixed events (1 total · 1 weekly · 0 one-off)");
    expect(contextText).toContain("周一 16:00-17:30 线上会议 A");
    expect(contextText).toContain("Active tasks: 0");
    expect(contextText).toContain("This window's plan:");
    expect(contextText).toContain("Scheduling rules (0): none");
    expect(contextText).toContain("Email: not configured");

    const toolNames = client.toolSets[0]!.map((tool) => tool.function.name).sort();
    expect(toolNames).toEqual([...SCHEDULE_TOOL_NAMES].sort());

    const tasks = store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("写论文初稿");
    expect(messages.list(session.id)).toHaveLength(4);
    expect(auditEvents.some((event) => event.type === "schedule.run")).toBe(true);
    expect(auditEvents.some((event) => event.type === "schedule.task.changed")).toBe(
      true,
    );
  });
});
