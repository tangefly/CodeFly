import { AppError } from "../http/errors.js";

export type RunKind = "chat" | "agent" | "paper";

interface ActiveRun {
  kind: RunKind;
  controller: AbortController;
}

/**
 * One LLM turn (chat or agent loop) per session at a time. Both modes write
 * to the same persisted transcript, so they must not interleave.
 *
 * Acquiring also registers an abort controller for the run, so a client can
 * ask the server to stop the turn explicitly instead of relying only on the
 * SSE connection being closed. Aborting that controller cancels the
 * in-flight model request (and any running tool) right away.
 */
export class SessionRunLock {
  private readonly active = new Map<string, ActiveRun>();

  /** Marks the session busy and returns the run's cancel signal. */
  acquire(sessionId: string, kind: RunKind): AbortSignal {
    const current = this.active.get(sessionId);
    if (current !== undefined) {
      throw new AppError(
        "SESSION_BUSY",
        `当前会话正在执行 ${
          current.kind === "chat"
            ? "聊天"
            : current.kind === "paper"
              ? "论文助手"
              : "Agent"
        } 回合，请等待结束或先停止。`,
        409,
      );
    }
    const controller = new AbortController();
    this.active.set(sessionId, { kind, controller });
    return controller.signal;
  }

  release(sessionId: string): void {
    this.active.delete(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  kind(sessionId: string): RunKind | null {
    return this.active.get(sessionId)?.kind ?? null;
  }

  /** Aborts the active run, if any, and reports what was stopped. */
  cancel(sessionId: string): RunKind | null {
    const run = this.active.get(sessionId);
    if (run === undefined) return null;
    run.controller.abort();
    return run.kind;
  }
}
