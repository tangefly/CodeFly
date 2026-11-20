import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/schedule/store.js";

describe("ScheduleStore", () => {
  let dir: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-schedule-store-"));
    store = new ScheduleStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores, updates and deletes structured memories", async () => {
    const memory = await store.createMemory({
      key: "morning_focus",
      category: "preference",
      title: "上午专注",
      content: "上午更适合写论文",
      tags: ["energy", "writing"],
      pinned: true,
    });
    expect(store.getMemory(memory.id)?.key).toBe("morning_focus");
    expect(store.getMemoryByKey("morning_focus")?.tags).toEqual([
      "energy",
      "writing",
    ]);
    await expect(
      store.createMemory({
        key: "morning_focus",
        title: "重复 key",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_MEMORY_KEY" });

    const updated = await store.updateMemory(memory.id, {
      title: "上午深度工作",
      content: "上午 9-12 点写论文",
      data: { intensity: "high" },
    });
    expect(updated.title).toBe("上午深度工作");
    expect(updated.data).toEqual({ intensity: "high" });

    const upserted = await store.upsertMemory({
      key: "morning_focus",
      content: "更新后的内容",
    });
    expect(upserted.created).toBe(false);
    expect(upserted.memory.content).toBe("更新后的内容");

    expect(await store.deleteMemory("morning_focus")).toBe(true);
    expect(store.getMemoryByKey("morning_focus")).toBeUndefined();
  });

  it("normalizes scheduling preferences and falls back on invalid fields", async () => {
    const defaults = store.getPreferences();
    expect(defaults.workdays).toEqual([1, 2, 3, 4, 5]);
    expect(defaults.maxFocusMinutes).toBe(90);

    await store.upsertMemory({
      key: "scheduling_preferences",
      category: "preference",
      title: "排期偏好",
      data: {
        timezone: "Asia/Shanghai",
        workdays: [1, 2, 3, 3, 9, "x"],
        workStart: "08:30",
        workEnd: "20:00",
        breaks: [{ label: "午餐", start: "12:00", end: "13:00" }],
        maxFocusMinutes: 120,
        minBlockMinutes: 45,
        bufferRatio: 0.2,
        dailyFocusLimitMinutes: 600,
      },
    });
    const preferences = store.getPreferences();
    expect(preferences.timezone).toBe("Asia/Shanghai");
    expect(preferences.workdays).toEqual([1, 2, 3]);
    expect(preferences.workStart).toBe("08:30");
    expect(preferences.workEnd).toBe("20:00");
    expect(preferences.maxFocusMinutes).toBe(120);
    expect(preferences.minBlockMinutes).toBe(45);
    expect(preferences.bufferRatio).toBe(0.2);
    expect(store.getPreferencesMemory()?.key).toBe("scheduling_preferences");
  });

  it("tracks task progress, completion and calibration", async () => {
    const task = await store.createTask({
      title: "写论文",
      estimatedMinutes: 120,
      estimateConfidence: "low",
      priority: "high",
    });
    expect(task.remainingMinutes).toBe(120);

    let updated = await store.recordTaskActual(task.id, 50);
    expect(updated.remainingMinutes).toBe(70);
    expect(updated.actualMinutes).toBe(50);
    expect(updated.status).toBe("in_progress");

    updated = await store.recordTaskActual(task.id, 70);
    expect(updated.remainingMinutes).toBe(0);
    expect(updated.actualMinutes).toBe(120);
    expect(updated.status).toBe("done");
    expect(store.getCalibration()).toEqual({
      completedTasks: 1,
      ratio: 1,
    });

    updated = await store.revertTaskActual(task.id, 70);
    expect(updated.remainingMinutes).toBe(70);
    expect(updated.actualMinutes).toBe(50);
    expect(updated.status).toBe("in_progress");
  });

  it("applies a schedule while preserving done blocks and replacing planned work", async () => {
    const t1 = await store.createTask({ title: "任务一", estimatedMinutes: 180 });
    const t2 = await store.createTask({ title: "任务二", estimatedMinutes: 60 });

    await store.applySchedule({
      taskIds: [],
      removeFromDate: "2026-11-16",
      skipBeforeDate: null,
      addBlocks: [
        {
          id: "b_done",
          taskId: t1.id,
          date: "2026-11-16",
          start: "09:00",
          end: "10:00",
          status: "done",
          actualMinutes: 60,
          note: "",
        },
        {
          id: "b_past",
          taskId: t1.id,
          date: "2026-11-17",
          start: "09:00",
          end: "10:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
        {
          id: "b_today",
          taskId: t1.id,
          date: "2026-11-18",
          start: "09:00",
          end: "10:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
        {
          id: "b_other",
          taskId: t2.id,
          date: "2026-11-18",
          start: "10:00",
          end: "11:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
      ],
    });

    const planMeta = new Map([
      [
        "2026-11-16",
        {
          unscheduled: [
            {
              taskId: t1.id,
              title: "任务一",
              remainingMinutes: 60,
              reason: "容量不足",
            },
          ],
          warnings: ["测试提醒"],
        },
      ],
    ]);
    const plans = await store.applySchedule({
      taskIds: [t1.id],
      removeFromDate: "2026-11-18",
      skipBeforeDate: "2026-11-18",
      addBlocks: [
        {
          id: "b_new",
          taskId: t1.id,
          date: "2026-11-18",
          start: "11:00",
          end: "12:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
      ],
      planMeta,
    });
    const plan = plans[0]!;

    expect(plan.blocks.map((block) => block.id).sort()).toEqual([
      "b_done",
      "b_new",
      "b_other",
      "b_past",
    ]);
    expect(plan.blocks.find((block) => block.id === "b_past")?.status).toBe(
      "skipped",
    );
    expect(plan.blocks.find((block) => block.id === "b_other")?.status).toBe(
      "planned",
    );
    expect(plan.unscheduled).toHaveLength(1);
    expect(plan.warnings).toEqual(["测试提醒"]);

    const reloaded = new ScheduleStore(dir);
    await reloaded.init();
    expect(reloaded.getPlan("2026-11-16")?.blocks).toHaveLength(4);
    expect(reloaded.getTask(t1.id)?.title).toBe("任务一");
  });

  it("deletes a task and its blocks", async () => {
    const task = await store.createTask({ title: "待删除", estimatedMinutes: 30 });
    await store.applySchedule({
      taskIds: [task.id],
      removeFromDate: "2026-11-16",
      skipBeforeDate: null,
      addBlocks: [
        {
          id: "b1",
          taskId: task.id,
          date: "2026-11-16",
          start: "09:00",
          end: "09:30",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
      ],
    });
    expect(store.getPlan("2026-11-16")?.blocks).toHaveLength(1);
    expect(await store.deleteTask(task.id)).toBe(true);
    expect(store.getTask(task.id)).toBeUndefined();
    expect(store.getPlan("2026-11-16")?.blocks).toHaveLength(0);
  });

  it("summarizes the current week", async () => {
    await store.upsertMemory({
      key: "scheduling_preferences",
      title: "排期偏好",
      data: { timezone: "Asia/Shanghai" },
    });
    const task = await store.createTask({ title: "任务", estimatedMinutes: 120 });
    await store.applySchedule({
      taskIds: [task.id],
      removeFromDate: "2026-11-16",
      skipBeforeDate: null,
      addBlocks: [
        {
          id: "b1",
          taskId: task.id,
          date: "2026-11-16",
          start: "09:00",
          end: "10:00",
          status: "done",
          actualMinutes: 60,
          note: "",
        },
        {
          id: "b2",
          taskId: task.id,
          date: "2026-11-16",
          start: "10:10",
          end: "11:10",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
      ],
    });

    const overview = store.overview("2026-11-16");
    expect(overview.weekStart).toBe("2026-11-16");
    expect(overview.weekEnd).toBe("2026-11-22");
    expect(overview.summary.totalPlannedMinutes).toBe(120);
    expect(overview.summary.doneMinutes).toBe(60);
    expect(overview.summary.taskCount).toBe(1);
    expect(overview.preferencesConfigured).toBe(true);
    expect(overview.timezone).toBe("Asia/Shanghai");
  });
});
