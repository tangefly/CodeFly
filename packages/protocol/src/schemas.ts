import { z } from "zod";
import {
  AGENT_MAX_STEPS_LIMIT,
  AGENT_TOOL_NAMES,
  APPROVAL_POLICIES,
  PAPER_READ_STATUSES,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  SCHEDULE_CONFIDENCE,
  SCHEDULE_FIXED_EVENT_KINDS,
  SCHEDULE_PRIORITIES,
  SCHEDULE_TASK_STATUSES,
  SCHEDULE_TIMES_OF_DAY,
} from "./types.js";

export const sandboxModeSchema = z.enum(SANDBOX_MODES);

export const approvalPolicySchema = z.enum(APPROVAL_POLICIES);

export const sessionKindSchema = z.enum(["chat", "agent", "paper", "schedule"]);

export const createSessionSchema = z
  .object({
    /** Defaults to `agent` so older clients keep their previous behavior. */
    kind: sessionKindSchema.optional(),
    workspaceRoot: z.string().trim().min(1).max(4096).optional(),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => (value.kind ?? "agent") !== "agent" || value.workspaceRoot !== undefined, {
    path: ["workspaceRoot"],
    message: "workspaceRoot is required for agent sessions",
  })
  .refine((value) => (value.kind ?? "agent") === "agent" || value.workspaceRoot === undefined, {
    path: ["workspaceRoot"],
    message: "non-agent sessions do not take a workspaceRoot",
  });

const paperTagsSchema = z.array(z.string().trim().min(1).max(64)).max(64).optional();
const paperCollectionsSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(64)
  .optional();

export const paperCreateSchema = z
  .object({
    arxivId: z.string().trim().min(1).max(200).optional(),
    url: z.string().trim().min(1).max(4096).optional(),
    tags: paperTagsSchema,
    collections: paperCollectionsSchema,
    status: z.enum(PAPER_READ_STATUSES).optional(),
  })
  .refine((value) => value.arxivId !== undefined || value.url !== undefined, {
    path: ["arxivId"],
    message: "provide an arXiv id or URL",
  });

export const paperUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    authors: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    abstract: z.string().max(50_000).optional(),
    tags: paperTagsSchema,
    collections: paperCollectionsSchema,
    status: z.enum(PAPER_READ_STATUSES).optional(),
    starred: z.boolean().optional(),
    notes: z.string().max(200_000).optional(),
    summary: z.string().max(200_000).optional(),
    citationKey: z.string().trim().max(200).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "no fields to update",
  });

export const paperQuerySchema = z.object({
  query: z.string().trim().max(2000).optional(),
  tags: z.string().trim().max(2000).optional(),
  status: z.enum(PAPER_READ_STATUSES).optional(),
  starred: z.enum(["true", "false"]).optional(),
  collection: z.string().trim().max(64).optional(),
  arxivId: z.string().trim().max(200).optional(),
  sort: z.enum(["added", "published", "title", "lastRead"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const paperContextSchema = z
  .object({
    add: z.array(z.string().min(1).max(200)).max(200).optional(),
    remove: z.array(z.string().min(1).max(200)).max(200).optional(),
    paperIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .refine(
    (value) =>
      value.paperIds !== undefined ||
      (value.add?.length ?? 0) > 0 ||
      (value.remove?.length ?? 0) > 0,
    { message: "provide paperIds, add or remove" },
  );

export const paperExportQuerySchema = z.object({
  format: z.enum(["bibtex", "markdown"]).optional(),
  ids: z.string().trim().max(20_000).optional(),
  collection: z.string().trim().max(64).optional(),
});

export const permissionsSchema = z.object({
  mode: sandboxModeSchema,
  approvalPolicy: approvalPolicySchema.optional(),
  /** Required by the server before enabling danger-full-access. */
  confirmRisk: z.boolean().optional(),
});

export const execSchema = z.object({
  command: z.string().min(1).max(100_000),
  cwd: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  /** Only valid as a one-shot retry after a sandbox denial of the same command. */
  sandboxPermissions: sandboxModeSchema.optional(),
  justification: z.string().trim().min(1).max(2000).optional(),
  /** Return immediately with a job id instead of waiting for exit. */
  runInBackground: z.boolean().optional(),
  /** Keep a timed-out foreground command running as a job (default true). */
  promoteOnTimeout: z.boolean().optional(),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["allow_once", "deny"]),
  approvalId: z.string().min(1).max(200).optional(),
});

export const agentQuestionAnswerSchema = z.object({
  answers: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        selected: z.array(z.string().max(500)).max(50),
        custom: z.string().max(10_000).optional(),
      }),
    )
    .max(50),
});

export const fsPathQuerySchema = z.object({
  path: z.string().max(4096).optional(),
});

export const fsWriteSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string(),
});

export const fsEditSchema = z.object({
  path: z.string().min(1).max(4096),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const mockChatSchema = z.object({
  message: z.string().min(1).max(8000),
});

export const chatSchema = z.object({
  message: z.string().trim().min(1).max(50_000),
});

export const llmSettingsUpdateSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().max(8192).optional(),
  clearApiKey: z.boolean().optional(),
  model: z.string().trim().min(1).max(200),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(1).max(131_072).nullable().optional(),
  systemPrompt: z.string().max(20_000).optional(),
  /** Inactivity timeout: 0 disables it. */
  timeoutMs: z.number().int().min(0).max(600_000).optional(),
  thinking: z.boolean().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  /** Saved profile the form was loaded from, for API-key inheritance. */
  profileId: z.string().trim().min(1).max(200).optional(),
});

export const llmTestSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  apiKey: z.string().max(8192).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(1).max(131_072).nullable().optional(),
  timeoutMs: z.number().int().min(0).max(600_000).optional(),
  /** Saved profile the form was loaded from, for API-key inheritance. */
  profileId: z.string().trim().min(1).max(200).optional(),
});

export const searchSettingsUpdateSchema = z.object({
  /** Empty string disables web_search and clears the derived endpoint. */
  baseUrl: z.string().trim().max(2048),
  apiKey: z.string().max(8192).optional(),
  clearApiKey: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

export const searchTestSchema = z.object({
  baseUrl: z.string().trim().max(2048).optional(),
  apiKey: z.string().max(8192).optional(),
  clearApiKey: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

export const agentSettingsUpdateSchema = z.object({
  maxSteps: z.number().int().min(1).max(AGENT_MAX_STEPS_LIMIT).optional(),
  commandTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
  enabledTools: z
    .array(z.enum(AGENT_TOOL_NAMES))
    .max(AGENT_TOOL_NAMES.length)
    .optional(),
  personaPrefix: z.string().max(20_000).optional(),
  personaSuffix: z.string().max(20_000).optional(),
});

export const updateSettingsSchema = z.object({
  defaultPreset: sandboxModeSchema,
});

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const clockSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm");

const scheduleBreakSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  start: clockSchema,
  end: clockSchema,
});

export const schedulePreferencesUpdateSchema = z
  .object({
    timezone: z.string().trim().min(1).max(100).optional(),
    workdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    workStart: clockSchema.optional(),
    workEnd: clockSchema.optional(),
    breaks: z.array(scheduleBreakSchema).max(12).optional(),
    maxFocusMinutes: z.number().int().min(15).max(480).optional(),
    minBlockMinutes: z.number().int().min(5).max(600).optional(),
    bufferRatio: z.number().min(0).max(1).optional(),
    gapMinutes: z.number().int().min(0).max(60).optional(),
    dailyFocusLimitMinutes: z.number().int().min(30).max(1440).optional(),
    rules: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "no fields to update",
  });

/** Arguments accepted by the assistant's preferences_update tool. */
export const schedulePreferencesPatchSchema = schedulePreferencesUpdateSchema
  .extend({
    add_rules: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
    remove_rules: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  })
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) => key !== "add_rules" && key !== "remove_rules",
      ) ||
      value.add_rules !== undefined ||
      value.remove_rules !== undefined,
    { message: "no fields to update" },
  );

export type SchedulePreferencesUpdateInput = z.infer<
  typeof schedulePreferencesUpdateSchema
>;
export type SchedulePreferencesPatchInput = z.infer<
  typeof schedulePreferencesPatchSchema
>;

export const scheduleTaskStepInputSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200),
  minutes: z.number().int().min(5).max(600),
});

export const scheduleTaskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().max(100_000).optional(),
    project: z.string().trim().max(120).nullable().optional(),
    priority: z.enum(SCHEDULE_PRIORITIES).optional(),
    status: z.enum(SCHEDULE_TASK_STATUSES).optional(),
    estimatedMinutes: z.number().int().min(1).max(100_000).optional(),
    remainingMinutes: z.number().int().min(0).max(100_000).optional(),
    actualMinutes: z.number().int().min(0).max(1_000_000).optional(),
    estimateConfidence: z.enum(SCHEDULE_CONFIDENCE).optional(),
    deadline: dateSchema.nullable().optional(),
    splittable: z.boolean().optional(),
    minBlockMinutes: z.number().int().min(5).max(600).optional(),
    preferredTimeOfDay: z.enum(SCHEDULE_TIMES_OF_DAY).optional(),
    steps: z.array(scheduleTaskStepInputSchema).max(100).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "no fields to update",
  });

const weekdaySchema = z.number().int().min(1).max(7);

export const scheduleFixedEventCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    kind: z.enum(SCHEDULE_FIXED_EVENT_KINDS),
    weekday: weekdaySchema.nullable().optional(),
    date: dateSchema.nullable().optional(),
    start: clockSchema,
    end: clockSchema,
    location: z.string().trim().max(120).optional(),
    note: z.string().max(10_000).optional(),
    busy: z.boolean().optional(),
  })
  .refine((value) => value.kind === "weekly" || value.date !== undefined, {
    path: ["date"],
    message: 'kind="once" requires a date',
  })
  .refine((value) => value.kind === "once" || value.weekday !== undefined, {
    path: ["weekday"],
    message: 'kind="weekly" requires a weekday (1=Monday … 7=Sunday)',
  })
  .refine((value) => value.end > value.start, {
    path: ["end"],
    message: "end must be after start",
  });

export const scheduleFixedEventUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    kind: z.enum(SCHEDULE_FIXED_EVENT_KINDS).optional(),
    weekday: weekdaySchema.nullable().optional(),
    date: dateSchema.nullable().optional(),
    start: clockSchema.optional(),
    end: clockSchema.optional(),
    location: z.string().trim().max(120).optional(),
    note: z.string().max(10_000).optional(),
    busy: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "no fields to update",
  });

export const scheduleOverviewQuerySchema = z.object({
  start_date: dateSchema.optional(),
});

export const scheduleEmailSettingsSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  secure: z.boolean(),
  user: z.string().trim().max(255),
  password: z.string().max(8192).optional(),
  clearPassword: z.boolean().optional(),
  from: z.string().trim().email().max(320),
  to: z.string().trim().email().max(320),
});

export const scheduleEmailTestSchema = z.object({
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  secure: z.boolean().optional(),
  user: z.string().trim().max(255).optional(),
  password: z.string().max(8192).optional(),
  clearPassword: z.boolean().optional(),
  from: z.string().trim().email().max(320).optional(),
  to: z.string().trim().email().max(320).optional(),
});

export const scheduleEmailSendSchema = z.object({
  start_date: dateSchema.optional(),
  days: z.number().int().min(1).max(21).optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type PermissionsInput = z.infer<typeof permissionsSchema>;
export type ExecInput = z.infer<typeof execSchema>;
export type FsWriteInput = z.infer<typeof fsWriteSchema>;
export type FsEditInput = z.infer<typeof fsEditSchema>;
export type ChatInput = z.infer<typeof chatSchema>;
export type LlmSettingsUpdateInput = z.infer<typeof llmSettingsUpdateSchema>;
export type LlmTestInputSchema = z.infer<typeof llmTestSchema>;
export type PaperCreateInputSchema = z.infer<typeof paperCreateSchema>;
export type PaperUpdateInputSchema = z.infer<typeof paperUpdateSchema>;
export type PaperQueryInput = z.infer<typeof paperQuerySchema>;
export type PaperContextInputSchema = z.infer<typeof paperContextSchema>;
export type ScheduleTaskUpdateInput = z.infer<typeof scheduleTaskUpdateSchema>;
export type ScheduleFixedEventCreateInput = z.infer<
  typeof scheduleFixedEventCreateSchema
>;
export type ScheduleFixedEventUpdateInput = z.infer<
  typeof scheduleFixedEventUpdateSchema
>;
export type ScheduleEmailSettingsInputSchema = z.infer<
  typeof scheduleEmailSettingsSchema
>;
