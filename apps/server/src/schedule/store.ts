import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SCHEDULE_BLOCK_STATUSES,
  SCHEDULE_CONFIDENCE,
  SCHEDULE_FIXED_EVENT_KINDS,
  SCHEDULE_MEMORY_CATEGORIES,
  SCHEDULE_PLAN_STATUSES,
  SCHEDULE_PRIORITIES,
  SCHEDULE_TASK_STATUSES,
  SCHEDULE_TIMES_OF_DAY,
  type ScheduleBlock,
  type ScheduleBlockStatus,
  type ScheduleCalibration,
  type ScheduleConfidence,
  type ScheduleFixedEvent,
  type ScheduleFixedEventInput,
  type ScheduleFixedEventKind,
  type ScheduleMemory,
  type ScheduleMemoryCategory,
  type ScheduleOverview,
  type SchedulePlan,
  type SchedulePlanStatus,
  type SchedulePlanSummary,
  type SchedulePreferences,
  type SchedulePriority,
  type ScheduleTask,
  type ScheduleTaskInput,
  type ScheduleTaskStatus,
  type ScheduleTaskStep,
  type ScheduleTimeOfDay,
  type ScheduleUnscheduledTask,
  type ScheduleWindow,
} from "@codefly/protocol";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { AppError, isNotFound } from "../http/errors.js";
import { buildScheduleAgenda } from "./agenda.js";
import {
  addDays,
  clockToMinutes,
  compareDates,
  durationMinutes,
  isValidClock,
  isValidDate,
  isValidTimezone,
  mondayOf,
  nowClockInTimezone,
  nowMinutesInTimezone,
  rangeEndOf,
  serverTimezone,
  todayInTimezone,
  weekEndOf,
  weekdayOf,
} from "./time.js";

export const PREFERENCES_MEMORY_KEY = "scheduling_preferences";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface MemoryFile {
  version?: unknown;
  memories?: unknown;
}
interface TaskFile {
  version?: unknown;
  tasks?: unknown;
}
interface PlanFile {
  version?: unknown;
  plans?: unknown;
}
interface FixedEventFile {
  version?: unknown;
  events?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asStringArray(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed.slice(0, 120));
    if (result.length >= max) break;
  }
  return result;
}

/** Normalizes the free-form scheduling rules kept in preferences. */
function asRuleArray(value: unknown, max = 50): string[] {
  const entries =
    typeof value === "string"
      ? value.split(/\r?\n/)
      : Array.isArray(value)
        ? value
        : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, 2000);
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= max) break;
  }
  return result;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.round(asNumber(value, fallback));
  return Math.min(max, Math.max(min, parsed));
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isCategory(value: unknown): value is ScheduleMemoryCategory {
  return SCHEDULE_MEMORY_CATEGORIES.includes(value as ScheduleMemoryCategory);
}

function isPriority(value: unknown): value is SchedulePriority {
  return SCHEDULE_PRIORITIES.includes(value as SchedulePriority);
}

function isTaskStatus(value: unknown): value is ScheduleTaskStatus {
  return SCHEDULE_TASK_STATUSES.includes(value as ScheduleTaskStatus);
}

function isConfidence(value: unknown): value is ScheduleConfidence {
  return SCHEDULE_CONFIDENCE.includes(value as ScheduleConfidence);
}

function isBlockStatus(value: unknown): value is ScheduleBlockStatus {
  return SCHEDULE_BLOCK_STATUSES.includes(value as ScheduleBlockStatus);
}

function isPlanStatus(value: unknown): value is SchedulePlanStatus {
  return SCHEDULE_PLAN_STATUSES.includes(value as SchedulePlanStatus);
}

function isTimeOfDay(value: unknown): value is ScheduleTimeOfDay {
  return SCHEDULE_TIMES_OF_DAY.includes(value as ScheduleTimeOfDay);
}

function isFixedEventKind(value: unknown): value is ScheduleFixedEventKind {
  return SCHEDULE_FIXED_EVENT_KINDS.includes(value as ScheduleFixedEventKind);
}

function slugify(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return ascii !== "" ? ascii : `memory-${randomUUID().slice(0, 8)}`;
}

function copyMemory(memory: ScheduleMemory): ScheduleMemory {
  return {
    ...memory,
    data: memory.data === null ? null : structuredClone(memory.data),
    tags: [...memory.tags],
  };
}

function copyTask(task: ScheduleTask): ScheduleTask {
  return {
    ...task,
    steps: task.steps.map((step) => ({ ...step })),
  };
}

function copyBlock(block: ScheduleBlock): ScheduleBlock {
  return { ...block };
}

function copyPlan(plan: SchedulePlan): SchedulePlan {
  return {
    ...plan,
    blocks: plan.blocks.map(copyBlock),
    unscheduled: plan.unscheduled.map((item) => ({ ...item })),
    warnings: [...plan.warnings],
  };
}

function normalizeMemory(raw: unknown): ScheduleMemory | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id).trim();
  const key = asString(raw.key).trim();
  const title = asString(raw.title).trim();
  if (id === "" || key === "" || title === "") return null;
  const now = new Date().toISOString();
  return {
    id,
    key: key.slice(0, 120),
    category: isCategory(raw.category) ? raw.category : "context",
    title: title.slice(0, 300),
    content: asString(raw.content).slice(0, 200_000),
    data: isRecord(raw.data) ? structuredClone(raw.data) : null,
    tags: asStringArray(raw.tags),
    pinned: asBoolean(raw.pinned),
    createdAt: asNullableString(raw.createdAt) ?? now,
    updatedAt: asNullableString(raw.updatedAt) ?? now,
  };
}

/**
 * Normalizes an optional task breakdown. Missing ids are generated; duplicate
 * ids are replaced so every step stays addressable from scheduled blocks.
 */
function normalizeSteps(raw: unknown): ScheduleTaskStep[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const steps: ScheduleTaskStep[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    // Step titles are rendered inline as block notes, so keep them single-line.
    const title = asString(entry.title).replace(/\s+/g, " ").trim();
    if (title === "") continue;
    let id = asString(entry.id).trim();
    if (id === "" || seen.has(id)) id = `step_${randomUUID()}`;
    seen.add(id);
    steps.push({
      id: id.slice(0, 200),
      title: title.slice(0, 200),
      minutes: asInt(entry.minutes, 30, 5, 600),
    });
    if (steps.length >= 100) break;
  }
  return steps;
}

function normalizeTask(raw: unknown): ScheduleTask | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id).trim();
  const title = asString(raw.title).trim();
  if (id === "" || title === "") return null;
  const now = new Date().toISOString();
  const estimated = asInt(raw.estimatedMinutes, 60, 1, 100_000);
  const status = isTaskStatus(raw.status) ? raw.status : "todo";
  const remaining = asInt(
    raw.remainingMinutes,
    status === "done" ? 0 : estimated,
    0,
    100_000,
  );
  const deadline = asNullableString(raw.deadline);
  return {
    id,
    title: title.slice(0, 300),
    notes: asString(raw.notes).slice(0, 100_000),
    project: asNullableString(raw.project)?.slice(0, 120) ?? null,
    priority: isPriority(raw.priority) ? raw.priority : "medium",
    status,
    estimatedMinutes: estimated,
    remainingMinutes: status === "done" ? 0 : remaining,
    actualMinutes: asInt(raw.actualMinutes, 0, 0, 1_000_000),
    estimateConfidence: isConfidence(raw.estimateConfidence)
      ? raw.estimateConfidence
      : "medium",
    deadline:
      deadline !== null && isValidDate(deadline) ? deadline : null,
    splittable: asBoolean(raw.splittable, true),
    minBlockMinutes: asInt(raw.minBlockMinutes, 30, 5, 600),
    preferredTimeOfDay: isTimeOfDay(raw.preferredTimeOfDay)
      ? raw.preferredTimeOfDay
      : "any",
    steps: normalizeSteps(raw.steps),
    createdAt: asNullableString(raw.createdAt) ?? now,
    updatedAt: asNullableString(raw.updatedAt) ?? now,
  };
}

function normalizeBlock(raw: unknown): ScheduleBlock | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id).trim();
  const taskId = asString(raw.taskId).trim();
  const date = asString(raw.date);
  const start = asString(raw.start);
  const end = asString(raw.end);
  if (
    id === "" ||
    taskId === "" ||
    !isValidDate(date) ||
    !isValidClock(start) ||
    !isValidClock(end) ||
    clockToMinutes(end) <= clockToMinutes(start)
  ) {
    return null;
  }
  return {
    id,
    taskId,
    date,
    start,
    end,
    status: isBlockStatus(raw.status) ? raw.status : "planned",
    actualMinutes:
      typeof raw.actualMinutes === "number" &&
      Number.isFinite(raw.actualMinutes) &&
      raw.actualMinutes >= 0
        ? Math.round(raw.actualMinutes)
        : null,
    note: asString(raw.note).slice(0, 10_000),
    stepId: asNullableString(raw.stepId)?.slice(0, 200) ?? null,
  };
}

function normalizeUnscheduled(raw: unknown): ScheduleUnscheduledTask | null {
  if (!isRecord(raw)) return null;
  const taskId = asString(raw.taskId).trim();
  const title = asString(raw.title).trim();
  if (taskId === "" || title === "") return null;
  return {
    taskId,
    title,
    remainingMinutes: asInt(raw.remainingMinutes, 0, 0, 100_000),
    reason: asString(raw.reason).slice(0, 2_000),
  };
}

function normalizePlan(raw: unknown): SchedulePlan | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id).trim();
  const weekStartRaw = asString(raw.weekStart);
  if (id === "" || !isValidDate(weekStartRaw)) return null;
  const weekStart = mondayOf(weekStartRaw);
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const blocks: ScheduleBlock[] = [];
  for (const entry of Array.isArray(raw.blocks) ? raw.blocks : []) {
    const block = normalizeBlock(entry);
    if (block === null || seen.has(block.id)) continue;
    seen.add(block.id);
    blocks.push(block);
  }
  blocks.sort(
    (a, b) =>
      compareDates(a.date, b.date) ||
      clockToMinutes(a.start) - clockToMinutes(b.start),
  );
  return {
    id,
    weekStart,
    weekEnd: weekEndOf(weekStart),
    timezone:
      typeof raw.timezone === "string" && isValidTimezone(raw.timezone)
        ? raw.timezone
        : serverTimezone(),
    status: isPlanStatus(raw.status) ? raw.status : "active",
    blocks,
    unscheduled: (Array.isArray(raw.unscheduled) ? raw.unscheduled : [])
      .map(normalizeUnscheduled)
      .filter((item): item is ScheduleUnscheduledTask => item !== null),
    warnings: asStringArray(raw.warnings, 100),
    notes: asString(raw.notes).slice(0, 20_000),
    createdAt: asNullableString(raw.createdAt) ?? now,
    updatedAt: asNullableString(raw.updatedAt) ?? now,
  };
}

function normalizeFixedEvent(raw: unknown): ScheduleFixedEvent | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id).trim();
  const title = asString(raw.title).trim();
  const kind = isFixedEventKind(raw.kind) ? raw.kind : null;
  const start = asString(raw.start);
  const end = asString(raw.end);
  if (
    id === "" ||
    title === "" ||
    kind === null ||
    !isValidClock(start) ||
    !isValidClock(end) ||
    clockToMinutes(end) <= clockToMinutes(start)
  ) {
    return null;
  }
  const weekday =
    kind === "weekly" && Number.isInteger(raw.weekday) &&
    (raw.weekday as number) >= 1 &&
    (raw.weekday as number) <= 7
      ? (raw.weekday as number)
      : null;
  const dateRaw = asNullableString(raw.date);
  const date = kind === "once" && dateRaw !== null && isValidDate(dateRaw) ? dateRaw : null;
  if (kind === "weekly" && weekday === null) return null;
  if (kind === "once" && date === null) return null;
  const now = new Date().toISOString();
  return {
    id,
    title: title.slice(0, 300),
    kind,
    weekday,
    date,
    start,
    end,
    location: asString(raw.location).slice(0, 120),
    note: asString(raw.note).slice(0, 10_000),
    busy: asBoolean(raw.busy, true),
    createdAt: asNullableString(raw.createdAt) ?? now,
    updatedAt: asNullableString(raw.updatedAt) ?? now,
  };
}

function copyFixedEvent(event: ScheduleFixedEvent): ScheduleFixedEvent {
  return { ...event };
}

export function defaultPreferences(timezone = serverTimezone()): SchedulePreferences {
  return {
    timezone,
    workdays: [1, 2, 3, 4, 5],
    workStart: "09:00",
    workEnd: "18:00",
    breaks: [{ label: "午休", start: "12:00", end: "13:00" }],
    maxFocusMinutes: 90,
    minBlockMinutes: 30,
    // No hidden padding: the planner schedules exactly the remaining minutes
    // unless the user explicitly opts into a buffer.
    bufferRatio: 0,
    gapMinutes: 0,
    dailyFocusLimitMinutes: 480,
    rules: [],
  };
}

/** Human-readable one-line summary persisted as the preference document text. */
export function formatPreferencesSummary(
  preferences: SchedulePreferences,
): string {
  const buffer = Math.round(preferences.bufferRatio * 100);
  const rules =
    preferences.rules.length > 0 ? ` · 规则 ${preferences.rules.length} 条` : "";
  return [
    `工作日 ${preferences.workdays.join(",")}`,
    `${preferences.workStart}-${preferences.workEnd}`,
    `最长专注 ${preferences.maxFocusMinutes}m`,
    `每日上限 ${preferences.dailyFocusLimitMinutes}m`,
    `缓冲 ${buffer}%`,
    `块间隙 ${preferences.gapMinutes}m`,
  ].join(" · ") + rules;
}

/** Merges stored preference fields over defaults; invalid fields are ignored. */
export function normalizePreferences(
  raw: unknown,
  fallbackTimezone = serverTimezone(),
): SchedulePreferences {
  const defaults = defaultPreferences(fallbackTimezone);
  if (!isRecord(raw)) return defaults;

  const timezone =
    typeof raw.timezone === "string" && isValidTimezone(raw.timezone)
      ? raw.timezone
      : defaults.timezone;
  const workdays = Array.isArray(raw.workdays)
    ? [...new Set(raw.workdays)]
        .filter((day): day is number => Number.isInteger(day) && day >= 1 && day <= 7)
        .sort((a, b) => a - b)
    : [];
  const workStart =
    typeof raw.workStart === "string" && isValidClock(raw.workStart)
      ? raw.workStart
      : defaults.workStart;
  const workEnd =
    typeof raw.workEnd === "string" &&
    isValidClock(raw.workEnd) &&
    clockToMinutes(raw.workEnd) > clockToMinutes(workStart)
      ? raw.workEnd
      : defaults.workEnd;
  const breaks = (Array.isArray(raw.breaks) ? raw.breaks : [])
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const start = asString(entry.start);
      const end = asString(entry.end);
      if (
        !isValidClock(start) ||
        !isValidClock(end) ||
        clockToMinutes(end) <= clockToMinutes(start) ||
        clockToMinutes(start) < clockToMinutes(workStart) ||
        clockToMinutes(end) > clockToMinutes(workEnd)
      ) {
        return null;
      }
      return {
        label: asString(entry.label, "休息").slice(0, 40) || "休息",
        start,
        end,
      };
    })
    .filter((entry): entry is SchedulePreferences["breaks"][number] => entry !== null)
    .sort((a, b) => clockToMinutes(a.start) - clockToMinutes(b.start));

  const maxFocusMinutes = asInt(raw.maxFocusMinutes, defaults.maxFocusMinutes, 15, 480);
  const minBlockMinutes = Math.min(
    maxFocusMinutes,
    asInt(raw.minBlockMinutes, defaults.minBlockMinutes, 5, 600),
  );
  return {
    timezone,
    workdays: workdays.length > 0 ? workdays : defaults.workdays,
    workStart,
    workEnd,
    // An explicitly empty breaks array means "no breaks"; only a missing
    // field falls back to the built-in lunch break.
    breaks: Array.isArray(raw.breaks) ? breaks : defaults.breaks,
    maxFocusMinutes,
    minBlockMinutes,
    bufferRatio: Math.min(1, Math.max(0, asNumber(raw.bufferRatio, defaults.bufferRatio))),
    gapMinutes: asInt(raw.gapMinutes, defaults.gapMinutes, 0, 60),
    dailyFocusLimitMinutes: asInt(
      raw.dailyFocusLimitMinutes,
      defaults.dailyFocusLimitMinutes,
      30,
      1440,
    ),
    rules: asRuleArray(raw.rules),
  };
}

export interface MemoryQuery {
  query?: string;
  key?: string;
  category?: ScheduleMemoryCategory;
  tags?: string[];
  limit?: number;
}

/** Fields accepted by updatePreferences; omitted fields keep their value. */
export interface SchedulePreferencesPatch {
  timezone?: string;
  workdays?: number[];
  workStart?: string;
  workEnd?: string;
  breaks?: Array<{ label?: string; start: string; end: string }>;
  maxFocusMinutes?: number;
  minBlockMinutes?: number;
  bufferRatio?: number;
  gapMinutes?: number;
  dailyFocusLimitMinutes?: number;
  rules?: string[];
}

export interface TaskQuery {
  status?: ScheduleTaskStatus;
  includeDone?: boolean;
  project?: string;
  query?: string;
  limit?: number;
}

export interface BlockUpdate {
  status?: ScheduleBlockStatus;
  actualMinutes?: number | null;
  note?: string;
  date?: string;
  start?: string;
  end?: string;
}

export interface ScheduleApplyInput {
  /** Ids whose future planned blocks should be replaced. */
  taskIds: string[];
  /** Planned blocks on/after this date are removed and regenerated. */
  removeFromDate: string;
  /**
   * Planned blocks before this date are marked skipped (they are overdue).
   * Blocks between this date and `removeFromDate` stay committed.
   */
  skipBeforeDate: string | null;
  addBlocks: ScheduleBlock[];
  /** Per-week metadata for plans touched by this run. */
  planMeta?: Map<string, { unscheduled?: ScheduleUnscheduledTask[]; warnings?: string[]; notes?: string }>;
}

/**
 * Global structured store for schedule memories, tasks and weekly plans.
 * Every file is rewritten atomically and writes within one file are ordered.
 */
export class ScheduleStore {
  private readonly memories = new Map<string, ScheduleMemory>();
  private readonly tasks = new Map<string, ScheduleTask>();
  private readonly plans = new Map<string, SchedulePlan>();
  private readonly fixedEvents = new Map<string, ScheduleFixedEvent>();
  private readonly exportsDir: string;
  private readonly memoriesFile: string;
  private readonly memoriesLegacyFile: string;
  private readonly tasksFile: string;
  private readonly plansFile: string;
  private readonly fixedEventsFile: string;
  private memoryQueue: Promise<void> = Promise.resolve();
  private taskQueue: Promise<void> = Promise.resolve();
  private planQueue: Promise<void> = Promise.resolve();
  private fixedEventQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    const root = path.join(dataDir, "schedule");
    this.memoriesFile = path.join(root, "memories.json");
    this.memoriesLegacyFile = path.join(root, "memories.legacy.json");
    this.tasksFile = path.join(root, "tasks.json");
    this.plansFile = path.join(root, "plans.json");
    this.fixedEventsFile = path.join(root, "fixed-events.json");
    this.exportsDir = path.join(root, "exports");
  }

  async init(): Promise<void> {
    await mkdir(this.exportsDir, { recursive: true });
    await this.loadMemories();
    await this.loadTasks();
    await this.loadPlans();
    await this.loadFixedEvents();
    await this.migrateFixedCommitmentMemories();
    await this.consolidateLegacyMemories();
    // Plans may reference a deleted task; keep blocks for history, but make
    // sure a plan's week is always canonical after loading.
    for (const plan of this.plans.values()) {
      plan.weekEnd = weekEndOf(plan.weekStart);
    }
  }

  getExportsDir(): string {
    return this.exportsDir;
  }

  private async loadMemories(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.memoriesFile, "utf8");
    } catch (error) {
      if (!isNotFound(error)) console.error("[schedule] cannot read memories.json");
      return;
    }
    try {
      const parsed = JSON.parse(raw) as MemoryFile;
      const keys = new Set<string>();
      for (const entry of Array.isArray(parsed.memories) ? parsed.memories : []) {
        const memory = normalizeMemory(entry);
        if (memory === null || this.memories.has(memory.id) || keys.has(memory.key)) {
          continue;
        }
        keys.add(memory.key);
        this.memories.set(memory.id, memory);
      }
    } catch {
      console.error("[schedule] ignoring corrupt memories.json");
    }
  }

  private async loadTasks(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.tasksFile, "utf8");
    } catch (error) {
      if (!isNotFound(error)) console.error("[schedule] cannot read tasks.json");
      return;
    }
    try {
      const parsed = JSON.parse(raw) as TaskFile;
      for (const entry of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
        const task = normalizeTask(entry);
        if (task === null || this.tasks.has(task.id)) continue;
        this.tasks.set(task.id, task);
      }
    } catch {
      console.error("[schedule] ignoring corrupt tasks.json");
    }
  }

  private async loadPlans(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.plansFile, "utf8");
    } catch (error) {
      if (!isNotFound(error)) console.error("[schedule] cannot read plans.json");
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PlanFile;
      for (const entry of Array.isArray(parsed.plans) ? parsed.plans : []) {
        const plan = normalizePlan(entry);
        if (plan === null) continue;
        const current = this.plans.get(plan.weekStart);
        if (current === undefined || current.updatedAt <= plan.updatedAt) {
          this.plans.set(plan.weekStart, plan);
        }
      }
    } catch {
      console.error("[schedule] ignoring corrupt plans.json");
    }
  }

  private async loadFixedEvents(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.fixedEventsFile, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        console.error("[schedule] cannot read fixed-events.json");
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as FixedEventFile;
      for (const entry of Array.isArray(parsed.events) ? parsed.events : []) {
        const event = normalizeFixedEvent(entry);
        if (event === null || this.fixedEvents.has(event.id)) continue;
        this.fixedEvents.set(event.id, event);
      }
    } catch {
      console.error("[schedule] ignoring corrupt fixed-events.json");
    }
  }

  // ---------------------------------------------------------------- memories

  listMemories(query: MemoryQuery = {}): ScheduleMemory[] {
    const text = query.query?.trim().toLowerCase();
    const tags = new Set((query.tags ?? []).map((tag) => tag.toLowerCase()));
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return [...this.memories.values()]
      .filter((memory) => {
        if (query.key !== undefined && memory.key !== query.key) return false;
        if (query.category !== undefined && memory.category !== query.category) {
          return false;
        }
        if (tags.size > 0) {
          const own = new Set(memory.tags.map((tag) => tag.toLowerCase()));
          for (const tag of tags) if (!own.has(tag)) return false;
        }
        if (text !== undefined && text !== "") {
          const haystack = [
            memory.key,
            memory.title,
            memory.content,
            memory.tags.join(" "),
            memory.data === null ? "" : JSON.stringify(memory.data),
          ]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit)
      .map(copyMemory);
  }

  getMemory(id: string): ScheduleMemory | undefined {
    const memory = this.memories.get(id);
    return memory === undefined ? undefined : copyMemory(memory);
  }

  getMemoryByKey(key: string): ScheduleMemory | undefined {
    for (const memory of this.memories.values()) {
      if (memory.key === key) return copyMemory(memory);
    }
    return undefined;
  }

  async createMemory(input: {
    key?: string;
    category?: ScheduleMemoryCategory;
    title: string;
    content?: string;
    data?: Record<string, unknown> | null;
    tags?: string[];
    pinned?: boolean;
  }): Promise<ScheduleMemory> {
    const key = (input.key?.trim() || slugify(input.title)).slice(0, 120);
    if (this.getMemoryByKey(key) !== undefined) {
      throw new AppError(
        "DUPLICATE_MEMORY_KEY",
        `memory key already exists: ${key}`,
        409,
      );
    }
    const now = new Date().toISOString();
    const memory: ScheduleMemory = {
      id: `mem_${randomUUID()}`,
      key,
      category: input.category ?? "context",
      title: input.title.trim().slice(0, 300),
      content: (input.content ?? "").slice(0, 200_000),
      data: input.data === undefined || input.data === null ? null : structuredClone(input.data),
      tags: asStringArray(input.tags ?? []),
      pinned: input.pinned === true,
      createdAt: now,
      updatedAt: now,
    };
    this.memories.set(memory.id, memory);
    await this.persistMemories();
    return copyMemory(memory);
  }

  async updateMemory(
    id: string,
    patch: {
      key?: string;
      category?: ScheduleMemoryCategory;
      title?: string;
      content?: string;
      data?: Record<string, unknown> | null;
      tags?: string[];
      pinned?: boolean;
    },
  ): Promise<ScheduleMemory> {
    const memory = this.memories.get(id);
    if (memory === undefined) {
      throw new AppError("MEMORY_NOT_FOUND", `unknown memory: ${id}`, 404);
    }
    if (patch.key !== undefined && patch.key !== memory.key) {
      const key = patch.key.trim().slice(0, 120);
      if (key === "") {
        throw new AppError("INVALID_MEMORY_KEY", "memory key must not be empty", 400);
      }
      const existing = this.getMemoryByKey(key);
      if (existing !== undefined && existing.id !== id) {
        throw new AppError(
          "DUPLICATE_MEMORY_KEY",
          `memory key already exists: ${key}`,
          409,
        );
      }
      memory.key = key;
    }
    if (patch.category !== undefined) memory.category = patch.category;
    if (patch.title !== undefined) memory.title = patch.title.trim().slice(0, 300);
    if (patch.content !== undefined) memory.content = patch.content.slice(0, 200_000);
    if (patch.data !== undefined) {
      memory.data = patch.data === null ? null : structuredClone(patch.data);
    }
    if (patch.tags !== undefined) memory.tags = asStringArray(patch.tags);
    if (patch.pinned !== undefined) memory.pinned = patch.pinned;
    memory.updatedAt = new Date().toISOString();
    await this.persistMemories();
    return copyMemory(memory);
  }

  async upsertMemory(input: {
    id?: string;
    key?: string;
    category?: ScheduleMemoryCategory;
    title?: string;
    content?: string;
    data?: Record<string, unknown> | null;
    tags?: string[];
    pinned?: boolean;
  }): Promise<{ memory: ScheduleMemory; created: boolean }> {
    let existing = input.id === undefined ? undefined : this.getMemory(input.id);
    if (existing === undefined && input.key !== undefined) {
      existing = this.getMemoryByKey(input.key);
    }
    if (existing !== undefined) {
      const memory = await this.updateMemory(existing.id, {
        key: input.key,
        category: input.category,
        title: input.title,
        content: input.content,
        data: input.data,
        tags: input.tags,
        pinned: input.pinned,
      });
      return { memory, created: false };
    }
    const memory = await this.createMemory({
      key: input.key,
      category: input.category,
      title: input.title ?? input.key ?? "新记忆",
      content: input.content,
      data: input.data,
      tags: input.tags,
      pinned: input.pinned,
    });
    return { memory, created: true };
  }

  async deleteMemory(idOrKey: string): Promise<boolean> {
    let memory = this.memories.get(idOrKey);
    if (memory === undefined) {
      memory = [...this.memories.values()].find(
        (candidate) => candidate.key === idOrKey,
      );
    }
    if (memory === undefined) return false;
    this.memories.delete(memory.id);
    await this.persistMemories();
    return true;
  }

  getPreferencesMemory(): ScheduleMemory | undefined {
    return this.getMemoryByKey(PREFERENCES_MEMORY_KEY);
  }

  getPreferences(): SchedulePreferences {
    return normalizePreferences(
      this.getPreferencesMemory()?.data ?? null,
      serverTimezone(),
    );
  }

  /**
   * Merges a partial preference update into the single scheduling_preferences
   * document, normalizes it and persists the canonical values.
   */
  async updatePreferences(
    patch: SchedulePreferencesPatch,
  ): Promise<SchedulePreferences> {
    const existing = this.getPreferencesMemory();
    const current = isRecord(existing?.data) ? existing.data : {};
    const next: Record<string, unknown> = { ...current };
    if (patch.timezone !== undefined) next.timezone = patch.timezone;
    if (patch.workdays !== undefined) next.workdays = patch.workdays;
    if (patch.workStart !== undefined) next.workStart = patch.workStart;
    if (patch.workEnd !== undefined) next.workEnd = patch.workEnd;
    if (patch.breaks !== undefined) {
      next.breaks = patch.breaks.map((entry) => ({
        label: entry.label ?? "休息",
        start: entry.start,
        end: entry.end,
      }));
    }
    if (patch.maxFocusMinutes !== undefined) {
      next.maxFocusMinutes = patch.maxFocusMinutes;
    }
    if (patch.minBlockMinutes !== undefined) {
      next.minBlockMinutes = patch.minBlockMinutes;
    }
    if (patch.bufferRatio !== undefined) next.bufferRatio = patch.bufferRatio;
    if (patch.gapMinutes !== undefined) next.gapMinutes = patch.gapMinutes;
    if (patch.dailyFocusLimitMinutes !== undefined) {
      next.dailyFocusLimitMinutes = patch.dailyFocusLimitMinutes;
    }
    if (patch.rules !== undefined) next.rules = patch.rules;

    const normalized = normalizePreferences(next, serverTimezone());
    const data = {
      timezone: normalized.timezone,
      workdays: normalized.workdays,
      workStart: normalized.workStart,
      workEnd: normalized.workEnd,
      breaks: normalized.breaks,
      maxFocusMinutes: normalized.maxFocusMinutes,
      minBlockMinutes: normalized.minBlockMinutes,
      bufferRatio: normalized.bufferRatio,
      gapMinutes: normalized.gapMinutes,
      dailyFocusLimitMinutes: normalized.dailyFocusLimitMinutes,
      rules: normalized.rules,
    };
    const content = formatPreferencesSummary(normalized);
    if (existing !== undefined) {
      await this.updateMemory(existing.id, { data, content });
    } else {
      await this.createMemory({
        key: PREFERENCES_MEMORY_KEY,
        category: "preference",
        title: "排期偏好",
        content,
        data,
      });
    }
    return normalized;
  }

  // ------------------------------------------------------------- fixed events

  listFixedEvents(): ScheduleFixedEvent[] {
    return [...this.fixedEvents.values()]
      .sort(
        (a, b) =>
          // Weekly events group by weekday first; one-off events sort by date.
          (a.weekday ?? 8) - (b.weekday ?? 8) ||
          (a.date ?? "").localeCompare(b.date ?? "") ||
          a.start.localeCompare(b.start) ||
          a.title.localeCompare(b.title),
      )
      .map(copyFixedEvent);
  }

  getFixedEvent(id: string): ScheduleFixedEvent | undefined {
    const event = this.fixedEvents.get(id);
    return event === undefined ? undefined : copyFixedEvent(event);
  }

  /** Events that occupy time on the given date (weekly by weekday, once by date). */
  fixedEventsForDate(date: string): ScheduleFixedEvent[] {
    if (!isValidDate(date)) return [];
    const weekday = weekdayOf(date);
    return [...this.fixedEvents.values()]
      .filter(
        (event) =>
          (event.kind === "weekly" && event.weekday === weekday) ||
          (event.kind === "once" && event.date === date),
      )
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(copyFixedEvent);
  }

  async createFixedEvent(
    input: ScheduleFixedEventInput & {
      title: string;
      kind: ScheduleFixedEventKind;
    },
  ): Promise<ScheduleFixedEvent> {
    const kind = input.kind;
    const weekday =
      kind === "weekly" && Number.isInteger(input.weekday)
        ? Math.min(7, Math.max(1, input.weekday as number))
        : null;
    const date =
      kind === "once" &&
      input.date !== undefined &&
      input.date !== null &&
      isValidDate(input.date)
        ? input.date
        : null;
    if (kind === "weekly" && weekday === null) {
      throw new AppError(
        "INVALID_FIXED_EVENT",
        'kind="weekly" requires weekday 1-7',
        400,
      );
    }
    if (kind === "once" && date === null) {
      throw new AppError(
        "INVALID_FIXED_EVENT",
        'kind="once" requires a valid date (YYYY-MM-DD)',
        400,
      );
    }
    const start = input.start ?? "";
    const end = input.end ?? "";
    if (
      !isValidClock(start) ||
      !isValidClock(end) ||
      clockToMinutes(end) <= clockToMinutes(start)
    ) {
      throw new AppError(
        "INVALID_FIXED_EVENT",
        "start/end must be HH:mm with end after start",
        400,
      );
    }
    const now = new Date().toISOString();
    const event: ScheduleFixedEvent = {
      id: `fixed_${randomUUID()}`,
      title: input.title.trim().slice(0, 300),
      kind,
      weekday,
      date,
      start,
      end,
      location: (input.location ?? "").trim().slice(0, 120),
      note: (input.note ?? "").slice(0, 10_000),
      busy: input.busy ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.fixedEvents.set(event.id, event);
    await this.persistFixedEvents();
    return copyFixedEvent(event);
  }

  async updateFixedEvent(
    id: string,
    patch: ScheduleFixedEventInput,
  ): Promise<ScheduleFixedEvent> {
    const event = this.fixedEvents.get(id);
    if (event === undefined) {
      throw new AppError(
        "FIXED_EVENT_NOT_FOUND",
        `unknown fixed event: ${id}`,
        404,
      );
    }
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === "") {
        throw new AppError(
          "INVALID_FIXED_EVENT",
          "fixed event title must not be empty",
          400,
        );
      }
      event.title = title.slice(0, 300);
    }
    if (patch.kind !== undefined) event.kind = patch.kind;
    if (patch.weekday !== undefined) {
      event.weekday =
        patch.weekday !== null &&
        Number.isInteger(patch.weekday) &&
        patch.weekday >= 1 &&
        patch.weekday <= 7
          ? patch.weekday
          : null;
    }
    if (patch.date !== undefined) {
      event.date =
        patch.date !== null && patch.date !== "" && isValidDate(patch.date)
          ? patch.date
          : null;
    }
    if (patch.start !== undefined) event.start = patch.start;
    if (patch.end !== undefined) event.end = patch.end;
    if (patch.location !== undefined) {
      event.location = patch.location.trim().slice(0, 120);
    }
    if (patch.note !== undefined) event.note = patch.note.slice(0, 10_000);
    if (patch.busy !== undefined) event.busy = patch.busy;
    // Re-validate the kind-specific fields and the time window after patching.
    if (
      (event.kind === "weekly" && event.weekday === null) ||
      (event.kind === "once" && event.date === null)
    ) {
      throw new AppError(
        "INVALID_FIXED_EVENT",
        `kind="${event.kind}" requires ${event.kind === "weekly" ? "weekday 1-7" : "a date"}`,
        400,
      );
    }
    if (
      !isValidClock(event.start) ||
      !isValidClock(event.end) ||
      clockToMinutes(event.end) <= clockToMinutes(event.start)
    ) {
      throw new AppError(
        "INVALID_FIXED_EVENT",
        "start/end must be HH:mm with end after start",
        400,
      );
    }
    event.updatedAt = new Date().toISOString();
    await this.persistFixedEvents();
    return copyFixedEvent(event);
  }

  async upsertFixedEvent(input: {
    id?: string;
    title?: string;
    kind?: ScheduleFixedEventKind;
    weekday?: number | null;
    date?: string | null;
    start?: string;
    end?: string;
    location?: string;
    note?: string;
    busy?: boolean;
  }): Promise<{ event: ScheduleFixedEvent; created: boolean }> {
    const existing =
      input.id === undefined ? undefined : this.getFixedEvent(input.id);
    if (existing !== undefined) {
      const event = await this.updateFixedEvent(existing.id, {
        title: input.title,
        kind: input.kind,
        weekday: input.weekday,
        date: input.date,
        start: input.start,
        end: input.end,
        location: input.location,
        note: input.note,
        busy: input.busy,
      });
      return { event, created: false };
    }
    if (
      input.title === undefined ||
      input.kind === undefined ||
      input.start === undefined ||
      input.end === undefined
    ) {
      throw new AppError(
        "INVALID_FIXED_EVENT",
        "Creating a fixed event requires title, kind (weekly|once), start and end, plus weekday (weekly) or date (once).",
        400,
      );
    }
    const event = await this.createFixedEvent({
      title: input.title,
      kind: input.kind,
      weekday: input.weekday,
      date: input.date,
      start: input.start,
      end: input.end,
      location: input.location,
      note: input.note,
      busy: input.busy,
    });
    return { event, created: true };
  }

  async deleteFixedEvent(id: string): Promise<boolean> {
    if (!this.fixedEvents.delete(id)) return false;
    await this.persistFixedEvents();
    return true;
  }

  /**
   * One-time, idempotent conversion of legacy freeform memories that carry
   * structured fixed commitments (course tables, weekly meetings) into
   * ScheduleFixedEvents, so weeks with only fixed commitments can be planned.
   */
  private async migrateFixedCommitmentMemories(): Promise<void> {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const created: ScheduleFixedEvent[] = [];
    let memoriesChanged = false;

    for (const memory of this.memories.values()) {
      if (memory.data === null || memory.data.migratedFixedEvents === true) {
        continue;
      }
      const candidates: Array<{
        title: string;
        kind: ScheduleFixedEventKind;
        weekday: number | null;
        date: string | null;
        start: string;
        end: string;
        location: string;
      }> = [];

      const weekly = memory.data.weekly;
      if (Array.isArray(weekly)) {
        for (const entry of weekly) {
          if (!isRecord(entry)) continue;
          const day = entry.day;
          if (
            !Number.isInteger(day) ||
            (day as number) < 1 ||
            (day as number) > 7
          ) {
            continue;
          }
          candidates.push({
            title: asString(entry.title, "固定会议").slice(0, 300) || "固定会议",
            kind: "weekly",
            weekday: day as number,
            date: null,
            start: asString(entry.start),
            end: asString(entry.end),
            location: asString(entry.location ?? entry.loc).slice(0, 120),
          });
        }
      }

      const schedule = memory.data.schedule;
      if (isRecord(schedule)) {
        for (const [dayName, slots] of Object.entries(schedule)) {
          const weekday = dayNames.indexOf(dayName);
          if (weekday <= 0 || !Array.isArray(slots)) continue;
          for (const slot of slots) {
            if (!isRecord(slot)) continue;
            const location = asString(slot.loc ?? slot.location).slice(0, 120);
            candidates.push({
              title: location !== "" ? `课程（${location}）` : "课程",
              kind: "weekly",
              weekday,
              date: null,
              start: asString(slot.start),
              end: asString(slot.end),
              location,
            });
          }
        }
      }

      if (candidates.length === 0) continue;
      let touched = false;
      for (const candidate of candidates) {
        if (
          !isValidClock(candidate.start) ||
          !isValidClock(candidate.end) ||
          clockToMinutes(candidate.end) <= clockToMinutes(candidate.start)
        ) {
          continue;
        }
        const duplicate = [...this.fixedEvents.values(), ...created].some(
          (event) =>
            event.kind === candidate.kind &&
            event.weekday === candidate.weekday &&
            event.date === candidate.date &&
            event.start === candidate.start &&
            event.title === candidate.title,
        );
        if (duplicate) continue;
        const now = new Date().toISOString();
        const event: ScheduleFixedEvent = {
          id: `fixed_${randomUUID()}`,
          title: candidate.title,
          kind: candidate.kind,
          weekday: candidate.weekday,
          date: candidate.date,
          start: candidate.start,
          end: candidate.end,
          location: candidate.location,
          note: "",
          busy: true,
          createdAt: now,
          updatedAt: now,
        };
        this.fixedEvents.set(event.id, event);
        created.push(event);
        touched = true;
      }
      if (touched) {
        memory.data = { ...memory.data, migratedFixedEvents: true };
        memory.updatedAt = new Date().toISOString();
        memoriesChanged = true;
      }
    }

    if (created.length > 0 || memoriesChanged) {
      await this.persistFixedEvents();
      if (memoriesChanged) await this.persistMemories();
      console.log(
        `[schedule] migrated ${created.length} fixed event(s) from legacy memories`,
      );
    }
  }

  /**
   * The assistant used to expose arbitrary memory documents. They are now
   * collapsed into the single scheduling_preferences document:
   * - course/meeting memories already migrated to fixed events are dropped;
   * - remaining free-form memories become human-readable rules;
   * - a backup of the original documents is written once for safety.
   */
  private async consolidateLegacyMemories(): Promise<void> {
    const preference = this.getPreferencesMemory();
    const legacy = [...this.memories.values()].filter(
      (memory) => memory.key !== PREFERENCES_MEMORY_KEY,
    );
    if (legacy.length === 0) return;

    await atomicWriteFile(
      this.memoriesLegacyFile,
      `${JSON.stringify({ version: 1, memories: legacy }, null, 2)}\n`,
    );

    const rules = new Set<string>(
      preference === undefined || preference.data === null
        ? []
        : asRuleArray(preference.data.rules),
    );
    for (const memory of legacy) {
      const data = memory.data;
      const migratedFixedEvents =
        data !== null &&
        (data.migratedFixedEvents === true ||
          Array.isArray(data.weekly) ||
          isRecord(data.schedule));
      if (migratedFixedEvents) continue;
      const content = memory.content.trim();
      if (content === "") continue;
      rules.add(`【${memory.title}】${content}`.slice(0, 2000));
    }

    for (const memory of legacy) this.memories.delete(memory.id);

    const now = new Date().toISOString();
    if (preference !== undefined) {
      const target = this.memories.get(preference.id);
      if (target !== undefined) {
        target.data = {
          ...(isRecord(target.data) ? target.data : {}),
          rules: [...rules],
        };
        target.updatedAt = now;
      }
    } else if (rules.size > 0) {
      const memory: ScheduleMemory = {
        id: `mem_${randomUUID()}`,
        key: PREFERENCES_MEMORY_KEY,
        category: "preference",
        title: "排期偏好",
        content: "",
        data: { rules: [...rules] },
        tags: [],
        pinned: false,
        createdAt: now,
        updatedAt: now,
      };
      this.memories.set(memory.id, memory);
    }

    await this.persistMemories();
    console.log(
      `[schedule] consolidated ${legacy.length} legacy memory document(s) into preferences (${rules.size} rule(s))`,
    );
  }

  // ------------------------------------------------------------------- tasks

  listTasks(query: TaskQuery = {}): ScheduleTask[] {
    const includeDone = query.includeDone === true;
    const text = query.query?.trim().toLowerCase();
    const limit = Math.min(Math.max(query.limit ?? 200, 1), MAX_LIMIT);
    const priorityRank: Record<SchedulePriority, number> = {
      urgent: 4,
      high: 3,
      medium: 2,
      low: 1,
    };
    return [...this.tasks.values()]
      .filter((task) => {
        if (query.status !== undefined && task.status !== query.status) return false;
        if (
          query.status === undefined &&
          !includeDone &&
          (task.status === "done" || task.status === "cancelled")
        ) {
          return false;
        }
        if (query.project !== undefined && task.project !== query.project) {
          return false;
        }
        if (text !== undefined && text !== "") {
          const haystack = [
            task.title,
            task.notes,
            task.project ?? "",
            task.steps.map((step) => step.title).join(" "),
          ]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          priorityRank[b.priority] - priorityRank[a.priority] ||
          (a.deadline ?? "9999-12-31").localeCompare(b.deadline ?? "9999-12-31") ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .slice(0, limit)
      .map(copyTask);
  }

  getTask(id: string): ScheduleTask | undefined {
    const task = this.tasks.get(id);
    return task === undefined ? undefined : copyTask(task);
  }

  async createTask(input: ScheduleTaskInput & { title: string }): Promise<ScheduleTask> {
    const now = new Date().toISOString();
    const estimated = Math.max(
      1,
      Math.min(100_000, Math.round(input.estimatedMinutes ?? 60)),
    );
    const status = input.status ?? "todo";
    const remaining = Math.max(
      0,
      Math.min(
        100_000,
        Math.round(
          input.remainingMinutes ??
            (status === "done" ? 0 : estimated),
        ),
      ),
    );
    const task: ScheduleTask = {
      id: `task_${randomUUID()}`,
      title: input.title.trim().slice(0, 300),
      notes: (input.notes ?? "").slice(0, 100_000),
      project: input.project?.trim().slice(0, 120) || null,
      priority: input.priority ?? "medium",
      status,
      estimatedMinutes: estimated,
      remainingMinutes: status === "done" ? 0 : remaining,
      actualMinutes: Math.max(0, Math.round(input.actualMinutes ?? 0)),
      estimateConfidence: input.estimateConfidence ?? "medium",
      deadline:
        input.deadline !== undefined &&
        input.deadline !== null &&
        isValidDate(input.deadline)
          ? input.deadline
          : null,
      splittable: input.splittable !== false,
      minBlockMinutes: Math.min(
        600,
        Math.max(5, Math.round(input.minBlockMinutes ?? 30)),
      ),
      preferredTimeOfDay: input.preferredTimeOfDay ?? "any",
      steps: normalizeSteps(input.steps ?? []),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    await this.persistTasks();
    return copyTask(task);
  }

  async updateTask(id: string, patch: ScheduleTaskInput): Promise<ScheduleTask> {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new AppError("TASK_NOT_FOUND", `unknown task: ${id}`, 404);
    }
    if (patch.title !== undefined) task.title = patch.title.trim().slice(0, 300);
    if (patch.notes !== undefined) task.notes = patch.notes.slice(0, 100_000);
    if (patch.project !== undefined) {
      task.project = patch.project?.trim().slice(0, 120) || null;
    }
    if (patch.priority !== undefined) task.priority = patch.priority;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.estimatedMinutes !== undefined) {
      task.estimatedMinutes = Math.max(1, Math.min(100_000, Math.round(patch.estimatedMinutes)));
      // Revising the estimate before any explicit remaining value keeps the
      // task consistent with work already recorded.
      if (patch.remainingMinutes === undefined) {
        task.remainingMinutes = Math.max(
          0,
          Math.min(100_000, task.estimatedMinutes - task.actualMinutes),
        );
      }
    }
    if (patch.remainingMinutes !== undefined) {
      task.remainingMinutes = Math.max(
        0,
        Math.min(100_000, Math.round(patch.remainingMinutes)),
      );
    }
    if (patch.actualMinutes !== undefined) {
      task.actualMinutes = Math.max(0, Math.round(patch.actualMinutes));
      if (
        patch.remainingMinutes === undefined &&
        patch.estimatedMinutes === undefined
      ) {
        task.remainingMinutes = Math.max(
          0,
          Math.min(100_000, task.estimatedMinutes - task.actualMinutes),
        );
      }
    }
    if (patch.estimateConfidence !== undefined) {
      task.estimateConfidence = patch.estimateConfidence;
    }
    if (patch.deadline !== undefined) {
      task.deadline =
        patch.deadline !== null && isValidDate(patch.deadline)
          ? patch.deadline
          : null;
    }
    if (patch.splittable !== undefined) task.splittable = patch.splittable;
    if (patch.minBlockMinutes !== undefined) {
      task.minBlockMinutes = Math.max(
        5,
        Math.min(600, Math.round(patch.minBlockMinutes)),
      );
    }
    if (patch.preferredTimeOfDay !== undefined) {
      task.preferredTimeOfDay = patch.preferredTimeOfDay;
    }
    if (patch.steps !== undefined) {
      task.steps = patch.steps === null ? [] : normalizeSteps(patch.steps);
    }
    if (task.status === "done") task.remainingMinutes = 0;
    if (task.status === "cancelled") task.remainingMinutes = 0;
    task.updatedAt = new Date().toISOString();
    await this.persistTasks();
    if (task.status === "done" || task.status === "cancelled") {
      await this.clearPlannedBlocks(task.id);
    }
    return copyTask(task);
  }

  /** Reverses previously recorded work, e.g. when a done block is reopened. */
  async revertTaskActual(id: string, minutes: number): Promise<ScheduleTask> {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new AppError("TASK_NOT_FOUND", `unknown task: ${id}`, 404);
    }
    const actual = Math.max(0, Math.round(minutes));
    task.actualMinutes = Math.max(0, task.actualMinutes - actual);
    task.remainingMinutes = Math.min(
      100_000,
      task.remainingMinutes + actual,
    );
    if (task.remainingMinutes > 0 && task.status === "done") {
      task.status = task.actualMinutes > 0 ? "in_progress" : "todo";
    }
    task.updatedAt = new Date().toISOString();
    await this.persistTasks();
    return copyTask(task);
  }

  /** Records completed work and closes the task when nothing remains. */
  async recordTaskActual(id: string, minutes: number): Promise<ScheduleTask> {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new AppError("TASK_NOT_FOUND", `unknown task: ${id}`, 404);
    }
    const actual = Math.max(0, Math.round(minutes));
    task.actualMinutes += actual;
    task.remainingMinutes = Math.max(0, task.remainingMinutes - actual);
    if (task.remainingMinutes === 0) task.status = "done";
    if (task.status === "todo") task.status = "in_progress";
    task.updatedAt = new Date().toISOString();
    await this.persistTasks();
    if (task.status === "done") {
      await this.clearPlannedBlocks(task.id);
    }
    return copyTask(task);
  }

  /** Completed or cancelled tasks no longer need future planned blocks. */
  private async clearPlannedBlocks(taskId: string): Promise<void> {
    let changed = false;
    const now = new Date().toISOString();
    for (const plan of this.plans.values()) {
      const next = plan.blocks.filter(
        (block) => !(block.taskId === taskId && block.status === "planned"),
      );
      if (next.length !== plan.blocks.length) {
        plan.blocks = next;
        plan.updatedAt = now;
        changed = true;
      }
    }
    if (changed) await this.persistPlans();
  }

  async deleteTask(id: string): Promise<boolean> {
    if (!this.tasks.delete(id)) return false;
    for (const plan of this.plans.values()) {
      plan.blocks = plan.blocks.filter((block) => block.taskId !== id);
      plan.unscheduled = plan.unscheduled.filter((item) => item.taskId !== id);
      plan.updatedAt = new Date().toISOString();
    }
    await this.persistTasks();
    await this.persistPlans();
    return true;
  }

  getCalibration(): ScheduleCalibration {
    let estimated = 0;
    let actual = 0;
    let completed = 0;
    for (const task of this.tasks.values()) {
      if (task.status !== "done" || task.actualMinutes <= 0) continue;
      completed += 1;
      estimated += task.estimatedMinutes;
      actual += task.actualMinutes;
    }
    return {
      completedTasks: completed,
      ratio: estimated > 0 ? Math.round((actual / estimated) * 100) / 100 : null,
    };
  }

  // ------------------------------------------------------------------- plans

  getPlan(weekStart: string): SchedulePlan | undefined {
    if (!isValidDate(weekStart)) return undefined;
    const plan = this.plans.get(mondayOf(weekStart));
    return plan === undefined ? undefined : copyPlan(plan);
  }

  getPlanForDate(date: string): SchedulePlan | undefined {
    return isValidDate(date) ? this.getPlan(mondayOf(date)) : undefined;
  }

  /**
   * Planned blocks whose time has already passed (before today, or earlier
   * today) with no recorded outcome. Their completion is unknown until the
   * user confirms, so replanning must surface them instead of silently
   * auto-skipping the work.
   */
  listOverduePlannedBlocks(
    options: { today?: string; nowMinutes?: number; limit?: number } = {},
  ): ScheduleBlock[] {
    const timezone = this.getPreferences().timezone;
    const today = options.today ?? todayInTimezone(timezone);
    const nowMinutes = options.nowMinutes ?? nowMinutesInTimezone(timezone);
    const overdue: ScheduleBlock[] = [];
    for (const plan of this.plans.values()) {
      for (const block of plan.blocks) {
        if (block.status !== "planned") continue;
        const dateComparison = compareDates(block.date, today);
        const ended =
          dateComparison < 0 ||
          (dateComparison === 0 && clockToMinutes(block.end) <= nowMinutes);
        if (ended) overdue.push(copyBlock(block));
      }
    }
    overdue.sort(
      (a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start),
    );
    return overdue.slice(0, options.limit ?? 20);
  }

  /**
   * Merges the stored per-ISO-week plans into one rolling window. A window
   * that only contains fixed commitments (and therefore zero blocks) is still
   * returned as long as a stored plan intersects the range.
   */
  getWindow(startDateInput: string, days = 7): ScheduleWindow | null {
    if (!isValidDate(startDateInput)) return null;
    const startDate = startDateInput;
    const endDate = rangeEndOf(startDate, days);
    const intersecting: SchedulePlan[] = [];
    for (const plan of this.plans.values()) {
      if (
        compareDates(plan.weekStart, endDate) <= 0 &&
        compareDates(plan.weekEnd, startDate) >= 0
      ) {
        intersecting.push(plan);
      }
    }
    if (intersecting.length === 0) return null;
    // Metadata is window-level and may be duplicated across the weeks the
    // window touches; read the most recently updated plan first so a stale
    // entry cannot win the dedupe.
    const newestFirst = [...intersecting].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );

    const blocks = intersecting
      .flatMap((plan) => plan.blocks)
      .filter(
        (block) =>
          compareDates(block.date, startDate) >= 0 &&
          compareDates(block.date, endDate) <= 0,
      )
      .map(copyBlock)
      .sort(
        (a, b) =>
          compareDates(a.date, b.date) ||
          clockToMinutes(a.start) - clockToMinutes(b.start),
      );

    const unscheduled: ScheduleUnscheduledTask[] = [];
    const seenTasks = new Set<string>();
    for (const plan of newestFirst) {
      for (const item of plan.unscheduled) {
        if (seenTasks.has(item.taskId)) continue;
        seenTasks.add(item.taskId);
        unscheduled.push({ ...item });
      }
    }

    const warnings: string[] = [];
    const seenWarnings = new Set<string>();
    for (const plan of newestFirst) {
      for (const warning of plan.warnings) {
        if (seenWarnings.has(warning)) continue;
        seenWarnings.add(warning);
        warnings.push(warning);
      }
    }

    const notes = [
      ...new Set(
        newestFirst
          .map((plan) => plan.notes.trim())
          .filter((note) => note !== ""),
      ),
    ].join("\n");

    return {
      startDate,
      endDate,
      timezone: this.getPreferences().timezone,
      blocks,
      unscheduled,
      warnings,
      notes,
    };
  }

  listPlans(): SchedulePlan[] {
    return [...this.plans.values()]
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .map(copyPlan);
  }

  findBlock(
    blockId: string,
  ): { plan: SchedulePlan; block: ScheduleBlock } | undefined {
    for (const plan of this.plans.values()) {
      const block = plan.blocks.find((candidate) => candidate.id === blockId);
      if (block !== undefined) {
        return { plan: copyPlan(plan), block: copyBlock(block) };
      }
    }
    return undefined;
  }

  /**
   * Replaces future planned work for the given tasks, optionally marking past
   * planned blocks as skipped, then inserts the newly generated blocks.
   */
  async applySchedule(input: ScheduleApplyInput): Promise<SchedulePlan[]> {
    const taskIds = new Set(input.taskIds);
    const now = new Date().toISOString();
    for (const plan of this.plans.values()) {
      const next: ScheduleBlock[] = [];
      for (const block of plan.blocks) {
        if (!taskIds.has(block.taskId)) {
          next.push(block);
          continue;
        }
        if (block.status === "done") {
          next.push(block);
          continue;
        }
        if (block.status === "skipped") {
          // Skipped history only matters before the replanned range; keeping
          // future skipped blocks would leave overlapping ghosts next to the
          // freshly generated blocks.
          if (compareDates(block.date, input.removeFromDate) < 0) {
            next.push(block);
          }
          continue;
        }
        if (compareDates(block.date, input.removeFromDate) >= 0) continue;
        if (
          input.skipBeforeDate !== null &&
          compareDates(block.date, input.skipBeforeDate) < 0
        ) {
          next.push({ ...block, status: "skipped" });
          continue;
        }
        next.push(block);
      }
      plan.blocks = next;
      plan.updatedAt = now;
    }

    const touched = new Set<string>();
    for (const block of input.addBlocks) {
      const weekStart = mondayOf(block.date);
      let plan = this.plans.get(weekStart);
      if (plan === undefined) {
        plan = {
          id: `plan_${randomUUID()}`,
          weekStart,
          weekEnd: weekEndOf(weekStart),
          timezone: this.getPreferences().timezone,
          status: "active",
          blocks: [],
          unscheduled: [],
          warnings: [],
          notes: "",
          createdAt: now,
          updatedAt: now,
        };
        this.plans.set(weekStart, plan);
      }
      if (!plan.blocks.some((existing) => existing.id === block.id)) {
        plan.blocks.push(copyBlock(block));
      }
      plan.updatedAt = now;
      touched.add(weekStart);
    }

    for (const [weekStart, meta] of input.planMeta ?? []) {
      let plan = this.plans.get(weekStart);
      if (plan === undefined) {
        plan = {
          id: `plan_${randomUUID()}`,
          weekStart,
          weekEnd: weekEndOf(weekStart),
          timezone: this.getPreferences().timezone,
          status: "active",
          blocks: [],
          unscheduled: [],
          warnings: [],
          notes: "",
          createdAt: now,
          updatedAt: now,
        };
        this.plans.set(weekStart, plan);
      }
      if (meta.unscheduled !== undefined) plan.unscheduled = meta.unscheduled.map((item) => ({ ...item }));
      if (meta.warnings !== undefined) plan.warnings = [...meta.warnings];
      if (meta.notes !== undefined) plan.notes = meta.notes.slice(0, 20_000);
      plan.updatedAt = now;
      touched.add(weekStart);
    }

    for (const plan of this.plans.values()) {
      plan.blocks.sort(
        (a, b) =>
          compareDates(a.date, b.date) ||
          clockToMinutes(a.start) - clockToMinutes(b.start),
      );
    }
    await this.persistPlans();
    return [...touched]
      .sort((a, b) => a.localeCompare(b))
      .map((weekStart) => copyPlan(this.plans.get(weekStart)!));
  }

  async updateBlock(
    blockId: string,
    patch: BlockUpdate,
  ): Promise<{ plan: SchedulePlan; block: ScheduleBlock; previous: ScheduleBlock }> {
    for (const plan of this.plans.values()) {
      const index = plan.blocks.findIndex((block) => block.id === blockId);
      if (index < 0) continue;
      const previous = plan.blocks[index]!;
      const next: ScheduleBlock = { ...previous };
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.actualMinutes !== undefined) {
        next.actualMinutes =
          patch.actualMinutes === null
            ? null
            : Math.max(0, Math.round(patch.actualMinutes));
      }
      if (patch.note !== undefined) next.note = patch.note.slice(0, 10_000);
      if (patch.start !== undefined) next.start = patch.start;
      if (patch.end !== undefined) next.end = patch.end;
      if (patch.date !== undefined) next.date = patch.date;
      if (
        !isValidDate(next.date) ||
        !isValidClock(next.start) ||
        !isValidClock(next.end) ||
        clockToMinutes(next.end) <= clockToMinutes(next.start)
      ) {
        throw new AppError("INVALID_BLOCK_TIME", "invalid block date or time", 400);
      }
      this.assertNoOverlap(mondayOf(next.date), next);
      plan.blocks[index] = next;
      plan.updatedAt = new Date().toISOString();

      // A block moved to another week belongs in that week's plan.
      if (mondayOf(next.date) !== plan.weekStart) {
        plan.blocks.splice(index, 1);
        const targetWeek = mondayOf(next.date);
        let target = this.plans.get(targetWeek);
        if (target === undefined) {
          target = {
            ...plan,
            id: `plan_${randomUUID()}`,
            weekStart: targetWeek,
            weekEnd: weekEndOf(targetWeek),
            blocks: [],
            unscheduled: [],
            warnings: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          this.plans.set(targetWeek, target);
        }
        target.blocks.push(next);
        target.blocks.sort(
          (a, b) =>
            compareDates(a.date, b.date) ||
            clockToMinutes(a.start) - clockToMinutes(b.start),
        );
        target.updatedAt = new Date().toISOString();
        await this.persistPlans();
        return {
          plan: copyPlan(target),
          block: copyBlock(next),
          previous: copyBlock(previous),
        };
      }

      plan.blocks.sort(
        (a, b) =>
          compareDates(a.date, b.date) ||
          clockToMinutes(a.start) - clockToMinutes(b.start),
      );
      await this.persistPlans();
      return {
        plan: copyPlan(plan),
        block: copyBlock(next),
        previous: copyBlock(previous),
      };
    }
    throw new AppError("BLOCK_NOT_FOUND", `unknown block: ${blockId}`, 404);
  }

  private assertNoOverlap(weekStart: string, candidate: ScheduleBlock): void {
    const plan = this.plans.get(weekStart);
    const start = clockToMinutes(candidate.start);
    const end = clockToMinutes(candidate.end);
    if (plan !== undefined) {
      for (const block of plan.blocks) {
        if (block.id === candidate.id) continue;
        if (block.date !== candidate.date || block.status === "skipped") continue;
        const otherStart = clockToMinutes(block.start);
        const otherEnd = clockToMinutes(block.end);
        if (start < otherEnd && otherStart < end) {
          throw new AppError(
            "BLOCK_OVERLAP",
            `block overlaps ${block.start}-${block.end}`,
            409,
          );
        }
      }
    }
    // Fixed commitments (courses, meetings) are not blocks but still occupy
    // wall-clock time; moving a block on top of them is rejected. Non-busy
    // events are parallel-by-design, so blocks may sit inside them.
    for (const event of this.fixedEventsForDate(candidate.date)) {
      if (!event.busy) continue;
      const eventStart = clockToMinutes(event.start);
      const eventEnd = clockToMinutes(event.end);
      if (start < eventEnd && eventStart < end) {
        throw new AppError(
          "BLOCK_OVERLAP",
          `block overlaps fixed event 「${event.title}」 ${event.start}-${event.end}`,
          409,
        );
      }
    }
  }

  async setPlanMeta(
    weekStart: string,
    meta: {
      unscheduled?: ScheduleUnscheduledTask[];
      warnings?: string[];
      notes?: string;
    },
  ): Promise<void> {
    const plan = this.plans.get(mondayOf(weekStart));
    if (plan === undefined) return;
    if (meta.unscheduled !== undefined) plan.unscheduled = meta.unscheduled.map((item) => ({ ...item }));
    if (meta.warnings !== undefined) plan.warnings = [...meta.warnings];
    if (meta.notes !== undefined) plan.notes = meta.notes.slice(0, 20_000);
    plan.updatedAt = new Date().toISOString();
    await this.persistPlans();
  }

  // ---------------------------------------------------------------- overview

  overview(startDateInput?: string, days = 7): ScheduleOverview {
    const preferences = this.getPreferences();
    const today = todayInTimezone(preferences.timezone);
    const rangeStart =
      startDateInput !== undefined && isValidDate(startDateInput)
        ? startDateInput
        : today;
    const rangeEnd = rangeEndOf(rangeStart, days);
    const window = this.getWindow(rangeStart, days);
    const summary =
      window === null
        ? {
            rangeStart,
            rangeEnd,
            timezone: preferences.timezone,
            planId: null,
            totalPlannedMinutes: 0,
            taskCount: 0,
            doneMinutes: 0,
            unscheduled: [],
            warnings: [],
          }
        : this.summarizeWindow(window);
    const tasks = this.listTasks({ includeDone: true, limit: MAX_LIMIT });
    const fixedEvents = this.listFixedEvents();
    const agenda = buildScheduleAgenda({
      window,
      tasks,
      fixedEvents,
      preferences,
      startDate: rangeStart,
      endDate: rangeEnd,
      today,
      nowClock: nowClockInTimezone(preferences.timezone),
      summary,
    });
    return {
      timezone: preferences.timezone,
      today,
      rangeStart,
      rangeEnd,
      preferences,
      preferencesConfigured: this.getPreferencesMemory() !== undefined,
      tasks,
      fixedEvents,
      window,
      agenda,
      summary,
      calibration: this.getCalibration(),
    };
  }

  summarizeWindow(window: ScheduleWindow): SchedulePlanSummary {
    let totalPlannedMinutes = 0;
    let doneMinutes = 0;
    const tasks = new Set<string>();
    for (const block of window.blocks) {
      if (block.status === "skipped") continue;
      const duration = durationMinutes(block.start, block.end);
      totalPlannedMinutes += duration;
      tasks.add(block.taskId);
      if (block.status === "done") doneMinutes += duration;
    }
    return {
      rangeStart: window.startDate,
      rangeEnd: window.endDate,
      timezone: window.timezone,
      planId: null,
      totalPlannedMinutes,
      taskCount: tasks.size,
      doneMinutes,
      unscheduled: window.unscheduled.map((item) => ({ ...item })),
      warnings: [...window.warnings],
    };
  }

  summarize(
    plan: SchedulePlan | null,
    preferences = this.getPreferences(),
  ): SchedulePlanSummary {
    if (plan === null) {
      return {
        rangeStart: "",
        rangeEnd: "",
        timezone: preferences.timezone,
        planId: null,
        totalPlannedMinutes: 0,
        taskCount: 0,
        doneMinutes: 0,
        unscheduled: [],
        warnings: [],
      };
    }
    let totalPlannedMinutes = 0;
    let doneMinutes = 0;
    const tasks = new Set<string>();
    for (const block of plan.blocks) {
      if (block.status === "skipped") continue;
      const duration = durationMinutes(block.start, block.end);
      totalPlannedMinutes += duration;
      tasks.add(block.taskId);
      if (block.status === "done") doneMinutes += duration;
    }
    return {
      rangeStart: plan.weekStart,
      rangeEnd: plan.weekEnd,
      timezone: plan.timezone,
      planId: plan.id,
      totalPlannedMinutes,
      taskCount: tasks.size,
      doneMinutes,
      unscheduled: plan.unscheduled.map((item) => ({ ...item })),
      warnings: [...plan.warnings],
    };
  }

  /** Upcoming planned blocks for a task, used by the replanner. */
  plannedMinutesBefore(taskId: string, date: string): number {
    let total = 0;
    for (const plan of this.plans.values()) {
      for (const block of plan.blocks) {
        if (
          block.taskId === taskId &&
          block.status === "planned" &&
          compareDates(block.date, date) < 0
        ) {
          total += durationMinutes(block.start, block.end);
        }
      }
    }
    return total;
  }

  addDays(date: string, days: number): string {
    return addDays(date, days);
  }

  // -------------------------------------------------------------- persistence

  private persistMemories(): Promise<void> {
    const data = JSON.stringify(
      { version: 1, memories: [...this.memories.values()] },
      null,
      2,
    );
    this.memoryQueue = this.memoryQueue
      .then(() => atomicWriteFile(this.memoriesFile, data))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error("[schedule] failed to persist memories", error);
      });
    return this.memoryQueue;
  }

  private persistTasks(): Promise<void> {
    const data = JSON.stringify(
      { version: 1, tasks: [...this.tasks.values()] },
      null,
      2,
    );
    this.taskQueue = this.taskQueue
      .then(() => atomicWriteFile(this.tasksFile, data))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error("[schedule] failed to persist tasks", error);
      });
    return this.taskQueue;
  }

  private persistPlans(): Promise<void> {
    const data = JSON.stringify(
      {
        version: 1,
        plans: [...this.plans.values()].sort((a, b) =>
          a.weekStart.localeCompare(b.weekStart),
        ),
      },
      null,
      2,
    );
    this.planQueue = this.planQueue
      .then(() => atomicWriteFile(this.plansFile, data))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error("[schedule] failed to persist plans", error);
      });
    return this.planQueue;
  }

  private persistFixedEvents(): Promise<void> {
    const data = JSON.stringify(
      { version: 1, events: this.listFixedEvents() },
      null,
      2,
    );
    this.fixedEventQueue = this.fixedEventQueue
      .then(() => atomicWriteFile(this.fixedEventsFile, data))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error("[schedule] failed to persist fixed-events", error);
      });
    return this.fixedEventQueue;
  }
}
