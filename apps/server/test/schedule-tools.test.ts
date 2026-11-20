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
  let startDate: string;
  let emailed: Array<{ startDate: string; to: string }>;

  const ctx = (overrides: Record<string, unknown> = {}) =>
    ({
      session: { id: "s_test" },
      signal: new AbortController().signal,
      emit: () => undefined,
      progress: () => undefined,
      toolCallId: "call_1",
      messageId: "m_test",
      questions: {
        ask: async () => ({ answers: [], outcome: "skipped" as const }),
      },
      ...overrides,
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
        sendPlan: async (input: { window: { startDate: string } }) => {
          emailed.push({
            startDate: input.window.startDate,
            to: "me@example.com",
          });
          return { to: "me@example.com", messageId: "<msg-1>" };
        },
      } as never,
    });
    const today = todayInTimezone("Asia/Shanghai");
    const futureMonday = mondayOf(addDays(today, 14));
    startDate = futureMonday;
    await tools.execute(
      "preferences_update",
      JSON.stringify({
        timezone: "Asia/Shanghai",
        workdays: [1, 2, 3, 4, 5],
        workStart: "09:00",
        workEnd: "18:00",
        breaks: [{ label: "午休", start: "12:00", end: "13:00" }],
        maxFocusMinutes: 90,
        minBlockMinutes: 30,
        bufferRatio: 0.1,
        gapMinutes: 0,
        dailyFocusLimitMinutes: 480,
      }),
      ctx(),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads and updates scheduling preferences and rules", async () => {
    const got = await tools.execute("preferences_get", "{}", ctx());
    expect(got.status).toBe("complete");
    expect(got.content).toContain("缓冲 10%");

    const updated = await tools.execute(
      "preferences_update",
      JSON.stringify({
        bufferRatio: 0,
        gapMinutes: 0,
        add_rules: ["十点前不排会"],
      }),
      ctx(),
    );
    expect(updated.status).toBe("complete");
    expect(store.getPreferences().bufferRatio).toBe(0);
    expect(store.getPreferences().gapMinutes).toBe(0);
    expect(store.getPreferences().rules).toEqual(["十点前不排会"]);

    const read = await tools.execute("preferences_get", "{}", ctx());
    expect(read.content).toContain("十点前不排会");

    const removed = await tools.execute(
      "preferences_update",
      JSON.stringify({ remove_rules: ["十点前不排会"] }),
      ctx(),
    );
    expect(removed.status).toBe("complete");
    expect(store.getPreferences().rules).toEqual([]);
  });

  it("creates a task, plans the rolling window, and renders a PNG", async () => {
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
      JSON.stringify({ from_date: startDate, allow_spill: true }),
      ctx(),
    );
    expect(planned.status).toBe("complete");
    expect(planned.content).toContain("已生成");
    expect(planned.meta?.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    const filePath = String(planned.meta?.filePath);
    expect((await stat(filePath)).size).toBeGreaterThan(1000);

    const plan = store.getPlan(startDate);
    expect(plan?.blocks.length).toBeGreaterThan(0);
    expect(plan?.blocks.every((block) => block.taskId === task.id)).toBe(true);

    const got = await tools.execute(
      "plan_get",
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    expect(got.content).toContain("写论文初稿");
    expect(got.content).toContain(plan!.blocks[0]!.id);
  });

  it("stores an optional breakdown and writes step notes into planned blocks", async () => {
    const created = await tools.execute(
      "task_upsert",
      JSON.stringify({
        title: "写论文初稿",
        estimated_minutes: 120,
        estimate_confidence: "high",
        priority: "high",
        steps: [
          { title: "精读基线论文", minutes: 60 },
          { title: "整理对比表", minutes: 60 },
        ],
      }),
      ctx(),
    );
    expect(created.status).toBe("complete");
    const task = store.listTasks()[0]!;
    expect(task.steps.map((step) => step.title)).toEqual([
      "精读基线论文",
      "整理对比表",
    ]);

    const listed = await tools.execute("task_list", "{}", ctx());
    expect(listed.content).toContain("拆解 2 步");
    expect(listed.content).toContain("精读基线论文");

    const planned = await tools.execute(
      "plan_schedule",
      JSON.stringify({ from_date: startDate, allow_spill: true }),
      ctx(),
    );
    expect(planned.status).toBe("complete");
    const plan = store.getPlan(startDate)!;
    expect(plan.blocks.map((block) => block.note)).toContain("精读基线论文");
    expect(plan.blocks.map((block) => block.note)).toContain("整理对比表");
    expect(planned.content).toContain("精读基线论文");
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
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    const task = store.listTasks()[0]!;
    const block = store.getPlan(startDate)!.blocks[0]!;

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
    expect(store.getPlan(startDate)!.blocks.find((item) => item.id === block.id)?.status).toBe(
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
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    const task = store.listTasks()[0]!;
    const planBefore = store.getPlan(startDate)!;
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
    const planAfter = store.getPlan(startDate)!;
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
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    const before = store.getPlan(startDate)!;
    const doneBlock = before.blocks[0]!;
    await tools.execute(
      "block_update",
      JSON.stringify({ block_id: doneBlock.id, status: "done" }),
      ctx(),
    );

    const replanned = await tools.execute(
      "plan_replan",
      JSON.stringify({
        from_date: addDays(startDate, 1),
        days: 7,
        allow_spill: true,
      }),
      ctx(),
    );
    expect(replanned.status).toBe("complete");
    expect(replanned.content).toContain("重排");
    const after = store.getPlan(startDate)!;
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
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );

    const result = await tools.execute(
      "plan_email",
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    expect(result.status).toBe("complete");
    expect(result.content).toContain("me@example.com");
    expect(emailed).toEqual([{ startDate, to: "me@example.com" }]);
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
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    const task = store.listTasks()[0]!;
    expect(store.getPlan(startDate)!.blocks.length).toBeGreaterThan(0);

    const result = await tools.execute(
      "task_delete",
      JSON.stringify({ task_id: task.id }),
      ctx(),
    );
    expect(result.status).toBe("complete");
    expect(store.getTask(task.id)).toBeUndefined();
    expect(store.getPlan(startDate)!.blocks).toHaveLength(0);
  });

  it("registers, lists, updates and deletes fixed events", async () => {
    const empty = await tools.execute(
      "fixed_event_list",
      JSON.stringify({}),
      ctx(),
    );
    expect(empty.status).toBe("complete");
    expect(empty.content).toContain("fixed_event_upsert");

    const created = await tools.execute(
      "fixed_event_upsert",
      JSON.stringify({
        title: "线上会议 A",
        kind: "weekly",
        weekday: 1,
        start: "16:00",
        end: "17:30",
        location: "线上",
      }),
      ctx(),
    );
    expect(created.status).toBe("complete");
    const event = store.listFixedEvents()[0]!;

    const invalid = await tools.execute(
      "fixed_event_upsert",
      JSON.stringify({
        title: "缺 weekday",
        kind: "weekly",
        start: "09:00",
        end: "10:00",
      }),
      ctx(),
    );
    expect(invalid.status).toBe("error");
    expect(store.listFixedEvents()).toHaveLength(1);

    const listed = await tools.execute(
      "fixed_event_list",
      JSON.stringify({ weekday: 1 }),
      ctx(),
    );
    expect(listed.content).toContain("线上会议 A");

    const updated = await tools.execute(
      "fixed_event_upsert",
      JSON.stringify({ event_id: event.id, end: "18:00" }),
      ctx(),
    );
    expect(updated.status).toBe("complete");
    expect(store.getFixedEvent(event.id)?.end).toBe("18:00");

    const deleted = await tools.execute(
      "fixed_event_delete",
      JSON.stringify({ event_id: event.id }),
      ctx(),
    );
    expect(deleted.status).toBe("complete");
    expect(store.listFixedEvents()).toHaveLength(0);
  });

  it("generates a fixed-only rolling plan without any tasks", async () => {
    await tools.execute(
      "fixed_event_upsert",
      JSON.stringify({
        title: "课程",
        kind: "weekly",
        weekday: 1,
        start: "08:00",
        end: "09:35",
        location: "3-130",
      }),
      ctx(),
    );
    await tools.execute(
      "fixed_event_upsert",
      JSON.stringify({
        title: "线上会议",
        kind: "weekly",
        weekday: 2,
        start: "19:00",
        end: "20:00",
      }),
      ctx(),
    );
    expect(store.listTasks()).toHaveLength(0);

    const planned = await tools.execute(
      "plan_schedule",
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    expect(planned.status).toBe("complete");
    expect(planned.content).toContain("仅含固定安排");
    expect(planned.content).toContain("课程");
    expect(planned.content).toContain("线上会议");
    expect(planned.meta?.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    const filePath = String(planned.meta?.filePath);
    expect((await stat(filePath)).size).toBeGreaterThan(1000);
    // A plan exists for the week even though it has no task blocks.
    expect(store.getPlan(startDate)).toBeDefined();

    const got = await tools.execute(
      "plan_get",
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    expect(got.content).toContain("（固定）");
    expect(got.content).toContain("课程");

    // Adding a task and replanning schedules it around the fixed events.
    await tools.execute(
      "task_upsert",
      JSON.stringify({
        title: "写论文初稿",
        estimated_minutes: 60,
        estimate_confidence: "high",
        priority: "high",
      }),
      ctx(),
    );
    const replanned = await tools.execute(
      "plan_schedule",
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    expect(replanned.status).toBe("complete");
    const blocks = store.getPlan(startDate)!.blocks;
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.date === startDate ? block.end <= "08:00" || block.start >= "09:35" : true).toBe(
        true,
      );
    }
  });

  it("explains what is missing when nothing can be scheduled", async () => {
    const result = await tools.execute(
      "plan_schedule",
      JSON.stringify({ from_date: startDate }),
      ctx(),
    );
    expect(result.status).toBe("complete");
    expect(result.content).toContain("没有需要排期的任务");
    expect(result.content).toContain("fixed_event_upsert");
    expect(result.meta?.data).toMatchObject({ agenda: null, window: null });
    expect(store.getPlan(startDate)).toBeUndefined();
  });

  it("asks the user a blocking question and returns the answers", async () => {
    let asked: Array<{ questions: Array<{ id: string }> }> = [];
    const result = await tools.execute(
      "ask_user_question",
      JSON.stringify({
        questions: [
          {
            id: "estimate",
            header: "估时",
            question: "写论文初稿大概需要多久？",
            options: [
              { label: "2 小时 (Recommended)" },
              { label: "4 小时" },
            ],
          },
        ],
      }),
      ctx({
        questions: {
          ask: async (input: { questions: Array<{ id: string }> }) => {
            asked = [input];
            return {
              answers: [{ id: "estimate", selected: ["4 小时"] }],
              outcome: "answered" as const,
            };
          },
        },
      }),
    );
    expect(asked[0]?.questions[0]?.id).toBe("estimate");
    expect(result.status).toBe("complete");
    expect(result.content).toContain("4 小时");
    expect(result.meta).toMatchObject({
      kind: "question",
      questionOutcome: "answered",
    });
    expect(store.listTasks()).toHaveLength(0);
  });

  it("reports a skipped question without inventing an answer", async () => {
    const result = await tools.execute(
      "ask_user_question",
      JSON.stringify({
        questions: [{ id: "deadline", question: "截止日期是哪天？" }],
      }),
      ctx(),
    );
    expect(result.status).toBe("complete");
    expect(result.content).toContain("(skipped)");
    expect(result.meta).toMatchObject({
      kind: "question",
      questionOutcome: "skipped",
    });
  });
});
