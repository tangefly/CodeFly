import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "@codefly/protocol";
import { paperHistoryForModel } from "../src/paper/service.js";

function record(
  id: string,
  role: ChatMessageRecord["role"],
  content: string,
  extra: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
  const now = new Date().toISOString();
  return {
    id,
    sessionId: "s_paper",
    role,
    content,
    status: "complete",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

describe("paperHistoryForModel", () => {
  it("keeps the full text when under budget", () => {
    const records = [
      record("u1", "user", "read it"),
      record("a1", "assistant", "", {
        toolCalls: [
          { id: "c1", name: "paper_read", arguments: '{"paper_id":"p_1"}' },
        ],
      }),
      record("t1", "tool", "full paper text", {
        toolCallId: "c1",
        toolName: "paper_read",
        meta: { kind: "paper", paperId: "p_1", pageRange: "1-5" },
      }),
      record("a2", "assistant", "summary"),
    ];
    const messages = paperHistoryForModel(records, 10_000);
    const tool = messages.find((message) => message.role === "tool");
    expect(tool?.content).toBe("full paper text");
  });

  it("compacts older paper reads once over budget", () => {
    const long = "x".repeat(10_000);
    const records = [
      record("u1", "user", "read paper one"),
      record("a1", "assistant", "", {
        toolCalls: [
          { id: "c1", name: "paper_read", arguments: '{"paper_id":"p_1"}' },
        ],
      }),
      record("t1", "tool", long, {
        toolCallId: "c1",
        toolName: "paper_read",
        meta: {
          kind: "paper",
          paperId: "p_1",
          paperTitle: "Paper One",
          pageRange: "1-5",
        },
      }),
      record("a2", "assistant", "summary one"),
      record("u2", "user", "now paper two"),
      record("a3", "assistant", "", {
        toolCalls: [
          { id: "c2", name: "paper_read", arguments: '{"paper_id":"p_2"}' },
        ],
      }),
      record("t2", "tool", "recent text", {
        toolCallId: "c2",
        toolName: "paper_read",
        meta: { kind: "paper", paperId: "p_2", pageRange: "1-2" },
      }),
      record("a4", "assistant", "summary two"),
    ];

    const messages = paperHistoryForModel(records, 2_000);
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(2);
    expect(String(tools[0]?.content)).toContain("omitted from model context");
    expect(String(tools[0]?.content)).toContain("Paper One");
    expect(tools[1]?.content).toBe("recent text");
  });

  it("keeps the two most recent reads within a single long turn", () => {
    const long = "y".repeat(10_000);
    const records: ChatMessageRecord[] = [
      record("u1", "user", "read several papers"),
    ];
    for (let index = 0; index < 4; index += 1) {
      records.push(
        record(`a${index}`, "assistant", "", {
          toolCalls: [
            {
              id: `c${index}`,
              name: "paper_read",
              arguments: '{"paper_id":"p"}',
            },
          ],
        }),
        record(`t${index}`, "tool", long, {
          toolCallId: `c${index}`,
          toolName: "paper_read",
          meta: { kind: "paper", paperId: "p", pageRange: String(index + 1) },
        }),
      );
    }
    records.push(record("final", "assistant", "done"));

    const messages = paperHistoryForModel(records, 3_000);
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(4);
    const stubbed = tools.filter((message) =>
      String(message.content).includes("omitted from model context"),
    );
    expect(stubbed).toHaveLength(2);
    expect(tools[2]?.content).toBe(long);
    expect(tools[3]?.content).toBe(long);
  });
});
