import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "@codefly/protocol";
import { scheduleHistoryForModel } from "../src/schedule/service.js";

function record(
  id: string,
  role: ChatMessageRecord["role"],
  content: string,
  extra: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
  const now = new Date().toISOString();
  return {
    id,
    sessionId: "s_schedule",
    role,
    content,
    status: "complete",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

describe("scheduleHistoryForModel", () => {
  it("keeps plan dumps verbatim when under budget", () => {
    const records = [
      record("u1", "user", "看看这周安排"),
      record("a1", "assistant", "", {
        toolCalls: [
          { id: "c1", name: "plan_get", arguments: "{}" },
        ],
      }),
      record("t1", "tool", "计划 2026-11-16 ~ 2026-11-22 …", {
        toolCallId: "c1",
        toolName: "plan_get",
        meta: {
          kind: "schedule",
          rangeStart: "2026-11-16",
          rangeEnd: "2026-11-22",
        },
      }),
      record("a2", "assistant", "总结"),
    ];
    const messages = scheduleHistoryForModel(records, 10_000);
    const tool = messages.find((message) => message.role === "tool");
    expect(tool?.content).toBe("计划 2026-11-16 ~ 2026-11-22 …");
  });

  it("compacts older plan dumps once over budget", () => {
    const long = "x".repeat(10_000);
    const records = [
      record("u1", "user", "排一下这周"),
      record("a1", "assistant", "", {
        toolCalls: [
          { id: "c1", name: "plan_schedule", arguments: "{}" },
        ],
      }),
      record("t1", "tool", long, {
        toolCallId: "c1",
        toolName: "plan_schedule",
        meta: {
          kind: "schedule",
          rangeStart: "2026-11-16",
          rangeEnd: "2026-11-22",
        },
      }),
      record("a2", "assistant", "总结一"),
      record("u2", "user", "重排"),
      record("a3", "assistant", "", {
        toolCalls: [
          { id: "c2", name: "plan_replan", arguments: "{}" },
        ],
      }),
      record("t2", "tool", "最新计划", {
        toolCallId: "c2",
        toolName: "plan_replan",
        meta: {
          kind: "schedule",
          rangeStart: "2026-11-16",
          rangeEnd: "2026-11-22",
        },
      }),
      record("a4", "assistant", "总结二"),
    ];

    const messages = scheduleHistoryForModel(records, 2_000);
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(2);
    expect(String(tools[0]?.content)).toContain("omitted from model context");
    expect(String(tools[0]?.content)).toContain("plan_schedule");
    expect(String(tools[0]?.content)).toContain("2026-11-16~2026-11-22");
    expect(tools[1]?.content).toBe("最新计划");
  });

  it("keeps the two most recent dumps within a single long turn", () => {
    const long = "y".repeat(10_000);
    const records: ChatMessageRecord[] = [
      record("u1", "user", "连续排期"),
    ];
    for (let index = 0; index < 4; index += 1) {
      records.push(
        record(`a${index}`, "assistant", "", {
          toolCalls: [
            { id: `c${index}`, name: "plan_schedule", arguments: "{}" },
          ],
        }),
        record(`t${index}`, "tool", long, {
          toolCallId: `c${index}`,
          toolName: "plan_schedule",
        }),
      );
    }
    records.push(record("final", "assistant", "done"));

    const messages = scheduleHistoryForModel(records, 3_000);
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(4);
    const stubbed = tools.filter((message) =>
      String(message.content).includes("omitted from model context"),
    );
    expect(stubbed).toHaveLength(2);
    expect(tools[2]?.content).toBe(long);
    expect(tools[3]?.content).toBe(long);
  });

  it("never stubs the current turn's dumps", () => {
    const long = "z".repeat(10_000);
    const records = [
      record("u1", "user", "排期"),
      record("a1", "assistant", "", {
        toolCalls: [{ id: "c1", name: "plan_schedule", arguments: "{}" }],
      }),
      record("t1", "tool", long, {
        toolCallId: "c1",
        toolName: "plan_schedule",
      }),
      record("a2", "assistant", "已排"),
      record("u2", "user", "再看下当前计划"),
      record("a3", "assistant", "", {
        toolCalls: [{ id: "c2", name: "plan_get", arguments: "{}" }],
      }),
      record("t2", "tool", long, {
        toolCallId: "c2",
        toolName: "plan_get",
      }),
      record("a4", "assistant", "done"),
    ];

    const messages = scheduleHistoryForModel(records, 3_000);
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(2);
    // The prior turn's stale dump is stubbed; the current turn's stays.
    expect(String(tools[0]?.content)).toContain("omitted from model context");
    expect(tools[1]?.content).toBe(long);
  });
});
