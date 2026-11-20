import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ScheduleFixedEvent,
  SchedulePlanSummary,
  SchedulePreferences,
  ScheduleTask,
  ScheduleWindow,
} from "@codefly/protocol";
import { buildScheduleAgenda } from "../src/schedule/agenda.js";
import { renderAgendaPng } from "../src/schedule/render.js";

const preferences: SchedulePreferences = {
  timezone: "Asia/Shanghai",
  workdays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  breaks: [{ label: "午休", start: "12:00", end: "13:00" }],
  maxFocusMinutes: 90,
  minBlockMinutes: 30,
  bufferRatio: 0.15,
  gapMinutes: 0,
  dailyFocusLimitMinutes: 480,
  rules: [],
};

const task: ScheduleTask = {
  id: "task_1",
  title: "写论文初稿：方法部分与实验分析",
  notes: "",
  project: "论文",
  priority: "high",
  status: "in_progress",
  estimatedMinutes: 180,
  remainingMinutes: 120,
  actualMinutes: 60,
  estimateConfidence: "low",
  deadline: "2026-11-30",
  splittable: true,
  minBlockMinutes: 30,
  preferredTimeOfDay: "morning",
  steps: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const window: ScheduleWindow = {
  startDate: "2026-11-16",
  endDate: "2026-11-22",
  timezone: "Asia/Shanghai",
  blocks: [
    {
      id: "b1",
      taskId: task.id,
      date: "2026-11-16",
      start: "09:00",
      end: "10:30",
      status: "done",
      actualMinutes: 90,
      note: "",
    },
    {
      id: "b2",
      taskId: task.id,
      date: "2026-11-17",
      start: "09:00",
      end: "10:30",
      status: "planned",
      actualMinutes: null,
      note: "",
    },
  ],
  unscheduled: [
    {
      taskId: task.id,
      title: "写论文初稿：方法部分与实验分析",
      remainingMinutes: 30,
      reason: "可用容量不足",
    },
  ],
  warnings: ["「写论文初稿」预计排到 2026-11-17，晚于截止 2026-11-16。"],
  notes: "周五下午留给组会。",
};

const summary: SchedulePlanSummary = {
  rangeStart: window.startDate,
  rangeEnd: window.endDate,
  timezone: window.timezone,
  planId: null,
  totalPlannedMinutes: 180,
  taskCount: 1,
  doneMinutes: 90,
  unscheduled: window.unscheduled,
  warnings: window.warnings,
};

const fixedEvents: ScheduleFixedEvent[] = [
  {
    id: "fixed_meeting",
    title: "线上会议 A",
    kind: "weekly",
    weekday: 1,
    date: null,
    start: "16:00",
    end: "17:30",
    location: "线上",
    note: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    id: "fixed_seminar",
    title: "讲座",
    kind: "once",
    weekday: null,
    date: "2026-11-18",
    start: "10:00",
    end: "12:00",
    location: "",
    note: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
];

function agendaFor(
  input: {
    window?: ScheduleWindow | null;
    events?: ScheduleFixedEvent[];
    summary?: SchedulePlanSummary;
  } = {},
) {
  return buildScheduleAgenda({
    window: input.window === undefined ? window : input.window,
    tasks: [task],
    fixedEvents: input.events ?? [],
    preferences,
    startDate: "2026-11-16",
    endDate: "2026-11-22",
    today: "2026-11-16",
    nowClock: "08:00",
    summary: input.summary ?? summary,
  });
}

describe("schedule agenda renderer", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-schedule-render-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a chronological day agenda and renders a real PNG", async () => {
    const agenda = agendaFor({ events: fixedEvents });
    expect(agenda.days).toHaveLength(7);
    expect(agenda.days[0]?.date).toBe("2026-11-16");
    expect(agenda.days[0]?.items.map((item) => item.title)).toEqual([
      "写论文初稿：方法部分与实验分析",
      "线上会议 A",
    ]);
    expect(agenda.days[0]?.items[0]).toMatchObject({
      kind: "task",
      status: "done",
      start: "09:00",
      end: "10:30",
    });
    expect(agenda.days[0]?.items[1]).toMatchObject({
      kind: "fixed",
      start: "16:00",
      end: "17:30",
      location: "线上",
    });
    expect(agenda.days[2]?.items[0]).toMatchObject({
      kind: "fixed",
      title: "讲座",
      start: "10:00",
    });
    expect(agenda.days[0]?.freeMinutes).not.toBeNull();

    const result = await renderAgendaPng({ agenda, outputDir: dir });
    // Default raster scale is 3x so the PNG is print-quality (≈300 DPI on A4).
    expect(result.width).toBe(820 * 3);
    expect(result.height).toBeGreaterThan(2000);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);

    const data = await readFile(result.filePath);
    expect([...data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect((await stat(result.filePath)).size).toBeGreaterThan(5000);
  });

  it("renders a window without any plan or fixed events", async () => {
    const emptySummary: SchedulePlanSummary = {
      rangeStart: "2026-11-16",
      rangeEnd: "2026-11-22",
      timezone: preferences.timezone,
      planId: null,
      totalPlannedMinutes: 0,
      taskCount: 0,
      doneMinutes: 0,
      unscheduled: [],
      warnings: [],
    };
    const agenda = agendaFor({ window: null, summary: emptySummary });
    expect(agenda.days).toHaveLength(7);
    expect(agenda.days.every((day) => day.items.length === 0)).toBe(true);
    const result = await renderAgendaPng({ agenda, outputDir: dir });
    expect(result.buffer.byteLength).toBeGreaterThan(1000);
  });

  it("supports an explicit raster scale", async () => {
    const agenda = agendaFor();
    const result = await renderAgendaPng({ agenda, outputDir: dir, scale: 1 });
    expect(result.width).toBe(820);
    expect(result.height).toBeGreaterThan(700);
  });

  it("marks non-working days with null free time", () => {
    const agenda = agendaFor();
    // 2026-11-21 is Saturday and 2026-11-22 is Sunday.
    expect(agenda.days[5]?.freeMinutes).toBeNull();
    expect(agenda.days[6]?.freeMinutes).toBeNull();
  });
});
