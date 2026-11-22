import { randomUUID } from "node:crypto";
import type {
  ScheduleBlock,
  ScheduleFixedEvent,
  SchedulePriority,
  SchedulePreferences,
  ScheduleTask,
  ScheduleUnscheduledTask,
} from "@codefly/protocol";
import {
  addDays,
  clockToMinutes,
  compareDates,
  durationMinutes,
  minutesToClock,
  weekEndOf,
  weekdayOf,
} from "./time.js";

interface Interval {
  start: number;
  end: number;
}

const PRIORITY_RANK: Record<SchedulePriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface SchedulerInput {
  /** First day that may receive new blocks (YYYY-MM-DD). */
  startDate: string;
  /** Last day that may receive new blocks (inclusive). */
  endDate: string;
  today: string;
  /**
   * Local wall-clock HH:mm. When the plan includes today, time before now is
   * treated as unavailable so a rolling window never schedules into the past.
   */
  nowClock?: string;
  tasks: ScheduleTask[];
  /** Blocks that remain after the store applies removals/skips. */
  existingBlocks: ScheduleBlock[];
  /** Fixed commitments (courses, meetings) that carve out busy time. */
  fixedEvents?: ScheduleFixedEvent[];
  preferences: SchedulePreferences;
  /**
   * Minutes already committed to planned blocks before `removeFromDate`.
   * They are not re-scheduled, so the target shrinks by this amount.
   */
  committedMinutesByTask?: Map<string, number>;
}

export interface SchedulerResult {
  blocks: ScheduleBlock[];
  unscheduled: ScheduleUnscheduledTask[];
  warnings: string[];
  capacityMinutes: number;
  demandMinutes: number;
  scheduledMinutesByTask: Map<string, number>;
}

function subtractInterval(
  intervals: Interval[],
  cutStart: number,
  cutEnd: number,
): Interval[] {
  if (cutEnd <= cutStart) return intervals;
  const next: Interval[] = [];
  for (const interval of intervals) {
    if (cutEnd <= interval.start || cutStart >= interval.end) {
      next.push(interval);
      continue;
    }
    if (cutStart > interval.start) {
      next.push({ start: interval.start, end: cutStart });
    }
    if (cutEnd < interval.end) {
      next.push({ start: cutEnd, end: interval.end });
    }
  }
  return next;
}

function preferredWindow(
  preference: ScheduleTask["preferredTimeOfDay"],
): Interval | null {
  if (preference === "morning") return { start: 0, end: 12 * 60 };
  if (preference === "afternoon") return { start: 12 * 60, end: 18 * 60 };
  if (preference === "evening") return { start: 18 * 60, end: 24 * 60 };
  return null;
}

class DayPool {
  readonly date: string;
  readonly availableMinutes: number;
  private intervals: Interval[];
  private limitRemaining: number;
  private readonly gapMinutes: number;

  constructor(
    date: string,
    intervals: Interval[],
    existingMinutes: number,
    dailyLimitMinutes: number,
    gapMinutes: number,
  ) {
    this.date = date;
    this.intervals = intervals;
    this.gapMinutes = Math.max(0, gapMinutes);
    const free = intervals.reduce(
      (total, interval) => total + (interval.end - interval.start),
      0,
    );
    this.limitRemaining = Math.max(0, dailyLimitMinutes - existingMinutes);
    this.availableMinutes = Math.min(free, this.limitRemaining);
  }

  /**
   * Places up to `requested` minutes, never below `minimum`. A partial block
   * is allowed when a gap is too small for the requested chunk but still
   * useful; non-splittable tasks pass minimum === requested.
   */
  place(
    requested: number,
    minimum: number,
    preference: ScheduleTask["preferredTimeOfDay"],
    avoidAdjacentTo: Interval[] = [],
  ): { start: number; end: number } | null {
    if (requested <= 0 || minimum <= 0 || this.limitRemaining < minimum) {
      return null;
    }
    const wanted = Math.min(requested, this.limitRemaining);
    if (wanted < minimum) return null;

    const preferred = preferredWindow(preference);
    const windows =
      preferred === null ? [null] : [preferred, null];

    // First pass: a slot that fits the whole requested chunk.
    for (const window of windows) {
      const slot = this.findSlot(wanted, wanted, window, avoidAdjacentTo);
      if (slot !== null) return this.consume(slot);
    }
    // Second pass: accept a smaller gap that still meets the minimum.
    if (minimum < wanted) {
      for (const window of windows) {
        const slot = this.findSlot(wanted, minimum, window, avoidAdjacentTo);
        if (slot !== null) return this.consume(slot);
      }
    }
    return null;
  }

  private findSlot(
    wanted: number,
    minimum: number,
    window: Interval | null,
    avoidAdjacentTo: Interval[],
  ): Interval | null {
    let best: Interval | null = null;
    let bestDuration = 0;
    for (const interval of this.intervals) {
      const lo = Math.max(interval.start, window?.start ?? 0, 0);
      const hi = Math.min(interval.end, window?.end ?? 24 * 60, 24 * 60);
      const available = hi - lo;
      if (available < minimum) continue;
      const duration = Math.min(wanted, available);
      const candidate = { start: lo, end: lo + duration };
      // Never place a second chunk of the same task directly against another
      // one on the same day: a task may only be split across a meal break (or
      // across days). This keeps 90-minute focus blocks from silently turning
      // into one 180-minute wall-to-wall session.
      if (
        avoidAdjacentTo.some(
          (block) =>
            candidate.start === block.end || candidate.end === block.start,
        )
      ) {
        continue;
      }
      if (duration >= wanted) return candidate;
      // Prefer the largest partial gap instead of the earliest tiny one.
      if (duration > bestDuration) {
        best = candidate;
        bestDuration = duration;
      }
    }
    return best;
  }

  private consume(slot: Interval): { start: number; end: number } {
    const duration = slot.end - slot.start;
    const next: Interval[] = [];
    for (const interval of this.intervals) {
      if (slot.start <= interval.start && slot.end >= interval.end) {
        continue;
      }
      if (slot.end <= interval.start || slot.start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (slot.start > interval.start) {
        next.push({ start: interval.start, end: slot.start });
      }
      if (slot.end < interval.end) {
        const tailStart = slot.end + this.gapMinutes;
        if (tailStart < interval.end) {
          next.push({ start: tailStart, end: interval.end });
        }
      }
    }
    this.intervals = next.sort((a, b) => a.start - b.start);
    this.limitRemaining = Math.max(0, this.limitRemaining - duration);
    return slot;
  }
}

function fixedEventsForDate(
  events: ScheduleFixedEvent[],
  date: string,
  weekday: number,
): ScheduleFixedEvent[] {
  return events.filter(
    (event) =>
      (event.kind === "weekly" && event.weekday === weekday) ||
      (event.kind === "once" && event.date === date),
  );
}

function buildDayPools(input: SchedulerInput): DayPool[] {
  const byDate = new Map<string, ScheduleBlock[]>();
  for (const block of input.existingBlocks) {
    if (block.status === "skipped") continue;
    const list = byDate.get(block.date) ?? [];
    list.push(block);
    byDate.set(block.date, list);
  }

  const workStart = clockToMinutes(input.preferences.workStart);
  const workEnd = clockToMinutes(input.preferences.workEnd);
  const gapMinutes = Math.max(0, input.preferences.gapMinutes);
  const nowMinutes =
    input.nowClock === undefined ? null : clockToMinutes(input.nowClock);
  const pools: DayPool[] = [];

  for (
    let date = input.startDate;
    compareDates(date, input.endDate) <= 0;
    date = addDays(date, 1)
  ) {
    const weekday = weekdayOf(date);
    if (!input.preferences.workdays.includes(weekday)) continue;

    // A rolling window starts now: on the current day, hours that already
    // passed cannot receive new work. Round up so blocks start on a tidy
    // five-minute boundary.
    const dayWorkStart =
      date === input.today && nowMinutes !== null
        ? Math.max(workStart, Math.ceil(nowMinutes / 5) * 5)
        : workStart;
    let intervals: Interval[] =
      dayWorkStart < workEnd ? [{ start: dayWorkStart, end: workEnd }] : [];
    for (const brk of input.preferences.breaks) {
      intervals = subtractInterval(
        intervals,
        clockToMinutes(brk.start),
        clockToMinutes(brk.end),
      );
    }

    // Fixed commitments (courses, meetings) are carved out like breaks. They
    // reduce schedulable capacity but never consume the daily focus limit.
    // Non-busy events (a course the user works through) stay in the plan but
    // remain schedulable time, so they are not carved out at all.
    for (const event of fixedEventsForDate(input.fixedEvents ?? [], date, weekday)) {
      if (!event.busy) continue;
      intervals = subtractInterval(
        intervals,
        Math.max(dayWorkStart, clockToMinutes(event.start) - gapMinutes),
        Math.min(workEnd, clockToMinutes(event.end) + gapMinutes),
      );
    }

    const existing = byDate.get(date) ?? [];
    for (const block of existing) {
      // Leave the configured buffer around existing commitments so regenerated
      // work does not start the instant a meeting or completed block ends.
      intervals = subtractInterval(
        intervals,
        Math.max(dayWorkStart, clockToMinutes(block.start) - gapMinutes),
        Math.min(workEnd, clockToMinutes(block.end) + gapMinutes),
      );
    }

    const existingMinutes = existing.reduce(
      (total, block) => total + durationMinutes(block.start, block.end),
      0,
    );
    pools.push(
      new DayPool(
        date,
        intervals.sort((a, b) => a.start - b.start),
        existingMinutes,
        input.preferences.dailyFocusLimitMinutes,
        gapMinutes,
      ),
    );
  }

  return pools;
}

function targetForTask(
  task: ScheduleTask,
  preferences: SchedulePreferences,
  committedMinutes: number,
): number {
  // The buffer applies to the task's total remaining work. Subtracting
  // already-committed blocks from the *buffered* total keeps replans stable
  // instead of applying the buffer twice.
  const total = Math.max(
    0,
    Math.round(task.remainingMinutes * (1 + preferences.bufferRatio)),
  );
  return Math.max(0, total - Math.max(0, committedMinutes));
}

/**
 * Splits a task's scheduled minutes into chunks that respect both the maximum
 * focus block and the minimum block size. Greedy full focus blocks are used
 * first; when the tail would be below the minimum, minutes are moved from the
 * previous block into the tail so no block exceeds the focus limit.
 */
function splitIntoChunks(
  total: number,
  maxFocusMinutes: number,
  minBlockMinutes: number,
  splittable: boolean,
): number[] {
  if (total <= 0) return [];
  if (!splittable) return [total];
  const maxChunk = Math.max(1, Math.floor(maxFocusMinutes));
  const minChunk = Math.max(1, Math.min(Math.floor(minBlockMinutes), maxChunk));
  if (total <= maxChunk) return [total];

  const chunks: number[] = [];
  let left = total;
  while (left > maxChunk) {
    chunks.push(maxChunk);
    left -= maxChunk;
  }

  if (left < minChunk && chunks.length > 0) {
    const deficit = minChunk - left;
    const lastIndex = chunks.length - 1;
    if (chunks[lastIndex]! - deficit >= minChunk) {
      chunks[lastIndex] = chunks[lastIndex]! - deficit;
      left = minChunk;
    } else {
      // The min/max constraints cannot be satisfied together; keep one block
      // instead of emitting unusable fragments.
      chunks.length = 0;
      left = total;
    }
  }
  chunks.push(left);
  return chunks.filter((chunk) => chunk > 0);
}

interface StepSegment {
  stepId: string | null;
  title: string;
  minutes: number;
}

/**
 * Turns a task's optional step list into a minute-bounded sequence that
 * matches the scheduler's target. Work already covered by kept/completed
 * blocks is skipped so a replan continues with the next concrete step instead
 * of relabelling finished work. Buffer padding becomes an unlabeled tail.
 */
function stepSegmentsFor(
  task: ScheduleTask,
  targetMinutes: number,
  existingBlocks: ScheduleBlock[],
): StepSegment[] {
  if (targetMinutes <= 0) return [];
  if (task.steps.length === 0) {
    return [{ stepId: null, title: "", minutes: targetMinutes }];
  }

  const remaining = new Map(
    task.steps.map((step) => [step.id, Math.max(0, step.minutes)]),
  );
  let unlabeledPlanned = 0;
  for (const block of existingBlocks) {
    if (block.taskId !== task.id || block.status === "skipped") continue;
    const minutes = durationMinutes(block.start, block.end);
    // A completed block only consumes the step by the work actually done, so
    // the unperformed remainder keeps its label and gets rescheduled.
    const covered =
      block.status === "done"
        ? Math.min(minutes, Math.max(0, block.actualMinutes ?? minutes))
        : minutes;
    const stepId = block.stepId ?? null;
    if (stepId !== null && remaining.has(stepId)) {
      remaining.set(
        stepId,
        Math.max(0, remaining.get(stepId)! - covered),
      );
      continue;
    }
    // Planned blocks without a step still consume the remaining target;
    // consume them from the front so labels do not restart. Done blocks
    // without a step are ignored because steps may postdate that work.
    if (block.status === "planned") unlabeledPlanned += covered;
  }

  const segments: StepSegment[] = task.steps
    .map((step) => ({
      stepId: step.id,
      title: step.title,
      minutes: remaining.get(step.id) ?? 0,
    }))
    .filter((segment) => segment.minutes > 0);

  let skip = unlabeledPlanned;
  while (skip > 0 && segments.length > 0) {
    const first = segments[0]!;
    const take = Math.min(first.minutes, skip);
    first.minutes -= take;
    skip -= take;
    if (first.minutes <= 0) segments.shift();
  }

  // Bound the labels to exactly targetMinutes: truncate an over-long
  // breakdown at the end and add an unlabeled tail for buffer padding.
  const bounded: StepSegment[] = [];
  let left = targetMinutes;
  for (const segment of segments) {
    if (left <= 0) break;
    const take = Math.min(segment.minutes, left);
    bounded.push({ ...segment, minutes: take });
    left -= take;
  }
  if (left > 0) {
    bounded.push({ stepId: null, title: "", minutes: left });
  }
  return bounded;
}

function sortTasks(
  tasks: ScheduleTask[],
  targetByTask: Map<string, number>,
): ScheduleTask[] {
  return [...tasks]
    .filter(
      (task) =>
        (task.status === "todo" || task.status === "in_progress") &&
        (targetByTask.get(task.id) ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
        (a.deadline ?? "9999-12-31").localeCompare(b.deadline ?? "9999-12-31") ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

/**
 * Greedy deterministic weekly scheduler. High-priority tasks are placed first
 * in chronological free slots; completed blocks are never moved by the caller.
 */
export function generateSchedule(input: SchedulerInput): SchedulerResult {
  const pools = buildDayPools(input);
  const capacityMinutes = pools.reduce(
    (total, pool) => total + pool.availableMinutes,
    0,
  );

  const targetByTask = new Map<string, number>();
  for (const task of input.tasks) {
    const committed = input.committedMinutesByTask?.get(task.id) ?? 0;
    targetByTask.set(
      task.id,
      targetForTask(task, input.preferences, committed),
    );
  }
  const demandMinutes = [...targetByTask.values()].reduce(
    (total, value) => total + value,
    0,
  );

  const warnings: string[] = [];
  const unscheduled: ScheduleUnscheduledTask[] = [];
  const blocks: ScheduleBlock[] = [];
  const scheduledMinutesByTask = new Map<string, number>();
  // Existing blocks per task/day; used to avoid placing a new chunk directly
  // against another chunk of the same task on the same day.
  const taskBlocksByDate = new Map<string, Map<string, Interval[]>>();
  for (const block of input.existingBlocks) {
    if (block.status === "skipped") continue;
    const byDate =
      taskBlocksByDate.get(block.taskId) ?? new Map<string, Interval[]>();
    const intervals = byDate.get(block.date) ?? [];
    intervals.push({
      start: clockToMinutes(block.start),
      end: clockToMinutes(block.end),
    });
    byDate.set(block.date, intervals);
    taskBlocksByDate.set(block.taskId, byDate);
  }

  if (compareDates(input.startDate, input.endDate) > 0) {
    warnings.push(
      `排期起始日 ${input.startDate} 晚于结束日 ${input.endDate}，未生成任何 block。`,
    );
  } else if (pools.length === 0) {
    warnings.push(
      `${input.startDate} ~ ${input.endDate} 没有可用工作日；请检查工作时段或工作日偏好。`,
    );
  }

  for (const task of sortTasks(input.tasks, targetByTask)) {
    let left = targetByTask.get(task.id) ?? 0;
    let dayIndex = 0;
    let lastDate: string | null = null;
    const minimumBlock = Math.max(
      task.minBlockMinutes,
      input.preferences.minBlockMinutes,
    );

    const segments = stepSegmentsFor(task, left, input.existingBlocks);
    let segmentIndex = 0;
    let segmentLeft = segments[0]?.minutes ?? 0;

    // Consumes the placed block's minutes from the step sequence and returns
    // the label of the step that covers most of the block.
    const takeStepLabel = (
      minutes: number,
    ): { stepId: string | null; title: string } => {
      let remainingMinutes = minutes;
      const consumed = new Map<number, number>();
      while (remainingMinutes > 0 && segmentIndex < segments.length) {
        if (segmentLeft <= 0) {
          segmentIndex += 1;
          segmentLeft = segments[segmentIndex]?.minutes ?? 0;
          continue;
        }
        const take = Math.min(segmentLeft, remainingMinutes);
        consumed.set(
          segmentIndex,
          (consumed.get(segmentIndex) ?? 0) + take,
        );
        segmentLeft -= take;
        remainingMinutes -= take;
        if (segmentLeft <= 0) {
          segmentIndex += 1;
          segmentLeft = segments[segmentIndex]?.minutes ?? 0;
        }
      }
      let bestIndex = -1;
      let bestMinutes = -1;
      for (const [index, value] of consumed) {
        if (value > bestMinutes) {
          bestIndex = index;
          bestMinutes = value;
        }
      }
      const segment = bestIndex >= 0 ? segments[bestIndex] : undefined;
      return {
        stepId: segment?.stepId ?? null,
        title: segment?.title ?? "",
      };
    };

    while (left > 0) {
      const requestedBase =
        splitIntoChunks(
          left,
          input.preferences.maxFocusMinutes,
          minimumBlock,
          task.splittable,
        )[0] ?? left;
      // Keep a block inside one step when the step has at least a minimum
      // block left; shorter steps are merged with the next one.
      const currentSegment = segments[segmentIndex];
      const requested =
        task.splittable &&
        currentSegment !== undefined &&
        currentSegment.stepId !== null &&
        segmentLeft >= minimumBlock &&
        segmentLeft < requestedBase
          ? segmentLeft
          : requestedBase;
      const minimum = task.splittable
        ? Math.min(minimumBlock, requested)
        : requested;

      let placed = false;
      for (let index = dayIndex; index < pools.length; index += 1) {
        const pool = pools[index]!;
        const avoid =
          taskBlocksByDate.get(task.id)?.get(pool.date) ?? [];
        const slot = pool.place(
          requested,
          minimum,
          task.preferredTimeOfDay,
          avoid,
        );
        if (slot === null) continue;

        const duration = slot.end - slot.start;
        const label = takeStepLabel(duration);
        blocks.push({
          id: `block_${randomUUID()}`,
          taskId: task.id,
          date: pool.date,
          start: minutesToClock(slot.start),
          end: minutesToClock(slot.end),
          status: "planned",
          actualMinutes: null,
          note: label.title,
          stepId: label.stepId,
        });
        const byDate =
          taskBlocksByDate.get(task.id) ?? new Map<string, Interval[]>();
        const intervals = byDate.get(pool.date) ?? [];
        intervals.push({ start: slot.start, end: slot.end });
        byDate.set(pool.date, intervals);
        taskBlocksByDate.set(task.id, byDate);
        lastDate = pool.date;
        left -= duration;
        scheduledMinutesByTask.set(
          task.id,
          (scheduledMinutesByTask.get(task.id) ?? 0) + duration,
        );
        placed = true;
        // Stay on this day; a later chunk falls through to the next day when
        // this day has no room left.
        dayIndex = index;
        break;
      }

      if (!placed) {
        break;
      }
    }

    if (left > 0) {
      const factor = 1 + input.preferences.bufferRatio;
      unscheduled.push({
        taskId: task.id,
        title: task.title,
        remainingMinutes: factor > 0 ? Math.round(left / factor) : left,
        reason:
          compareDates(input.startDate, input.endDate) > 0
            ? "排期范围为空"
            : pools.length === 0
              ? "范围内没有可用工作日"
              : task.splittable
                ? "可用容量不足"
                : "剩余时长找不到连续时段（任务不可拆分）",
      });
    }

    if (task.deadline !== null) {
      if (compareDates(task.deadline, input.today) < 0) {
        warnings.push(`「${task.title}」已逾期（截止 ${task.deadline}）。`);
      } else if (lastDate !== null && compareDates(lastDate, task.deadline) > 0) {
        warnings.push(
          `「${task.title}」预计排到 ${lastDate}，晚于截止 ${task.deadline}。`,
        );
      }
    }
  }

  if (unscheduled.length > 0) {
    warnings.push(
      `计划需求约 ${Math.round(demandMinutes / 6) / 10} 小时，可用约 ${
        Math.round(capacityMinutes / 6) / 10
      } 小时；${unscheduled.length} 项任务仍未排入，可延长范围或调整优先级。`,
    );
  }

  blocks.sort(
    (a, b) =>
      compareDates(a.date, b.date) ||
      clockToMinutes(a.start) - clockToMinutes(b.start),
  );

  return {
    blocks,
    unscheduled,
    warnings,
    capacityMinutes,
    demandMinutes,
    scheduledMinutesByTask,
  };
}

/** Week start for a date, exported for tools that build date ranges. */
export function weekRangeOf(date: string): {
  weekStart: string;
  weekEnd: string;
} {
  const weekStart = addDays(date, -(weekdayOf(date) - 1));
  return { weekStart, weekEnd: weekEndOf(weekStart) };
}
