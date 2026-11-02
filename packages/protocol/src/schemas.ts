import { z } from "zod";
import {
  AGENT_MAX_STEPS_LIMIT,
  AGENT_TOOL_NAMES,
  APPROVAL_POLICIES,
  REASONING_EFFORTS,
  SANDBOX_MODES,
} from "./types.js";

export const sandboxModeSchema = z.enum(SANDBOX_MODES);

export const approvalPolicySchema = z.enum(APPROVAL_POLICIES);

export const createSessionSchema = z.object({
  workspaceRoot: z.string().min(1).max(4096),
  title: z.string().trim().min(1).max(120).optional(),
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
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  thinking: z.boolean().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
});

export const llmTestSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  apiKey: z.string().max(8192).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(1).max(131_072).nullable().optional(),
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
