import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/schedule/store.js";
import { ScheduleToolExecutor } from "../src/schedule/tools.js";
import { addDays, mondayOf, todayInTimezone } from "../src/schedule/time.js";

describe("schedule tools", () => {
  let dir: string;
  let store: ScheduleStore;
  let tools: ScheduleToolExecutor;
  let weekStart: string;
  let emailed: Array<{ weekStart: string; to: string }>;

  const ctx = () =>
    ({
      session: { id: "s_test" },
      signal: new AbortController().signal,
      emit: () => undefined,
      progress: () => undefined,
      toolCallId: "call_1",
    }) as never;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-schedule-tools-"));
    store = new ScheduleStore(dir);
    await store.init();
    emailed = [];
    tools = new ScheduleToolExecutor({
      store,
      audit: { append: async () => undefined } as never,
      email: {
        sendPlan: async (input: { plan: { weekStart: string } }) => {
          emailed.push({
            weekStart: input.plan.weekStart,
            to: "me@example.com",
          });
          return { to: "me@example.com", messageId: "<msg-1>" };
        },
      } as never,
    });
    const today = todayInTimezone("Asia/Shanghai");
    const futureMonday = mondayOf(addDays(today, 14));
    weekStart = futureMonday;
    await tools.execute(
      "memory_upsert",
      JSON.stringify({
        key: "scheduling_preferences",
        category: "preference",
        title: "排期偏好",
        content: "工作日 9-18 点，午休一小时",
        data: {
          timezone: "Asia/Shanghai",
          workdays: [1, 2, 3, 4, 5],
          workStart: "09:00",
          workEnd: "18:00",
          breaks: [{ label: "午休", start: "12:00", end: "13:00" }],
          maxFocusMinutes: 90,
          minBlockMinutes: 30,
          bufferRatio: 0.1,
          dailyFocusLimitMinutes: 480,
        },
      }),
      ctx(),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saves, searches and deletes memories", async () => {
    const upsert = await tools.execute(
      "memory_upsert",
      JSON.stringify({
        key: "no_meetings_before_10",
        category: "constraint",
        title: "十点前不排会",
        content: "上午十点前需要深度工作",
        tags: ["focus"],
      }),
      ctx(),
    );
    expect(upsert.status).toBe("complete");
    expect(upsert.content).toContain("no_meetings_before_10");

    const search = await tools.execute(
      "memory_search",
      JSON.stringify({ key: "no_meetings_before_10" }),
      ctx(),
    );
    expect(search.content).toContain("十点前不排会");

    const deleted = await tools.execute(
      "memory_delete",
      JSON.stringify({ key: "no_meetings_before_10" }),
      ctx(),
    );
    expect(deleted.content).toContain("Deleted memory");
    expect(store.getMemoryByKey("no_meetings_before_10")).toBeUndefined();
  });

  it("creates a task, plans the week, and renders a PNG", async () => {
    const created = await tools.execute(
      "task_upsert",
      JSON.stringify({
        title: "写论文初稿",
        estimated_minutes: 180,
        estimate_confidence: "high",
        priority: "high",
      }),
      ctx(),
    );
    expect(created.status).toBe("complete");
    const task = store.listTasks()[0]!;

    const planned = await tools.execute(
      "plan_schedule",
      JSON.stringify({ week_start: weekStart, allow_spill: true }),
      ctx(),
    );
    expect(planned.status).toBe("complete");
    expect(planned.content).toContain("已生成");
    expect(planned.meta?.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    const filePath = String(planned.meta?.filePath);
    expect((await stat(filePath)).size).toBeGreaterThan(1000);

    const plan = store.getPlan(weekStart);
    expect(plan?.blocks.length).toBeGreaterThan(0);
    expect(plan?.blocks.every((block) => block.taskId === task.id)).toBe(true);

    const got = await tools.execute(
      "plan_get",
      JSON.stringify({ week_start: weekStart }),
      ctx(),
    );
    expect(got.content).toContain("写论文初稿");
    expect(got.content).toContain(plan!.blocks[0]!.id);
  });

  it("marks a block done and syncs task progress", async () => {
    await tools.execute(
      "task_upsert",
      JSON.stringify({
        title: "写论文初稿",
        estimated_minutes: 180,
        estimate_confidence: "medium",
        priority: "high",
      }),
      ctx(),
    );
    await tools.execute(
      "plan_schedule",
      JSON.stringify({ week_start: weekStart }),
      ctx(),
    );
    const task = store.listTasks()[0]!;
    const block = store.getPlan(weekStart)!.blocks[0]!;

    const updated = await tools.execute(
      "block_update",
      JSON.stringify({
        block_id: block.id,
        status: "done",
        actual_minutes: 30,
      }),
      ctx(),
    );
    expect(updated.status).toBe("complete");
    const after = store.getTask(task.id)!;
    expect(after.actualMinutes).toBe(30);
    expect(after.remainingMinutes).toBe(150);
    expect(after.status).toBe("in_progress");
    expect(store.getPlan(weekStart)!.blocks.find((item) => item.id === block.id)?.status).toBe(
      "done",
    );
  });

  it("drops future planned blocks when a task is completed", async () => {
    await tools.execute(
      "task_upsert",
      JSON.stringify({
        title: "大任务",
        estimated_minutes: 300,
        estimate_confidence: "low",
        priority: "high",
      }),
      ctx(),
    );
    await tools.execute(
      "plan_schedule",
      JSON.stringify({ week_start: weekStart }),
      ctx(),
    );
    const task = store.listTasks()[0]!;
    const planBefore = store.getPlan(weekStart)!;
    expect(
      planBefore.blocks.filter((block) => block.status === "planned").length,
    ).toBeGreaterThan(1);

    const first = planBefore.blocks.find((block) => block.status === "planned")!;
    await tools.execute(
      "block_update",
      JSON.stringify({
        block_id: first.id,
        status: "done",
        actual_minutes: 300,
      }),
      ctx(),
    );
    const after = store.getTask(task.id)!;
    expect(after.status).toBe("done");
    const planAfter = store.getPlan(weekStart)!;
    expect(
      planAfter.blocks.filter(
        (block) => block.taskId === task.id && block.status === "planned",
      ),
    ).toHaveLength(0);
    expect(planAfter.blocks.filter((block) => block.id === first.id)).toHaveLength(1);
  });

  it("replans unfinished work and preserves completed blocks", async () => {
    await tools.execute(
      "task_upsert",
      JSON.stringify({
        title: "写论文初稿",
        estimated_minutes: 300,
        estimate_confidence: "low",
        priority: "urgent",
      }),
      ctx(),
    );
    await tools.execute(
      "plan_schedule",
      JSON.stringify({ week_start: weekStart }),
      ctx(),
    );
    const before = store.getPlan(weekStart)!;
    const doneBlock = before.blocks[0]!;
    await tools.execute(
      "block_update",
      JSON.stringify({ block_id: doneBlock.id, status: "done" }),
      ctx(),
    );

    const replanned = await tools.execute(
      "plan_replan",
      JSON.stringify({
        from_date: addDays(weekStart, 1),
        days: 7,
        allow_spill: true,
      }),
      ctx(),
    );
    expect(replanned.status).toBe("complete");
    expect(replanned.content).toContain("重排");
    const after = store.getPlan(weekStart)!;
    expect(after.blocks.find((block) => block.id === doneBlock.id)?.status).toBe(
      "done",
    );
  });

  it("emails the plan through the configured service", async () => {
    await tools.execute(
      "task_upsert",
      JSON.stringify({
        title: "写论文初稿",
        estimated_minutes: 60,
        estimate_confidence: "high",
        priority: "medium",
      }),
      ctx(),
    );
    await tools.execute(
      "plan_schedule",
      JSON.stringify({ week_start: weekStart }),
      ctx(),
    );

    const result = await tools.execute(
      "plan_email",
      JSON.stringify({ week_start: weekStart }),
      ctx(),
    );
    expect(result.status).toBe("complete");
    expect(result.content).toContain("me@example.com");
    expect(emailed).toEqual([{ weekStart, to: "me@example.com" }]);
  });

  it("deletes a task and its blocks", async () => {
    await tools.execute(
      "task_upsert",
      JSON.stringify({
        title: "临时任务",
        estimated_minutes: 30,
        estimate_confidence: "high",
        priority: "low",
      }),
      ctx(),
    );
    await tools.execute(
      "plan_schedule",
      JSON.stringify({ week_start: weekStart }),
      ctx(),
    );
    const task = store.listTasks()[0]!;
    expect(store.getPlan(weekStart)!.blocks.length).toBeGreaterThan(0);

    const result = await tools.execute(
      "task_delete",
      JSON.stringify({ task_id: task.id }),
      ctx(),
    );
    expect(result.status).toBe("complete");
    expect(store.getTask(task.id)).toBeUndefined();
    expect(store.getPlan(weekStart)!.blocks).toHaveLength(0);
  });
});
