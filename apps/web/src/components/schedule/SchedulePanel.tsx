import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Brain,
  CalendarDays,
  Check,
  Clock3,
  ListTodo,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type {
  ScheduleMemory,
  ScheduleMemoryCategory,
  ScheduleOverview,
  ScheduleTask,
} from "@codefly/protocol";
import { useAppStore } from "../../lib/store.js";
import { cn } from "../../lib/utils.js";
import { Button, Modal } from "../ui.js";

const CATEGORY_LABEL: Record<ScheduleMemoryCategory, string> = {
  preference: "偏好",
  constraint: "约束",
  routine: "习惯",
  goal: "目标",
  context: "背景",
};

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

function minutesLabel(minutes: number): string {
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function WeekTable({ overview }: { overview: ScheduleOverview }) {
  const plan = overview.plan;
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(overview.weekStart, index);
    const label = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][index]!;
    return { date, label };
  });
  const tasks = new Map(overview.tasks.map((task) => [task.id, task]));
  const rows = new Map<
    string,
    {
      task: ScheduleTask | undefined;
      title: string;
      cells: Array<Array<{ id: string; start: string; end: string; status: string }>>;
    }
  >();
  for (const block of plan?.blocks ?? []) {
    let row = rows.get(block.taskId);
    if (row === undefined) {
      const task = tasks.get(block.taskId);
      row = {
        task,
        title: task?.title ?? "已删除任务",
        cells: days.map(() => []),
      };
      rows.set(block.taskId, row);
    }
    const index = days.findIndex((day) => day.date === block.date);
    if (index >= 0) {
      row.cells[index]!.push({
        id: block.id,
        start: block.start,
        end: block.end,
        status: block.status,
      });
    }
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border/80">
      <table className="w-full min-w-[760px] border-collapse text-[11px]">
        <thead>
          <tr className="bg-muted/40 text-left text-muted-foreground">
            <th className="w-[220px] border-b border-border/70 px-2.5 py-2 font-medium">
              任务
            </th>
            {days.map((day) => (
              <th
                key={day.date}
                className="border-b border-l border-border/70 px-2 py-2 font-medium"
              >
                {day.label}
                <span className="ml-1 font-mono text-[9px] text-muted-foreground/50">
                  {day.date.slice(5)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.size === 0 ? (
            <tr>
              <td
                colSpan={8}
                className="px-3 py-8 text-center text-[11px] text-muted-foreground/60"
              >
                这一周还没有计划。在对话里让助手生成，或先添加任务。
              </td>
            </tr>
          ) : (
            [...rows.entries()].map(([taskId, row]) => (
              <tr key={taskId} className="align-top">
                <td className="border-b border-border/50 px-2.5 py-2">
                  <span className="block font-medium text-foreground/90">
                    {row.title}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground/60">
                    {row.task
                      ? `${PRIORITY_LABEL[row.task.priority] ?? row.task.priority} · 剩余 ${minutesLabel(
                          row.task.remainingMinutes,
                        )}`
                      : "任务已删除"}
                  </span>
                </td>
                {row.cells.map((cell, index) => (
                  <td
                    key={days[index]?.date ?? index}
                    className="border-b border-l border-border/50 px-1.5 py-2"
                  >
                    {cell.length === 0 ? (
                      <span className="text-muted-foreground/20">—</span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        {cell.map((block) => (
                          <span
                            key={block.id}
                            className={cn(
                              "font-mono text-[10px]",
                              block.status === "done"
                                ? "text-primary"
                                : block.status === "skipped"
                                  ? "text-muted-foreground/40 line-through"
                                  : "text-foreground/80",
                            )}
                          >
                            {block.status === "done"
                              ? "✓ "
                              : block.status === "skipped"
                                ? "— "
                                : ""}
                            {block.start}-{block.end}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function MemoryEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ScheduleMemory | null;
  onSave: (value: {
    title: string;
    key: string;
    category: ScheduleMemoryCategory;
    content: string;
    tags: string;
    pinned: boolean;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [category, setCategory] = useState<ScheduleMemoryCategory>(
    initial?.category ?? "context",
  );
  const [content, setContent] = useState(initial?.content ?? "");
  const [tags, setTags] = useState(initial?.tags.join(", ") ?? "");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (title.trim() === "" || saving) return;
    setSaving(true);
    await onSave({
      title: title.trim(),
      key: key.trim(),
      category,
      content,
      tags,
      pinned,
    });
    setSaving(false);
  };

  return (
    <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs focus:border-primary/40 focus:outline-none"
            placeholder="例如：上午效率最高"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            唯一 key（可选）
          </span>
          <input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={initial !== undefined && initial !== null}
            className="h-8 w-full rounded-lg border border-border bg-background px-2 font-mono text-xs focus:border-primary/40 focus:outline-none disabled:opacity-50"
            placeholder="morning_focus"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(event) =>
            setCategory(event.target.value as ScheduleMemoryCategory)
          }
          className="h-8 rounded-lg border border-border bg-background px-2 text-[11px] focus:outline-none"
        >
          {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          className="h-8 min-w-[10rem] flex-1 rounded-lg border border-border bg-background px-2 text-[11px] focus:border-primary/40 focus:outline-none"
          placeholder="标签，用逗号分隔"
        />
        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(event) => setPinned(event.target.checked)}
          />
          置顶
        </label>
      </div>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={3}
        className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-xs leading-5 focus:border-primary/40 focus:outline-none"
        placeholder="用一两句话描述这条记忆，助手会在排期时参考。"
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={saving || title.trim() === ""}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          保存
        </Button>
      </div>
    </div>
  );
}

export function SchedulePanel() {
  const open = useAppStore((state) => state.ui.schedulePanelOpen);
  const close = useAppStore((state) => state.closeSchedulePanel);
  const overview = useAppStore((state) => state.scheduleOverview);
  const loading = useAppStore((state) => state.scheduleLoading);
  const emailSettings = useAppStore((state) => state.scheduleEmailSettings);
  const loadOverview = useAppStore((state) => state.loadScheduleOverview);
  const createMemory = useAppStore((state) => state.createScheduleMemory);
  const updateMemory = useAppStore((state) => state.updateScheduleMemory);
  const deleteMemory = useAppStore((state) => state.deleteScheduleMemory);
  const updateTask = useAppStore((state) => state.updateScheduleTask);
  const deleteTask = useAppStore((state) => state.deleteScheduleTask);
  const sendScheduleEmail = useAppStore((state) => state.sendScheduleEmailNow);
  const openEmailSettings = useAppStore(
    (state) => state.openScheduleEmailSettings,
  );

  const [tab, setTab] = useState<"plan" | "memories" | "tasks">("plan");
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const [memoryEditor, setMemoryEditor] = useState<
    { id: string | null; initial: ScheduleMemory | null } | null
  >(null);
  const [pendingMemoryDelete, setPendingMemoryDelete] = useState<string | null>(
    null,
  );
  const [pendingTaskDelete, setPendingTaskDelete] = useState<string | null>(
    null,
  );
  const [emailing, setEmailing] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadOverview(weekStart);
  }, [open, weekStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeTasks = useMemo(
    () =>
      (overview?.tasks ?? []).filter(
        (task) =>
          (task.status === "todo" || task.status === "in_progress") &&
          task.remainingMinutes > 0,
      ),
    [overview],
  );
  const doneTasks = useMemo(
    () => (overview?.tasks ?? []).filter((task) => task.status === "done"),
    [overview],
  );

  const saveMemory = async (value: {
    title: string;
    key: string;
    category: ScheduleMemoryCategory;
    content: string;
    tags: string;
    pinned: boolean;
  }): Promise<void> => {
    const tags = value.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");
    if (memoryEditor?.id) {
      const ok = await updateMemory(memoryEditor.id, {
        title: value.title,
        category: value.category,
        content: value.content,
        tags,
        pinned: value.pinned,
      });
      if (ok) setMemoryEditor(null);
    } else {
      const ok = await createMemory({
        title: value.title,
        key: value.key || undefined,
        category: value.category,
        content: value.content,
        tags,
        pinned: value.pinned,
      });
      if (ok) setMemoryEditor(null);
    }
  };

  const sendEmail = async (): Promise<void> => {
    if (!overview?.plan || emailing) return;
    setEmailing(true);
    await sendScheduleEmail(overview.plan.weekStart);
    setEmailing(false);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="日程面板"
      description="本周计划、结构化记忆与任务；删除和编辑会同步到助手使用的全局数据。"
      className="max-w-6xl"
    >
      <div className="flex min-h-[30rem] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border bg-background p-0.5">
            {(
              [
                ["plan", "本周计划", CalendarDays],
                ["memories", "记忆", Brain],
                ["tasks", "任务", ListTodo],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-colors",
                  tab === value
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3 w-3" />
                {label}
              </button>
            ))}
          </div>

          {overview ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="上一周"
                onClick={() => setWeekStart(addDays(overview.weekStart, -7))}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="font-mono text-[10px] text-muted-foreground">
                {overview.weekStart} ~ {overview.weekEnd}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="下一周"
                onClick={() => setWeekStart(addDays(overview.weekStart, 7))}
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新"
                onClick={() => void loadOverview(weekStart)}
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          ) : null}

          <div className="ml-auto flex items-center gap-1.5">
            {overview?.preferencesConfigured ? (
              <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[9px] text-primary">
                偏好已配置
              </span>
            ) : (
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[9px] text-warning">
                偏好未配置
              </span>
            )}
            <Button variant="ghost" size="icon" aria-label="关闭" onClick={close}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {loading && overview === null ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载日程数据…
          </div>
        ) : null}

        {!loading && overview === null ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
            日程数据加载失败，请稍后重试。
          </p>
        ) : null}

        {overview ? (
          <>
            {tab === "plan" ? (
              <div className="space-y-3">
                {!overview.preferencesConfigured ? (
                  <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-5 text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    还没有配置排期偏好。在对话里告诉助手你的工作时段、工作日和休息时间，它会写入
                    <code className="mx-1 rounded bg-muted/50 px-1 font-mono text-[10px]">
                      scheduling_preferences
                    </code>
                    记忆。
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
                  <Clock3 className="h-3 w-3 text-primary" />
                  <span>
                    工作日{" "}
                    {overview.preferences.workdays
                      .map((day) => ["一", "二", "三", "四", "五", "六", "日"][day - 1])
                      .join("、")}
                  </span>
                  <span>
                    {overview.preferences.workStart}-{overview.preferences.workEnd}
                  </span>
                  <span>最长专注 {overview.preferences.maxFocusMinutes}m</span>
                  <span>每日上限 {overview.preferences.dailyFocusLimitMinutes}m</span>
                  <span className="font-mono text-muted-foreground/50">
                    {overview.timezone}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-lg border border-border/70 bg-background/40 px-2 py-1 text-[10px] text-muted-foreground">
                    {overview.summary.taskCount} 项任务 · 计划{" "}
                    {minutesLabel(overview.summary.totalPlannedMinutes)} · 已完成{" "}
                    {minutesLabel(overview.summary.doneMinutes)}
                  </span>
                  {overview.plan ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[10px]"
                      disabled={emailing || !emailSettings?.configured}
                      title={
                        emailSettings?.configured
                          ? "发送计划表图片"
                          : "请先配置邮件设置"
                      }
                      onClick={() => void sendEmail()}
                    >
                      {emailing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Mail className="h-3 w-3" />
                      )}
                      邮件发送
                    </Button>
                  ) : null}
                  {!emailSettings?.configured ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[10px]"
                      onClick={openEmailSettings}
                    >
                      配置邮件
                    </Button>
                  ) : null}
                  {overview.plan?.warnings.length ? (
                    <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[9px] text-warning">
                      {overview.plan.warnings.length} 条提醒
                    </span>
                  ) : null}
                </div>

                <WeekTable overview={overview} />

                {overview.plan?.warnings.length ? (
                  <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                    {overview.plan.warnings.map((warning) => (
                      <p
                        key={warning}
                        className="text-[10px] leading-5 text-warning"
                      >
                        • {warning}
                      </p>
                    ))}
                  </div>
                ) : null}

                {overview.plan?.unscheduled.length ? (
                  <div className="rounded-lg border border-border/70 bg-background/30 px-3 py-2">
                    <p className="text-[10px] font-medium text-foreground/80">
                      未排期任务
                    </p>
                    {overview.plan.unscheduled.map((item) => (
                      <p
                        key={item.taskId}
                        className="text-[10px] leading-5 text-muted-foreground"
                      >
                        • {item.title} · 剩余 {minutesLabel(item.remainingMinutes)} ·{" "}
                        {item.reason}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {tab === "memories" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground">
                    {overview.memories.length} 条结构化记忆 · 助手会按 key 精确读取
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[10px]"
                    onClick={() => setMemoryEditor({ id: null, initial: null })}
                  >
                    <Plus className="h-3 w-3" />
                    新增记忆
                  </Button>
                </div>

                {memoryEditor ? (
                  <MemoryEditor
                    initial={memoryEditor.initial}
                    onSave={saveMemory}
                    onCancel={() => setMemoryEditor(null)}
                  />
                ) : null}

                <div className="space-y-1.5">
                  {overview.memories.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                      还没有记忆。可以在对话里让助手保存偏好，或点击「新增记忆」。
                    </p>
                  ) : (
                    overview.memories.map((memory) => (
                      <div
                        key={memory.id}
                        className="rounded-xl border border-border/70 bg-background/40 px-3 py-2.5"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium">
                            {memory.title}
                          </span>
                          <span className="rounded bg-muted/50 px-1 py-px text-[8px] text-muted-foreground">
                            {CATEGORY_LABEL[memory.category]}
                          </span>
                          {memory.pinned ? (
                            <span className="text-[8px] text-warning">置顶</span>
                          ) : null}
                          <span className="font-mono text-[8px] text-muted-foreground/50">
                            {memory.key}
                          </span>
                          <span className="ml-auto flex items-center gap-1">
                            <button
                              type="button"
                              aria-label="编辑记忆"
                              onClick={() =>
                                setMemoryEditor({
                                  id: memory.id,
                                  initial: memory,
                                })
                              }
                              className="rounded p-1 text-muted-foreground/50 hover:bg-muted/50 hover:text-foreground"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            {pendingMemoryDelete === memory.id ? (
                              <span className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    void deleteMemory(memory.id);
                                    setPendingMemoryDelete(null);
                                  }}
                                  className="rounded bg-danger/15 px-1.5 py-0.5 text-[9px] text-danger"
                                >
                                  确认删除
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPendingMemoryDelete(null)}
                                  className="rounded px-1 py-0.5 text-[9px] text-muted-foreground"
                                >
                                  取消
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                aria-label="删除记忆"
                                onClick={() => setPendingMemoryDelete(memory.id)}
                                className="rounded p-1 text-muted-foreground/50 hover:bg-danger/10 hover:text-danger"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        </div>
                        {memory.content.trim() !== "" ? (
                          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">
                            {memory.content}
                          </p>
                        ) : null}
                        {memory.data !== null ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[9px] text-muted-foreground/60">
                              结构化字段
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono text-[9px] leading-4 text-muted-foreground">
                              {JSON.stringify(memory.data, null, 2)}
                            </pre>
                          </details>
                        ) : null}
                        {memory.tags.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {memory.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded bg-muted/40 px-1 py-px text-[8px] text-muted-foreground/70"
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {tab === "tasks" ? (
              <div className="space-y-3">
                <div>
                  <p className="mb-1.5 text-[10px] text-muted-foreground">
                    待办与进行中（{activeTasks.length}）
                  </p>
                  <div className="space-y-1">
                    {activeTasks.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[11px] text-muted-foreground/60">
                        没有待办任务。可以在对话里让助手添加。
                      </p>
                    ) : (
                      activeTasks.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          onDone={() =>
                            void updateTask(task.id, { status: "done" })
                          }
                          onDelete={() => setPendingTaskDelete(task.id)}
                          pendingDelete={pendingTaskDelete === task.id}
                          onCancelDelete={() => setPendingTaskDelete(null)}
                          onConfirmDelete={() => {
                            void deleteTask(task.id);
                            setPendingTaskDelete(null);
                          }}
                        />
                      ))
                    )}
                  </div>
                </div>

                {doneTasks.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-[10px] text-muted-foreground">
                      已完成（{doneTasks.length}）
                    </p>
                    <div className="space-y-1">
                      {doneTasks.slice(0, 30).map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          onReopen={() =>
                            void updateTask(task.id, {
                              status: "in_progress",
                              remainingMinutes: Math.max(
                                1,
                                task.estimatedMinutes - task.actualMinutes,
                              ),
                            })
                          }
                          onDelete={() => setPendingTaskDelete(task.id)}
                          pendingDelete={pendingTaskDelete === task.id}
                          onCancelDelete={() => setPendingTaskDelete(null)}
                          onConfirmDelete={() => {
                            void deleteTask(task.id);
                            setPendingTaskDelete(null);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function TaskRow({
  task,
  onDone,
  onReopen,
  onDelete,
  pendingDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  task: ScheduleTask;
  onDone?: () => void;
  onReopen?: () => void;
  onDelete: () => void;
  pendingDelete: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-2.5 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[11px]">{task.title}</span>
      <span className="font-mono text-[9px] text-muted-foreground/60">
        剩余 {minutesLabel(task.remainingMinutes)} / 预估{" "}
        {minutesLabel(task.estimatedMinutes)}
      </span>
      <span className="rounded bg-muted/50 px-1 py-px text-[8px] text-muted-foreground">
        {PRIORITY_LABEL[task.priority] ?? task.priority}
      </span>
      {task.deadline ? (
        <span className="text-[9px] text-muted-foreground/60">
          截止 {task.deadline}
        </span>
      ) : null}
      {onDone ? (
        <button
          type="button"
          onClick={onDone}
          className="rounded p-1 text-muted-foreground/50 hover:bg-primary/10 hover:text-primary"
          title="标记完成"
        >
          <Check className="h-3 w-3" />
        </button>
      ) : null}
      {onReopen ? (
        <button
          type="button"
          onClick={onReopen}
          className="rounded p-1 text-muted-foreground/50 hover:bg-primary/10 hover:text-primary"
          title="重新打开"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      ) : null}
      {pendingDelete ? (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={onConfirmDelete}
            className="rounded bg-danger/15 px-1.5 py-0.5 text-[9px] text-danger"
          >
            确认删除
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            className="rounded px-1 py-0.5 text-[9px] text-muted-foreground"
          >
            取消
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-muted-foreground/50 hover:bg-danger/10 hover:text-danger"
          title="删除任务"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
