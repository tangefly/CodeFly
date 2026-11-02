import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalOutcome,
  ApprovalPolicy,
  ApprovalRequest,
  SandboxMode,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";

export type ApprovalReason =
  | "allowed"
  | "denied"
  | "timeout"
  | "disconnected"
  | "cancelled"
  | "policy";

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  reason: ApprovalReason;
}

export interface ApprovalAskInput {
  kind: ApprovalKind;
  toolName: string;
  sessionId: string;
  execId: string;
  currentMode: SandboxMode;
  requestedMode: SandboxMode;
  command?: string;
  path?: string;
  justification: string;
}

export interface AskOptions {
  policy: ApprovalPolicy;
  timeoutMs: number;
  onAsked?: (request: ApprovalRequest) => void;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * One-shot approvals. There is deliberately no "always allow": long-lived
 * widening happens by changing the session preset, not by accumulating
 * exceptions here.
 */
export class ApprovalService {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly audit: AuditLog) {}

  ask(input: ApprovalAskInput, options: AskOptions): Promise<ApprovalResult> {
    if (options.policy === "never") {
      void this.audit.append({
        type: "approval.decided",
        sessionId: input.sessionId,
        execId: input.execId,
        approvalId: null,
        requestedMode: input.requestedMode,
        currentMode: input.currentMode,
        outcome: "rejected",
        reason: "policy",
      });
      return Promise.resolve({ outcome: "rejected", reason: "policy" });
    }

    const id = `a_${randomUUID()}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + options.timeoutMs);
    const request: ApprovalRequest = {
      id,
      kind: input.kind,
      toolName: input.toolName,
      sessionId: input.sessionId,
      execId: input.execId,
      currentMode: input.currentMode,
      requestedMode: input.requestedMode,
      command: input.command,
      path: input.path,
      justification: input.justification,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(
        () => this.finish(id, { outcome: "cancelled", reason: "timeout" }),
        options.timeoutMs,
      );
      timer.unref?.();

      this.pending.set(id, { request, resolve, timer });

      void this.audit.append({
        type: "approval.asked",
        sessionId: input.sessionId,
        execId: input.execId,
        approvalId: id,
        kind: input.kind,
        command: input.command,
        path: input.path,
        currentMode: input.currentMode,
        requestedMode: input.requestedMode,
        justification: input.justification,
      });

      options.onAsked?.(request);
    });
  }

  /** Returns false when the approval is unknown or already decided. */
  decide(id: string, decision: ApprovalDecision): boolean {
    if (!this.pending.has(id)) return false;
    if (decision === "allow_once") {
      this.finish(id, { outcome: "allowed-once", reason: "allowed" }, decision);
    } else {
      this.finish(id, { outcome: "rejected", reason: "denied" }, decision);
    }
    return true;
  }

  cancelForExec(execId: string, reason: "disconnected" | "cancelled"): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.execId === execId) {
        this.finish(id, { outcome: "cancelled", reason });
      }
    }
  }

  cancelAll(reason: "disconnected" | "cancelled"): void {
    for (const id of [...this.pending.keys()]) {
      this.finish(id, { outcome: "cancelled", reason });
    }
  }

  private finish(
    id: string,
    result: ApprovalResult,
    decision?: ApprovalDecision,
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    void this.audit.append({
      type: "approval.decided",
      sessionId: pending.request.sessionId,
      execId: pending.request.execId,
      approvalId: id,
      decision: decision ?? null,
      outcome: result.outcome,
      reason: result.reason,
    });

    pending.resolve(result);
  }
}
