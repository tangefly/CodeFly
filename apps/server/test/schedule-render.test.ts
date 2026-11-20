import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SchedulePlan,
  SchedulePlanSummary,
  SchedulePreferences,
  ScheduleTask,
} from "@codefly/protocol";
import { renderWeekPng } from "../src/schedule/render.js";

const preferences: SchedulePreferences = {
  timezone: "Asia/Shanghai",
  workdays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  breaks: [{ label: "午休", start: "12:00", end: "13:00" }],
  maxFocusMinutes: 90,
  minBlockMinutes: 30,
  bufferRatio: 0.15,
  dailyFocusLimitMinutes: 480,
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
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const plan: SchedulePlan = {
  id: "plan_1",
  weekStart: "2026-11-16",
  weekEnd: "2026-11-22",
  timezone: "Asia/Shanghai",
  status: "active",
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
  createdAt: "2026-11-16T00:00:00.000Z",
  updatedAt: "2026-11-16T00:00:00.000Z",
};

const summary: SchedulePlanSummary = {
  weekStart: plan.weekStart,
  weekEnd: plan.weekEnd,
  timezone: plan.timezone,
  planId: plan.id,
  totalPlannedMinutes: 180,
  taskCount: 1,
  doneMinutes: 90,
  unscheduled: plan.unscheduled,
  warnings: plan.warnings,
};

describe("schedule PNG renderer", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-schedule-render-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders a task × weekday table to a real PNG", async () => {
    const result = await renderWeekPng({
      plan,
      tasks: [task],
      preferences,
      weekStart: plan.weekStart,
      weekEnd: plan.weekEnd,
      summary,
      outputDir: dir,
    });

    expect(result.table.days).toHaveLength(7);
    expect(result.table.rows).toHaveLength(1);
    expect(result.table.rows[0]?.title).toContain("写论文初稿");
    expect(result.table.rows[0]?.days[0]).toHaveLength(1);
    expect(result.table.unscheduled).toHaveLength(1);
    expect(result.width).toBeGreaterThan(1000);
    expect(result.height).toBeGreaterThan(300);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);

    const data = await readFile(result.filePath);
    expect([...data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect((await stat(result.filePath)).size).toBeGreaterThan(5000);
  });

  it("renders an empty week without throwing", async () => {
    const emptySummary: SchedulePlanSummary = {
      weekStart: "2026-11-23",
      weekEnd: "2026-11-29",
      timezone: preferences.timezone,
      planId: null,
      totalPlannedMinutes: 0,
      taskCount: 0,
      doneMinutes: 0,
      unscheduled: [],
      warnings: [],
    };
    const result = await renderWeekPng({
      plan: null,
      tasks: [],
      preferences,
      weekStart: "2026-11-23",
      weekEnd: "2026-11-29",
      summary: emptySummary,
      outputDir: dir,
    });
    expect(result.table.rows).toHaveLength(0);
    expect(result.buffer.byteLength).toBeGreaterThan(1000);
  });
});
