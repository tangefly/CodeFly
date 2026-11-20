import { useState } from "react";
import {
  AlertTriangle,
  Brain,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  ListTodo,
  Loader2,
  Mail,
} from "lucide-react";
import type {
  ScheduleConfidence,
  ScheduleMemory,
  SchedulePriority,
  ScheduleTask,
} from "@codefly/protocol";
import type { ToolMessage } from "../../lib/store.js";
import { useAppStore } from "../../lib/store.js";
import { SCHEDULE_TOOL_LABEL } from "../../lib/tool-labels.js";
import { cn, formatDuration } from "../../lib/utils.js";
import { Button } from "../ui.js";

interface CellBlock {
  id: string;
  start: string;
  end: string;
  status: "planned" | "done" | "skipped";
  actualMinutes: number | null;
  note: string;
}

interface TableRow {
  taskId: string;
  title: string;
  priority: SchedulePriority;
  confidence: ScheduleConfidence;
  status: ScheduleTask["status"];
  estimatedMinutes: number;
  remainingMinutes: number;
  actualMinutes: number;
  totalMinutes: number;
  days: CellBlock[][];
}

interface TableDay {
  date: string;
  label: string;
}

interface ScheduleTable {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  days: TableDay[];
  rows: TableRow[];
  summary?: {
    totalPlannedMinutes: number;
    doneMinutes: number;
    taskCount: number;
  };
  unscheduled?: Array<{
    taskId: string;
    title: string;
    remainingMinutes: number;
    reason: string;
  }>;
  warnings?: string[];
  notes?: string;
}

interface ScheduleToolData {
  view?: string;
  table?: ScheduleTable | null;
  weekStart?: string;
  weekEnd?: string;
  memories?: ScheduleMemory[];
  tasks?: ScheduleTask[];
  deletedId?: string;
  block?: {
    id: string;
    taskId: string;
    date: string;
    start: string;
    end: string;
    status: string;
    actualMinutes: number | null;
    note: string;
  };
  previous?: {
    status: string;
  };
  filePath?: string;
  emailedTo?: string;
  created?: boolean;
}

const PRIORITY_LABEL: Record<SchedulePriority, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

const CONFIDENCE_LABEL: Record<ScheduleConfidence, string> = {
  low: "置信低",
  medium: "置信中",
  high: "置信高",
};

const PRIORITY_CLASS: Record<SchedulePriority, string> = {
  urgent: "border-danger/30 bg-danger/10 text-danger",
  high: "border-warning/30 bg-warning/10 text-warning",
  medium: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  low: "border-border bg-muted/40 text-muted-foreground",
};

function minutesLabel(minutes: number): string {
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function statusMeta(message: ToolMessage): {
  label: string;
  className: string;
} {
  if (message.status === "running") {
    return {
      label: "执行中",
      className: "border-sky-400/30 bg-sky-400/10 text-sky-300",
    };
  }
  if (message.status === "cancelled") {
    return {
      label: "已取消",
      className: "border-border bg-muted/40 text-muted-foreground",
    };
  }
  if (message.status === "error") {
    return {
      label: "失败",
      className: "border-danger/35 bg-danger/10 text-danger",
    };
  }
  return {
    label: "完成",
    className: "border-primary/30 bg-primary/10 text-primary",
  };
}

function PlanTable({ table }: { table: ScheduleTable }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/80">
      <table className="w-full min-w-[720px] border-collapse text-[10px]">
        <thead>
          <tr className="bg-muted/40 text-left text-muted-foreground">
            <th className="w-[220px] border-b border-border/70 px-2 py-1.5 font-medium">
              任务
            </th>
            {table.days.map((day) => (
              <th
                key={day.date}
                className="border-b border-l border-border/70 px-1.5 py-1.5 font-medium"
              >
                <span className="block">{day.label}</span>
                <span className="block font-mono text-[8px] text-muted-foreground/60">
                  {day.date.slice(5)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <tr>
              <td
                colSpan={table.days.length + 1}
                className="px-3 py-6 text-center text-[11px] text-muted-foreground/60"
              >
                这一周还没有已排入的任务
              </td>
            </tr>
          ) : (
            table.rows.map((row) => (
              <tr key={row.taskId} className="align-top">
                <td className="border-b border-border/50 px-2 py-1.5">
                  <div className="flex items-start gap-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground/90">
                        {row.title}
                      </span>
                      <span className="mt-0.5 block text-[9px] text-muted-foreground/60">
                        {PRIORITY_LABEL[row.priority]} · {CONFIDENCE_LABEL[row.confidence]} · 剩余{" "}
                        {minutesLabel(row.remainingMinutes)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded border px-1 py-px text-[8px]",
                        PRIORITY_CLASS[row.priority],
                      )}
                    >
                      {PRIORITY_LABEL[row.priority]}
                    </span>
                  </div>
                </td>
                {row.days.map((cell, index) => (
                  <td
                    key={table.days[index]?.date ?? index}
                    className="border-b border-l border-border/50 px-1.5 py-1.5"
                  >
                    {cell.length === 0 ? (
                      <span className="text-muted-foreground/25">—</span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        {cell.map((block) => (
                          <span
                            key={block.id}
                            className={cn(
                              "font-mono text-[9px]",
                              block.status === "done"
                                ? "text-primary"
                                : block.status === "skipped"
                                  ? "text-muted-foreground/40 line-through"
                                  : "text-foreground/80",
                            )}
                            title={block.note}
                          >
                            {block.status === "done"
                              ? "✓ "
                              : block.status === "skipped"
                                ? "— "
                                : ""}
                            {block.start}-{block.end}
                            {block.actualMinutes !== null
                              ? ` (${block.actualMinutes}m)`
                              : ""}
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

function MemoryList({ memories }: { memories: ScheduleMemory[] }) {
  if (memories.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground/60">
        没有匹配的记忆
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {memories.map((memory) => (
        <div
          key={memory.id}
          className="rounded-lg border border-border/70 bg-background/40 px-2.5 py-2"
        >
          <div className="flex items-center gap-1.5">
            <Brain className="h-3 w-3 shrink-0 text-primary" />
            <span className="truncate text-[11px] font-medium">{memory.title}</span>
            <span className="shrink-0 rounded bg-muted/50 px-1 py-px text-[8px] text-muted-foreground">
              {memory.category}
            </span>
            {memory.pinned ? (
              <span className="shrink-0 text-[8px] text-warning">置顶</span>
            ) : null}
            <span className="ml-auto shrink-0 font-mono text-[8px] text-muted-foreground/50">
              {memory.key}
            </span>
          </div>
          {memory.content.trim() !== "" ? (
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10px] leading-4 text-muted-foreground">
              {memory.content}
            </p>
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
      ))}
    </div>
  );
}

function TaskList({ tasks }: { tasks: ScheduleTask[] }) {
  if (tasks.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground/60">
        没有匹配的任务
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-2.5 py-1.5"
        >
          <ListTodo className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <span className="min-w-0 flex-1 truncate text-[11px]">{task.title}</span>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">
            剩余 {minutesLabel(task.remainingMinutes)}
          </span>
          <span
            className={cn(
              "shrink-0 rounded border px-1 py-px text-[8px]",
              PRIORITY_CLASS[task.priority],
            )}
          >
            {PRIORITY_LABEL[task.priority]}
          </span>
          <span className="shrink-0 text-[9px] text-muted-foreground/50">
            {task.status}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ScheduleToolCard({ message }: { message: ToolMessage }) {
  const meta = message.meta ?? {};
  const data = (meta.data ?? {}) as ScheduleToolData;
  const label = SCHEDULE_TOOL_LABEL[message.toolName] ?? message.toolName;
  const status = statusMeta(message);
  const sendScheduleEmailNow = useAppStore((state) => state.sendScheduleEmailNow);
  const openSchedulePanel = useAppStore((state) => state.openSchedulePanel);
  const [outputOpen, setOutputOpen] = useState(false);
  const [emailing, setEmailing] = useState(false);

  const table = data.table ?? null;
  const imageDataUrl =
    typeof meta.imageDataUrl === "string" ? meta.imageDataUrl : undefined;
  const weekStart = table?.weekStart ?? data.weekStart;
  const hasPlan = table !== null;
  const hasMemories = Array.isArray(data.memories);
  const hasTasks = Array.isArray(data.tasks);
  const hasBlock = data.block !== undefined;

  const sendEmail = async (): Promise<void> => {
    if (weekStart === undefined || emailing) return;
    setEmailing(true);
    await sendScheduleEmailNow(weekStart);
    setEmailing(false);
  };

  return (
    <div className="cf-fade-up overflow-hidden rounded-xl border border-border bg-card/70">
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
          {hasPlan ? (
            <CalendarDays className="h-3.5 w-3.5" />
          ) : hasMemories ? (
            <Brain className="h-3.5 w-3.5" />
          ) : (
            <ListTodo className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-foreground/90">{label}</span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[8px]",
                status.className,
              )}
            >
              {status.label}
            </span>
            {table !== null ? (
              <span className="font-mono text-[9px] text-muted-foreground/60">
                {table.weekStart} ~ {table.weekEnd}
              </span>
            ) : null}
            {data.emailedTo ? (
              <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-[8px] text-primary">
                已发送 {data.emailedTo}
              </span>
            ) : null}
            {typeof meta.durationMs === "number" ? (
              <span className="ml-auto text-[9px] text-muted-foreground/50">
                {formatDuration(meta.durationMs)}
              </span>
            ) : null}
          </div>
          {table !== null && table.summary ? (
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">
              {table.summary.taskCount} 项任务 · 计划{" "}
              {minutesLabel(table.summary.totalPlannedMinutes)} · 已完成{" "}
              {minutesLabel(table.summary.doneMinutes)}
              {table.unscheduled && table.unscheduled.length > 0
                ? ` · 未排期 ${table.unscheduled.length} 项`
                : " · 全部已排入"}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2.5 px-3.5 pb-3">
        {table !== null ? <PlanTable table={table} /> : null}

        {hasMemories ? <MemoryList memories={data.memories ?? []} /> : null}
        {hasTasks ? <TaskList tasks={data.tasks ?? []} /> : null}

        {hasBlock && data.block ? (
          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-2.5 py-2 text-[10px]">
            <Clock3 className="h-3 w-3 text-primary" />
            <span className="font-mono">
              {data.block.date} {data.block.start}-{data.block.end}
            </span>
            <span className="rounded bg-muted/50 px-1.5 py-px text-[9px]">
              {data.block.status}
            </span>
            {data.previous && data.previous.status !== data.block.status ? (
              <span className="text-muted-foreground/60">
                （{data.previous.status} → {data.block.status}）
              </span>
            ) : null}
            {data.block.actualMinutes !== null ? (
              <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">
                实际 {data.block.actualMinutes}m
              </span>
            ) : null}
          </div>
        ) : null}

        {table !== null && table.warnings && table.warnings.length > 0 ? (
          <div className="rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2">
            {table.warnings.map((warning) => (
              <p
                key={warning}
                className="flex items-start gap-1.5 text-[10px] leading-4 text-warning"
              >
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {warning}
              </p>
            ))}
          </div>
        ) : null}

        {table !== null && table.unscheduled && table.unscheduled.length > 0 ? (
          <div className="rounded-lg border border-border/70 bg-background/30 px-2.5 py-2">
            <p className="text-[10px] font-medium text-foreground/80">未排期任务</p>
            {table.unscheduled.map((item) => (
              <p
                key={item.taskId}
                className="mt-1 text-[10px] leading-4 text-muted-foreground"
              >
                • {item.title} · 剩余 {minutesLabel(item.remainingMinutes)} · {item.reason}
              </p>
            ))}
          </div>
        ) : null}

        {table !== null && (table.notes ?? "").trim() !== "" ? (
          <p className="rounded-lg bg-muted/20 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
            备注：{table.notes}
          </p>
        ) : null}

        {imageDataUrl ? (
          <div className="overflow-hidden rounded-lg border border-border/70 bg-white">
            <img
              src={imageDataUrl}
              alt="周计划表格"
              className="max-h-[340px] w-full object-contain"
            />
          </div>
        ) : null}

        {(hasPlan || imageDataUrl || hasMemories || hasTasks) ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {imageDataUrl ? (
              <a
                href={imageDataUrl}
                download={`codefly-week-${weekStart ?? "plan"}.png`}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-background px-2 text-[10px] text-foreground/80 transition-colors hover:border-primary/30 hover:text-primary"
              >
                <Download className="h-3 w-3" />
                下载 PNG
              </a>
            ) : null}
            {table !== null && weekStart ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[10px]"
                disabled={emailing}
                onClick={() => void sendEmail()}
              >
                {emailing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Mail className="h-3 w-3" />
                )}
                发送到我的邮箱
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[10px]"
              onClick={openSchedulePanel}
            >
              <CheckCircle2 className="h-3 w-3" />
              打开日程面板
            </Button>
            {typeof data.filePath === "string" ? (
              <span className="ml-auto max-w-full truncate font-mono text-[8px] text-muted-foreground/40">
                {data.filePath}
              </span>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setOutputOpen((value) => !value)}
          className="flex items-center gap-1 text-[9px] text-muted-foreground/50 transition-colors hover:text-foreground"
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", outputOpen && "rotate-90")}
          />
          工具输出
        </button>
        {outputOpen ? (
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-background/60 p-2 font-mono text-[9px] leading-4 text-muted-foreground">
            {message.content}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
