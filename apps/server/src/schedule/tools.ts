import { z } from "zod";
import {
  SCHEDULE_CONFIDENCE,
  SCHEDULE_FIXED_EVENT_KINDS,
  SCHEDULE_PRIORITIES,
  SCHEDULE_TASK_STATUSES,
  SCHEDULE_TIMES_OF_DAY,
  schedulePreferencesPatchSchema,
  type ScheduleAgendaModel,
  type ScheduleBlock,
  type ScheduleFixedEvent,
  type SchedulePlan,
  type SchedulePlanSummary,
  type SchedulePreferences,
  type ScheduleSession,
  type ScheduleTask,
  type ScheduleTaskAllocation,
  type ScheduleTaskInput,
  type ScheduleWindow,
} from "@codefly/protocol";
import type { AgentEvent } from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import type { ToolResult } from "../agent/tools.js";
import {
  ASK_USER_QUESTION_DEFINITION,
  askUserQuestionResult,
  type QuestionServiceLike,
} from "../interaction/ask-user-question.js";
import type { LlmToolDefinition } from "../llm/client.js";
import { buildScheduleAgenda, pairParallelBlocks } from "./agenda.js";
import type { ScheduleEmailService } from "./email.js";
import {
  CONFIDENCE_LABEL,
  PRIORITY_LABEL,
  renderAgendaPng,
  type RenderAgendaResult,
} from "./render.js";
import { generateSchedule } from "./scheduler.js";
import type { ScheduleStore } from "./store.js";
import {
  addDays,
  compareDates,
  daysBetween,
  durationMinutes,
  maxDate,
  mondayOf,
  nowClockInTimezone,
  rangeEndOf,
  todayInTimezone,
  weekdayOf,
} from "./time.js";

const MAX_TOOL_CONTENT_CHARS = 30_000;
const DEFAULT_TASK_LIMIT = 100;

export interface ScheduleToolContext {
  session: ScheduleSession;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  progress: (text: string) => void;
  toolCallId: string;
  messageId: string;
  questions: QuestionServiceLike;
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

function formatTask(task: ScheduleTask): string {
  return [
    `[${task.id}] ${task.title} · ${PRIORITY_LABEL[task.priority]} · ${task.status}`,
    `   预估 ${formatMinutes(task.estimatedMinutes)} · 剩余 ${formatMinutes(
      task.remainingMinutes,
    )} · 已用 ${formatMinutes(task.actualMinutes)} · ${CONFIDENCE_LABEL[task.estimateConfidence]}`,
    task.deadline === null ? null : `   截止 ${task.deadline}`,
    task.project === null ? null : `   项目 ${task.project}`,
    `   ${task.splittable ? "可拆分" : "不可拆分"} · 最小时段 ${task.minBlockMinutes}m · 偏好 ${task.preferredTimeOfDay}`,
    task.steps.length === 0
      ? null
      : `   拆解 ${task.steps.length} 步（合计 ${formatMinutes(
          task.steps.reduce((total, step) => total + step.minutes, 0),
        )}，剩余 ${formatMinutes(task.remainingMinutes)}）：${task.steps
          .map(
            (step, index) =>
              `${index + 1}. ${step.title} ${formatMinutes(step.minutes)}`,
          )
          .join(" · ")
          .slice(0, 1200)}`,
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

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function weekdayNumberName(weekday: number): string {
  return WEEKDAY_NAMES[weekday - 1] ?? "";
}

/** Filters a fixed-event list to those occupying time on the given date. */
function fixedEventsForDateOf(
  events: ScheduleFixedEvent[],
  date: string,
): ScheduleFixedEvent[] {
  const weekday = weekdayOf(date);
  return events
    .filter(
      (event) =>
        (event.kind === "weekly" && event.weekday === weekday) ||
        (event.kind === "once" && event.date === date),
    )
    .sort((a, b) => a.start.localeCompare(b.start));
}

function formatFixedEvent(event: ScheduleFixedEvent): string {
  const when =
    event.kind === "weekly"
      ? `每周${weekdayNumberName(event.weekday ?? 1)}`
      : `${event.date}（${weekdayName(event.date ?? "")}）`;
  const busySuffix = event.busy ? "" : " · 时段可安排任务";
  return [
    `[${event.id}] ${event.title} · ${when} ${event.start}-${event.end}${busySuffix}`,
    event.location.trim() !== "" ? `   地点 ${event.location}` : null,
    event.note.trim() !== "" ? `   ${event.note.trim().slice(0, 1000)}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Per-task totals over one planning window, used in tool output and UI. */
function taskAllocationsFor(
  window: ScheduleWindow | null,
  tasks: ScheduleTask[],
): ScheduleTaskAllocation[] {
  if (window === null) return [];
  const totals = new Map<string, { minutes: number; blocks: number }>();
  for (const block of window.blocks) {
    if (block.status === "skipped") continue;
    const entry = totals.get(block.taskId) ?? { minutes: 0, blocks: 0 };
    entry.minutes += durationMinutes(block.start, block.end);
    entry.blocks += 1;
    totals.set(block.taskId, entry);
  }
  const taskIndex = new Map(tasks.map((task) => [task.id, task]));
  return [...totals.entries()]
    .map(([taskId, total]) => {
      const task = taskIndex.get(taskId);
      return {
        taskId,
        title: task?.title ?? "已删除任务",
        estimatedMinutes: task?.estimatedMinutes ?? 0,
        remainingMinutes: task?.remainingMinutes ?? 0,
        scheduledMinutes: total.minutes,
        blockCount: total.blocks,
      };
    })
    .sort((a, b) => b.scheduledMinutes - a.scheduledMinutes);
}

function formatPreferences(
  preferences: SchedulePreferences,
  configured: boolean,
): string {
  const breaks =
    preferences.breaks.length === 0
      ? "无"
      : preferences.breaks
          .map((brk) => `${brk.label} ${brk.start}-${brk.end}`)
          .join("、");
  const buffer = Math.round(preferences.bufferRatio * 100);
  const lines = [
    `排期偏好${configured ? "" : "（未配置，以下为默认值）"}：`,
    `  工作日 ${preferences.workdays.join(",")} · ${preferences.workStart}-${preferences.workEnd} · 休息 ${breaks}`,
    `  最长专注 ${preferences.maxFocusMinutes}m · 每日上限 ${preferences.dailyFocusLimitMinutes}m · 缓冲 ${buffer}% · 块间隙 ${preferences.gapMinutes}m · 时区 ${preferences.timezone}`,
  ];
  if (preferences.rules.length === 0) {
    lines.push("  规则：暂无");
  } else {
    lines.push("  规则：");
    for (const rule of preferences.rules) lines.push(`    - ${rule}`);
  }
  return lines.join("\n");
}

function formatPlan(
  window: ScheduleWindow | null,
  tasks: ScheduleTask[],
  fixedEvents: ScheduleFixedEvent[],
  preferences: SchedulePreferences,
  summary: SchedulePlanSummary,
): string {
  if (window === null) {
    return `这个时间窗口还没有计划。可用 plan_schedule 生成（只有固定课程/会议没有任务也可以生成），或先添加任务。`;
  }
  const taskIndex = new Map(tasks.map((task) => [task.id, task]));
  const lines: string[] = [
    `计划 ${window.startDate} ~ ${window.endDate}（${window.timezone}）`,
    `共 ${summary.taskCount} 项任务 · 计划 ${formatMinutes(summary.totalPlannedMinutes)} · 已完成 ${formatMinutes(summary.doneMinutes)}`,
  ];
  const days = new Map<string, ScheduleBlock[]>();
  for (const block of window.blocks) {
    const list = days.get(block.date) ?? [];
    list.push(block);
    days.set(block.date, list);
  }
  const dayCount = daysBetween(window.startDate, window.endDate) + 1;
  for (let index = 0; index < dayCount; index += 1) {
    const date = addDays(window.startDate, index);
    const blocks = (days.get(date) ?? []).sort((a, b) =>
      a.start.localeCompare(b.start),
    );
    const dayEvents = fixedEventsForDateOf(fixedEvents, date);
    if (blocks.length === 0 && dayEvents.length === 0) continue;
    const { byEventId, absorbedBlockIds } = pairParallelBlocks(
      dayEvents,
      blocks,
      taskIndex,
    );
    lines.push("", `${weekdayName(date)} ${date}`);
    for (const event of dayEvents) {
      const location = event.location.trim() === "" ? "" : ` @${event.location}`;
      const parallel = byEventId.get(event.id);
      if (parallel === undefined) {
        const suffix = event.busy ? "（固定）" : "（固定·可并行）";
        lines.push(
          `  ▣ ${event.start}-${event.end} ${event.title}${location}${suffix}`,
        );
        continue;
      }
      // Course and the task blocks inside its window share one line so the
      // parallel arrangement reads at a glance.
      const tasks = parallel
        .map((block) => {
          const status =
            block.status === "done"
              ? "✓"
              : block.status === "skipped"
                ? "—"
                : "·";
          return `${status}${block.start}-${block.end} ${block.title}`;
        })
        .join(" ∥ ");
      lines.push(
        `  ▣ ${event.start}-${event.end} ${event.title}${location}（固定·可并行）∥ ${tasks}`,
      );
    }
    for (const block of blocks) {
      if (absorbedBlockIds.has(block.id)) continue;
      const task = taskIndex.get(block.taskId);
      const status =
        block.status === "done"
          ? "✓"
          : block.status === "skipped"
            ? "—"
            : "·";
      lines.push(
        `  ${status} ${block.start}-${block.end} [${block.id}] ${task?.title ?? "已删除任务"} (${block.taskId})${
          block.note.trim() === ""
            ? ""
            : ` — ${block.note.trim().slice(0, 200)}`
        }`,
      );
    }
  }
  const allocations = taskAllocationsFor(window, tasks);
  if (allocations.length > 0) {
    lines.push("", "排期汇总（任务维度）：");
    for (const item of allocations) {
      const extra =
        item.estimatedMinutes > 0 &&
        item.scheduledMinutes > item.estimatedMinutes
          ? ` · 超出预估 ${formatMinutes(
              item.scheduledMinutes - item.estimatedMinutes,
            )}`
          : "";
      lines.push(
        `  - ${item.title}：已排 ${formatMinutes(
          item.scheduledMinutes,
        )}（${item.blockCount} 段） · 预估 ${formatMinutes(
          item.estimatedMinutes,
        )} · 剩余 ${formatMinutes(item.remainingMinutes)}${extra}`,
      );
    }
  }
  if (window.unscheduled.length > 0) {
    lines.push("", "未排期：");
    for (const item of window.unscheduled) {
      lines.push(
        `  - ${item.title} (${item.taskId}) · 剩余 ${formatMinutes(
          item.remainingMinutes,
        )} · ${item.reason}`,
      );
    }
  }
  if (window.warnings.length > 0) {
    lines.push("", "提醒：");
    for (const warning of window.warnings) lines.push(`  - ${warning}`);
  }
  if (window.notes.trim() !== "") lines.push("", `备注：${window.notes.trim()}`);
  lines.push(
    "",
    `偏好：工作日 ${preferences.workdays.join(",")} · ${preferences.workStart}-${preferences.workEnd} · 最长专注 ${preferences.maxFocusMinutes}m · 每日上限 ${preferences.dailyFocusLimitMinutes}m · 缓冲 ${Math.round(
      preferences.bufferRatio * 100,
    )}% · 块间隙 ${preferences.gapMinutes}m · 规则 ${preferences.rules.length} 条`,
  );
  return lines.join("\n");
}

/**
 * Lists planned blocks whose time has passed with no recorded outcome. The
 * planning tools refuse to run while any remain, so the model must confirm
 * each one with the user (done + actual minutes, or skipped) before
 * replanning; force_overdue_skip is the only bypass.
 */
function formatOverdueSection(
  blocks: ScheduleBlock[],
  tasks: ScheduleTask[],
): string {
  const taskIndex = new Map(tasks.map((task) => [task.id, task]));
  const totalMinutes = blocks.reduce(
    (total, block) => total + durationMinutes(block.start, block.end),
    0,
  );
  const lines = [
    `过期待确认（时间已过但未记录完成，${blocks.length} 块 / 共 ${formatMinutes(totalMinutes)}）：`,
  ];
  for (const block of blocks) {
    const task = taskIndex.get(block.taskId);
    lines.push(
      `  · ${block.date} ${block.start}-${block.end} [${block.id}] ${
        task?.title ?? "已删除任务"
      } (${block.taskId})${
        block.note.trim() === "" ? "" : ` — ${block.note.trim().slice(0, 200)}`
      }`,
    );
  }
  lines.push(
    "",
    "先用任务记录判断（任务已 done 无需处理；actualMinutes 已覆盖该块 → block_update status=done 且 actual_minutes=0，避免重复记账），其余用 ask_user_question 逐块确认：完成 → block_update status=done；未完成 → block_update status=skipped。",
  );
  return lines.join("\n");
}

/**
 * One consistent snapshot of a plan window — store reads, summary and the
 * shared agenda model — produced by a single `loadPlanView` pass and reused
 * by the text dump, the PNG render and the UI result meta.
 */
interface PlanView {
  startDate: string;
  endDate: string;
  window: ScheduleWindow | null;
  tasks: ScheduleTask[];
  fixedEvents: ScheduleFixedEvent[];
  summary: SchedulePlanSummary;
  agenda: ScheduleAgendaModel;
}

function planResultMeta(input: {
  view: PlanView;
  extra: Record<string, unknown> & { data?: Record<string, unknown> };
}): Record<string, unknown> {
  const { view } = input;
  const taskAllocations = taskAllocationsFor(view.window, view.tasks);
  return {
    kind: "schedule",
    view: "plan",
    rangeStart: view.startDate,
    rangeEnd: view.endDate,
    summary: view.summary,
    taskAllocations,
    ...input.extra,
    data: {
      view: "plan",
      agenda: view.agenda,
      window: view.window,
      summary: view.summary,
      taskAllocations,
      ...input.extra.data,
    },
  };
}

function emptySummary(
  startDate: string,
  endDate: string,
  timezone: string,
): SchedulePlanSummary {
  return {
    rangeStart: startDate,
    rangeEnd: endDate,
    timezone,
    planId: null,
    totalPlannedMinutes: 0,
    taskCount: 0,
    doneMinutes: 0,
    unscheduled: [],
    warnings: [],
  };
}

const preferencesGetArgs = z.object({}).strict();

const preferencesUpdateArgs = schedulePreferencesPatchSchema;

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
    steps: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          minutes: z.number().int().min(5).max(600),
        }),
      )
      .max(100)
      .nullable()
      .optional(),
  })
  .strict();

const taskDeleteArgs = z
  .object({
    task_id: z.string().trim().min(1).max(200),
  })
  .strict();

const fixedEventListArgs = z
  .object({
    kind: z.enum(SCHEDULE_FIXED_EVENT_KINDS).optional(),
    weekday: z.number().int().min(1).max(7).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    query: z.string().trim().max(2000).optional(),
  })
  .strict();

const fixedEventUpsertArgs = z
  .object({
    event_id: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    kind: z.enum(SCHEDULE_FIXED_EVENT_KINDS).optional(),
    weekday: z.number().int().min(1).max(7).nullable().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    location: z.string().trim().max(120).optional(),
    note: z.string().max(10_000).optional(),
    busy: z.boolean().optional(),
  })
  .strict();

const fixedEventDeleteArgs = z
  .object({
    event_id: z.string().trim().min(1).max(200),
  })
  .strict();

const planGetArgs = z
  .object({
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    days: z.number().int().min(1).max(21).optional(),
  })
  .strict();

const planScheduleArgs = z
  .object({
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    days: z.number().int().min(1).max(21).optional(),
    task_ids: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    allow_spill: z.boolean().optional(),
    force_overdue_skip: z.boolean().optional(),
    notes: z.string().max(20_000).optional(),
  })
  .strict();

const planReplanArgs = z
  .object({
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    days: z.number().int().min(1).max(21).optional(),
    task_ids: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    allow_spill: z.boolean().optional(),
    force_overdue_skip: z.boolean().optional(),
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
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    days: z.number().int().min(1).max(21).optional(),
  })
  .strict();

const planEmailArgs = z
  .object({
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    days: z.number().int().min(1).max(21).optional(),
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
    steps: args.steps,
  };
}

const DEFINITIONS: Record<string, LlmToolDefinition> = {
  preferences_get: {
    type: "function",
    function: {
      name: "preferences_get",
      description:
        "Read the user's scheduling preferences and free-form rules. Call this on first contact and before planning; do not guess working hours, breaks, buffer or rules.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  preferences_update: {
    type: "function",
    function: {
      name: "preferences_update",
      description:
        "Update scheduling preferences. Only include fields the user confirmed. bufferRatio and gapMinutes control all padding: 0 means exact back-to-back scheduling with no hidden buffer. Use add_rules/remove_rules to maintain a short list of constraints that cannot be represented structurally (e.g. split rules, semester week rules).",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA timezone." },
          workdays: {
            type: "array",
            items: { type: "integer", minimum: 1, maximum: 7 },
            description: "ISO weekdays, Monday=1 … Sunday=7.",
          },
          workStart: { type: "string", description: "HH:mm." },
          workEnd: { type: "string", description: "HH:mm; must be after workStart." },
          breaks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                start: { type: "string", description: "HH:mm." },
                end: { type: "string", description: "HH:mm; must be after start." },
              },
              required: ["start", "end"],
              additionalProperties: false,
            },
          },
          maxFocusMinutes: { type: "integer", minimum: 15, maximum: 480 },
          minBlockMinutes: { type: "integer", minimum: 5, maximum: 600 },
          bufferRatio: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Extra fraction added to estimates; 0 = exact.",
          },
          gapMinutes: {
            type: "integer",
            minimum: 0,
            maximum: 60,
            description: "Wall-clock minutes between blocks; 0 = back-to-back.",
          },
          dailyFocusLimitMinutes: {
            type: "integer",
            minimum: 30,
            maximum: 1440,
          },
          rules: {
            type: "array",
            items: { type: "string" },
            description: "Replace the full rules list.",
          },
          add_rules: {
            type: "array",
            items: { type: "string" },
            description: "Append rules without replacing existing ones.",
          },
          remove_rules: {
            type: "array",
            items: { type: "string" },
            description: "Remove rules by exact text.",
          },
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
        "Create or update a task. New tasks require title and estimated_minutes. If the estimate, priority or deadline is unclear, ask the user with ask_user_question instead of inventing one. Use add_actual_minutes when the user reports progress; it reduces remaining time and closes the task at zero. Steps are optional: only decompose large or multi-day work where a concrete breakdown helps; omit steps (or pass []) for simple tasks. Each step becomes the note of the block(s) covering it.",
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
          steps: {
            type: "array",
            description:
              "Optional ordered breakdown of the task's work; replaces the current list, [] clears it. Only include when decomposition helps (large or multi-day tasks). Each step is a short concrete action of 5-600 minutes and becomes the note of the block(s) covering it.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description:
                    "Short concrete action, e.g. 精读 3 篇基线论文并整理对比表.",
                },
                minutes: { type: "integer", minimum: 5, maximum: 600 },
              },
              required: ["title", "minutes"],
              additionalProperties: false,
            },
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
        "Delete a task and all of its scheduled blocks. Ask the user with ask_user_question before deleting work history.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
  },
  fixed_event_list: {
    type: "function",
    function: {
      name: "fixed_event_list",
      description:
        "List fixed commitments (weekly courses/meetings or one-off events). Fixed events occupy wall-clock time, need no estimate, and a week containing only fixed events is a valid plan.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...SCHEDULE_FIXED_EVENT_KINDS] },
          weekday: {
            type: "integer",
            minimum: 1,
            maximum: 7,
            description: "Filter weekly events by ISO weekday (1=Monday).",
          },
          date: {
            type: "string",
            description: "Filter one-off events by date (YYYY-MM-DD).",
          },
          query: { type: "string", description: "Free-text search." },
        },
        additionalProperties: false,
      },
    },
  },
  fixed_event_upsert: {
    type: "function",
    function: {
      name: "fixed_event_upsert",
      description:
        "Create or update a fixed commitment (course, meeting, appointment). New events require title, kind (weekly|once), start and end, plus weekday 1-7 (weekly) or date YYYY-MM-DD (once). If any of those are missing or ambiguous, ask the user with ask_user_question instead of guessing. Use this for courses and recurring meetings instead of creating tasks; do not re-create events that fixed_event_list already shows. Set busy=false when the user works through the commitment (e.g. a course they do not listen to): the event stays in the plan but its slot remains schedulable, so task blocks may run in parallel with it.",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "Existing event id to update." },
          title: { type: "string" },
          kind: { type: "string", enum: [...SCHEDULE_FIXED_EVENT_KINDS] },
          weekday: {
            type: "integer",
            minimum: 1,
            maximum: 7,
            description: "ISO weekday 1=Monday … 7=Sunday; required for kind=weekly.",
          },
          date: {
            type: "string",
            description: "YYYY-MM-DD; required for kind=once.",
          },
          start: { type: "string", description: "HH:mm." },
          end: { type: "string", description: "HH:mm; must be after start." },
          location: { type: "string" },
          note: { type: "string" },
          busy: {
            type: "boolean",
            description:
              "Whether the event truly occupies the user (default true). busy=false keeps the slot visible in the plan but schedulable for tasks.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  fixed_event_delete: {
    type: "function",
    function: {
      name: "fixed_event_delete",
      description: "Delete one fixed event by id.",
      parameters: {
        type: "object",
        properties: { event_id: { type: "string" } },
        required: ["event_id"],
        additionalProperties: false,
      },
    },
  },
  plan_get: {
    type: "function",
    function: {
      name: "plan_get",
      description:
        "Read one rolling planning window with block ids, daily grouping, unscheduled tasks, warnings and preferences. Defaults to today through the next 6 days.",
      parameters: {
        type: "object",
        properties: {
          from_date: {
            type: "string",
            description: "First day of the window (YYYY-MM-DD); defaults to today.",
          },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 21,
            description: "Window length in days (default 7).",
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
        "Generate or regenerate a rolling N-day plan starting from today (default) or from_date. Preserves completed blocks, replaces future planned blocks for the selected tasks, respects working hours/breaks, never schedules into time that already passed today, carves out fixed events (courses/meetings) and buffers uncertain estimates. Works with zero tasks: a window with only fixed events still produces an agenda. Renders and saves a PNG automatically. REFUSES with an error while overdue unconfirmed blocks exist (time passed, no recorded outcome): confirm each with the user via ask_user_question, record done/skipped with block_update, then retry. force_overdue_skip=true bypasses the gate only when the user explicitly declines to confirm.",
      parameters: {
        type: "object",
        properties: {
          from_date: {
            type: "string",
            description: "First day of the window (YYYY-MM-DD); defaults to today and cannot be in the past.",
          },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 21,
            description: "Window length in days (default 7).",
          },
          task_ids: {
            type: "array",
            items: { type: "string" },
            description: "Only schedule these tasks; defaults to all active tasks.",
          },
          allow_spill: {
            type: "boolean",
            description: "Allow overflow beyond the window (default true).",
          },
          force_overdue_skip: {
            type: "boolean",
            description:
              "Only set true when the user explicitly declined to confirm the overdue blocks (e.g. 别问了直接排). Overdue unconfirmed blocks are then treated as not done: auto-skipped and their work rescheduled.",
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
        "Replan a rolling window from a date (default today). Keeps completed blocks and moves unfinished work into free slots around fixed events, optionally spilling beyond the window. Renders and saves a PNG agenda automatically. REFUSES with an error while overdue unconfirmed blocks exist (time passed, no recorded outcome): confirm each with the user via ask_user_question, record done/skipped with block_update, then retry. force_overdue_skip=true bypasses the gate only when the user explicitly declines to confirm, and then overdue planned blocks are treated as not done (auto-skipped, work rescheduled).",
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
          force_overdue_skip: {
            type: "boolean",
            description:
              "Only set true when the user explicitly declined to confirm the overdue blocks. They are then auto-skipped and their work rescheduled.",
          },
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
        "Render the rolling agenda to a PNG in data/schedule/exports and return a preview. Defaults to today through the next 6 days. Use when the user wants the image again or after manual edits.",
      parameters: {
        type: "object",
        properties: {
          from_date: {
            type: "string",
            description: "First day of the window (YYYY-MM-DD); defaults to today.",
          },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 21,
            description: "Window length in days (default 7).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  ask_user_question: ASK_USER_QUESTION_DEFINITION,
  plan_email: {
    type: "function",
    function: {
      name: "plan_email",
      description:
        "Email the rolling agenda PNG to the user's configured mailbox. Defaults to today through the next 6 days. Only call when the user explicitly asks to send it. The recipient is fixed in settings and cannot be supplied here.",
      parameters: {
        type: "object",
        properties: {
          from_date: {
            type: "string",
            description: "First day of the window (YYYY-MM-DD); defaults to today.",
          },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 21,
            description: "Window length in days (default 7).",
          },
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
      case "preferences_get":
        return this.preferencesGet(rawArguments);
      case "preferences_update":
        return this.preferencesUpdate(rawArguments, ctx);
      case "task_list":
        return this.taskList(rawArguments);
      case "task_upsert":
        return this.taskUpsert(rawArguments, ctx);
      case "task_delete":
        return this.taskDelete(rawArguments, ctx);
      case "fixed_event_list":
        return this.fixedEventList(rawArguments);
      case "fixed_event_upsert":
        return this.fixedEventUpsert(rawArguments, ctx);
      case "fixed_event_delete":
        return this.fixedEventDelete(rawArguments, ctx);
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
      case "ask_user_question":
        return askUserQuestionResult(rawArguments, {
          sessionId: ctx.session.id,
          toolCallId: ctx.toolCallId,
          messageId: ctx.messageId,
          signal: ctx.signal,
          emit: ctx.emit,
          questions: ctx.questions,
        });
      default:
        return toolError(`Unknown schedule tool: ${name}`);
    }
  }

  private today(): string {
    return todayInTimezone(this.options.store.getPreferences().timezone);
  }

  /** Loads the plan window, tasks, fixed events, summary and agenda in one pass. */
  private loadPlanView(startDate: string, days: number): PlanView {
    const store = this.options.store;
    const preferences = store.getPreferences();
    const endDate = rangeEndOf(startDate, days);
    const window = store.getWindow(startDate, days);
    const tasks = store.listTasks({ includeDone: true, limit: 200 });
    const fixedEvents = store.listFixedEvents();
    const summary =
      window === null
        ? emptySummary(startDate, endDate, preferences.timezone)
        : store.summarizeWindow(window);
    const agenda = buildScheduleAgenda({
      window,
      tasks,
      fixedEvents,
      preferences,
      startDate,
      endDate,
      today: this.today(),
      nowClock: nowClockInTimezone(preferences.timezone),
      summary,
    });
    return { startDate, endDate, window, tasks, fixedEvents, summary, agenda };
  }

  private preferencesGet(raw: string): ToolResult {
    const parsed = parseArgs(preferencesGetArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "preferences" });
    const preferences = this.options.store.getPreferences();
    const configured = this.options.store.getPreferencesMemory() !== undefined;
    return {
      content: formatPreferences(preferences, configured),
      status: "complete",
      meta: {
        kind: "preferences",
        view: "preferences",
        data: { view: "preferences", preferences, configured },
      },
    };
  }

  private async preferencesUpdate(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(preferencesUpdateArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "preferences" });
    const args = parsed.data;
    const current = this.options.store.getPreferences();
    let rules = args.rules ?? current.rules;
    if (args.add_rules !== undefined && args.add_rules.length > 0) {
      rules = [...rules, ...args.add_rules];
    }
    if (args.remove_rules !== undefined && args.remove_rules.length > 0) {
      const remove = new Set(args.remove_rules);
      rules = rules.filter((rule) => !remove.has(rule));
    }
    try {
      const preferences = await this.options.store.updatePreferences({
        timezone: args.timezone,
        workdays: args.workdays,
        workStart: args.workStart,
        workEnd: args.workEnd,
        breaks: args.breaks,
        maxFocusMinutes: args.maxFocusMinutes,
        minBlockMinutes: args.minBlockMinutes,
        bufferRatio: args.bufferRatio,
        gapMinutes: args.gapMinutes,
        dailyFocusLimitMinutes: args.dailyFocusLimitMinutes,
        rules:
          args.rules !== undefined ||
          args.add_rules !== undefined ||
          args.remove_rules !== undefined
            ? rules
            : undefined,
      });
      void this.options.audit.append({
        type: "schedule.preferences.changed",
        sessionId: ctx.session.id,
        action: "updated",
        rules: preferences.rules.length,
        bufferRatio: preferences.bufferRatio,
        gapMinutes: preferences.gapMinutes,
      });
      return {
        content: `已保存排期偏好。\n${formatPreferences(preferences, true)}`,
        status: "complete",
        meta: {
          kind: "preferences",
          view: "preferences",
          data: { view: "preferences", preferences, configured: true },
        },
      };
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : String(error),
        { view: "preferences" },
      );
    }
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

  private fixedEventList(raw: string): ToolResult {
    const parsed = parseArgs(fixedEventListArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "fixed" });
    const args = parsed.data;
    const query = args.query?.trim().toLowerCase();
    const events = this.options.store
      .listFixedEvents()
      .filter((event) => {
        if (args.kind !== undefined && event.kind !== args.kind) return false;
        if (args.weekday !== undefined && event.weekday !== args.weekday) {
          return false;
        }
        if (args.date !== undefined && event.date !== args.date) return false;
        if (query !== undefined && query !== "") {
          const haystack = [event.title, event.location, event.note]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
    if (events.length === 0) {
      return {
        content:
          "没有固定安排。用户提到的固定课程、例会或预约请用 fixed_event_upsert 登记（weekly 需要 weekday 1-7，once 需要 date）。",
        status: "complete",
        meta: {
          kind: "schedule",
          view: "fixed",
          resultCount: 0,
          data: { view: "fixed", fixedEvents: [] },
        },
      };
    }
    return {
      content: truncate(events.map((event) => formatFixedEvent(event)).join("\n\n")),
      status: "complete",
      meta: {
        kind: "schedule",
        view: "fixed",
        resultCount: events.length,
        data: { view: "fixed", fixedEvents: events },
      },
    };
  }

  private async fixedEventUpsert(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(fixedEventUpsertArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "fixed" });
    const args = parsed.data;
    try {
      const { event, created } = await this.options.store.upsertFixedEvent({
        id: args.event_id,
        title: args.title,
        kind: args.kind,
        weekday: args.weekday,
        date: args.date,
        start: args.start,
        end: args.end,
        location: args.location,
        note: args.note,
        busy: args.busy,
      });
      void this.options.audit.append({
        type: "schedule.fixed_event.changed",
        sessionId: ctx.session.id,
        action: created ? "created" : "updated",
        fixedEventId: event.id,
        title: event.title,
      });
      const hint = created
        ? event.busy
          ? "\n固定安排会占用对应时段；用 plan_schedule 重新生成日程即可生效。"
          : "\n该时段仍可安排任务；用 plan_schedule 重新生成日程即可生效。"
        : "";
      return {
        content: `${created ? "Created" : "Updated"} fixed event:\n${formatFixedEvent(event)}${hint}`,
        status: "complete",
        meta: {
          kind: "schedule",
          view: "fixed",
          data: { view: "fixed", fixedEvents: [event], created },
        },
      };
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : String(error),
        { view: "fixed" },
      );
    }
  }

  private async fixedEventDelete(
    raw: string,
    ctx: ScheduleToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(fixedEventDeleteArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "fixed" });
    const existing = this.options.store.getFixedEvent(parsed.data.event_id);
    if (existing === undefined) {
      return toolError(
        `Fixed event not found: ${parsed.data.event_id}`,
        { view: "fixed" },
      );
    }
    const deleted = await this.options.store.deleteFixedEvent(existing.id);
    if (!deleted) {
      return toolError(
        `Fixed event not found: ${parsed.data.event_id}`,
        { view: "fixed" },
      );
    }
    void this.options.audit.append({
      type: "schedule.fixed_event.changed",
      sessionId: ctx.session.id,
      action: "deleted",
      fixedEventId: existing.id,
      title: existing.title,
    });
    return {
      content: `Deleted fixed event ${existing.title} (${existing.id}).`,
      status: "complete",
      meta: {
        kind: "schedule",
        view: "fixed",
        data: { view: "fixed", fixedEvents: [], deletedId: existing.id },
      },
    };
  }

  private planGet(raw: string): ToolResult {
    const parsed = parseArgs(planGetArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { view: "plan" });
    const preferences = this.options.store.getPreferences();
    const today = this.today();
    const view = this.loadPlanView(
      parsed.data.from_date ?? today,
      parsed.data.days ?? 7,
    );
    const overdue = this.options.store.listOverduePlannedBlocks();
    return {
      content: truncate(
        formatPlan(
          view.window,
          view.tasks,
          view.fixedEvents,
          preferences,
          view.summary,
        ) +
          `\n\n历史校准：${JSON.stringify(
            this.options.store.getCalibration(),
          )}` +
          (overdue.length > 0
            ? `\n\n${formatOverdueSection(overdue, view.tasks)}`
            : ""),
      ),
      status: "complete",
      meta: planResultMeta({
        view,
        extra: {
          today,
          data: overdue.length > 0 ? { overdue } : {},
        },
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
      mode: "schedule",
      fromDate: parsed.data.from_date,
      days: parsed.data.days ?? 7,
      taskIds: parsed.data.task_ids,
      allowSpill: parsed.data.allow_spill !== false,
      forceOverdueSkip: parsed.data.force_overdue_skip === true,
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
      forceOverdueSkip: parsed.data.force_overdue_skip === true,
      notes: parsed.data.notes,
      ctx,
    });
  }

  private async runPlanner(input: {
    mode: "schedule" | "replan";
    fromDate?: string;
    days: number;
    taskIds?: string[];
    allowSpill: boolean;
    forceOverdueSkip?: boolean;
    notes?: string;
    ctx: ScheduleToolContext;
  }): Promise<ToolResult> {
    const { ctx } = input;
    const store = this.options.store;
    const preferences = store.getPreferences();
    const today = this.today();

    // Hard gate: planning must not silently auto-skip work whose outcome is
    // unknown. Refuse while any overdue planned block is unconfirmed and make
    // the model reconcile it with the user (ask_user_question + block_update)
    // before retrying. force_overdue_skip is the explicit user-waived escape.
    if (!input.forceOverdueSkip) {
      const overdue = store.listOverduePlannedBlocks();
      if (overdue.length > 0) {
        const tasks = store.listTasks({ includeDone: true, limit: 200 });
        const toolName =
          input.mode === "schedule" ? "plan_schedule" : "plan_replan";
        return toolError(
          [
            `${toolName} 未执行：存在 ${overdue.length} 个过期待确认块（时间已过但未记录完成）。完成情况未知的工作不能被静默跳过或重排。`,
            "",
            formatOverdueSection(overdue, tasks),
            "",
            `确认并用 block_update 记录后重试 ${toolName}。仅当用户明确表示不想逐块确认时，才传 force_overdue_skip=true 按未完成处理并继续。`,
          ].join("\n"),
          { view: "plan", overdue },
        );
      }
    }

    // A rolling window always starts now or later. Requested past dates are
    // clamped to today instead of erroring so the model can recover.
    const startDate = maxDate(input.fromDate ?? today, today);
    const windowEnd = rangeEndOf(startDate, input.days);
    const endDate = addDays(windowEnd, input.allowSpill ? 7 : 0);

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
    // A window containing only fixed commitments (courses, meetings) is a
    // valid plan: generate the fixed-only agenda instead of refusing.
    const fixedOnlyWindow = active.length === 0;
    if (fixedOnlyWindow) {
      let hasFixedEvents = false;
      for (
        let date = startDate;
        compareDates(date, windowEnd) <= 0;
        date = addDays(date, 1)
      ) {
        if (store.fixedEventsForDate(date).length > 0) {
          hasFixedEvents = true;
          break;
        }
      }
      if (!hasFixedEvents) {
        return {
          content:
            "没有需要排期的任务，这个时间窗口也没有登记固定安排。可以先用 fixed_event_upsert 登记固定课程/会议（无需估时），或用 task_upsert 添加需要排期的任务。",
          status: "complete",
          meta: {
            kind: "schedule",
            view: "plan",
            data: { view: "plan", agenda: null, window: null },
          },
        };
      }
    }

    const included = new Set(active.map((task) => task.id));
    const removeFromDate = startDate;
    const storedPlans = store.listPlans();
    const allBlocks = storedPlans.flatMap((plan) => plan.blocks);
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
      nowClock: nowClockInTimezone(preferences.timezone),
      tasks: active,
      existingBlocks,
      fixedEvents: store.listFixedEvents(),
      preferences,
      committedMinutesByTask,
    });

    if (store.getPreferencesMemory() === undefined) {
      result.warnings.unshift(
        "尚未配置排期偏好，已使用默认的工作日与工作时段。请向用户确认工作时段、休息时间和每日专注上限，并用 preferences_update 保存。",
      );
    }
    const weeks = new Set<string>();
    for (const block of result.blocks) weeks.add(mondayOf(block.date));
    const startWeek = mondayOf(startDate);
    weeks.add(startWeek);
    // Attach the window-level metadata to every ISO week the planning range
    // touches. A rolling window can start on any weekday, so anchoring it to a
    // single week would hide unscheduled work when the user looks at a window
    // that starts in the other week. getWindow dedupes repeated entries.
    const planMeta = new Map<
      string,
      { unscheduled?: typeof result.unscheduled; warnings?: string[]; notes?: string }
    >();
    for (
      let date = startDate;
      compareDates(date, endDate) <= 0;
      date = addDays(date, 1)
    ) {
      planMeta.set(mondayOf(date), {
        unscheduled: result.unscheduled,
        warnings: result.warnings,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
    }

    // Snapshot the overdue blocks of the tasks this run replaces, so the
    // result can report what applySchedule silently auto-skips or removes.
    const overdueBefore = store
      .listOverduePlannedBlocks()
      .filter((block) => included.has(block.taskId));
    const overdueSkipped = overdueBefore.filter(
      (block) => compareDates(block.date, today) < 0,
    );
    const overdueTodayCount = overdueBefore.length - overdueSkipped.length;
    const overdueSkippedMinutes = overdueSkipped.reduce(
      (total, block) => total + durationMinutes(block.start, block.end),
      0,
    );

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
      action: input.mode === "schedule" ? "scheduled" : "replanned",
      weeks: [...weeks],
      blocks: result.blocks.length,
      unscheduled: result.unscheduled.length,
    });

    const view = this.loadPlanView(startDate, input.days);
    const render = await this.renderPlanView(view, ctx);
    const spillBlocks = result.blocks.filter(
      (block) => compareDates(block.date, windowEnd) > 0,
    ).length;
    const affected = updatedPlans
      .map((candidate) => `${candidate.weekStart}(${candidate.blocks.length} blocks)`)
      .join(", ");
    const content = [
      fixedOnlyWindow
        ? `这个时间窗口没有需要排期的科研任务；已生成仅含固定安排（课程/会议）的议程，科研任务补充后用 plan_schedule 重新生成即可排入空闲时段。`
        : input.mode === "schedule"
          ? `已生成 ${startDate} 起的 ${input.days} 天滚动日程。`
          : `已从 ${startDate} 起重排未完成工作（${input.days} 天窗口）。`,
      `生成 ${result.blocks.length} 个 block，涉及 ${weeks.size} 个 ISO 周：${affected}。`,
      spillBlocks > 0
        ? `其中 ${spillBlocks} 个 block 排在 ${windowEnd} 之后（窗口外溢出）。`
        : "",
      overdueBefore.length > 0
        ? `已将 ${overdueSkipped.length} 个过期未记录块按未完成标记为跳过（force_overdue_skip）${
            overdueTodayCount > 0
              ? `，另有 ${overdueTodayCount} 个今日已过时间的块已删除重排`
              : ""
          }，涉及约 ${formatMinutes(
            overdueSkippedMinutes,
          )}，工作量已保留并将重排。如其中有些实际已完成，可用 block_update 改为 done，或用 task_upsert 补记实际用时。`
        : "",
      render !== null
        ? `日程 PNG 已保存：${render.filePath}`
        : "计划已保存，但 PNG 渲染失败；可稍后用 plan_render 重试。",
      "",
      formatPlan(
        view.window,
        view.tasks,
        view.fixedEvents,
        preferences,
        view.summary,
      ),
    ]
      .filter((line) => line !== "")
      .join("\n");

    return {
      content: truncate(content),
      status: "complete",
      meta: {
        ...planResultMeta({
          view,
          extra: {
            today,
            filePath: render?.filePath,
            width: render?.width,
            height: render?.height,
            affectedWeeks: [...weeks],
            spillBlocks,
            data: {
              affectedWeeks: [...weeks],
              spillBlocks,
              filePath: render?.filePath,
            },
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

      const today = this.today();
      const days = 7;
      const todayWindowEnd = rangeEndOf(today, days);
      const windowStart =
        compareDates(block.date, today) < 0 ||
        compareDates(block.date, todayWindowEnd) <= 0
          ? today
          : addDays(block.date, -(days - 1));
      const view = this.loadPlanView(windowStart, days);
      return {
        content: `Updated block ${block.id}: ${block.date} ${block.start}-${block.end} · ${block.status}${
          task === undefined
            ? ""
            : `\nTask: ${formatTask(task)}\nRemaining work changed; call plan_replan if the rest of the window should be compacted or pushed back.`
        }`,
        status: "complete",
        meta: planResultMeta({
          view,
          extra: { today, data: { block, previous: before.block } },
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
    const startDate = parsed.data.from_date ?? this.today();
    const days = parsed.data.days ?? 7;
    const view = this.loadPlanView(startDate, days);
    const render = await this.renderPlanView(view, ctx);
    if (render === null) {
      return toolError("渲染 PNG 失败。", { view: "plan" });
    }
    return {
      content: `Rendered ${render.width}×${render.height} PNG for ${view.startDate} ~ ${view.endDate}:\n${render.filePath}`,
      status: "complete",
      meta: {
        ...planResultMeta({
          view,
          extra: {
            filePath: render.filePath,
            width: render.width,
            height: render.height,
            data: {
              filePath: render.filePath,
              width: render.width,
              height: render.height,
            },
          },
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
    const startDate = parsed.data.from_date ?? this.today();
    const days = parsed.data.days ?? 7;
    const view = this.loadPlanView(startDate, days);
    if (view.window === null) {
      return toolError(
        `这个时间窗口还没有计划：${view.startDate} ~ ${view.endDate}。先用 plan_schedule 生成计划。`,
        { view: "plan" },
      );
    }
    const render = await this.renderPlanView(view, ctx);
    if (render === null) {
      return toolError("渲染日程 PNG 失败，未发送邮件。", { view: "plan" });
    }
    try {
      const result = await this.options.email.sendPlan({
        window: view.window,
        agenda: view.agenda,
        summary: view.summary,
        png: render.buffer,
        fileName: `codefly-agenda-${view.startDate}.png`,
        note: parsed.data.note,
      });
      void this.options.audit.append({
        type: "schedule.email.sent",
        sessionId: ctx.session.id,
        rangeStart: view.startDate,
        rangeEnd: view.endDate,
        to: result.to,
        messageId: result.messageId,
        imagePath: render.filePath,
      });
      return {
        content: `已把 ${view.startDate} ~ ${view.endDate} 的日程发送到 ${result.to}（messageId: ${
          result.messageId ?? "n/a"
        }）。附件：${render.filePath}`,
        status: "complete",
        meta: {
          ...planResultMeta({
            view,
            extra: {
              filePath: render.filePath,
              emailedTo: result.to,
              data: {
                filePath: render.filePath,
                emailedTo: result.to,
                messageId: result.messageId,
              },
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

  private async renderPlanView(
    view: PlanView,
    ctx: ScheduleToolContext,
  ): Promise<RenderAgendaResult | null> {
    try {
      ctx.progress("正在渲染日程议程…");
      return await renderAgendaPng({
        agenda: view.agenda,
        outputDir: this.options.store.getExportsDir(),
      });
    } catch (error) {
      console.error("[schedule] render failed", error);
      return null;
    }
  }
}
