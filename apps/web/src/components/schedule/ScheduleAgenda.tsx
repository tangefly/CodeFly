import type {
  ScheduleAgendaDay,
  ScheduleAgendaItem,
  ScheduleAgendaModel,
  SchedulePriority,
} from "@codefly/protocol";
import { cn } from "../../lib/utils.js";

const PRIORITY_LABEL: Record<SchedulePriority, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

function minutesLabel(minutes: number): string {
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function itemTone(item: ScheduleAgendaItem): string {
  if (item.status === "done") return "border-emerald-500/70 bg-emerald-500/[0.06]";
  if (item.status === "skipped") return "border-border bg-muted/20 opacity-60";
  return item.kind === "fixed"
    ? "border-teal-500/70 bg-teal-500/[0.06]"
    : "border-sky-500/70 bg-sky-500/[0.06]";
}

function itemMeta(item: ScheduleAgendaItem): string {
  if (item.kind === "fixed") {
    return item.location.trim() === ""
      ? "固定安排"
      : `固定 · ${item.location.trim()}`;
  }
  const status =
    item.status === "done"
      ? "已完成"
      : item.status === "skipped"
        ? "已跳过"
        : "待办";
  const priority =
    item.priority === null ? "" : `${PRIORITY_LABEL[item.priority] ?? item.priority} · `;
  return `${priority}${status}`;
}

function freeLabel(day: ScheduleAgendaDay): string {
  if (day.freeMinutes === null) {
    return day.items.length > 0 ? "非工作日 · 有安排" : "休息日";
  }
  if (day.freeMinutes <= 0) return "工作时段已排满";
  return `空闲约 ${minutesLabel(day.freeMinutes)}`;
}

function DayCard({
  day,
  today,
  compact,
}: {
  day: ScheduleAgendaDay;
  today: string;
  compact: boolean;
}) {
  const isToday = day.date === today;
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-background/40",
        isToday ? "border-primary/40 ring-1 ring-primary/15" : "border-border/70",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border/60 px-2.5",
          compact ? "py-1.5" : "py-2",
          isToday ? "bg-primary/[0.07]" : "bg-muted/25",
        )}
      >
        <span className={cn("font-semibold", compact ? "text-[11px]" : "text-xs")}>
          {day.weekday}
        </span>
        <span className="font-mono text-[9px] text-muted-foreground/70">
          {day.date.slice(5)}
        </span>
        {isToday ? (
          <span className="rounded-full bg-primary/15 px-1.5 py-px text-[8px] font-medium text-primary">
            今天
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[9px] text-muted-foreground/70">
          {day.items.length > 0
            ? `${day.items.length} 项 · ${minutesLabel(day.plannedMinutes)}`
            : "无安排"}
        </span>
      </div>

      <div className={cn(compact ? "px-1.5 py-1" : "px-2 py-1.5")}>
        {day.items.length === 0 ? (
          <p className="px-1 py-2 text-[10px] text-muted-foreground/50">
            这一天没有安排
          </p>
        ) : (
          <div className={compact ? "space-y-1" : "space-y-1.5"}>
            {day.items.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex items-start gap-2 rounded-r-md border-l-2 px-2 py-1",
                  itemTone(item),
                )}
              >
                <span
                  className={cn(
                    "shrink-0 font-mono text-muted-foreground/80",
                    compact ? "w-[4.2rem] text-[9px]" : "w-20 text-[10px]",
                    item.status === "skipped" && "line-through",
                  )}
                >
                  {item.start}-{item.end}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "truncate font-medium text-foreground/90",
                      compact ? "text-[10.5px]" : "text-[11px]",
                      item.status === "skipped" && "line-through",
                    )}
                    title={item.title}
                  >
                    {item.status === "done" ? "✓ " : ""}
                    {item.title}
                  </p>
                  <p
                    className="truncate text-[9px] text-muted-foreground/65"
                    title={
                      item.note.trim() === "" ? undefined : item.note.trim()
                    }
                  >
                    {itemMeta(item)}
                    {item.note.trim() !== "" ? ` · ${item.note.trim()}` : ""}
                    {item.actualMinutes !== null && item.actualMinutes > 0
                      ? ` · 实际 ${item.actualMinutes}m`
                      : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        className={cn(
          "flex items-center justify-between border-t border-border/50 px-2.5 text-[9px] text-muted-foreground/60",
          compact ? "py-1" : "py-1.5",
        )}
      >
        <span>{freeLabel(day)}</span>
        <span>计划 {minutesLabel(day.plannedMinutes)}</span>
      </div>
    </div>
  );
}

/**
 * Rolling 7-day agenda: a compact load strip on top, then one card per day
 * with fixed commitments and task blocks in chronological order.
 */
export function ScheduleAgenda({
  agenda,
  compact = false,
}: {
  agenda: ScheduleAgendaModel;
  compact?: boolean;
}) {
  const maxPlanned = Math.max(1, ...agenda.days.map((day) => day.plannedMinutes));
  return (
    <div className={cn(compact ? "space-y-2" : "space-y-3")}>
      <div className={cn("grid grid-cols-7", compact ? "gap-0.5" : "gap-1")}>
        {agenda.days.map((day) => {
          const isToday = day.date === agenda.today;
          const load = Math.round((day.plannedMinutes / maxPlanned) * 100);
          return (
            <div
              key={day.date}
              className={cn(
                "min-w-0 rounded-lg border px-1 py-1 text-center",
                isToday
                  ? "border-primary/40 bg-primary/10"
                  : "border-border/60 bg-background/30",
              )}
              title={`${day.weekday} ${day.date} · ${day.items.length} 项 · ${minutesLabel(day.plannedMinutes)}`}
            >
              <p
                className={cn(
                  "truncate text-[9px] font-medium",
                  isToday ? "text-primary" : "text-muted-foreground/80",
                )}
              >
                {day.weekday}
              </p>
              <p className="font-mono text-[8px] text-muted-foreground/55">
                {day.date.slice(5)}
              </p>
              <div className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-muted/50">
                <div
                  className={cn(
                    "h-full rounded-full",
                    isToday ? "bg-primary/80" : "bg-primary/45",
                  )}
                  style={{ width: `${load}%` }}
                />
              </div>
              <p className="mt-0.5 truncate text-[8px] text-muted-foreground/60">
                {day.plannedMinutes > 0 ? minutesLabel(day.plannedMinutes) : "空闲"}
              </p>
            </div>
          );
        })}
      </div>

      <div
        className={cn(
          compact
            ? "space-y-1.5"
            : "grid gap-2 md:grid-cols-2",
        )}
      >
        {agenda.days.map((day) => (
          <DayCard
            key={day.date}
            day={day}
            today={agenda.today}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}
