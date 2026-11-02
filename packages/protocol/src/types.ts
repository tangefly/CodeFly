/** The three sandbox file-effect modes. */
export const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const APPROVAL_POLICIES = ["ask", "never"] as const;

export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** How completely the active sandbox enforces the mode's promises. */
export type Enforcement = "full" | "partial";

export type RunnerName = "bwrap" | "landlock";

export type SandboxProbe = "full" | "partial" | "unusable";

export interface Session {
  id: string;
  title: string;
  /** Canonical absolute path. Immutable after creation. */
  workspaceRoot: string;
  mode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  createdAt: string;
  updatedAt: string;
  /** The most recent command whose stderr looked like a sandbox denial. */
  lastDenial: DenialRecord | null;
}

export interface DenialRecord {
  command: string;
  mode: SandboxMode;
  at: string;
}

export interface Settings {
  /** Sandbox mode used for newly created sessions. */
  defaultPreset: SandboxMode;
}

export interface SandboxStatus {
  available: boolean;
  runner: RunnerName | null;
  probe: SandboxProbe;
  enforcement: Enforcement | null;
  platform: string;
  details: string;
}

export type ApprovalKind = "exec" | "fs";

export type ApprovalOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  toolName: string;
  sessionId: string;
  execId: string;
  currentMode: SandboxMode;
  requestedMode: SandboxMode;
  command?: string;
  path?: string;
  justification: string;
  createdAt: string;
  expiresAt: string;
}

export type ApprovalDecision = "allow_once" | "deny";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessageStatus = "complete" | "streaming" | "error" | "cancelled";

/** Tool calls emitted by the model for an assistant message. */
export interface AgentToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as emitted by the provider. */
  arguments: string;
}

/** Structured display metadata for a persisted tool result. */
export interface AgentToolMeta {
  kind?: "command" | "read" | "write" | "edit" | "list" | "error";
  command?: string;
  cwd?: string;
  path?: string;
  operation?: string;
  exitCode?: number | null;
  durationMs?: number;
  mode?: SandboxMode;
  stdout?: string;
  stderr?: string;
  bytes?: number;
  replacements?: number;
  truncated?: boolean;
  denied?: boolean;
  spillPaths?: string[];
  [key: string]: unknown;
}

/** A persisted chat/agent message. Tool-call records reuse this shape. */
export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  error?: string;
  model?: string;
  /** Assistant messages: token usage reported by the provider. */
  usage?: ChatUsage;
  /** Assistant messages: milliseconds from request start to stream end. */
  durationMs?: number;
  /** Assistant messages: milliseconds from request start to first visible delta. */
  firstTokenMs?: number;
  /** Assistant messages: streamed reasoning/thinking text, when the provider returns it. */
  reasoning?: string;
  /** Assistant messages: tool calls requested by the model. */
  toolCalls?: AgentToolCall[];
  /** Tool messages: which assistant tool call this result answers. */
  toolCallId?: string;
  toolName?: string;
  /** Tool messages: raw JSON arguments of the call. */
  toolArguments?: string;
  /** Tool messages: structured display metadata. */
  meta?: AgentToolMeta;
  createdAt: string;
  updatedAt: string;
}

export const AGENT_TOOL_NAMES = [
  "run_command",
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
] as const;

/** Hard ceiling for Agent loop steps in a single run. */
export const AGENT_MAX_STEPS_LIMIT = 500;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentSettingsPublic {
  maxSteps: number;
  commandTimeoutMs: number;
  enabledTools: AgentToolName[];
  systemPrompt: string;
  updatedAt: string | null;
}

export interface AgentSettingsInput {
  maxSteps?: number;
  commandTimeoutMs?: number;
  enabledTools?: AgentToolName[];
  systemPrompt?: string;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Prompt tokens served from a provider cache, when reported. */
  cachedTokens?: number;
  /** Reasoning tokens, included in completionTokens when reported. */
  reasoningTokens?: number;
}

export const REASONING_EFFORTS = ["low", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface LlmSettingsPublic {
  configured: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  temperature: number | null;
  maxTokens: number | null;
  systemPrompt: string;
  timeoutMs: number;
  /** DeepSeek thinking mode. Enabled by default. */
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  updatedAt: string | null;
}

/** Input accepted by PUT /api/llm/settings. */
export interface LlmSettingsInput {
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model: string;
  temperature?: number | null;
  maxTokens?: number | null;
  systemPrompt?: string;
  timeoutMs?: number;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
}

/** Input accepted by POST /api/llm/test; omitted fields fall back to saved config. */
export interface LlmTestInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  timeoutMs?: number;
}

export interface LlmTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  model: string;
}

export interface ChatHistoryResponse {
  messages: ChatMessageRecord[];
}

export type AuditType =
  | "session.created"
  | "session.deleted"
  | "permission.changed"
  | "settings.changed"
  | "exec.started"
  | "exec.denied"
  | "exec.exit"
  | "approval.asked"
  | "approval.decided"
  | "fs.write"
  | "sandbox.unavailable"
  | "llm.config.changed"
  | "llm.chat"
  | "agent.run"
  | "agent.tool";

export interface AuditEvent {
  ts: string;
  type: AuditType;
  sessionId?: string;
  [key: string]: unknown;
}

export interface SessionListResponse {
  sessions: Session[];
}

export interface WorkspaceBrowseEntry {
  name: string;
  path: string;
}

/** GET /api/fs/browse: subdirectories for the new-session workspace picker. */
export interface WorkspaceBrowseResponse {
  /** Absolute, resolved path that was listed. */
  path: string;
  /** Parent directory, or null at the filesystem root. */
  parent: string | null;
  /** The server user's home directory, used as the picker's home shortcut. */
  home: string;
  /** Visible subdirectories, sorted by name. */
  entries: WorkspaceBrowseEntry[];
}

export interface CreateSessionResponse {
  session: Session;
}

export interface ExecAcceptedResponse {
  execId: string;
  status: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeMs: number;
  sandbox: SandboxStatus;
  dev: boolean;
}
