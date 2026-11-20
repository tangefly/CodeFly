import { describe, expect, it } from "vitest";
import type {
  ScheduleBlock,
  SchedulePreferences,
  ScheduleTask,
} from "@codefly/protocol";
import { generateSchedule } from "../src/schedule/scheduler.js";

const PREFERENCES: SchedulePreferences = {
  timezone: "Asia/Shanghai",
  workdays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  breaks: [{ label: "午休", start: "12:00", end: "13:00" }],
  maxFocusMinutes: 90,
  minBlockMinutes: 30,
  bufferRatio: 0,
  dailyFocusLimitMinutes: 480,
};

function task(
  overrides: Omit<Partial<ScheduleTask>, "id"> & { id: string },
): ScheduleTask {
  const { id, ...rest } = overrides;
  return {
    id,
    title: overrides.title ?? id,
    notes: "",
    project: null,
    priority: "medium",
    status: "todo",
    estimatedMinutes: 120,
    remainingMinutes: 120,
    actualMinutes: 0,
    estimateConfidence: "high",
    deadline: null,
    splittable: true,
    minBlockMinutes: 30,
    preferredTimeOfDay: "any",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...rest,
  };
}

function block(overrides: Partial<ScheduleBlock> & { id: string }): ScheduleBlock {
  return {
    id: overrides.id,
    taskId: overrides.taskId ?? "other",
    date: overrides.date ?? "2026-11-16",
    start: overrides.start ?? "09:00",
    end: overrides.end ?? "10:00",
    status: overrides.status ?? "planned",
    actualMinutes: overrides.actualMinutes ?? null,
    note: "",
  };
}

describe("generateSchedule", () => {
  it("splits work into focus blocks and respects breaks", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [task({ id: "t1", title: "写论文", remainingMinutes: 120 })],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0, maxFocusMinutes: 90 },
    });

    expect(result.blocks.map((item) => [item.start, item.end])).toEqual([
      ["09:00", "10:30"],
      ["10:40", "11:10"],
    ]);
    expect(result.blocks.every((item) => item.date === "2026-11-16")).toBe(true);
    expect(result.unscheduled).toHaveLength(0);
  });

  it("orders tasks by priority and packs urgent work first", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [
        task({ id: "low", title: "低优先级", priority: "low", remainingMinutes: 60 }),
        task({ id: "urgent", title: "紧急", priority: "urgent", remainingMinutes: 60 }),
      ],
      existingBlocks: [],
      preferences: PREFERENCES,
    });
    expect(result.blocks[0]?.taskId).toBe("urgent");
    expect(result.blocks[1]?.taskId).toBe("low");
  });

  it("adds a confidence buffer for uncertain estimates", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [
        task({
          id: "uncertain",
          remainingMinutes: 100,
          estimateConfidence: "low",
        }),
      ],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0.1, maxFocusMinutes: 240 },
    });
    // 100 * (1 + 0.1 + 0.25) = 135 minutes
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.start).toBe("09:00");
    expect(result.blocks[0]?.end).toBe("11:15");
    expect(result.demandMinutes).toBe(135);
  });

  it("keeps non-splittable tasks in one block", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [
        task({
          id: "one-shot",
          remainingMinutes: 120,
          splittable: false,
        }),
      ],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0 },
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.start).toBe("09:00");
    expect(result.blocks[0]?.end).toBe("11:00");
  });

  it("reports unscheduled work when capacity is insufficient", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [task({ id: "big", remainingMinutes: 600 })],
      existingBlocks: [],
      preferences: {
        ...PREFERENCES,
        bufferRatio: 0,
        dailyFocusLimitMinutes: 120,
      },
    });
    expect(result.blocks.reduce((total, item) => {
      const [sh, sm] = item.start.split(":").map(Number);
      const [eh, em] = item.end.split(":").map(Number);
      return total + (eh! * 60 + em! - sh! * 60 - sm!);
    }, 0)).toBe(120);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0]?.remainingMinutes).toBe(480);
    expect(result.warnings.join(" ")).toContain("未排入");
  });

  it("starts after existing done blocks and never overlaps them", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [task({ id: "t1", remainingMinutes: 60 })],
      existingBlocks: [
        block({
          id: "done",
          taskId: "t1",
          start: "09:00",
          end: "10:00",
          status: "done",
          actualMinutes: 60,
        }),
      ],
      preferences: PREFERENCES,
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.start).toBe("10:10");
    expect(result.blocks[0]?.end).toBe("11:10");
  });

  it("spills into the next week when the range extends", () => {
    const result = generateSchedule({
      startDate: "2026-11-20",
      endDate: "2026-11-23",
      today: "2026-11-20",
      tasks: [task({ id: "t1", remainingMinutes: 120 })],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0, dailyFocusLimitMinutes: 60 },
    });
    expect(result.blocks.map((item) => item.date)).toEqual([
      "2026-11-20",
      "2026-11-23",
    ]);
  });

  it("warns when a task misses its deadline", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-17",
      today: "2026-11-16",
      tasks: [
        task({
          id: "late",
          title: "迟到的任务",
          priority: "urgent",
          remainingMinutes: 240,
          deadline: "2026-11-16",
        }),
      ],
      existingBlocks: [],
      preferences: {
        ...PREFERENCES,
        bufferRatio: 0,
        dailyFocusLimitMinutes: 120,
      },
    });
    expect(result.blocks.some((item) => item.date === "2026-11-17")).toBe(true);
    expect(result.warnings.join(" ")).toContain("晚于截止 2026-11-16");
  });

  it("does not reschedule minutes already committed before the start date", () => {
    const result = generateSchedule({
      startDate: "2026-11-23",
      endDate: "2026-11-23",
      today: "2026-11-16",
      tasks: [task({ id: "t1", remainingMinutes: 120 })],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0 },
      committedMinutesByTask: new Map([["t1", 60]]),
    });
    expect(result.demandMinutes).toBe(60);
    expect(result.blocks[0]?.end).toBe("10:00");
  });
});
