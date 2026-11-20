import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentQuestion } from "@codefly/protocol";
import type { AuditLog } from "../src/audit/log.js";
import { QuestionService } from "../src/interaction/questions.js";

const audit = {
  append: async () => undefined,
  recent: async () => [],
} as unknown as AuditLog;

const questions: AgentQuestion[] = [
  {
    id: "q1",
    question: "Which mode?",
    options: [{ label: "fast" }, { label: "safe" }],
  },
];

describe("QuestionService", () => {
  it("blocks until the user answers and emits both events", async () => {
    const events: AgentEvent[] = [];
    const service = new QuestionService(audit, { timeoutMs: 1000 });
    const pending = service.ask({
      sessionId: "s_test",
      toolCallId: "c_test",
      messageId: "m_test",
      questions,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    const required = events[0];
    expect(required).toMatchObject({
      type: "agent.question_required",
      questions,
    });
    const questionId =
      required?.type === "agent.question_required" ? required.questionId : "";

    expect(
      service.answer(questionId, [{ id: "q1", selected: ["safe"] }]),
    ).toBe(true);
    const result = await pending;
    expect(result).toEqual({
      outcome: "answered",
      answers: [{ id: "q1", selected: ["safe"] }],
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent.question_answered",
      outcome: "answered",
    });
    expect(service.answer(questionId, [])).toBe(false);
  });

  it("returns a timeout outcome", async () => {
    const events: AgentEvent[] = [];
    const service = new QuestionService(audit, { timeoutMs: 20 });
    const result = await service.ask({
      sessionId: "s_test",
      toolCallId: "c_test",
      messageId: "m_test",
      questions,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });
    expect(result.outcome).toBe("timeout");
    expect(events.at(-1)).toMatchObject({
      type: "agent.question_answered",
      outcome: "timeout",
    });
  });

  it("returns a cancelled outcome when the turn aborts", async () => {
    const controller = new AbortController();
    const service = new QuestionService(audit, { timeoutMs: 1000 });
    const pending = service.ask({
      sessionId: "s_test",
      toolCallId: "c_test",
      messageId: "m_test",
      questions,
      signal: controller.signal,
      emit: () => undefined,
    });
    controller.abort();
    expect((await pending).outcome).toBe("cancelled");
  });
});
