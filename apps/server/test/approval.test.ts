import { describe, expect, it } from "vitest";
import { ApprovalService } from "../src/approval/service.js";
import type { AuditLog } from "../src/audit/log.js";

const audit = {
  append: async () => undefined,
  recent: async () => [],
} as unknown as AuditLog;

const input = {
  kind: "exec" as const,
  toolName: "bash",
  sessionId: "s_test",
  execId: "e_test",
  currentMode: "workspace-write" as const,
  requestedMode: "danger-full-access" as const,
  command: "touch ~/x",
  justification: "test",
};

describe("ApprovalService", () => {
  it("rejects without asking when policy is never", async () => {
    const service = new ApprovalService(audit);
    let asked = false;
    const result = await service.ask(input, {
      policy: "never",
      timeoutMs: 1000,
      onAsked: () => {
        asked = true;
      },
    });
    expect(result).toEqual({ outcome: "rejected", reason: "policy" });
    expect(asked).toBe(false);
  });

  it("resolves allowed-once and exposes the request", async () => {
    const service = new ApprovalService(audit);
    let requestId = "";
    const pending = service.ask(input, {
      policy: "ask",
      timeoutMs: 5000,
      onAsked: (request) => {
        requestId = request.id;
        expect(request.requestedMode).toBe("danger-full-access");
        expect(Date.parse(request.expiresAt)).toBeGreaterThan(Date.now());
      },
    });

    expect(service.decide(requestId, "allow_once")).toBe(true);
    await expect(pending).resolves.toEqual({
      outcome: "allowed-once",
      reason: "allowed",
    });
    expect(service.decide(requestId, "allow_once")).toBe(false);
  });

  it("resolves rejected on deny", async () => {
    const service = new ApprovalService(audit);
    let requestId = "";
    const pending = service.ask(input, {
      policy: "ask",
      timeoutMs: 5000,
      onAsked: (request) => {
        requestId = request.id;
      },
    });
    service.decide(requestId, "deny");
    await expect(pending).resolves.toEqual({
      outcome: "rejected",
      reason: "denied",
    });
  });

  it("times out as cancelled", async () => {
    const service = new ApprovalService(audit);
    const result = await service.ask(input, { policy: "ask", timeoutMs: 20 });
    expect(result).toEqual({ outcome: "cancelled", reason: "timeout" });
  });

  it("cancels pending approvals for one exec", async () => {
    const service = new ApprovalService(audit);
    const pending = service.ask(input, { policy: "ask", timeoutMs: 5000 });
    service.cancelForExec("e_test", "disconnected");
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      reason: "disconnected",
    });
  });
});
