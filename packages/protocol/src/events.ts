import type {
  AgentToolCall,
  ApprovalKind,
  ApprovalOutcome,
  ChatMessageRecord,
  ChatUsage,
  Enforcement,
  RunnerName,
  SandboxMode,
  Session,
} from "./types.js";

/** The event union pushed over the exec SSE stream. */
export type ExecEvent =
  | {
      type: "exec.queued";
      execId: string;
      command: string;
      cwd: string;
      mode: SandboxMode;
    }
  | {
      type: "approval.required";
      approvalId: string;
      execId: string;
      kind: ApprovalKind;
      command: string;
      path?: string;
      currentMode: SandboxMode;
      requestedMode: SandboxMode;
      justification: string;
      expiresAt: string;
    }
  | {
      type: "approval.decided";
      approvalId: string;
      outcome: ApprovalOutcome;
      reason: string;
    }
  | {
      type: "exec.started";
      execId: string;
      mode: SandboxMode;
      runner: RunnerName | "none";
      enforcement: Enforcement;
    }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | {
      type: "exec.denied";
      mode: SandboxMode;
      message: string;
      command: string;
      canEscalateTo: SandboxMode[];
    }
  | {
      type: "exec.exit";
      code: number | null;
      signal: string | null;
      durationMs: number;
      truncated: boolean;
      cancelled: boolean;
      timedOut: boolean;
      spillPaths: string[];
    }
  | { type: "exec.error"; code: string; message: string };

export type ExecEventType = ExecEvent["type"];

/** The event union pushed over the chat SSE stream. */
export type ChatEvent =
  | {
      type: "chat.started";
      userMessage: ChatMessageRecord;
      assistantMessage: ChatMessageRecord;
    }
  | { type: "chat.delta"; messageId: string; data: string }
  | { type: "chat.reasoning"; messageId: string; data: string }
  | { type: "chat.done"; message: ChatMessageRecord; usage?: ChatUsage }
  | { type: "chat.error"; messageId: string; code: string; message: string }
  /** The session was retitled (first-exchange summary); emitted when ready. */
  | { type: "session.updated"; session: Session };

/**
 * Agent mode events. Each model step gets an assistant message; tool calls
 * produce one persisted tool message each, executed sequentially.
 */
export type AgentEvent =
  | { type: "agent.started"; userMessage: ChatMessageRecord }
  | { type: "agent.step"; message: ChatMessageRecord }
  | { type: "agent.delta"; messageId: string; data: string }
  | { type: "agent.reasoning"; messageId: string; data: string }
  | { type: "agent.message"; message: ChatMessageRecord; usage?: ChatUsage }
  | { type: "agent.tool.started"; message: ChatMessageRecord; toolCall: AgentToolCall }
  | { type: "agent.tool.finished"; message: ChatMessageRecord }
  | {
      type: "agent.approval_required";
      approvalId: string;
      execId: string;
      toolCallId: string;
      command: string;
      currentMode: SandboxMode;
      requestedMode: SandboxMode;
      justification: string;
      expiresAt: string;
    }
  | {
      type: "agent.approval_decided";
      approvalId: string;
      outcome: ApprovalOutcome;
      reason: string;
    }
  | { type: "agent.done"; message: ChatMessageRecord }
  | { type: "agent.error"; code: string; message: string; messageId?: string }
  /** The session was retitled (first-exchange summary); emitted when ready. */
  | { type: "session.updated"; session: Session };

/** Mock chat only exists to exercise the streaming markdown renderer. */
export type MockChatEvent =
  | { type: "chunk"; data: string }
  | { type: "done" }
  | { type: "error"; message: string };
