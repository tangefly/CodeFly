import { useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  ListTodo,
  Loader2,
  Mail,
  Settings,
} from "lucide-react";
import type {
  ScheduleAgendaModel,
  SchedulePreferences,
  SchedulePriority,
  ScheduleTask,
  ScheduleTaskAllocation,
} from "@codefly/protocol";
import type { ToolMessage } from "../../lib/store.js";
import { useAppStore } from "../../lib/store.js";
import { SCHEDULE_TOOL_LABEL } from "../../lib/tool-labels.js";
import { cn, formatDuration } from "../../lib/utils.js";
import { Button } from "../ui.js";
import { ScheduleAgenda } from "./ScheduleAgenda.js";

interface ScheduleToolData {
  view?: string;
  agenda?: ScheduleAgendaModel | null;
  rangeStart?: string;
  rangeEnd?: string;
  preferences?: SchedulePreferences;
  configured?: boolean;
  taskAllocations?: ScheduleTaskAllocation[];
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

function PreferencesSummary({
  preferences,
  configured,
}: {
  preferences: SchedulePreferences;
  configured: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/40 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <Settings className="h-3 w-3 shrink-0 text-primary" />
        <span className="font-medium text-foreground/80">
          排期偏好{configured ? "" : "（默认值）"}
        </span>
        <span>
          工作日 {preferences.workdays.join(",")} · {preferences.workStart}-
          {preferences.workEnd}
        </span>
        <span>最长专注 {minutesLabel(preferences.maxFocusMinutes)}</span>
        <span>每日上限 {minutesLabel(preferences.dailyFocusLimitMinutes)}</span>
        <span>缓冲 {Math.round(preferences.bufferRatio * 100)}%</span>
        <span>块间隙 {preferences.gapMinutes}m</span>
        <span className="font-mono text-muted-foreground/50">
          {preferences.timezone}
        </span>
      </div>
      {preferences.rules.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {preferences.rules.map((rule) => (
            <p
              key={rule}
              className="line-clamp-2 text-[10px] leading-4 text-muted-foreground/80"
            >
              • {rule}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskAllocations({
  allocations,
}: {
  allocations: ScheduleTaskAllocation[];
}) {
  return (
    <div className="space-y-1 rounded-lg border border-border/70 bg-background/40 px-2.5 py-2">
      <p className="text-[10px] font-medium text-foreground/80">排期汇总</p>
      {allocations.map((item) => {
        const over =
          item.estimatedMinutes > 0 &&
          item.scheduledMinutes > item.estimatedMinutes;
        return (
          <div
            key={item.taskId}
            className="flex items-center gap-2 text-[10px] text-muted-foreground"
          >
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <span className="shrink-0 font-mono">
              已排 {minutesLabel(item.scheduledMinutes)} / 预估{" "}
              {minutesLabel(item.estimatedMinutes)}
            </span>
            <span className="shrink-0 text-muted-foreground/50">
              {item.blockCount} 段
            </span>
            {over ? (
              <span className="shrink-0 text-warning">超出预估</span>
            ) : null}
          </div>
        );
      })}
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
  const [expanded, setExpanded] = useState(false);
  const [emailing, setEmailing] = useState(false);

  const agenda = data.agenda ?? null;
  const imageDataUrl =
    typeof meta.imageDataUrl === "string" ? meta.imageDataUrl : undefined;
  const rangeStart = agenda?.startDate ?? data.rangeStart;
  const hasPlan = agenda !== null;
  const hasPreferences = data.preferences !== undefined;
  const hasAllocations =
    Array.isArray(data.taskAllocations) && data.taskAllocations.length > 0;
  const hasTasks = Array.isArray(data.tasks);
  const hasBlock = data.block !== undefined;

  const sendEmail = async (): Promise<void> => {
    if (rangeStart === undefined || emailing) return;
    setEmailing(true);
    await sendScheduleEmailNow(rangeStart, 7);
    setEmailing(false);
  };

  return (
    <div className="cf-fade-up overflow-hidden rounded-xl border border-border bg-card/70">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? "收起工具结果" : "展开工具结果"}
        className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/20"
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
          {hasPlan ? (
            <CalendarDays className="h-3.5 w-3.5" />
          ) : hasPreferences ? (
            <Settings className="h-3.5 w-3.5" />
          ) : (
            <ListTodo className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="block min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-foreground/90">{label}</span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[8px]",
                status.className,
              )}
            >
              {status.label}
            </span>
            {agenda !== null ? (
              <span className="font-mono text-[9px] text-muted-foreground/60">
                {agenda.startDate} ~ {agenda.endDate}
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
          </span>
          {agenda !== null ? (
            <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
              {agenda.summary.taskCount} 项任务 · 计划{" "}
              {minutesLabel(agenda.summary.totalPlannedMinutes)} · 已完成{" "}
              {minutesLabel(agenda.summary.doneMinutes)}
              {agenda.unscheduled.length > 0
                ? ` · 未排期 ${agenda.unscheduled.length} 项`
                : " · 全部已排入"}
            </span>
          ) : null}
        </span>
        <ChevronRight
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded ? (
        <div className="space-y-2.5 px-3.5 pb-3">
          {agenda !== null ? <ScheduleAgenda agenda={agenda} compact /> : null}

          {hasAllocations ? (
            <TaskAllocations allocations={data.taskAllocations ?? []} />
          ) : null}
          {hasPreferences && data.preferences ? (
            <PreferencesSummary
              preferences={data.preferences}
              configured={data.configured === true}
            />
          ) : null}
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

          {agenda !== null && agenda.warnings.length > 0 ? (
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2">
              {agenda.warnings.map((warning) => (
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

          {agenda !== null && agenda.unscheduled.length > 0 ? (
            <div className="rounded-lg border border-border/70 bg-background/30 px-2.5 py-2">
              <p className="text-[10px] font-medium text-foreground/80">未排期任务</p>
              {agenda.unscheduled.map((item) => (
                <p
                  key={item.taskId}
                  className="mt-1 text-[10px] leading-4 text-muted-foreground"
                >
                  • {item.title} · 剩余 {minutesLabel(item.remainingMinutes)} · {item.reason}
                </p>
              ))}
            </div>
          ) : null}

          {agenda !== null && agenda.notes.trim() !== "" ? (
            <p className="rounded-lg bg-muted/20 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
              备注：{agenda.notes}
            </p>
          ) : null}

          {imageDataUrl ? (
            <div className="overflow-hidden rounded-lg border border-border/70 bg-white">
              <img
                src={imageDataUrl}
                alt="未来 7 天日程"
                className="max-h-[340px] w-full object-contain"
              />
            </div>
          ) : null}

          {(hasPlan || imageDataUrl || hasPreferences || hasTasks) ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {imageDataUrl ? (
                <a
                  href={imageDataUrl}
                  download={`codefly-agenda-${rangeStart ?? "plan"}.png`}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-background px-2 text-[10px] text-foreground/80 transition-colors hover:border-primary/30 hover:text-primary"
                >
                  <Download className="h-3 w-3" />
                  下载 PNG
                </a>
              ) : null}
              {agenda !== null && rangeStart ? (
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

          <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-background/60 p-2 font-mono text-[9px] leading-4 text-muted-foreground">
            {message.content}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
