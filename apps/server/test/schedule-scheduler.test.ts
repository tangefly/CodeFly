import { describe, expect, it } from "vitest";
import type {
  ScheduleBlock,
  ScheduleFixedEvent,
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
  gapMinutes: 10,
  dailyFocusLimitMinutes: 480,
  rules: [],
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
    steps: [],
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
    stepId: overrides.stepId ?? null,
  };
}

function fixedEvent(
  overrides: Partial<ScheduleFixedEvent> & { id: string },
): ScheduleFixedEvent {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    kind: overrides.kind ?? "weekly",
    weekday: overrides.weekday ?? (overrides.kind === "once" ? null : 1),
    date: overrides.date ?? null,
    start: overrides.start ?? "08:00",
    end: overrides.end ?? "09:35",
    location: overrides.location ?? "",
    note: "",
    busy: overrides.busy ?? true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
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

  it("uses step titles as block notes and continues after completed steps", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [
        task({
          id: "decomposed",
          remainingMinutes: 120,
          steps: [
            { id: "step_a", title: "精读基线论文", minutes: 60 },
            { id: "step_b", title: "整理对比表", minutes: 60 },
            { id: "step_c", title: "写方法小节", minutes: 60 },
          ],
        }),
      ],
      existingBlocks: [
        block({
          id: "done-a",
          taskId: "decomposed",
          start: "09:00",
          end: "10:00",
          status: "done",
          actualMinutes: 60,
          stepId: "step_a",
        }),
      ],
      preferences: { ...PREFERENCES, bufferRatio: 0, gapMinutes: 10 },
    });

    expect(result.blocks.map((item) => item.note)).toEqual([
      "整理对比表",
      "写方法小节",
    ]);
    expect(result.blocks.map((item) => item.stepId)).toEqual([
      "step_b",
      "step_c",
    ]);
    expect(result.blocks[0]?.start).toBe("10:10");
  });

  it("keeps the same step label when one step spans multiple blocks", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [
        task({
          id: "long-step",
          remainingMinutes: 180,
          steps: [{ id: "method", title: "写方法部分", minutes: 180 }],
        }),
      ],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0, gapMinutes: 0 },
    });

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.map((item) => item.note)).toEqual([
      "写方法部分",
      "写方法部分",
    ]);
    expect(result.blocks.every((item) => item.stepId === "method")).toBe(true);
  });

  it("keeps a partially completed step labelled with its unperformed minutes", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-17",
      today: "2026-11-16",
      tasks: [
        task({
          id: "partial",
          remainingMinutes: 150,
          steps: [
            { id: "step_a", title: "精读基线论文", minutes: 60 },
            { id: "step_b", title: "整理对比表", minutes: 60 },
            { id: "step_c", title: "写方法小节", minutes: 60 },
          ],
        }),
      ],
      existingBlocks: [
        block({
          id: "done-a",
          taskId: "partial",
          start: "09:00",
          end: "10:00",
          status: "done",
          actualMinutes: 30,
          stepId: "step_a",
        }),
      ],
      preferences: { ...PREFERENCES, bufferRatio: 0, gapMinutes: 10 },
    });

    expect(result.blocks[0]?.note).toBe("精读基线论文");
    expect(result.blocks[0]?.stepId).toBe("step_a");
    expect(result.blocks[0]?.end).toBe("10:40");
  });

  it("keeps notes empty when a task has no breakdown", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [task({ id: "plain", remainingMinutes: 60 })],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0 },
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.note).toBe("");
    expect(result.blocks[0]?.stepId).toBeNull();
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

  it("does not add a hidden confidence buffer", () => {
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
    // Only bufferRatio applies: 100 * 1.1 = 110 minutes. Confidence is
    // advisory to the model, not an automatic multiplier.
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.start).toBe("09:00");
    expect(result.blocks[0]?.end).toBe("10:50");
    expect(result.demandMinutes).toBe(110);
  });

  it("schedules an exact estimate when buffer and gap are zero", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [
        task({
          id: "exact",
          remainingMinutes: 180,
          estimateConfidence: "medium",
        }),
      ],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0, gapMinutes: 0 },
    });
    expect(result.blocks.map((item) => [item.start, item.end])).toEqual([
      ["09:00", "10:30"],
      ["13:00", "14:30"],
    ]);
    expect(result.demandMinutes).toBe(180);
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

  it("carves fixed weekly events out of the free pool", () => {
    // 2026-11-16 is a Monday; a morning course occupies 09:00-11:00.
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [task({ id: "t1", remainingMinutes: 120 })],
      existingBlocks: [],
      fixedEvents: [
        fixedEvent({
          id: "class",
          title: "课程",
          kind: "weekly",
          weekday: 1,
          start: "09:00",
          end: "11:00",
        }),
      ],
      preferences: PREFERENCES,
    });
    // With the course (plus 10-minute buffers) removed, no work overlaps the
    // class: the 90-minute chunk lands after lunch, the 30-minute tail fills
    // the morning gap (blocks are listed by start time).
    expect(result.blocks.map((item) => [item.start, item.end])).toEqual([
      ["11:10", "11:40"],
      ["13:00", "14:30"],
    ]);
  });

  it("schedules tasks inside non-busy fixed events", () => {
    // Same Monday course 09:00-11:00, but the user works through it: the
    // slot stays schedulable and the task starts at work start.
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [task({ id: "t1", remainingMinutes: 120 })],
      existingBlocks: [],
      fixedEvents: [
        fixedEvent({
          id: "class",
          title: "课程",
          kind: "weekly",
          weekday: 1,
          start: "09:00",
          end: "11:00",
          busy: false,
        }),
      ],
      preferences: PREFERENCES,
    });
    expect(result.blocks.map((item) => [item.start, item.end])).toEqual([
      ["09:00", "10:30"],
      ["10:40", "11:10"],
    ]);
    // The parallel course never consumed capacity, so the full workday minus
    // the lunch break remains (540 - 60).
    expect(result.capacityMinutes).toBe(480);
  });

  it("works with fixed events only and no tasks", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [],
      existingBlocks: [],
      fixedEvents: [
        fixedEvent({
          id: "meeting",
          title: "线上会议",
          kind: "weekly",
          weekday: 1,
          start: "16:00",
          end: "17:30",
        }),
      ],
      preferences: PREFERENCES,
    });
    expect(result.blocks).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    // Capacity reflects the class/meeting carve-out, not the full workday.
    expect(result.capacityMinutes).toBeGreaterThan(0);
    expect(result.capacityMinutes).toBeLessThan(540);
  });

  it("does not let fixed events consume the daily focus limit", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      tasks: [task({ id: "t1", remainingMinutes: 240 })],
      existingBlocks: [],
      fixedEvents: [
        fixedEvent({
          id: "class",
          kind: "weekly",
          weekday: 1,
          start: "09:00",
          end: "11:00",
        }),
      ],
      preferences: {
        ...PREFERENCES,
        bufferRatio: 0,
        maxFocusMinutes: 120,
        dailyFocusLimitMinutes: 240,
      },
    });
    // The two 120-minute focus blocks still fit even though the class also
    // occupies 120 minutes of the day.
    expect(
      result.blocks.reduce((total, item) => {
        const [sh, sm] = item.start.split(":").map(Number);
        const [eh, em] = item.end.split(":").map(Number);
        return total + (eh! * 60 + em! - sh! * 60 - sm!);
      }, 0),
    ).toBe(240);
    expect(result.unscheduled).toHaveLength(0);
  });

  it("never schedules into time that already passed today", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      today: "2026-11-16",
      nowClock: "15:00",
      tasks: [task({ id: "t1", remainingMinutes: 120 })],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0, maxFocusMinutes: 90 },
    });
    expect(result.blocks.map((item) => [item.start, item.end])).toEqual([
      ["15:00", "16:30"],
      ["16:40", "17:10"],
    ]);
    expect(result.blocks.every((item) => item.date === "2026-11-16")).toBe(true);
  });

  it("does not clamp days after today", () => {
    const result = generateSchedule({
      startDate: "2026-11-17",
      endDate: "2026-11-17",
      today: "2026-11-16",
      nowClock: "15:00",
      tasks: [task({ id: "t1", remainingMinutes: 60 })],
      existingBlocks: [],
      preferences: { ...PREFERENCES, bufferRatio: 0, maxFocusMinutes: 60 },
    });
    expect(result.blocks.map((item) => [item.start, item.end])).toEqual([
      ["09:00", "10:00"],
    ]);
  });

  it("honours one-off events on their specific date", () => {
    const result = generateSchedule({
      startDate: "2026-11-16",
      endDate: "2026-11-17",
      today: "2026-11-16",
      tasks: [task({ id: "t1", remainingMinutes: 180 })],
      existingBlocks: [],
      fixedEvents: [
        fixedEvent({
          id: "seminar",
          kind: "once",
          date: "2026-11-17",
          start: "09:00",
          end: "12:00",
        }),
      ],
      preferences: { ...PREFERENCES, bufferRatio: 0, maxFocusMinutes: 180 },
    });
    // Monday fills completely; Tuesday cannot fit another 90-minute block
    // before/after the seminar, so the remainder spills to a later day.
    const mondayMinutes = result.blocks
      .filter((item) => item.date === "2026-11-16")
      .reduce((total, item) => {
        const [sh, sm] = item.start.split(":").map(Number);
        const [eh, em] = item.end.split(":").map(Number);
        return total + (eh! * 60 + em! - sh! * 60 - sm!);
      }, 0);
    expect(mondayMinutes).toBe(180);
    expect(
      result.blocks.some(
        (item) => item.date === "2026-11-17" && item.start < "09:00",
      ),
    ).toBe(false);
  });
});
