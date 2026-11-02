import { AppError } from "../http/errors.js";

export type RunKind = "chat" | "agent";

/**
 * One LLM turn (chat or agent loop) per session at a time. Both modes write
 * to the same persisted transcript, so they must not interleave.
 */
export class SessionRunLock {
  private readonly active = new Map<string, RunKind>();

  acquire(sessionId: string, kind: RunKind): void {
    const current = this.active.get(sessionId);
    if (current !== undefined) {
      throw new AppError(
        "SESSION_BUSY",
        `当前会话正在执行 ${current === "chat" ? "聊天" : "Agent"} 回合，请等待结束或先停止。`,
        409,
      );
    }
    this.active.set(sessionId, kind);
  }

  release(sessionId: string): void {
    this.active.delete(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  kind(sessionId: string): RunKind | null {
    return this.active.get(sessionId) ?? null;
  }
}
