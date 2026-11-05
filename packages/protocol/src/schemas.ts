import { z } from "zod";
import {
  AGENT_MAX_STEPS_LIMIT,
  AGENT_TOOL_NAMES,
  APPROVAL_POLICIES,
  PAPER_READ_STATUSES,
  REASONING_EFFORTS,
  SANDBOX_MODES,
} from "./types.js";

export const sandboxModeSchema = z.enum(SANDBOX_MODES);

export const approvalPolicySchema = z.enum(APPROVAL_POLICIES);

export const sessionKindSchema = z.enum(["chat", "agent", "paper"]);

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
    message: "chat and paper sessions do not take a workspaceRoot",
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
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["allow_once", "deny"]),
  approvalId: z.string().min(1).max(200).optional(),
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
});

export const llmTestSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  apiKey: z.string().max(8192).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(1).max(131_072).nullable().optional(),
  timeoutMs: z.number().int().min(0).max(600_000).optional(),
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
  systemPrompt: z.string().max(20_000).optional(),
});

export const updateSettingsSchema = z.object({
  defaultPreset: sandboxModeSchema,
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
