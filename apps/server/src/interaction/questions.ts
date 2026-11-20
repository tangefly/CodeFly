import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionOutcome,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";

export interface QuestionAskInput {
  sessionId: string;
  toolCallId: string;
  messageId: string;
  questions: AgentQuestion[];
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}

export interface QuestionAskResult {
  answers: AgentQuestionAnswer[];
  outcome: "answered" | "skipped" | "timeout" | "cancelled";
}

export interface QuestionServiceOptions {
  timeoutMs: number;
}

interface PendingQuestion {
  id: string;
  sessionId: string;
  questions: AgentQuestion[];
  emit: (event: AgentEvent) => void;
  resolve: (result: QuestionAskResult) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  signal: AbortSignal;
}

/**
 * Blocking mid-turn questions. There is at most one pending set per tool
 * call; the UI answers through the HTTP route and the tool receives the
 * answers inline, so the model never has to end its turn to ask.
 */
export class QuestionService {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(
    private readonly audit: AuditLog,
    private readonly options: QuestionServiceOptions,
  ) {}

  ask(input: QuestionAskInput): Promise<QuestionAskResult> {
    if (input.signal.aborted) {
      return Promise.resolve({ answers: [], outcome: "cancelled" });
    }

    const id = `q_${randomUUID()}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.options.timeoutMs);

    return new Promise<QuestionAskResult>((resolve) => {
      const onAbort = (): void => {
        this.finish(id, [], "cancelled");
      };
      const timer = setTimeout(() => {
        this.finish(id, [], "timeout");
      }, this.options.timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        id,
        sessionId: input.sessionId,
        questions: input.questions,
        emit: input.emit,
        resolve,
        timer,
        onAbort,
        signal: input.signal,
      });
      input.signal.addEventListener("abort", onAbort, { once: true });

      void this.audit.append({
        type: "agent.question",
        sessionId: input.sessionId,
        questionId: id,
        toolCallId: input.toolCallId,
        questions: input.questions,
        expiresAt: expiresAt.toISOString(),
      });

      input.emit({
        type: "agent.question_required",
        questionId: id,
        toolCallId: input.toolCallId,
        messageId: input.messageId,
        questions: input.questions,
        expiresAt: expiresAt.toISOString(),
      });
    });
  }

  /** Returns false when the question is unknown or already settled. */
  answer(questionId: string, answers: AgentQuestionAnswer[]): boolean {
    if (!this.pending.has(questionId)) return false;
    const skipped = answers.every(
      (answer) =>
        answer.selected.length === 0 && (answer.custom ?? "").trim() === "",
    );
    this.finish(questionId, answers, skipped ? "skipped" : "answered");
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) {
        this.finish(pending.id, [], "cancelled");
      }
    }
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.finish(id, [], "cancelled");
    }
  }

  private finish(
    id: string,
    answers: AgentQuestionAnswer[],
    outcome: AgentQuestionOutcome,
  ): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.onAbort);

    void this.audit.append({
      type: "agent.answer",
      sessionId: pending.sessionId,
      questionId: id,
      outcome,
      answers,
    });

    pending.emit({
      type: "agent.question_answered",
      questionId: id,
      answers,
      outcome,
    });
    pending.resolve({
      answers,
      outcome,
    });
  }
}
