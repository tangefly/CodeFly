import type {
  ScheduleAgendaDay,
  ScheduleAgendaItem,
  ScheduleAgendaModel,
  ScheduleAgendaParallelBlock,
  ScheduleBlock,
  ScheduleFixedEvent,
  SchedulePlanSummary,
  SchedulePreferences,
  ScheduleTask,
  ScheduleWindow,
} from "@codefly/protocol";
import {
  addDays,
  clockToMinutes,
  compareDates,
  daysBetween,
  durationMinutes,
  weekdayLabel,
  weekdayOf,
} from "./time.js";

interface Interval {
  start: number;
  end: number;
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

function totalMinutes(intervals: Interval[]): number {
  return intervals.reduce(
    (total, interval) => total + (interval.end - interval.start),
    0,
  );
}

/** Fixed commitments that occupy wall-clock time on `date`. */
export function fixedEventsForDate(
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
    .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

/**
 * Assigns task blocks that overlap a non-busy fixed event's window to that
 * event, so course and task render side by side. A block overlapping several
 * events joins the one it overlaps most. `blocks` must already be filtered to
 * the same date as `events`. Returns the absorbed block ids so they are not
 * emitted as standalone agenda items.
 */
export function pairParallelBlocks(
  events: ScheduleFixedEvent[],
  blocks: ScheduleBlock[],
  taskIndex: Map<string, ScheduleTask>,
): {
  byEventId: Map<string, ScheduleAgendaParallelBlock[]>;
  absorbedBlockIds: Set<string>;
} {
  const byEventId = new Map<string, ScheduleAgendaParallelBlock[]>();
  const absorbedBlockIds = new Set<string>();
  const nonBusy = events.filter((event) => !event.busy);
  if (nonBusy.length === 0) return { byEventId, absorbedBlockIds };
  for (const block of blocks) {
    const start = clockToMinutes(block.start);
    const end = clockToMinutes(block.end);
    let best: ScheduleFixedEvent | null = null;
    let bestOverlap = 0;
    for (const event of nonBusy) {
      const overlap =
        Math.min(end, clockToMinutes(event.end)) -
        Math.max(start, clockToMinutes(event.start));
      if (overlap > bestOverlap) {
        best = event;
        bestOverlap = overlap;
      }
    }
    if (best === null) continue;
    const task = taskIndex.get(block.taskId);
    const list = byEventId.get(best.id) ?? [];
    list.push({
      blockId: block.id,
      title: task?.title ?? "已删除任务",
      start: block.start,
      end: block.end,
      status: block.status,
      priority: task?.priority ?? null,
    });
    byEventId.set(best.id, list);
    absorbedBlockIds.add(block.id);
  }
  return { byEventId, absorbedBlockIds };
}

function agendaItemsForDay(input: {
  date: string;
  fixedEvents: ScheduleFixedEvent[];
  window: ScheduleWindow | null;
  taskIndex: Map<string, ScheduleTask>;
}): ScheduleAgendaItem[] {
  const dayEvents = fixedEventsForDate(input.fixedEvents, input.date);
  const dayBlocks = (input.window?.blocks ?? []).filter(
    (block) => block.date === input.date,
  );
  const { byEventId, absorbedBlockIds } = pairParallelBlocks(
    dayEvents,
    dayBlocks,
    input.taskIndex,
  );
  const items: ScheduleAgendaItem[] = [];
  for (const event of dayEvents) {
    items.push({
      id: `fixed:${event.id}:${input.date}`,
      kind: "fixed",
      title: event.title,
      start: event.start,
      end: event.end,
      status: "planned",
      actualMinutes: null,
      priority: null,
      location: event.location,
      note: event.note,
      busy: event.busy,
      parallelBlocks: byEventId.get(event.id),
    });
  }
  for (const block of dayBlocks) {
    if (absorbedBlockIds.has(block.id)) continue;
    const task = input.taskIndex.get(block.taskId);
    items.push({
      id: block.id,
      kind: "task",
      title: task?.title ?? "已删除任务",
      start: block.start,
      end: block.end,
      status: block.status,
      actualMinutes: block.actualMinutes,
      priority: task?.priority ?? null,
      location: "",
      note: block.note,
      busy: null,
    });
  }
  // Chronological order; fixed commitments win ties so they anchor the day.
  return items.sort(
    (a, b) =>
      clockToMinutes(a.start) - clockToMinutes(b.start) ||
      (a.kind === b.kind ? 0 : a.kind === "fixed" ? -1 : 1) ||
      a.title.localeCompare(b.title),
  );
}

function freeMinutesForDay(input: {
  date: string;
  items: ScheduleAgendaItem[];
  preferences: SchedulePreferences;
  today: string;
  nowClock: string;
}): number | null {
  const weekday = weekdayOf(input.date);
  if (!input.preferences.workdays.includes(weekday)) return null;

  const workStart = clockToMinutes(input.preferences.workStart);
  const workEnd = clockToMinutes(input.preferences.workEnd);
  const dayStart =
    input.date === input.today
      ? Math.max(workStart, Math.ceil(clockToMinutes(input.nowClock) / 5) * 5)
      : workStart;
  if (dayStart >= workEnd || workEnd <= workStart) return 0;

  let free: Interval[] = [{ start: dayStart, end: workEnd }];
  for (const brk of input.preferences.breaks) {
    free = subtractInterval(
      free,
      Math.max(dayStart, clockToMinutes(brk.start)),
      Math.min(workEnd, clockToMinutes(brk.end)),
    );
  }
  for (const item of input.items) {
    if (item.status === "skipped") continue;
    if (item.kind === "fixed" && item.busy === false) {
      // The course itself leaves its slot usable; only the work actually
      // scheduled inside it consumes free time.
      for (const block of item.parallelBlocks ?? []) {
        if (block.status === "skipped") continue;
        free = subtractInterval(
          free,
          Math.max(dayStart, clockToMinutes(block.start)),
          Math.min(workEnd, clockToMinutes(block.end)),
        );
      }
      continue;
    }
    free = subtractInterval(
      free,
      Math.max(dayStart, clockToMinutes(item.start)),
      Math.min(workEnd, clockToMinutes(item.end)),
    );
  }
  return Math.max(0, totalMinutes(free));
}

/**
 * Builds the day-by-day agenda shared by the schedule panel, tool cards and
 * the PNG renderer. It merges fixed commitments with task blocks, keeps each
 * day in chronological order and reports remaining free time inside working
 * hours. On the current day free time starts at "now", never in the past.
 */
export function buildScheduleAgenda(input: {
  window: ScheduleWindow | null;
  tasks: ScheduleTask[];
  fixedEvents: ScheduleFixedEvent[];
  preferences: SchedulePreferences;
  startDate: string;
  endDate: string;
  today: string;
  nowClock: string;
  summary: SchedulePlanSummary;
}): ScheduleAgendaModel {
  const taskIndex = new Map(input.tasks.map((task) => [task.id, task]));
  const dayCount = Math.max(
    1,
    compareDates(input.endDate, input.startDate) < 0
      ? 1
      : daysBetween(input.startDate, input.endDate) + 1,
  );
  const days: ScheduleAgendaDay[] = [];
  for (let index = 0; index < dayCount; index += 1) {
    const date = addDays(input.startDate, index);
    const items = agendaItemsForDay({
      date,
      fixedEvents: input.fixedEvents,
      window: input.window,
      taskIndex,
    });
    const plannedMinutes = items.reduce((total, item) => {
      if (item.status === "skipped") return total;
      if (item.kind === "fixed" && item.busy === false) {
        // A parallel course does not consume time; count the work inside it.
        return total + (item.parallelBlocks ?? []).reduce(
          (sum, block) =>
            block.status === "skipped"
              ? sum
              : sum + durationMinutes(block.start, block.end),
          0,
        );
      }
      return total + durationMinutes(item.start, item.end);
    }, 0);
    days.push({
      date,
      weekday: weekdayLabel(date),
      items,
      plannedMinutes,
      freeMinutes: freeMinutesForDay({
        date,
        items,
        preferences: input.preferences,
        today: input.today,
        nowClock: input.nowClock,
      }),
    });
  }

  return {
    startDate: input.startDate,
    endDate: input.endDate,
    timezone: input.preferences.timezone,
    today: input.today,
    generatedAt: new Date().toISOString(),
    days,
    summary: input.summary,
    unscheduled: input.window?.unscheduled.map((item) => ({ ...item })) ?? [],
    warnings: [...(input.window?.warnings ?? [])],
    notes: input.window?.notes ?? "",
  };
}
