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

/**
 * Chat sessions are plain model conversations and have no workspace; agent
 * sessions are bound to a workspace and can run tools inside it; paper
 * sessions are bound to the global paper library and can search/read papers;
 * schedule sessions are bound to the global schedule store.
 */
export type SessionKind = "chat" | "agent" | "paper" | "schedule";

interface SessionBase {
  id: string;
  title: string;
  /**
   * How the title was chosen. `default` titles are replaced with an
   * auto-generated summary once the first exchange exists.
   */
  titleSource?: "default" | "user" | "auto";
  mode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  createdAt: string;
  updatedAt: string;
  /** The most recent command whose stderr looked like a sandbox denial. */
  lastDenial: DenialRecord | null;
}

export interface ChatSession extends SessionBase {
  kind: "chat";
  /** Chat sessions never bind a workspace. */
  workspaceRoot: null;
}

export interface AgentSession extends SessionBase {
  kind: "agent";
  /** Canonical absolute path. Immutable after creation. */
  workspaceRoot: string;
}

export interface PaperSession extends SessionBase {
  kind: "paper";
  /** Paper sessions never bind a filesystem workspace. */
  workspaceRoot: null;
  /** Papers pinned to this conversation's working context. */
  paperIds: string[];
}

export interface ScheduleSession extends SessionBase {
  kind: "schedule";
  /** Schedule sessions never bind a filesystem workspace. */
  workspaceRoot: null;
}

export type Session = ChatSession | AgentSession | PaperSession | ScheduleSession;

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

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** One entry of the model-maintained task list (todo_write). */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** One question shown to the user by ask_user_question. */
export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  id: string;
  question: string;
  header?: string;
  options?: AgentQuestionOption[];
  multiSelect?: boolean;
}

/** The user's answer to one question. Empty selected + no custom means skipped. */
export interface AgentQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export type AgentQuestionOutcome = "answered" | "skipped" | "timeout" | "cancelled";

/** Structured display metadata for a persisted tool result. */
export interface AgentToolMeta {
  kind?:
    | "command"
    | "read"
    | "write"
    | "edit"
    | "patch"
    | "list"
    | "grep"
    | "glob"
    | "search"
    | "fetch"
    | "image"
    | "job"
    | "todo"
    | "question"
    | "arxiv"
    | "paper"
    | "library"
    | "schedule"
    | "preferences"
    | "memory"
    | "error";
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
  edits?: number;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  pattern?: string;
  matches?: number;
  query?: string;
  resultCount?: number;
  /** web_fetch: request URL, response status and media type. */
  url?: string;
  statusCode?: number;
  contentType?: string;
  /** read_image: decoded image facts plus an inline data URL for UI/model. */
  mime?: string;
  width?: number;
  height?: number;
  imageDataUrl?: string;
  /** Paper tools: paper/arXiv identifiers and reading metadata. */
  paperId?: string;
  arxivId?: string;
  paperTitle?: string;
  authors?: string[];
  publishedAt?: string | null;
  pageCount?: number;
  pageRange?: string;
  charCount?: number;
  tags?: string[];
  libraryStatus?: PaperReadStatus;
  /** Paper tools: structured result for UI cards (never sent to the model). */
  data?: unknown;
  truncated?: boolean;
  denied?: boolean;
  spillPaths?: string[];
  /** apply_patch / edit_file: unified diff and changed-file summary. */
  diff?: string;
  filesChanged?: number;
  /** Background execution (run_command run_in_background, job_* tools). */
  jobId?: string;
  running?: boolean;
  startedAt?: string;
  /** todo_write: the complete task list. */
  todos?: TodoItem[];
  /** ask_user_question: questions and the answers that came back. */
  questions?: AgentQuestion[];
  answers?: AgentQuestionAnswer[];
  questionOutcome?: AgentQuestionOutcome;
  /** Read version recorded for a file (mtimeMs:size) when it was read/edited. */
  fileVersion?: string;
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
  "apply_patch",
  "list_files",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "read_image",
  "job_output",
  "job_list",
  "job_kill",
  "write_stdin",
  "todo_write",
  "ask_user_question",
] as const;

/** Hard ceiling for Agent loop steps in a single run. */
export const AGENT_MAX_STEPS_LIMIT = 500;

/** Default Agent loop steps for a new install. */
export const DEFAULT_AGENT_MAX_STEPS = 500;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Tools available to paper sessions. Kept separate from AGENT_TOOL_NAMES. */
export const PAPER_TOOL_NAMES = [
  "arxiv_search",
  "arxiv_get",
  "paper_outline",
  "paper_read",
  "paper_search",
  "library_add",
  "library_search",
  "library_update",
  "library_export",
] as const;

export type PaperToolName = (typeof PAPER_TOOL_NAMES)[number];

export const PAPER_SOURCES = ["arxiv", "upload"] as const;
export type PaperSource = (typeof PAPER_SOURCES)[number];

export const PAPER_READ_STATUSES = ["unread", "reading", "read"] as const;
export type PaperReadStatus = (typeof PAPER_READ_STATUSES)[number];

export const PAPER_TEXT_STATUSES = [
  "none",
  "pending",
  "ready",
  "error",
] as const;
export type PaperTextStatus = (typeof PAPER_TEXT_STATUSES)[number];

/** Normalized arXiv metadata shared by the arxiv tools and the library. */
export interface ArxivPaper {
  arxivId: string;
  version: number | null;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  primaryCategory: string | null;
  publishedAt: string;
  updatedAt: string;
  pdfUrl: string;
  absUrl: string;
  comment: string | null;
  journalRef: string | null;
  doi: string | null;
}

/** One detected section of an extracted PDF. Pages are 1-based and inclusive. */
export interface PaperSection {
  title: string;
  startPage: number;
  endPage: number;
}

/** A paper stored in the global library. */
export interface PaperRecord {
  id: string;
  source: PaperSource;
  arxivId: string | null;
  version: number | null;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  primaryCategory: string | null;
  publishedAt: string | null;
  /** Last revision date reported by arXiv (distinct from modifiedAt). */
  arxivUpdatedAt: string | null;
  journalRef: string | null;
  doi: string | null;
  comment: string | null;
  pdfUrl: string | null;
  absUrl: string | null;
  addedAt: string;
  modifiedAt: string;
  lastReadAt: string | null;
  status: PaperReadStatus;
  starred: boolean;
  tags: string[];
  /** Reserved for a future collections UI. */
  collections: string[];
  /** User-authored notes. */
  notes: string;
  /** Model-authored structured notes. */
  summary: string;
  citationKey: string | null;
  textStatus: PaperTextStatus;
  pageCount: number | null;
  charCount: number | null;
  extractionError: string | null;
  /** SHA-256 of the PDF file, used to deduplicate uploads. */
  fileHash: string | null;
  fileName: string | null;
}

export interface PaperListResponse {
  papers: PaperRecord[];
  total: number;
}

export interface PaperQuery {
  query?: string;
  tags?: string[];
  status?: PaperReadStatus;
  starred?: boolean;
  collection?: string;
  arxivId?: string;
  sort?: "added" | "published" | "title" | "lastRead";
  limit?: number;
  offset?: number;
}

export interface PaperCreateInput {
  arxivId?: string;
  /** arXiv abs/pdf/html URL; the service extracts the identifier. */
  url?: string;
  tags?: string[];
  collections?: string[];
  status?: PaperReadStatus;
}

export interface PaperUpdateInput {
  title?: string;
  authors?: string[];
  abstract?: string;
  tags?: string[];
  collections?: string[];
  status?: PaperReadStatus;
  starred?: boolean;
  notes?: string;
  summary?: string;
  citationKey?: string | null;
}

export interface PaperUploadInput {
  title?: string;
  authors?: string[];
  tags?: string[];
  collections?: string[];
  status?: PaperReadStatus;
}

export interface PaperContextInput {
  add?: string[];
  remove?: string[];
  paperIds?: string[];
}

/** Structured outline returned by paper_outline. */
export interface PaperOutline {
  paperId: string;
  pageCount: number;
  charCount: number;
  sections: PaperSection[];
}

/** Tools available to schedule sessions. Kept separate from other modes. */
export const SCHEDULE_TOOL_NAMES = [
  "preferences_get",
  "preferences_update",
  "task_list",
  "task_upsert",
  "task_delete",
  "fixed_event_list",
  "fixed_event_upsert",
  "fixed_event_delete",
  "plan_get",
  "plan_schedule",
  "plan_replan",
  "block_update",
  "plan_render",
  "plan_email",
  "ask_user_question",
] as const;

export type ScheduleToolName = (typeof SCHEDULE_TOOL_NAMES)[number];

export const SCHEDULE_MEMORY_CATEGORIES = [
  "preference",
  "constraint",
  "routine",
  "goal",
  "context",
] as const;
export type ScheduleMemoryCategory =
  (typeof SCHEDULE_MEMORY_CATEGORIES)[number];

/**
 * Legacy persisted document shape. The schedule assistant now keeps only the
 * single `scheduling_preferences` document; other memories are migrated into
 * `SchedulePreferences.rules` on startup.
 */
export interface ScheduleMemory {
  id: string;
  /** Stable unique slug used for deterministic lookups. */
  key: string;
  category: ScheduleMemoryCategory;
  title: string;
  content: string;
  /** Optional structured fields, e.g. scheduling_preferences. */
  data: Record<string, unknown> | null;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export const SCHEDULE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type SchedulePriority = (typeof SCHEDULE_PRIORITIES)[number];

export const SCHEDULE_TASK_STATUSES = [
  "todo",
  "in_progress",
  "done",
  "cancelled",
] as const;
export type ScheduleTaskStatus = (typeof SCHEDULE_TASK_STATUSES)[number];

export const SCHEDULE_CONFIDENCE = ["low", "medium", "high"] as const;
export type ScheduleConfidence = (typeof SCHEDULE_CONFIDENCE)[number];

export const SCHEDULE_BLOCK_STATUSES = ["planned", "done", "skipped"] as const;
export type ScheduleBlockStatus = (typeof SCHEDULE_BLOCK_STATUSES)[number];

export const SCHEDULE_TIMES_OF_DAY = [
  "any",
  "morning",
  "afternoon",
  "evening",
] as const;
export type ScheduleTimeOfDay = (typeof SCHEDULE_TIMES_OF_DAY)[number];

export const SCHEDULE_FIXED_EVENT_KINDS = ["weekly", "once"] as const;
export type ScheduleFixedEventKind =
  (typeof SCHEDULE_FIXED_EVENT_KINDS)[number];

/**
 * A commitment that occupies wall-clock time every week (courses, meetings)
 * or on one specific day. Fixed events are not tasks: they need no estimate
 * and can form a valid weekly plan on their own. A non-busy event (busy
 * = false) keeps its slot in the plan while remaining schedulable time.
 */
export interface ScheduleFixedEvent {
  id: string;
  title: string;
  kind: ScheduleFixedEventKind;
  /** ISO weekday 1 (Monday) … 7 (Sunday); set when kind="weekly". */
  weekday: number | null;
  /** YYYY-MM-DD; set when kind="once". */
  date: string | null;
  /** Local wall-clock HH:mm. */
  start: string;
  end: string;
  location: string;
  note: string;
  /**
   * Whether the event truly occupies the user: busy events are carved out of
   * schedulable time; non-busy ones (a course the user attends but works
   * through) stay visible in the plan while tasks may be scheduled inside.
   */
  busy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleFixedEventInput {
  title?: string;
  kind?: ScheduleFixedEventKind;
  weekday?: number | null;
  date?: string | null;
  start?: string;
  end?: string;
  location?: string;
  note?: string;
  busy?: boolean;
}

/**
 * One ordered piece of a task's work. Steps are optional: simple tasks keep an
 * empty list and are scheduled as before. When present, the planner uses each
 * step as the note of the block(s) covering it.
 */
export interface ScheduleTaskStep {
  id: string;
  /** Short, concrete description, e.g. "精读 3 篇基线论文并整理对比表". */
  title: string;
  /** Planned minutes for this piece; usually close to one focus block. */
  minutes: number;
}

/** A unit of work the user wants to finish. Tasks are global across weeks. */
export interface ScheduleTask {
  id: string;
  title: string;
  notes: string;
  project: string | null;
  priority: SchedulePriority;
  status: ScheduleTaskStatus;
  estimatedMinutes: number;
  /** Unfinished work not yet performed; done blocks reduce it. */
  remainingMinutes: number;
  actualMinutes: number;
  estimateConfidence: ScheduleConfidence;
  /** YYYY-MM-DD, inclusive. */
  deadline: string | null;
  splittable: boolean;
  minBlockMinutes: number;
  preferredTimeOfDay: ScheduleTimeOfDay;
  /** Optional ordered breakdown of the work; empty when no decomposition needed. */
  steps: ScheduleTaskStep[];
  createdAt: string;
  updatedAt: string;
}

/** One scheduled piece of a task. Times are local wall-clock HH:mm. */
export interface ScheduleBlock {
  id: string;
  taskId: string;
  /** YYYY-MM-DD. */
  date: string;
  start: string;
  end: string;
  status: ScheduleBlockStatus;
  actualMinutes: number | null;
  note: string;
  /**
   * Step covered by this block when the task was decomposed. Undefined/null
   * for undecomposed tasks and for blocks created before steps existed.
   */
  stepId?: string | null;
}

export const SCHEDULE_PLAN_STATUSES = ["draft", "active", "archived"] as const;
export type SchedulePlanStatus = (typeof SCHEDULE_PLAN_STATUSES)[number];

/** One week's plan. Blocks reference global tasks by id. */
export interface SchedulePlan {
  id: string;
  /** Monday of the planned week, YYYY-MM-DD. */
  weekStart: string;
  weekEnd: string;
  timezone: string;
  status: SchedulePlanStatus;
  blocks: ScheduleBlock[];
  /** Work that did not fit when the plan was last generated. */
  unscheduled: ScheduleUnscheduledTask[];
  warnings: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleBreak {
  label: string;
  start: string;
  end: string;
}

/** Normalized scheduling preferences stored in the single preference document. */
export interface SchedulePreferences {
  timezone: string;
  /** ISO weekdays, Monday = 1 … Sunday = 7. */
  workdays: number[];
  workStart: string;
  workEnd: string;
  breaks: ScheduleBreak[];
  maxFocusMinutes: number;
  minBlockMinutes: number;
  /**
   * Extra time added to every estimate. 0 means the planner schedules exactly
   * the remaining minutes; there is no hidden confidence buffer.
   */
  bufferRatio: number;
  /** Wall-clock minutes left between adjacent blocks (0 = back-to-back). */
  gapMinutes: number;
  dailyFocusLimitMinutes: number;
  /** Free-form rules the planner cannot model structurally, one per entry. */
  rules: string[];
}

export interface ScheduleUnscheduledTask {
  taskId: string;
  title: string;
  remainingMinutes: number;
  reason: string;
}

/** How much of one task is actually placed in a planning window. */
export interface ScheduleTaskAllocation {
  taskId: string;
  title: string;
  estimatedMinutes: number;
  remainingMinutes: number;
  /** Non-skipped block minutes inside the window. */
  scheduledMinutes: number;
  blockCount: number;
}

export interface SchedulePlanSummary {
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
  planId: string | null;
  totalPlannedMinutes: number;
  taskCount: number;
  doneMinutes: number;
  unscheduled: ScheduleUnscheduledTask[];
  warnings: string[];
}

/**
 * A rolling planning window assembled from the stored per-ISO-week plans.
 * Blocks are always date-sorted. A window may contain zero blocks: a window
 * with only fixed commitments (courses, meetings) is still a valid plan.
 */
export interface ScheduleWindow {
  startDate: string;
  endDate: string;
  timezone: string;
  blocks: ScheduleBlock[];
  unscheduled: ScheduleUnscheduledTask[];
  warnings: string[];
  notes: string;
}

/**
 * A task block scheduled inside a non-busy fixed event's window. Carried on
 * the fixed item so every surface can render course and task side by side.
 */
export interface ScheduleAgendaParallelBlock {
  blockId: string;
  title: string;
  /** Local wall-clock HH:mm. */
  start: string;
  end: string;
  status: ScheduleBlockStatus;
  priority: SchedulePriority | null;
}

/** One chronological entry in a day agenda: a fixed event or a task block. */
export interface ScheduleAgendaItem {
  id: string;
  kind: "fixed" | "task";
  title: string;
  /** Local wall-clock HH:mm. */
  start: string;
  end: string;
  status: ScheduleBlockStatus;
  actualMinutes: number | null;
  priority: SchedulePriority | null;
  location: string;
  note: string;
  /** Whether a fixed event occupies the user; null on task items. */
  busy: boolean | null;
  /** Task blocks running inside this non-busy fixed event's window. */
  parallelBlocks?: ScheduleAgendaParallelBlock[];
}

export interface ScheduleAgendaDay {
  date: string;
  /** Localized weekday label, e.g. 周五. */
  weekday: string;
  items: ScheduleAgendaItem[];
  /** Fixed events plus non-skipped task blocks. */
  plannedMinutes: number;
  /** Free minutes inside working hours; null on non-working days. */
  freeMinutes: number | null;
}

/**
 * Day-by-day presentation model shared by the UI, tool cards and the PNG
 * renderer so all three surfaces stay consistent.
 */
export interface ScheduleAgendaModel {
  startDate: string;
  endDate: string;
  timezone: string;
  today: string;
  generatedAt: string;
  days: ScheduleAgendaDay[];
  summary: SchedulePlanSummary;
  unscheduled: ScheduleUnscheduledTask[];
  warnings: string[];
  notes: string;
}

/** GET /api/schedule/overview response and tool card payload. */
export interface ScheduleOverview {
  timezone: string;
  today: string;
  /** First day of the rolling window (inclusive). */
  rangeStart: string;
  /** Last day of the rolling window (inclusive). */
  rangeEnd: string;
  preferences: SchedulePreferences;
  preferencesConfigured: boolean;
  tasks: ScheduleTask[];
  fixedEvents: ScheduleFixedEvent[];
  window: ScheduleWindow | null;
  agenda: ScheduleAgendaModel;
  summary: SchedulePlanSummary;
  calibration: ScheduleCalibration;
}

/** Actual/estimate calibration derived from completed tasks. */
export interface ScheduleCalibration {
  completedTasks: number;
  /** Average actual / estimated ratio; null when no history exists. */
  ratio: number | null;
}

export interface ScheduleEmailSettingsPublic {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPassword: boolean;
  passwordHint: string | null;
  from: string;
  to: string;
  updatedAt: string | null;
}

export interface ScheduleEmailSettingsInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  clearPassword?: boolean;
  from: string;
  to: string;
}

export interface ScheduleEmailTestInput {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  clearPassword?: boolean;
  from?: string;
  to?: string;
}

export interface ScheduleEmailTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface ScheduleEmailSendResult {
  ok: boolean;
  message: string;
  to: string;
  messageId: string | null;
  imagePath: string;
}

/** One step accepted when creating or updating a task. */
export interface ScheduleTaskStepInput {
  id?: string;
  title: string;
  minutes: number;
}

export interface ScheduleTaskInput {
  title?: string;
  notes?: string;
  project?: string | null;
  priority?: SchedulePriority;
  status?: ScheduleTaskStatus;
  estimatedMinutes?: number;
  remainingMinutes?: number;
  actualMinutes?: number;
  estimateConfidence?: ScheduleConfidence;
  deadline?: string | null;
  splittable?: boolean;
  minBlockMinutes?: number;
  preferredTimeOfDay?: ScheduleTimeOfDay;
  /** Replaces the full step list. Empty array or null clears it. */
  steps?: ScheduleTaskStepInput[] | null;
}

export interface AgentSettingsPublic {
  maxSteps: number;
  commandTimeoutMs: number;
  enabledTools: AgentToolName[];
  /** Prepended to the harness-owned base prompt; empty when uncustomized. */
  personaPrefix: string;
  /** Appended after the base prompt and tool guidance; empty when uncustomized. */
  personaSuffix: string;
  updatedAt: string | null;
}

export interface AgentSettingsInput {
  maxSteps?: number;
  commandTimeoutMs?: number;
  enabledTools?: AgentToolName[];
  personaPrefix?: string;
  personaSuffix?: string;
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

/**
 * A saved model configuration. Profiles are keyed by Base URL + model, so
 * configuring another model keeps the previous one available for switching.
 */
export interface LlmProfilePublic {
  id: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  temperature: number | null;
  maxTokens: number | null;
  systemPrompt: string;
  timeoutMs: number;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  /** Whether this profile backs the configuration currently in use. */
  active: boolean;
  updatedAt: string;
}

export interface LlmSettingsPublic {
  configured: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  temperature: number | null;
  maxTokens: number | null;
  systemPrompt: string;
  /** Inactivity timeout in ms; 0 disables it. */
  timeoutMs: number;
  /** DeepSeek thinking mode. Enabled by default. */
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  /** Id of the saved profile backing the active configuration. */
  activeProfileId: string | null;
  /** Saved configurations, active first and newest first. */
  profiles: LlmProfilePublic[];
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
  /** Inactivity timeout in ms; 0 disables it. */
  timeoutMs?: number;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  /**
   * Saved profile the form was loaded from. When the submitted Base URL
   * matches it, an omitted API key falls back to that profile's key.
   */
  profileId?: string;
}

/** Input accepted by POST /api/llm/test; omitted fields fall back to saved config. */
export interface LlmTestInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  timeoutMs?: number;
  /** Saved profile the form was loaded from, for API-key inheritance. */
  profileId?: string;
}

export interface LlmTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  model: string;
}

/**
 * Web search provider settings. Stored separately from the model provider so
 * `web_search` can use a different vendor, key, or gateway.
 */
export interface SearchSettingsPublic {
  configured: boolean;
  baseUrl: string;
  /** Resolved POST endpoint, or null when no base URL is configured. */
  endpoint: string | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  timeoutMs: number;
  updatedAt: string | null;
}

/** Input accepted by PUT /api/search/settings. */
export interface SearchSettingsInput {
  /** Search service base URL. Empty string disables web_search. */
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
}

/** Input accepted by POST /api/search/test; omitted fields fall back to saved config. */
export interface SearchTestInput {
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
}

export interface SearchTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  resultCount: number;
}

export interface ChatHistoryResponse {
  messages: ChatMessageRecord[];
}

export type AuditType =
  | "session.created"
  | "session.deleted"
  | "session.titled"
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
  | "search.config.changed"
  | "llm.chat"
  | "agent.run"
  | "agent.tool"
  | "agent.question"
  | "agent.answer"
  | "paper.run"
  | "paper.added"
  | "paper.updated"
  | "paper.deleted"
  | "paper.extracted"
  | "paper.context.changed"
  | "schedule.run"
  | "schedule.preferences.changed"
  | "schedule.memory.changed"
  | "schedule.task.changed"
  | "schedule.fixed_event.changed"
  | "schedule.plan.changed"
  | "schedule.email.sent";

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
