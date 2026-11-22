import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/schedule/store.js";
import { todayInTimezone } from "../src/schedule/time.js";

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
    expect(defaults.bufferRatio).toBe(0);
    expect(defaults.gapMinutes).toBe(0);
    expect(defaults.rules).toEqual([]);

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
        gapMinutes: 15,
        dailyFocusLimitMinutes: 600,
        rules: ["规则一", "规则一", " 规则二 "],
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
    expect(preferences.gapMinutes).toBe(15);
    expect(preferences.rules).toEqual(["规则一", "规则二"]);
    expect(store.getPreferencesMemory()?.key).toBe("scheduling_preferences");
  });

  it("merges partial preference updates and persists rules", async () => {
    const updated = await store.updatePreferences({
      workStart: "08:00",
      workEnd: "21:00",
      gapMinutes: 0,
      bufferRatio: 0,
      rules: ["十点前不排会"],
    });
    expect(updated.workStart).toBe("08:00");
    expect(updated.workEnd).toBe("21:00");
    expect(updated.gapMinutes).toBe(0);
    expect(updated.rules).toEqual(["十点前不排会"]);

    const reloaded = new ScheduleStore(dir);
    await reloaded.init();
    expect(reloaded.getPreferences().workStart).toBe("08:00");
    expect(reloaded.getPreferences().rules).toEqual(["十点前不排会"]);
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

  it("stores, replaces and clears optional task steps", async () => {
    const task = await store.createTask({
      title: "写论文",
      estimatedMinutes: 180,
      steps: [
        { title: "精读基线论文", minutes: 60 },
        { title: "整理对比表", minutes: 45 },
      ],
    });
    expect(task.steps.map((step) => step.title)).toEqual([
      "精读基线论文",
      "整理对比表",
    ]);
    expect(task.steps.every((step) => step.id.startsWith("step_"))).toBe(true);
    const firstId = task.steps[0]!.id;

    const updated = await store.updateTask(task.id, {
      steps: [
        { id: firstId, title: "精读基线论文（修订）", minutes: 70 },
        { title: "写方法小节", minutes: 90 },
      ],
    });
    expect(updated.steps).toHaveLength(2);
    expect(updated.steps[0]).toMatchObject({
      id: firstId,
      title: "精读基线论文（修订）",
      minutes: 70,
    });

    const reloaded = new ScheduleStore(dir);
    await reloaded.init();
    expect(reloaded.getTask(task.id)?.steps.map((step) => step.title)).toEqual([
      "精读基线论文（修订）",
      "写方法小节",
    ]);

    const cleared = await store.updateTask(task.id, { steps: null });
    expect(cleared.steps).toEqual([]);
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

  it("lists overdue planned blocks whose time has passed", async () => {
    const task = await store.createTask({
      title: "任务",
      estimatedMinutes: 300,
    });
    await store.applySchedule({
      taskIds: [],
      removeFromDate: "2026-11-16",
      skipBeforeDate: null,
      addBlocks: [
        {
          id: "b_past",
          taskId: task.id,
          date: "2026-11-17",
          start: "09:00",
          end: "10:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
        {
          id: "b_done",
          taskId: task.id,
          date: "2026-11-17",
          start: "10:00",
          end: "11:00",
          status: "done",
          actualMinutes: 60,
          note: "",
        },
        {
          id: "b_skipped",
          taskId: task.id,
          date: "2026-11-18",
          start: "09:00",
          end: "10:00",
          status: "skipped",
          actualMinutes: null,
          note: "",
        },
        {
          id: "b_today_ended",
          taskId: task.id,
          date: "2026-11-19",
          start: "08:00",
          end: "09:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
        {
          id: "b_today_running",
          taskId: task.id,
          date: "2026-11-19",
          start: "09:00",
          end: "23:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
        {
          id: "b_future",
          taskId: task.id,
          date: "2026-11-20",
          start: "09:00",
          end: "10:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
      ],
    });

    const overdue = store.listOverduePlannedBlocks({
      today: "2026-11-19",
      nowMinutes: 600,
    });
    expect(overdue.map((block) => block.id)).toEqual([
      "b_past",
      "b_today_ended",
    ]);

    const limited = store.listOverduePlannedBlocks({
      today: "2026-11-19",
      nowMinutes: 600,
      limit: 1,
    });
    expect(limited.map((block) => block.id)).toEqual(["b_past"]);
  });

  it("drops future skipped blocks when replanning an included task", async () => {
    const task = await store.createTask({ title: "任务", estimatedMinutes: 60 });
    await store.applySchedule({
      taskIds: [task.id],
      removeFromDate: "2026-11-16",
      skipBeforeDate: null,
      addBlocks: [
        {
          id: "old_skipped",
          taskId: task.id,
          date: "2026-11-19",
          start: "09:00",
          end: "10:00",
          status: "skipped",
          actualMinutes: null,
          note: "",
        },
        {
          id: "old_done",
          taskId: task.id,
          date: "2026-11-17",
          start: "09:00",
          end: "10:00",
          status: "done",
          actualMinutes: 60,
          note: "",
        },
      ],
    });
    await store.applySchedule({
      taskIds: [task.id],
      removeFromDate: "2026-11-18",
      skipBeforeDate: "2026-11-18",
      addBlocks: [],
    });
    expect(
      store
        .getPlan("2026-11-16")!
        .blocks.map((block) => block.id)
        .sort(),
    ).toEqual(["old_done"]);
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

  it("summarizes a requested rolling window", async () => {
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
    expect(overview.rangeStart).toBe("2026-11-16");
    expect(overview.rangeEnd).toBe("2026-11-22");
    expect(overview.summary.rangeStart).toBe("2026-11-16");
    expect(overview.summary.rangeEnd).toBe("2026-11-22");
    expect(overview.summary.totalPlannedMinutes).toBe(120);
    expect(overview.summary.doneMinutes).toBe(60);
    expect(overview.summary.taskCount).toBe(1);
    expect(overview.preferencesConfigured).toBe(true);
    expect(overview.timezone).toBe("Asia/Shanghai");
    expect(overview.window?.blocks).toHaveLength(2);
    expect(overview.agenda.days).toHaveLength(7);
    expect(overview.agenda.days[0]?.date).toBe("2026-11-16");
    expect(overview.agenda.days[0]?.items).toHaveLength(2);
  });

  it("merges rolling-window blocks across two ISO weeks", async () => {
    await store.upsertMemory({
      key: "scheduling_preferences",
      title: "排期偏好",
      data: { timezone: "Asia/Shanghai", workdays: [1, 2, 3, 4, 5] },
    });
    const task = await store.createTask({ title: "跨周任务", estimatedMinutes: 120 });
    await store.applySchedule({
      taskIds: [task.id],
      removeFromDate: "2026-11-18",
      skipBeforeDate: null,
      addBlocks: [
        {
          id: "b1",
          taskId: task.id,
          date: "2026-11-18",
          start: "09:00",
          end: "10:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
        {
          id: "b2",
          taskId: task.id,
          date: "2026-11-23",
          start: "09:00",
          end: "10:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
      ],
    });

    // 2026-11-18 (Wed) .. 2026-11-24 (Tue) crosses the Sunday/Monday split.
    const window = store.getWindow("2026-11-18", 7);
    expect(window?.startDate).toBe("2026-11-18");
    expect(window?.endDate).toBe("2026-11-24");
    expect(window?.blocks.map((block) => block.date)).toEqual([
      "2026-11-18",
      "2026-11-23",
    ]);
    const overview = store.overview("2026-11-18");
    expect(overview.summary.totalPlannedMinutes).toBe(120);
    expect(overview.agenda.days.map((day) => day.date)).toContain("2026-11-23");
  });

  it("returns a fixed-only window with zero blocks", async () => {
    const today = todayInTimezone("Asia/Shanghai");
    const fixed = await store.createFixedEvent({
      title: "固定课程",
      kind: "once",
      date: today,
      start: "09:00",
      end: "10:00",
    });
    const window = store.getWindow(today, 7);
    // No plan exists yet, so the window itself is absent; the agenda still
    // carries the fixed commitment for the requested day.
    expect(window).toBeNull();
    const overview = store.overview(today);
    expect(overview.agenda.days[0]?.items[0]?.title).toBe("固定课程");
    expect(overview.agenda.days[0]?.items[0]?.id).toContain(fixed.id);
  });

  it("stores, updates and deletes fixed events", async () => {
    const weekly = await store.createFixedEvent({
      title: "组会",
      kind: "weekly",
      weekday: 1,
      start: "16:00",
      end: "17:30",
      location: "线上",
    });
    const once = await store.createFixedEvent({
      title: "讲座",
      kind: "once",
      date: "2026-11-19",
      start: "10:00",
      end: "12:00",
    });
    expect(weekly.id.startsWith("fixed_")).toBe(true);

    await expect(
      store.createFixedEvent({
        title: "缺 weekday",
        kind: "weekly",
        start: "09:00",
        end: "10:00",
      }),
    ).rejects.toMatchObject({ code: "INVALID_FIXED_EVENT" });
    await expect(
      store.createFixedEvent({
        title: "时间倒挂",
        kind: "weekly",
        weekday: 2,
        start: "10:00",
        end: "09:00",
      }),
    ).rejects.toMatchObject({ code: "INVALID_FIXED_EVENT" });

    const updated = await store.updateFixedEvent(weekly.id, {
      start: "15:00",
      end: "16:00",
    });
    expect(updated.start).toBe("15:00");

    // 2026-11-16 is Monday; both the weekly event and the one-off on the 19th
    // match their dates correctly.
    expect(
      store.fixedEventsForDate("2026-11-16").map((event) => event.id),
    ).toEqual([weekly.id]);
    expect(
      store.fixedEventsForDate("2026-11-19").map((event) => event.id),
    ).toEqual([once.id]);
    expect(store.fixedEventsForDate("2026-11-17")).toEqual([]);

    const reloaded = new ScheduleStore(dir);
    await reloaded.init();
    expect(reloaded.listFixedEvents()).toHaveLength(2);
    expect(reloaded.getFixedEvent(weekly.id)?.end).toBe("16:00");

    expect(await reloaded.deleteFixedEvent(weekly.id)).toBe(true);
    expect(reloaded.getFixedEvent(weekly.id)).toBeUndefined();
  });

  it("supports non-busy events and defaults legacy data to busy", async () => {
    const busyDefault = await store.createFixedEvent({
      title: "组会",
      kind: "weekly",
      weekday: 1,
      start: "16:00",
      end: "17:30",
    });
    expect(busyDefault.busy).toBe(true);

    const parallel = await store.upsertFixedEvent({
      title: "线性代数",
      kind: "weekly",
      weekday: 1,
      start: "09:00",
      end: "11:00",
      busy: false,
    });
    expect(parallel.created).toBe(true);
    expect(parallel.event.busy).toBe(false);

    const updated = await store.updateFixedEvent(parallel.event.id, {
      busy: true,
    });
    expect(updated.busy).toBe(true);

    const reloaded = new ScheduleStore(dir);
    await reloaded.init();
    expect(reloaded.getFixedEvent(parallel.event.id)?.busy).toBe(true);

    // A pre-busy-era file without the field still loads as busy.
    await writeFile(
      path.join(dir, "schedule", "fixed-events.json"),
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "fixed_legacy",
            title: "老课程",
            kind: "weekly",
            weekday: 2,
            date: null,
            start: "08:00",
            end: "09:35",
            location: "",
            note: "",
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const legacy = new ScheduleStore(dir);
    await legacy.init();
    expect(legacy.getFixedEvent("fixed_legacy")?.busy).toBe(true);
  });

  it("migrates legacy fixed-commitment memories into fixed events once", async () => {
    await store.upsertMemory({
      key: "class_schedule_constraint",
      category: "constraint",
      title: "固定上课时间表",
      data: {
        schedule: {
          Mon: [{ start: "08:00", end: "09:35", loc: "3-130" }],
          Tue: [{ start: "08:00", end: "09:35", loc: "3-130" }],
        },
      },
    });
    await store.upsertMemory({
      key: "fixed_meetings",
      category: "routine",
      title: "每周固定线上会议",
      data: {
        weekly: [
          { day: 1, start: "16:00", end: "17:30", title: "线上会议 A" },
        ],
      },
    });

    await store.upsertMemory({
      key: "task_split_rule",
      category: "constraint",
      title: "任务拆分规则",
      content: "同一任务同一天只在跨饭点时拆分。",
    });

    const reloaded = new ScheduleStore(dir);
    await reloaded.init();
    const events = reloaded.listFixedEvents();
    expect(events).toHaveLength(3);
    expect(
      events.filter((event) => event.kind === "weekly" && event.weekday === 1),
    ).toHaveLength(2);
    const mondayCourses = events.filter(
      (event) =>
        event.weekday === 1 && event.title.startsWith("课程"),
    );
    expect(mondayCourses).toHaveLength(1);
    expect(mondayCourses[0]?.location).toBe("3-130");
    // Migrated fixed-commitment memories are removed; other free-form
    // memories become rules in the single preference document.
    expect(reloaded.getMemoryByKey("class_schedule_constraint")).toBeUndefined();
    expect(reloaded.getMemoryByKey("fixed_meetings")).toBeUndefined();
    expect(
      reloaded
        .getPreferences()
        .rules.some((rule) => rule.includes("跨饭点")),
    ).toBe(true);
    expect(reloaded.listMemories()).toHaveLength(1);

    // Second init must not duplicate anything.
    const again = new ScheduleStore(dir);
    await again.init();
    expect(again.listFixedEvents()).toHaveLength(3);
    expect(again.listMemories()).toHaveLength(1);
  });

  it("rejects blocks that overlap a fixed event", async () => {
    const event = await store.createFixedEvent({
      title: "课程",
      kind: "weekly",
      weekday: 1,
      start: "09:00",
      end: "11:00",
    });
    const task = await store.createTask({ title: "任务", estimatedMinutes: 60 });
    await store.applySchedule({
      taskIds: [task.id],
      removeFromDate: "2026-11-16",
      skipBeforeDate: null,
      addBlocks: [
        {
          id: "b1",
          taskId: task.id,
          date: "2026-11-16",
          start: "14:00",
          end: "15:00",
          status: "planned",
          actualMinutes: null,
          note: "",
        },
      ],
    });
    await expect(
      store.updateBlock("b1", { start: "10:00", end: "11:00" }),
    ).rejects.toMatchObject({ code: "BLOCK_OVERLAP" });
    // Moving outside the fixed event still works.
    const updated = await store.updateBlock("b1", {
      start: "13:00",
      end: "14:00",
    });
    expect(updated.block.start).toBe("13:00");
    expect(store.getFixedEvent(event.id)).toBeDefined();
  });

  it("allows blocks inside a non-busy event and pairs them in the agenda", async () => {
    await store.createFixedEvent({
      title: "线性代数",
      kind: "weekly",
      weekday: 1,
      start: "09:00",
      end: "11:00",
      busy: false,
    });
    const task = await store.createTask({ title: "任务", estimatedMinutes: 60 });
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
          status: "planned",
          actualMinutes: null,
          note: "",
        },
      ],
    });
    // The block sits inside the course window without a BLOCK_OVERLAP error.
    const moved = await store.updateBlock("b1", {
      start: "09:30",
      end: "10:30",
    });
    expect(moved.block.start).toBe("09:30");

    const overview = store.overview("2026-11-16");
    const monday = overview.agenda.days[0]!;
    const courseItem = monday.items.find((item) => item.kind === "fixed");
    expect(courseItem).toMatchObject({ title: "线性代数", busy: false });
    expect(courseItem?.parallelBlocks).toHaveLength(1);
    expect(courseItem?.parallelBlocks?.[0]).toMatchObject({
      blockId: "b1",
      start: "09:30",
      end: "10:30",
    });
    // No standalone task row: the block renders beside its course.
    expect(monday.items.some((item) => item.kind === "task")).toBe(false);
  });
});
