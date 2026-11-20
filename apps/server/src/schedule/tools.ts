import { z } from "zod";
import {
  SCHEDULE_CONFIDENCE,
  SCHEDULE_MEMORY_CATEGORIES,
  SCHEDULE_PRIORITIES,
  SCHEDULE_TASK_STATUSES,
  SCHEDULE_TIMES_OF_DAY,
  type ScheduleBlock,
  type ScheduleMemory,
  type SchedulePlan,
  type SchedulePreferences,
  type ScheduleSession,
  type ScheduleTask,
  type ScheduleTaskInput,
} from "@codefly/protocol";
import type { AgentEvent } from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import type { ToolResult } from "../agent/tools.js";
import type { LlmToolDefinition } from "../llm/client.js";
import type { ScheduleEmailService } from "./email.js";
import { buildScheduleTable, CONFIDENCE_LABEL, PRIORITY_LABEL, renderWeekPng } from "./render.js";
import { generateSchedule } from "./scheduler.js";
import type { ScheduleStore } from "./store.js";
import {
  addDays,
  compareDates,
  durationMinutes,
  maxDate,
  mondayOf,
  todayInTimezone,
  weekEndOf,
} from "./time.js";

const MAX_TOOL_CONTENT_CHARS = 30_000;
const MAX_CONTENT_PER_MEMORY = 6_000;
const DEFAULT_TASK_LIMIT = 100;

export interface ScheduleToolContext {
  session: ScheduleSession;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  progress: (text: string) => void;
  toolCallId: string;
}

export interface ScheduleToolExecutorOptions {
  store: ScheduleStore;
  email: ScheduleEmailService;
  audit: AuditLog;
}

function parseArgs<T>(
  schema: z.ZodType<T>,
  raw: string,
): { ok: true; data: T } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === "" ? "{}" : raw);
  } catch {
    return { ok: false, message: "Tool arguments must be valid JSON." };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `Invalid tool arguments: ${details}` };
  }
  return { ok: true, data: result.data };
}

function toolError(message: string, data?: unknown): ToolResult {
  return {
    content: message,
    status: "error",
    meta: { kind: "error", ...(data === undefined ? {} : { data }) },
  };
}

function truncate(content: string, max = MAX_TOOL_CONTENT_CHARS): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n[... truncated; result too large for the model context]`;
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function formatMemory(memory: ScheduleMemory, includeContent = true): string {
  const data =
    memory.data === null ? "" : `\n   data: ${JSON.stringify(memory.data)}`;
  return [
    `[${memory.id}] ${memory.key} · ${memory.category} · ${memory.title}${memory.pinned ? " · pinned" : ""}`,
    memory.tags.length > 0 ? `   tags: ${memory.tags.join(", ")}` : null,
    includeContent && memory.content.trim() !== ""
      ? `   ${memory.content.trim().slice(0, MAX_CONTENT_PER_MEMORY)}`
      : null,
    data.trim() !== "" ? data : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatTask(task: ScheduleTask): string {
  return [
    `[${task.id}] ${task.title} · ${PRIORITY_LABEL[task.priority]} · ${task.status}`,
    `   预估 ${formatMinutes(task.estimatedMinutes)} · 剩余 ${formatMinutes(
      task.remainingMinutes,
    )} · 已用 ${formatMinutes(task.actualMinutes)} · ${CONFIDENCE_LABEL[task.estimateConfidence]}`,
    task.deadline === null ? null : `   截止 ${task.deadline}`,
    task.project === null ? null : `   项目 ${task.project}`,
    `   ${task.splittable ? "可拆分" : "不可拆分"} · 最小时段 ${task.minBlockMinutes}m · 偏好 ${task.preferredTimeOfDay}`,
    task.notes.trim() === "" ? null : `   ${task.notes.trim().slice(0, 1000)}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function weekdayName(date: string): string {
  const names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!, 12)).getUTCDay();
  return names[(value === 0 ? 7 : value) - 1] ?? "";
}

function formatPlan(
  plan: SchedulePlan | null,
  tasks: ScheduleTask[],
  preferences: SchedulePreferences,
  summary: {
    totalPlannedMinutes: number;
    taskCount: number;
    doneMinutes: number;
  },
): string {
  if (plan === null) {
    return `这一周还没有计划。可用 plan_schedule 生成，或先添加任务。`;
  }
  const taskIndex = new Map(tasks.map((task) => [task.id, task]));
  const lines: string[] = [
    `计划 ${plan.weekStart} ~ ${plan.weekEnd}（${plan.timezone}）`,
    `共 ${summary.taskCount} 项任务 · 计划 ${formatMinutes(summary.totalPlannedMinutes)} · 已完成 ${formatMinutes(summary.doneMinutes)}`,
  ];
  const days = new Map<string, ScheduleBlock[]>();
  for (const block of plan.blocks) {
    const list = days.get(block.date) ?? [];
    list.push(block);
    days.set(block.date, list);
  }
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(plan.weekStart, index);
    const blocks = (days.get(date) ?? []).sort((a, b) =>
      a.start.localeCompare(b.start),
    );
    if (blocks.length === 0) continue;
    lines.push("", `${weekdayName(date)} ${date}`);
    for (const block of blocks) {
      const task = taskIndex.get(block.taskId);
      const status =
        block.status === "done"
          ? "✓"
          : block.status === "skipped"
            ? "—"
            : "·";
      lines.push(
        `  ${status} ${block.start}-${block.end} [${block.id}] ${task?.title ?? "已删除任务"} (${block.taskId})`,
      );
    }
  }
  if (plan.unscheduled.length > 0) {
    lines.push("", "未排期：");
    for (const item of plan.unscheduled) {
      lines.push(
        `  - ${item.title} (${item.taskId}) · 剩余 ${formatMinutes(
          item.remainingMinutes,
        )} · ${item.reason}`,
      );
    }
  }
  if (plan.warnings.length > 0) {
    lines.push("", "提醒：");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }
  if (plan.notes.trim() !== "") lines.push("", `备注：${plan.notes.trim()}`);
  lines.push(
    "",
    `偏好：工作日 ${preferences.workdays.join(",")} · ${preferences.workStart}-${preferences.workEnd} · 最长专注 ${preferences.maxFocusMinutes}m · 每日上限 ${preferences.dailyFocusLimitMinutes}m`,
  );
  return lines.join("\n");
}

function planResultMeta(
  plan: SchedulePlan | null,
  tasks: ScheduleTask[],
  preferences: SchedulePreferences,
  summary: ReturnType<ScheduleStore["summarize"]>,
  extra: Record<string, unknown> & { data?: Record<string, unknown> },
): Record<string, unknown> {
  const table = buildScheduleTable({
    plan,
    tasks,
    preferences,
    weekStart: plan?.weekStart ?? String(extra.weekStart ?? ""),
    weekEnd: plan?.weekEnd ?? String(extra.weekEnd ?? ""),
    summary,
  });
  return {
    kind: "schedule",
    view: "plan",
    weekStart: table.weekStart,
    weekEnd: table.weekEnd,
    summary,
    ...extra,
    data: {
      view: "plan",
      table,
      plan,
      summary,
      ...extra.data,
    },
  };
}

const memorySearchArgs = z
  .object({
    query: z.string().trim().max(2000).optional(),
    key: z.string().trim().max(120).optional(),
    category: z.enum(SCHEDULE_MEMORY_CATEGORIES).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const memoryUpsertArgs = z
  .object({
    memory_id: z.string().trim().min(1).max(200).optional(),
    key: z.string().trim().min(1).max(120).optional(),
    category: z.enum(SCHEDULE_MEMORY_CATEGORIES).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().max(200_000).optional(),
    data: z.record(z.string(), z.unknown()).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

const memoryDeleteArgs = z
  .object({
    memory_id: z.string().trim().min(1).max(200).optional(),
    key: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((value) => value.memory_id !== undefined || value.key !== undefined, {
    message: "provide memory_id or key",
  });

const taskListArgs = z
  .object({
    status: z.enum(SCHEDULE_TASK_STATUSES).optional(),
    include_done: z.boolean().optional(),
    project: z.string().trim().max(120).optional(),
    query: z.string().trim().max(2000).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const taskUpsertArgs = z
  .object({
    task_id: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().max(100_000).optional(),
    project: z.string().trim().max(120).nullable().optional(),
    priority: z.enum(SCHEDULE_PRIORITIES).optional(),
    status: z.enum(SCHEDULE_TASK_STATUSES).optional(),
    estimated_minutes: z.number().int().min(1).max(100_000).optional(),
    remaining_minutes: z.number().int().min(0).max(100_000).optional(),
    actual_minutes: z.number().int().min(0).max(1_000_000).optional(),
    add_actual_minutes: z.number().int().min(0).max(100_000).optional(),
    estimate_confidence: z.enum(SCHEDULE_CONFIDENCE).optional(),
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    splittable: z.boolean().optional(),
    min_block_minutes: z.number().int().min(5).max(600).optional(),
    preferred_time_of_day: z.enum(SCHEDULE_TIMES_OF_DAY).optional(),
  })
  .strict();

const taskDeleteArgs = z
  .object({
    task_id: z.string().trim().min(1).max(200),
  })
  .strict();

const planGetArgs = z
  .object({
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

const planScheduleArgs = z
  .object({
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    task_ids: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    allow_spill: z.boolean().optional(),
    notes: z.string().max(20_000).optional(),
  })
  .strict();

const planReplanArgs = z
  .object({
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    days: z.number().int().min(1).max(21).optional(),
    task_ids: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    allow_spill: z.boolean().optional(),
    notes: z.string().max(20_000).optional(),
  })
  .strict();

const blockUpdateArgs = z
  .object({
    block_id: z.string().trim().min(1).max(200),
    status: z.enum(["planned", "done", "skipped"]).optional(),
    actual_minutes: z.number().int().min(0).max(100_000).nullable().optional(),
    note: z.string().max(10_000).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  })
  .strict();

const planRenderArgs = z
  .object({
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

const planEmailArgs = z
  .object({
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().max(10_000).optional(),
  })
  .strict();

function taskInputFromArgs(
  args: z.infer<typeof taskUpsertArgs>,
): ScheduleTaskInput {
  return {
    title: args.title,
    notes: args.notes,
    project: args.project,
    priority: args.priority,
    status: args.status,
    estimatedMinutes: args.estimated_minutes,
    remainingMinutes: args.remaining_minutes,
    actualMinutes: args.actual_minutes,
    estimateConfidence: args.estimate_confidence,
    deadline: args.deadline,
    splittable: args.splittable,
    minBlockMinutes: args.min_block_minutes,
    preferredTimeOfDay: args.preferred_time_of_day,
  };
}

const DEFINITIONS: Record<string, LlmToolDefinition> = {
  memory_search: {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search the user's structured schedule memories (preferences, constraints, routines, goals, context). Use key='scheduling_preferences' to read the structured scheduling preferences.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search." },
          key: { type: "string", description: "Exact memory key." },
          category: { type: "string", enum: [...SCHEDULE_MEMORY_CATEGORIES] },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
    },
  },
  memory_upsert: {
    type: "function",
    function: {
      name: "memory_upsert",
      description:
        "Create or update one structured memory document. Use a stable, descriptive key. For scheduling_preferences, put workdays/workStart/workEnd/breaks/maxFocusMinutes/minBlockMinutes/bufferRatio/dailyFocusLimitMinutes/timezone into data.",
      parameters: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Existing memory id." },
          key: { type: "string", description: "Unique stable key." },
          category: { type: "string", enum: [...SCHEDULE_MEMORY_CATEGORIES] },
          title: { type: "string" },
          content: { type: "string", description: "Human-readable memory text." },
          data: {
            type: "object",
            description: "Optional structured fields.",
            additionalProperties: true,
          },
          tags: { type: "array", items: { type: "string" } },
          pinned: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  },
  memory_delete: {
    type: "function",
    function: {
      name: "memory_delete",
      description: "Delete one memory by id or key.",
      parameters: {
        type: "object",
        properties: {
          memory_id: { type: "string" },
          key: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  task_list: {
    type: "function",
    function: {
      name: "task_list",
      description:
        "List schedule tasks with estimates, remaining/actual minutes and historical estimate calibration. Active tasks are returned by default.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...SCHEDULE_TASK_STATUSES] },
          include_done: { type: "boolean" },
          project: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
    },
  },
  task_upsert: {
    type: "function",
    function: {
      name: "task_upsert",
      description:
        "Create or update a task. New tasks require title and estimated_minutes. Use add_actual_minutes when the user reports progress; it reduces remaining time and closes the task at zero.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          title: { type: "string" },
          notes: { type: "string" },
          project: { type: "string" },
          priority: { type: "string", enum: [...SCHEDULE_PRIORITIES] },
          status: { type: "string", enum: [...SCHEDULE_TASK_STATUSES] },
          estimated_minutes: { type: "integer", minimum: 1, maximum: 100000 },
          remaining_minutes: { type: "integer", minimum: 0, maximum: 100000 },
          actual_minutes: { type: "integer", minimum: 0, maximum: 1000000 },
          add_actual_minutes: { type: "integer", minimum: 0, maximum: 100000 },
          estimate_confidence: {
            type: "string",
            enum: [...SCHEDULE_CONFIDENCE],
          },
          deadline: { type: "string", description: "YYYY-MM-DD or null." },
          splittable: { type: "boolean" },
          min_block_minutes: { type: "integer", minimum: 5, maximum: 600 },
          preferred_time_of_day: {
            type: "string",
            enum: [...SCHEDULE_TIMES_OF_DAY],
          },
        },
        additionalProperties: false,
      },
    },
  },
  task_delete: {
    type: "function",
    function: {
      name: "task_delete",
      description:
        "Delete a task and all of its scheduled blocks. Ask the user before deleting work history.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
  },
  plan_get: {
    type: "function",
    function: {
      name: "plan_get",
      description:
        "Read one week's plan with block ids, daily grouping, unscheduled tasks, warnings and preferences.",
      parameters: {
        type: "object",
        properties: {
          week_start: {
            type: "string",
            description: "Any date in the week; defaults to the current week.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  plan_schedule: {
    type: "function",
    function: {
      name: "plan_schedule",
      description:
        "Generate or regenerate a weekly plan. Preserves completed blocks, replaces future planned blocks for the selected tasks, respects working hours/breaks and buffers uncertain estimates. Renders and saves a PNG table automatically.",
      parameters: {
        type: "object",
        properties: {
          week_start: {
            type: "string",
            description: "Any date in the target week; defaults to the current week.",
          },
          task_ids: {
            type: "array",
            items: { type: "string" },
            description: "Only schedule these tasks; defaults to all active tasks.",
          },
          allow_spill: {
            type: "boolean",
            description: "Allow overflow into the following week (default true).",
          },
          notes: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  plan_replan: {
    type: "function",
    function: {
      name: "plan_replan",
      description:
        "Replan from a date (default today). Marks overdue planned blocks as skipped, keeps completed blocks, and moves unfinished work into free slots, optionally spilling into the next week. Renders and saves a PNG table automatically.",
      parameters: {
        type: "object",
        properties: {
          from_date: {
            type: "string",
            description: "YYYY-MM-DD, defaults to today.",
          },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 21,
            description: "Planning horizon in days (default 7).",
          },
          task_ids: { type: "array", items: { type: "string" } },
          allow_spill: { type: "boolean" },
          notes: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  block_update: {
    type: "function",
    function: {
      name: "block_update",
      description:
        "Update one scheduled block: mark done/skipped/planned, record actual minutes, add a note, or move its date/time. Marking done also records the actual time against the task.",
      parameters: {
        type: "object",
        properties: {
          block_id: { type: "string" },
          status: { type: "string", enum: ["planned", "done", "skipped"] },
          actual_minutes: { type: "integer", minimum: 0, maximum: 100000 },
          note: { type: "string" },
          date: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
        },
        required: ["block_id"],
        additionalProperties: false,
      },
    },
  },
  plan_render: {
    type: "function",
    function: {
      name: "plan_render",
      description:
        "Render the weekly table to a PNG in data/schedule/exports and return a preview. Use when the user wants the image again or after manual edits.",
      parameters: {
        type: "object",
        properties: {
          week_start: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  plan_email: {
    type: "function",
    function: {
      name: "plan_email",
      description:
        "Email the weekly plan PNG to the user's configured mailbox. Only call when the user explicitly asks to send it. The recipient is fixed in settings and cannot be supplied here.",
      parameters: {
        type: "object",
        properties: {
          week_start: { type: "string" },
          note: { type: "string", description: "Optional note included in the email." },
        },
        additionalProperties: false,
      },
    },
  },
};

/** Schedule-session tool executor. All tools touch the global schedule store. */
export class ScheduleToolExecutor {
  private readonly options: ScheduleToolExecutorOptions;

  constructor(options: ScheduleToolExecutorOptions) {
    this.options = options;
  }

  definitions(): LlmToolDefinition[] {
    return Object.values(DEFINITIONS);
  }

  async execute(
    name: string,
    rawArguments: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    switch (name) {
      case "memory_search":
        return this.memorySearch(rawArguments);
      case "memory_upsert":
        return this.memoryUpsert(rawArguments, ctx);
      case "memory_delete":
        return this.memoryDelete(rawArguments, ctx);
      case "task_list":
        return this.taskList(rawArguments);
      case "task_upsert":
        return this.taskUpsert(rawArguments, ctx);
      case "task_delete":
        return this.taskDelete(rawArguments, ctx);
      case "plan_get":
        return this.planGet(rawArguments);
      case "plan_schedule":
        return this.planSchedule(rawArguments, ctx);
      case "plan_replan":
        return this.planReplan(rawArguments, ctx);
      case "block_update":
        return this.blockUpdate(rawArguments, ctx);
      case "plan_render":
        return this.planRender(rawArguments, ctx);
      case "plan_email":
        return this.planEmail(rawArguments, ctx);
      default:
        return toolError(`Unknown schedule tool: ${name}`);
    }
  }

  private today(): string {
    return todayInTimezone(this.options.store.getPreferences().timezone);
  }

  private memorySearch(raw: string): ToolResult {
    const parsed = parseArgs(memorySearchArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "memory" });
    const memories = this.options.store.listMemories({
      query: parsed.data.query,
      key: parsed.data.key,
      category: parsed.data.category,
      tags: parsed.data.tags,
      limit: parsed.data.limit,
    });
    if (memories.length === 0) {
      return {
        content:
          "No matching memories. If this is a first-time setup, ask the user for their scheduling preferences and save them with memory_upsert key='scheduling_preferences'.",
        status: "complete",
        meta: { kind: "memory", view: "memory", data: { view: "memory", memories: [] } },
      };
    }
    return {
      content: truncate(memories.map((memory) => formatMemory(memory)).join("\n\n")),
      status: "complete",
      meta: {
        kind: "memory",
        view: "memory",
        resultCount: memories.length,
        data: { view: "memory", memories },
      },
    };
  }

  private async memoryUpsert(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(memoryUpsertArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "memory" });
    const args = parsed.data;
    try {
      const existing =
        args.memory_id !== undefined
          ? this.options.store.getMemory(args.memory_id)
          : args.key !== undefined
            ? this.options.store.getMemoryByKey(args.key)
            : undefined;
      if (existing === undefined && args.title === undefined) {
        return toolError("Creating a memory requires a title.", { view: "memory" });
      }
      const { memory, created } = await this.options.store.upsertMemory({
        id: args.memory_id,
        key: args.key,
        category: args.category,
        title: args.title,
        content: args.content,
        data: args.data,
        tags: args.tags,
        pinned: args.pinned,
      });
      void this.options.audit.append({
        type: "schedule.memory.changed",
        sessionId: ctx.session.id,
        action: created ? "created" : "updated",
        memoryId: memory.id,
        key: memory.key,
      });
      const preferencesNote =
        memory.key === "scheduling_preferences"
          ? `\nNormalized preferences: ${JSON.stringify(this.options.store.getPreferences())}`
          : "";
      return {
        content: `${created ? "Created" : "Updated"} memory:\n${formatMemory(memory)}${preferencesNote}`,
        status: "complete",
        meta: {
          kind: "memory",
          view: "memory",
          data: { view: "memory", memories: [memory], created },
        },
      };
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : String(error),
        { view: "memory" },
      );
    }
  }

  private async memoryDelete(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(memoryDeleteArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "memory" });
    const target = parsed.data.memory_id ?? parsed.data.key!;
    const existing =
      parsed.data.memory_id !== undefined
        ? this.options.store.getMemory(parsed.data.memory_id)
        : this.options.store.getMemoryByKey(parsed.data.key!);
    if (existing === undefined) {
      return toolError(`Memory not found: ${target}`, { view: "memory" });
    }
    const deleted = await this.options.store.deleteMemory(existing.id);
    if (!deleted) return toolError(`Memory not found: ${target}`, { view: "memory" });
    void this.options.audit.append({
      type: "schedule.memory.changed",
      sessionId: ctx.session.id,
      action: "deleted",
      memoryId: existing.id,
      key: existing.key,
    });
    return {
      content: `Deleted memory ${existing.key} (${existing.id}).`,
      status: "complete",
      meta: {
        kind: "memory",
        view: "memory",
        data: { view: "memory", memories: [], deletedId: existing.id },
      },
    };
  }

  private taskList(raw: string): ToolResult {
    const parsed = parseArgs(taskListArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "tasks" });
    const tasks = this.options.store.listTasks({
      status: parsed.data.status,
      includeDone: parsed.data.include_done,
      project: parsed.data.project,
      query: parsed.data.query,
      limit: parsed.data.limit ?? DEFAULT_TASK_LIMIT,
    });
    const calibration = this.options.store.getCalibration();
    const calibrationText =
      calibration.ratio === null
        ? "历史校准：暂无已完成任务的实际耗时，无法计算 actual/estimate 比例。"
        : `历史校准：${calibration.completedTasks} 个已完成任务，平均 actual/estimate = ${calibration.ratio}。`;
    const content =
      tasks.length === 0
        ? `No matching tasks. ${calibrationText}`
        : `${tasks.map(formatTask).join("\n\n")}\n\n${calibrationText}`;
    return {
      content: truncate(content),
      status: "complete",
      meta: {
        kind: "schedule",
        view: "tasks",
        data: { view: "tasks", tasks, calibration },
      },
    };
  }

  private async taskUpsert(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(taskUpsertArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "tasks" });
    const args = parsed.data;
    try {
      if (args.task_id === undefined) {
        if (args.title === undefined || args.estimated_minutes === undefined) {
          return toolError(
            "Creating a task requires title and estimated_minutes. Ask the user for a realistic estimate and confidence.",
            { view: "tasks" },
          );
        }
        const task = await this.options.store.createTask({
          ...taskInputFromArgs(args),
          title: args.title,
        });
        void this.options.audit.append({
          type: "schedule.task.changed",
          sessionId: ctx.session.id,
          action: "created",
          taskId: task.id,
        });
        return {
          content: `Created task:\n${formatTask(task)}`,
          status: "complete",
          meta: {
            kind: "schedule",
            view: "tasks",
            data: { view: "tasks", tasks: [task] },
          },
        };
      }

      let task = await this.options.store.updateTask(
        args.task_id,
        taskInputFromArgs(args),
      );
      if (args.add_actual_minutes !== undefined && args.add_actual_minutes > 0) {
        task = await this.options.store.recordTaskActual(
          task.id,
          args.add_actual_minutes,
        );
      }
      void this.options.audit.append({
        type: "schedule.task.changed",
        sessionId: ctx.session.id,
        action: "updated",
        taskId: task.id,
      });
      const progressHint =
        args.add_actual_minutes !== undefined || args.status === "done"
          ? "\nRemaining work changed; call plan_replan if the current week should be adjusted."
          : "";
      return {
        content: `Updated task:\n${formatTask(task)}${progressHint}`,
        status: "complete",
        meta: {
          kind: "schedule",
          view: "tasks",
          data: { view: "tasks", tasks: [task] },
        },
      };
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : String(error),
        { view: "tasks" },
      );
    }
  }

  private async taskDelete(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(taskDeleteArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "tasks" });
    const task = this.options.store.getTask(parsed.data.task_id);
    if (task === undefined) {
      return toolError(`Task not found: ${parsed.data.task_id}`, { view: "tasks" });
    }
    await this.options.store.deleteTask(task.id);
    void this.options.audit.append({
      type: "schedule.task.changed",
      sessionId: ctx.session.id,
      action: "deleted",
      taskId: task.id,
    });
    return {
      content: `Deleted task ${task.title} (${task.id}) and its blocks.`,
      status: "complete",
      meta: {
        kind: "schedule",
        view: "tasks",
        data: { view: "tasks", tasks: [], deletedId: task.id },
      },
    };
  }

  private planGet(raw: string): ToolResult {
    const parsed = parseArgs(planGetArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "plan" });
    const preferences = this.options.store.getPreferences();
    const today = this.today();
    const weekStart = mondayOf(parsed.data.week_start ?? today);
    const plan = this.options.store.getPlan(weekStart) ?? null;
    const tasks = this.options.store.listTasks({ includeDone: true, limit: 200 });
    const summary = this.options.store.summarize(plan, preferences);
    if (plan === null) {
      summary.weekStart = weekStart;
      summary.weekEnd = weekEndOf(weekStart);
    }
    return {
      content: truncate(
        formatPlan(plan, tasks, preferences, summary) +
          `\n\n历史校准：${JSON.stringify(this.options.store.getCalibration())}`,
      ),
      status: "complete",
      meta: planResultMeta(plan, tasks, preferences, summary, {
        weekStart,
        weekEnd: weekEndOf(weekStart),
        today,
        data: {},
      }),
    };
  }

  private async planSchedule(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(planScheduleArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "plan" });
    return this.runPlanner({
      mode: "week",
      weekStartInput: parsed.data.week_start,
      taskIds: parsed.data.task_ids,
      allowSpill: parsed.data.allow_spill !== false,
      notes: parsed.data.notes,
      ctx,
    });
  }

  private async planReplan(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(planReplanArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "plan" });
    return this.runPlanner({
      mode: "replan",
      fromDate: parsed.data.from_date,
      days: parsed.data.days ?? 7,
      taskIds: parsed.data.task_ids,
      allowSpill: parsed.data.allow_spill !== false,
      notes: parsed.data.notes,
      ctx,
    });
  }

  private async runPlanner(input: {
    mode: "week" | "replan";
    weekStartInput?: string;
    fromDate?: string;
    days?: number;
    taskIds?: string[];
    allowSpill: boolean;
    notes?: string;
    ctx: ScheduleToolContext;
  }): Promise<ToolResult> {
    const { ctx } = input;
    const store = this.options.store;
    const preferences = store.getPreferences();
    const today = this.today();

    const targetWeekStart =
      input.mode === "week"
        ? mondayOf(input.weekStartInput ?? today)
        : mondayOf(input.fromDate ?? today);
    if (
      input.mode === "week" &&
      compareDates(targetWeekStart, mondayOf(today)) < 0
    ) {
      return toolError(
        `该周已经过去（${targetWeekStart} ~ ${weekEndOf(targetWeekStart)}），请指定当前或未来的周。`,
        { view: "plan" },
      );
    }
    const startDate =
      input.mode === "week"
        ? maxDate(targetWeekStart, today)
        : maxDate(input.fromDate ?? today, today);
    const endDate =
      input.mode === "week"
        ? addDays(weekEndOf(targetWeekStart), input.allowSpill ? 7 : 0)
        : addDays(startDate, (input.days ?? 7) - 1 + (input.allowSpill ? 7 : 0));

    if (compareDates(startDate, endDate) > 0) {
      return toolError(
        `该周已经过去（${targetWeekStart} ~ ${weekEndOf(targetWeekStart)}），请指定当前或未来的周。`,
        { view: "plan" },
      );
    }

    let tasks: ScheduleTask[];
    if (input.taskIds !== undefined && input.taskIds.length > 0) {
      const wanted = new Set(input.taskIds);
      tasks = store
        .listTasks({ includeDone: true, limit: 200 })
        .filter((task) => wanted.has(task.id));
      if (tasks.length === 0) {
        return toolError("None of the requested task ids exist.", { view: "plan" });
      }
    } else {
      tasks = store.listTasks({ limit: 200 });
    }
    const active = tasks.filter(
      (task) =>
        (task.status === "todo" || task.status === "in_progress") &&
        task.remainingMinutes > 0,
    );
    if (active.length === 0) {
      return {
        content:
          "没有需要排期的任务（没有 todo/in_progress 且剩余时间大于 0 的任务）。先用 task_upsert 添加任务。",
        status: "complete",
        meta: {
          kind: "schedule",
          view: "plan",
          data: { view: "plan", table: null, plan: null },
        },
      };
    }

    const included = new Set(active.map((task) => task.id));
    const removeFromDate = startDate;
    const allBlocks = store.listPlans().flatMap((plan) => plan.blocks);
    const existingBlocks: ScheduleBlock[] = [];
    const committedMinutesByTask = new Map<string, number>();
    for (const block of allBlocks) {
      if (!included.has(block.taskId)) {
        if (block.status !== "skipped") existingBlocks.push(block);
        continue;
      }
      if (block.status === "done") {
        existingBlocks.push(block);
        continue;
      }
      if (block.status !== "planned") continue;
      if (compareDates(block.date, removeFromDate) >= 0) continue;
      if (compareDates(block.date, today) < 0) continue;
      existingBlocks.push(block);
      committedMinutesByTask.set(
        block.taskId,
        (committedMinutesByTask.get(block.taskId) ?? 0) +
          durationMinutes(block.start, block.end),
      );
    }

    const result = generateSchedule({
      startDate,
      endDate,
      today,
      tasks: active,
      existingBlocks,
      preferences,
      committedMinutesByTask,
    });

    if (store.getPreferencesMemory() === undefined) {
      result.warnings.unshift(
        "尚未配置排期偏好，已使用默认的工作日与工作时段。请向用户确认工作时段、休息时间和每日专注上限，并用 memory_upsert 保存 key=scheduling_preferences。",
      );
    }
    const weeks = new Set<string>();
    for (const block of result.blocks) weeks.add(mondayOf(block.date));
    // If the requested week has no usable workday left (e.g. planning on a
    // weekend), present and annotate the first week that actually got blocks.
    const primaryWeek =
      result.blocks.length > 0
        ? mondayOf(result.blocks[0]!.date)
        : mondayOf(startDate);
    weeks.add(primaryWeek);
    const planMeta = new Map<
      string,
      { unscheduled?: typeof result.unscheduled; warnings?: string[]; notes?: string }
    >();
    for (const week of weeks) {
      planMeta.set(week, {
        unscheduled: week === primaryWeek ? result.unscheduled : [],
        warnings: result.warnings,
        ...(week === primaryWeek && input.notes !== undefined
          ? { notes: input.notes }
          : {}),
      });
    }

    const updatedPlans = await store.applySchedule({
      taskIds: [...included],
      removeFromDate,
      skipBeforeDate: today,
      addBlocks: result.blocks,
      planMeta,
    });

    void this.options.audit.append({
      type: "schedule.plan.changed",
      sessionId: ctx.session.id,
      action: input.mode === "week" ? "scheduled" : "replanned",
      weeks: [...weeks],
      blocks: result.blocks.length,
      unscheduled: result.unscheduled.length,
    });

    const renderWeek = primaryWeek;
    const render = await this.tryRender(renderWeek, ctx, input.notes);
    const plan = store.getPlan(renderWeek) ?? null;
    const latestTasks = store.listTasks({ includeDone: true, limit: 200 });
    const summary = store.summarize(plan, preferences);
    const affected = updatedPlans
      .map((candidate) => `${candidate.weekStart}(${candidate.blocks.length} blocks)`)
      .join(", ");
    const content = [
      input.mode === "week"
        ? targetWeekStart === primaryWeek
          ? `已生成 ${targetWeekStart} 开始的周计划。`
          : `目标周 ${targetWeekStart} 已没有可用工作日，计划从 ${primaryWeek} 开始排入。`
        : startDate === primaryWeek
          ? `已从 ${startDate} 开始重排未完成工作。`
          : `从 ${startDate} 起没有可用工作日，重排结果从 ${primaryWeek} 开始。`,
      `生成 ${result.blocks.length} 个 block，涉及 ${weeks.size} 周：${affected}。`,
      render !== null
        ? `计划表 PNG 已保存：${render.filePath}`
        : "计划已保存，但 PNG 渲染失败；可稍后用 plan_render 重试。",
      "",
      formatPlan(plan, latestTasks, preferences, summary),
    ].join("\n");

    return {
      content: truncate(content),
      status: "complete",
      meta: {
        ...planResultMeta(plan, latestTasks, preferences, summary, {
          weekStart: renderWeek,
          weekEnd: weekEndOf(renderWeek),
          today,
          filePath: render?.filePath,
          width: render?.width,
          height: render?.height,
          affectedWeeks: [...weeks],
          data: {
            affectedWeeks: [...weeks],
            filePath: render?.filePath,
          },
        }),
        ...(render?.dataUrl ? { imageDataUrl: render.dataUrl } : {}),
      },
    };
  }

  private async blockUpdate(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(blockUpdateArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "block" });
    const args = parsed.data;
    try {
      const before = this.options.store.findBlock(args.block_id);
      if (before === undefined) {
        return toolError(`Block not found: ${args.block_id}`, { view: "block" });
      }
      const previousStatus = before.block.status;
      const previousActual =
        before.block.actualMinutes ??
        durationMinutes(before.block.start, before.block.end);
      const { plan, block } = await this.options.store.updateBlock(
        args.block_id,
        {
          status: args.status,
          actualMinutes: args.actual_minutes,
          note: args.note,
          date: args.date,
          start: args.start,
          end: args.end,
        },
      );

      // Sync the task's actual/remaining counters with the block transition.
      let task = this.options.store.getTask(block.taskId);
      if (task !== undefined) {
        if (previousStatus === "done" && block.status !== "done") {
          task = await this.options.store.revertTaskActual(task.id, previousActual);
        }
        if (previousStatus === "done" && block.status === "done") {
          const nextActual =
            block.actualMinutes ?? durationMinutes(block.start, block.end);
          if (nextActual !== previousActual) {
            await this.options.store.revertTaskActual(task.id, previousActual);
            task = await this.options.store.recordTaskActual(task.id, nextActual);
          }
        }
        if (previousStatus !== "done" && block.status === "done") {
          task = await this.options.store.recordTaskActual(
            task.id,
            block.actualMinutes ?? durationMinutes(block.start, block.end),
          );
        }
      }

      void this.options.audit.append({
        type: "schedule.plan.changed",
        sessionId: ctx.session.id,
        action: "block-updated",
        blockId: block.id,
        weekStart: plan.weekStart,
        status: block.status,
      });

      const preferences = this.options.store.getPreferences();
      const tasks = this.options.store.listTasks({ includeDone: true, limit: 200 });
      const summary = this.options.store.summarize(plan, preferences);
      return {
        content: `Updated block ${block.id}: ${block.date} ${block.start}-${block.end} · ${block.status}${
          task === undefined
            ? ""
            : `\nTask: ${formatTask(task)}\nRemaining work changed; call plan_replan if the rest of the week should be compacted or pushed back.`
        }`,
        status: "complete",
        meta: planResultMeta(plan, tasks, preferences, summary, {
          weekStart: plan.weekStart,
          weekEnd: plan.weekEnd,
          today: this.today(),
          data: { block, previous: before.block },
        }),
      };
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : String(error),
        { view: "block" },
      );
    }
  }

  private async planRender(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(planRenderArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "plan" });
    const preferences = this.options.store.getPreferences();
    const weekStart = mondayOf(parsed.data.week_start ?? this.today());
    const render = await this.tryRender(weekStart, ctx, undefined);
    if (render === null) {
      return toolError("渲染 PNG 失败。", { view: "plan" });
    }
    const plan = this.options.store.getPlan(weekStart) ?? null;
    const tasks = this.options.store.listTasks({ includeDone: true, limit: 200 });
    const summary = this.options.store.summarize(plan, preferences);
    return {
      content: `Rendered ${render.width}×${render.height} PNG for ${weekStart}:\n${render.filePath}`,
      status: "complete",
      meta: {
        ...planResultMeta(plan, tasks, preferences, summary, {
          weekStart,
          weekEnd: weekEndOf(weekStart),
          filePath: render.filePath,
          width: render.width,
          height: render.height,
          data: { filePath: render.filePath, width: render.width, height: render.height },
        }),
        imageDataUrl: render.dataUrl ?? undefined,
      },
    };
  }

  private async planEmail(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(planEmailArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "plan" });
    const preferences = this.options.store.getPreferences();
    const weekStart = mondayOf(parsed.data.week_start ?? this.today());
    const plan = this.options.store.getPlan(weekStart) ?? null;
    if (plan === null) {
      return toolError(
        `这一周还没有计划：${weekStart}。先用 plan_schedule 生成计划。`,
        { view: "plan" },
      );
    }
    const tasks = this.options.store.listTasks({ includeDone: true, limit: 200 });
    const summary = this.options.store.summarize(plan, preferences);
    const render = await this.tryRender(weekStart, ctx, undefined);
    if (render === null) {
      return toolError("渲染计划表 PNG 失败，未发送邮件。", { view: "plan" });
    }
    try {
      const result = await this.options.email.sendPlan({
        plan,
        summary,
        png: render.buffer,
        fileName: `codefly-week-${weekStart}.png`,
        note: parsed.data.note,
      });
      void this.options.audit.append({
        type: "schedule.email.sent",
        sessionId: ctx.session.id,
        weekStart,
        to: result.to,
        messageId: result.messageId,
        imagePath: render.filePath,
      });
      return {
        content: `已把 ${weekStart} 的计划表发送到 ${result.to}（messageId: ${
          result.messageId ?? "n/a"
        }）。附件：${render.filePath}`,
        status: "complete",
        meta: {
          ...planResultMeta(plan, tasks, preferences, summary, {
            weekStart,
            weekEnd: weekEndOf(weekStart),
            filePath: render.filePath,
            emailedTo: result.to,
            data: {
              filePath: render.filePath,
              emailedTo: result.to,
              messageId: result.messageId,
            },
          }),
          imageDataUrl: render.dataUrl ?? undefined,
        },
      };
    } catch (error) {
      return toolError(
        `发送邮件失败：${error instanceof Error ? error.message : String(error)}`,
        { view: "plan" },
      );
    }
  }

  private async tryRender(
    weekStart: string,
    ctx: ScheduleToolContext,
    notes: string | undefined,
  ): Promise<Awaited<ReturnType<typeof renderWeekPng>> | null> {
    try {
      ctx.progress("正在渲染周计划表格…");
      const preferences = this.options.store.getPreferences();
      const plan = this.options.store.getPlan(weekStart) ?? null;
      const tasks = this.options.store.listTasks({ includeDone: true, limit: 200 });
      const summary = this.options.store.summarize(plan, preferences);
      return await renderWeekPng({
        plan,
        tasks,
        preferences,
        weekStart,
        weekEnd: weekEndOf(weekStart),
        summary,
        outputDir: this.options.store.getExportsDir(),
        notes,
      });
    } catch (error) {
      console.error("[schedule] render failed", error);
      return null;
    }
  }
}
