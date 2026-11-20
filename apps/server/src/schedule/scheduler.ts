import { randomUUID } from "node:crypto";
import type {
  ScheduleBlock,
  ScheduleConfidence,
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

/** Small buffer between generated blocks so the day is not wall-to-wall. */
const GAP_MINUTES = 10;

const PRIORITY_RANK: Record<SchedulePriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const CONFIDENCE_EXTRA: Record<ScheduleConfidence, number> = {
  low: 0.25,
  medium: 0.1,
  high: 0,
};

interface Interval {
  start: number;
  end: number;
}

export interface SchedulerInput {
  /** First day that may receive new blocks (YYYY-MM-DD). */
  startDate: string;
  /** Last day that may receive new blocks (inclusive). */
  endDate: string;
  today: string;
  tasks: ScheduleTask[];
  /** Blocks that remain after the store applies removals/skips. */
  existingBlocks: ScheduleBlock[];
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

  constructor(
    date: string,
    intervals: Interval[],
    existingMinutes: number,
    dailyLimitMinutes: number,
  ) {
    this.date = date;
    this.intervals = intervals;
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
      const slot = this.findSlot(wanted, wanted, window);
      if (slot !== null) return this.consume(slot);
    }
    // Second pass: accept a smaller gap that still meets the minimum.
    if (minimum < wanted) {
      for (const window of windows) {
        const slot = this.findSlot(wanted, minimum, window);
        if (slot !== null) return this.consume(slot);
      }
    }
    return null;
  }

  private findSlot(
    wanted: number,
    minimum: number,
    window: Interval | null,
  ): Interval | null {
    let best: Interval | null = null;
    let bestDuration = 0;
    for (const interval of this.intervals) {
      const lo = Math.max(interval.start, window?.start ?? 0, 0);
      const hi = Math.min(interval.end, window?.end ?? 24 * 60, 24 * 60);
      const available = hi - lo;
      if (available < minimum) continue;
      const duration = Math.min(wanted, available);
      if (duration >= wanted) {
        return { start: lo, end: lo + duration };
      }
      // Prefer the largest partial gap instead of the earliest tiny one.
      if (duration > bestDuration) {
        best = { start: lo, end: lo + duration };
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
        const tailStart = slot.end + GAP_MINUTES;
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
  const pools: DayPool[] = [];

  for (
    let date = input.startDate;
    compareDates(date, input.endDate) <= 0;
    date = addDays(date, 1)
  ) {
    if (!input.preferences.workdays.includes(weekdayOf(date))) continue;

    let intervals: Interval[] = [{ start: workStart, end: workEnd }];
    for (const brk of input.preferences.breaks) {
      intervals = subtractInterval(
        intervals,
        clockToMinutes(brk.start),
        clockToMinutes(brk.end),
      );
    }

    const existing = byDate.get(date) ?? [];
    for (const block of existing) {
      // Leave a small buffer around existing commitments so regenerated work
      // does not start the instant a meeting or completed block ends.
      intervals = subtractInterval(
        intervals,
        Math.max(workStart, clockToMinutes(block.start) - GAP_MINUTES),
        Math.min(workEnd, clockToMinutes(block.end) + GAP_MINUTES),
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
  const work = Math.max(0, task.remainingMinutes - committedMinutes);
  if (work <= 0) return 0;
  const factor =
    1 +
    preferences.bufferRatio +
    CONFIDENCE_EXTRA[task.estimateConfidence];
  return Math.max(1, Math.ceil(work * factor));
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

    while (left > 0) {
      let requested = task.splittable
        ? Math.min(input.preferences.maxFocusMinutes, left)
        : left;
      if (
        task.splittable &&
        left - requested > 0 &&
        left - requested < minimumBlock
      ) {
        // Merge a tail that is too small to stand on its own.
        requested = left;
      }
      const minimum = task.splittable
        ? Math.min(minimumBlock, left)
        : requested;

      let placed = false;
      for (let index = dayIndex; index < pools.length; index += 1) {
        const pool = pools[index]!;
        const slot = pool.place(requested, minimum, task.preferredTimeOfDay);
        if (slot === null) continue;

        const duration = slot.end - slot.start;
        blocks.push({
          id: `block_${randomUUID()}`,
          taskId: task.id,
          date: pool.date,
          start: minutesToClock(slot.start),
          end: minutesToClock(slot.end),
          status: "planned",
          actualMinutes: null,
          note: "",
        });
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
      const factor =
        1 +
        input.preferences.bufferRatio +
        CONFIDENCE_EXTRA[task.estimateConfidence];
      unscheduled.push({
        taskId: task.id,
        title: task.title,
        remainingMinutes: Math.ceil(left / factor),
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
