import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CalendarDays,
  Check,
  Clock3,
  ListTodo,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import type {
  ScheduleFixedEvent,
  ScheduleFixedEventKind,
  SchedulePreferences,
  SchedulePreferencesUpdateInput,
  ScheduleTask,
} from "@codefly/protocol";
import { useAppStore } from "../../lib/store.js";
import { cn } from "../../lib/utils.js";
import { Button, Modal } from "../ui.js";
import { ScheduleAgenda } from "./ScheduleAgenda.js";

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

function PreferencesPanel({
  preferences,
  configured,
  onSave,
}: {
  preferences: SchedulePreferences;
  configured: boolean;
  onSave: (input: SchedulePreferencesUpdateInput) => Promise<boolean>;
}) {
  const [workdays, setWorkdays] = useState<number[]>(preferences.workdays);
  const [workStart, setWorkStart] = useState(preferences.workStart);
  const [workEnd, setWorkEnd] = useState(preferences.workEnd);
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [maxFocusMinutes, setMaxFocusMinutes] = useState(
    String(preferences.maxFocusMinutes),
  );
  const [minBlockMinutes, setMinBlockMinutes] = useState(
    String(preferences.minBlockMinutes),
  );
  const [dailyFocusLimitMinutes, setDailyFocusLimitMinutes] = useState(
    String(preferences.dailyFocusLimitMinutes),
  );
  const [bufferPercent, setBufferPercent] = useState(
    String(Math.round(preferences.bufferRatio * 100)),
  );
  const [gapMinutes, setGapMinutes] = useState(String(preferences.gapMinutes));
  const [breaks, setBreaks] = useState(
    preferences.breaks.map((brk) => ({ ...brk })),
  );
  const [rules, setRules] = useState(preferences.rules.join("\n"));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWorkdays(preferences.workdays);
    setWorkStart(preferences.workStart);
    setWorkEnd(preferences.workEnd);
    setTimezone(preferences.timezone);
    setMaxFocusMinutes(String(preferences.maxFocusMinutes));
    setMinBlockMinutes(String(preferences.minBlockMinutes));
    setDailyFocusLimitMinutes(String(preferences.dailyFocusLimitMinutes));
    setBufferPercent(String(Math.round(preferences.bufferRatio * 100)));
    setGapMinutes(String(preferences.gapMinutes));
    setBreaks(preferences.breaks.map((brk) => ({ ...brk })));
    setRules(preferences.rules.join("\n"));
  }, [preferences]);

  const toggleDay = (day: number): void => {
    setWorkdays((current) =>
      current.includes(day)
        ? current.filter((value) => value !== day)
        : [...current, day].sort((a, b) => a - b),
    );
  };

  const save = async (): Promise<void> => {
    if (saving || workdays.length === 0) return;
    setSaving(true);
    await onSave({
      timezone: timezone.trim() || preferences.timezone,
      workdays,
      workStart,
      workEnd,
      breaks: breaks.map((brk) => ({
        label: brk.label.trim() || "休息",
        start: brk.start,
        end: brk.end,
      })),
      maxFocusMinutes: Number(maxFocusMinutes),
      minBlockMinutes: Number(minBlockMinutes),
      bufferRatio: Math.min(1, Math.max(0, Number(bufferPercent) / 100)),
      gapMinutes: Number(gapMinutes),
      dailyFocusLimitMinutes: Number(dailyFocusLimitMinutes),
      rules: rules
        .split(/\r?\n/)
        .map((rule) => rule.trim())
        .filter((rule) => rule !== ""),
    });
    setSaving(false);
  };

  const numberInput =
    "h-8 w-full rounded-lg border border-border bg-background px-2 text-xs focus:border-primary/40 focus:outline-none";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium">排期偏好与规则</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {configured
              ? "这些设置会直接决定排期；修改后下一次 plan_schedule 生效。"
              : "尚未配置，当前显示默认值；保存后助手会读取这些设置。"}
          </p>
        </div>
        <span className="rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[9px] text-muted-foreground">
          {preferences.timezone}
        </span>
      </div>

      <div className="rounded-xl border border-border/70 bg-background/40 p-3">
        <p className="mb-2 text-[10px] font-medium text-muted-foreground">工作日</p>
        <div className="flex flex-wrap gap-1.5">
          {["一", "二", "三", "四", "五", "六", "日"].map((label, index) => {
            const day = index + 1;
            const active = workdays.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(day)}
                className={cn(
                  "h-7 w-9 rounded-lg border text-[11px] transition-colors",
                  active
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            上班时间
          </span>
          <input
            type="time"
            value={workStart}
            onChange={(event) => setWorkStart(event.target.value)}
            className={numberInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            下班时间
          </span>
          <input
            type="time"
            value={workEnd}
            onChange={(event) => setWorkEnd(event.target.value)}
            className={numberInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            最长专注（分钟）
          </span>
          <input
            type="number"
            min={15}
            max={480}
            value={maxFocusMinutes}
            onChange={(event) => setMaxFocusMinutes(event.target.value)}
            className={numberInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            最小任务块（分钟）
          </span>
          <input
            type="number"
            min={5}
            max={600}
            value={minBlockMinutes}
            onChange={(event) => setMinBlockMinutes(event.target.value)}
            className={numberInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            每日专注上限（分钟）
          </span>
          <input
            type="number"
            min={30}
            max={1440}
            value={dailyFocusLimitMinutes}
            onChange={(event) => setDailyFocusLimitMinutes(event.target.value)}
            className={numberInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            时区
          </span>
          <input
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            className={numberInput}
            placeholder="Asia/Shanghai"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            预估缓冲（%）· 0 = 精确按估时排
          </span>
          <input
            type="number"
            min={0}
            max={100}
            value={bufferPercent}
            onChange={(event) => setBufferPercent(event.target.value)}
            className={numberInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            块间隙（分钟）· 0 = 紧挨着排
          </span>
          <input
            type="number"
            min={0}
            max={60}
            value={gapMinutes}
            onChange={(event) => setGapMinutes(event.target.value)}
            className={numberInput}
          />
        </label>
      </div>

      <div className="rounded-xl border border-border/70 bg-background/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-medium text-muted-foreground">休息时段</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px]"
            onClick={() =>
              setBreaks((current) => [
                ...current,
                { label: "休息", start: "12:00", end: "13:00" },
              ])
            }
          >
            <Plus className="h-3 w-3" />
            添加
          </Button>
        </div>
        <div className="space-y-1.5">
          {breaks.length === 0 ? (
            <p className="text-[10px] text-muted-foreground/60">没有休息时段。</p>
          ) : (
            breaks.map((brk, index) => (
              <div key={index} className="flex flex-wrap items-center gap-1.5">
                <input
                  value={brk.label}
                  onChange={(event) =>
                    setBreaks((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, label: event.target.value }
                          : item,
                      ),
                    )
                  }
                  className="h-7 w-24 rounded-lg border border-border bg-background px-2 text-[11px] focus:border-primary/40 focus:outline-none"
                  placeholder="名称"
                />
                <input
                  type="time"
                  value={brk.start}
                  onChange={(event) =>
                    setBreaks((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, start: event.target.value }
                          : item,
                      ),
                    )
                  }
                  className="h-7 rounded-lg border border-border bg-background px-2 text-[11px] focus:border-primary/40 focus:outline-none"
                />
                <span className="text-[10px] text-muted-foreground">-</span>
                <input
                  type="time"
                  value={brk.end}
                  onChange={(event) =>
                    setBreaks((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, end: event.target.value }
                          : item,
                      ),
                    )
                  }
                  className="h-7 rounded-lg border border-border bg-background px-2 text-[11px] focus:border-primary/40 focus:outline-none"
                />
                <button
                  type="button"
                  aria-label="删除休息时段"
                  onClick={() =>
                    setBreaks((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                  className="rounded p-1 text-muted-foreground/50 hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-[10px] text-muted-foreground">
          规则（每行一条；用于无法结构化的约束，如“同一任务只有跨饭点才拆分”）
        </span>
        <textarea
          value={rules}
          onChange={(event) => setRules(event.target.value)}
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-xs leading-5 focus:border-primary/40 focus:outline-none"
          placeholder="同一任务同一天只在跨饭点时拆分。&#10;课程只在实际教学周生效。"
        />
      </label>

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={saving || workdays.length === 0}
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          保存偏好
        </Button>
      </div>
    </div>
  );
}

const WEEKDAY_OPTIONS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function FixedEventEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ScheduleFixedEvent | null;
  onSave: (value: {
    title: string;
    kind: ScheduleFixedEventKind;
    weekday: number | null;
    date: string | null;
    start: string;
    end: string;
    location: string;
    note: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [kind, setKind] = useState<ScheduleFixedEventKind>(
    initial?.kind ?? "weekly",
  );
  const [weekday, setWeekday] = useState<number>(initial?.weekday ?? 1);
  const [date, setDate] = useState(initial?.date ?? "");
  const [start, setStart] = useState(initial?.start ?? "08:00");
  const [end, setEnd] = useState(initial?.end ?? "09:00");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (title.trim() === "" || saving) return;
    setSaving(true);
    await onSave({
      title: title.trim(),
      kind,
      weekday: kind === "weekly" ? weekday : null,
      date: kind === "once" ? date : null,
      start,
      end,
      location: location.trim(),
      note,
    });
    setSaving(false);
  };

  const inputClass =
    "h-8 w-full rounded-lg border border-border bg-background px-2 text-xs focus:border-primary/40 focus:outline-none";

  return (
    <div className="space-y-2 rounded-xl border border-teal-500/30 bg-teal-500/5 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={inputClass}
            placeholder="例如：组会 / 线性代数"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">重复</span>
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as ScheduleFixedEventKind)
            }
            className="h-8 w-full rounded-lg border border-border bg-background px-2 text-[11px] focus:outline-none"
          >
            <option value="weekly">每周固定</option>
            <option value="once">仅一次</option>
          </select>
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        {kind === "weekly" ? (
          <label className="block">
            <span className="mb-1 block text-[10px] text-muted-foreground">星期</span>
            <select
              value={weekday}
              onChange={(event) => setWeekday(Number(event.target.value))}
              className="h-8 w-full rounded-lg border border-border bg-background px-2 text-[11px] focus:outline-none"
            >
              {WEEKDAY_OPTIONS.map((label, index) => (
                <option key={label} value={index + 1}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className="mb-1 block text-[10px] text-muted-foreground">日期</span>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className={inputClass}
            />
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">开始</span>
          <input
            type="time"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">结束</span>
          <input
            type="time"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            地点（可选）
          </span>
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            className={inputClass}
            placeholder="如 3-130 / 线上"
          />
        </label>
      </div>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-xs leading-5 focus:border-primary/40 focus:outline-none"
        placeholder="备注（可选）"
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={
            saving ||
            title.trim() === "" ||
            (kind === "weekly" ? false : date === "")
          }
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
  const updatePreferences = useAppStore(
    (state) => state.updateSchedulePreferences,
  );
  const createFixedEvent = useAppStore((state) => state.createScheduleFixedEvent);
  const updateFixedEvent = useAppStore((state) => state.updateScheduleFixedEvent);
  const deleteFixedEvent = useAppStore((state) => state.deleteScheduleFixedEvent);
  const updateTask = useAppStore((state) => state.updateScheduleTask);
  const deleteTask = useAppStore((state) => state.deleteScheduleTask);
  const sendScheduleEmail = useAppStore((state) => state.sendScheduleEmailNow);
  const openEmailSettings = useAppStore(
    (state) => state.openScheduleEmailSettings,
  );

  const [tab, setTab] = useState<"plan" | "fixed" | "preferences" | "tasks">(
    "plan",
  );
  const [rangeStart, setRangeStart] = useState<string | undefined>(undefined);
  const [fixedEditor, setFixedEditor] = useState<
    { id: string | null; initial: ScheduleFixedEvent | null } | null
  >(null);
  const [pendingFixedDelete, setPendingFixedDelete] = useState<string | null>(
    null,
  );
  const [pendingTaskDelete, setPendingTaskDelete] = useState<string | null>(
    null,
  );
  const [emailing, setEmailing] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadOverview(rangeStart);
  }, [open, rangeStart]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const saveFixedEvent = async (value: {
    title: string;
    kind: ScheduleFixedEventKind;
    weekday: number | null;
    date: string | null;
    start: string;
    end: string;
    location: string;
    note: string;
  }): Promise<void> => {
    if (fixedEditor?.id) {
      const ok = await updateFixedEvent(fixedEditor.id, value);
      if (ok) setFixedEditor(null);
    } else {
      const ok = await createFixedEvent(value);
      if (ok) setFixedEditor(null);
    }
  };

  const sendEmail = async (): Promise<void> => {
    if (!overview?.window || emailing) return;
    setEmailing(true);
    await sendScheduleEmail(overview.rangeStart, 7);
    setEmailing(false);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="日程面板"
      description="未来 7 天日程、排期偏好与任务；删除和编辑会同步到助手使用的全局数据。"
      className="max-w-6xl"
    >
      <div className="flex min-h-[30rem] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border bg-background p-0.5">
            {(
              [
                ["plan", "7 天日程", CalendarDays],
                ["fixed", "固定", CalendarClock],
                ["tasks", "任务", ListTodo],
                ["preferences", "偏好", Settings],
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
                aria-label="前 7 天"
                onClick={() => setRangeStart(addDays(overview.rangeStart, -7))}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="font-mono text-[10px] text-muted-foreground">
                {overview.rangeStart} ~ {overview.rangeEnd}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="后 7 天"
                onClick={() => setRangeStart(addDays(overview.rangeStart, 7))}
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
              {overview.rangeStart !== overview.today ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-[10px]"
                  onClick={() => setRangeStart(undefined)}
                >
                  回到今天
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新"
                onClick={() => void loadOverview(rangeStart)}
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
                    还没有配置排期偏好。在对话里告诉助手你的工作时段、工作日和休息时间，或直接到
                    <button
                      type="button"
                      onClick={() => setTab("preferences")}
                      className="mx-1 rounded bg-muted/50 px-1 font-mono text-[10px] underline-offset-2 hover:underline"
                    >
                      偏好
                    </button>
                    页编辑。
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
                  <span>缓冲 {Math.round(overview.preferences.bufferRatio * 100)}%</span>
                  <span>块间隙 {overview.preferences.gapMinutes}m</span>
                  <span>规则 {overview.preferences.rules.length} 条</span>
                  <span className="font-mono text-muted-foreground/50">
                    {overview.timezone}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-lg border border-border/70 bg-background/40 px-2 py-1 text-[10px] text-muted-foreground">
                    {overview.summary.taskCount} 项任务 ·{" "}
                    {overview.fixedEvents.length} 项固定安排 · 计划{" "}
                    {minutesLabel(overview.summary.totalPlannedMinutes)} · 已完成{" "}
                    {minutesLabel(overview.summary.doneMinutes)}
                  </span>
                  {overview.window ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[10px]"
                      disabled={emailing || !emailSettings?.configured}
                      title={
                        emailSettings?.configured
                          ? "发送日程图片"
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
                  {overview.window?.warnings.length ? (
                    <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[9px] text-warning">
                      {overview.window.warnings.length} 条提醒
                    </span>
                  ) : null}
                </div>

                <ScheduleAgenda agenda={overview.agenda} />

                {overview.window?.warnings.length ? (
                  <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                    {overview.window.warnings.map((warning) => (
                      <p
                        key={warning}
                        className="text-[10px] leading-5 text-warning"
                      >
                        • {warning}
                      </p>
                    ))}
                  </div>
                ) : null}

                {overview.window?.unscheduled.length ? (
                  <div className="rounded-lg border border-border/70 bg-background/30 px-3 py-2">
                    <p className="text-[10px] font-medium text-foreground/80">
                      未排期任务
                    </p>
                    {overview.window.unscheduled.map((item) => (
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

            {tab === "fixed" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground">
                    {overview.fixedEvents.length} 项固定安排（课程、例会等） ·
                    助手排期时会自动避开这些时段
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[10px]"
                    onClick={() => setFixedEditor({ id: null, initial: null })}
                  >
                    <Plus className="h-3 w-3" />
                    新增固定安排
                  </Button>
                </div>

                {fixedEditor ? (
                  <FixedEventEditor
                    initial={fixedEditor.initial}
                    onSave={saveFixedEvent}
                    onCancel={() => setFixedEditor(null)}
                  />
                ) : null}

                <div className="space-y-1">
                  {overview.fixedEvents.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                      还没有固定安排。可以在对话里把课程表发给助手，或点击「新增固定安排」。
                    </p>
                  ) : (
                    overview.fixedEvents.map((event) => (
                      <div
                        key={event.id}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-2.5 py-1.5"
                      >
                        <span className="min-w-0 flex-1 truncate text-[11px]">
                          {event.title}
                        </span>
                        <span className="rounded bg-teal-500/15 px-1 py-px text-[8px] text-teal-600">
                          {event.kind === "weekly" ? "每周" : "单次"}
                        </span>
                        <span className="font-mono text-[9px] text-muted-foreground/70">
                          {event.kind === "weekly"
                            ? `${WEEKDAY_OPTIONS[(event.weekday ?? 1) - 1]}`
                            : (event.date ?? "")}
                          {" "}
                          {event.start}-{event.end}
                        </span>
                        {event.location.trim() !== "" ? (
                          <span className="text-[9px] text-muted-foreground/60">
                            {event.location.trim()}
                          </span>
                        ) : null}
                        <span className="ml-auto flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="编辑固定安排"
                            onClick={() =>
                              setFixedEditor({ id: event.id, initial: event })
                            }
                            className="rounded p-1 text-muted-foreground/50 hover:bg-muted/50 hover:text-foreground"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          {pendingFixedDelete === event.id ? (
                            <span className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  void deleteFixedEvent(event.id);
                                  setPendingFixedDelete(null);
                                }}
                                className="rounded bg-danger/15 px-1.5 py-0.5 text-[9px] text-danger"
                              >
                                确认删除
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingFixedDelete(null)}
                                className="rounded px-1 py-0.5 text-[9px] text-muted-foreground"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              aria-label="删除固定安排"
                              onClick={() => setPendingFixedDelete(event.id)}
                              className="rounded p-1 text-muted-foreground/50 hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {tab === "preferences" ? (
              <PreferencesPanel
                preferences={overview.preferences}
                configured={overview.preferencesConfigured}
                onSave={updatePreferences}
              />
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
      {task.steps.length > 0 ? (
        <span
          className="rounded bg-primary/10 px-1 py-px text-[8px] text-primary"
          title={task.steps
            .map(
              (step, index) =>
                `${index + 1}. ${step.title}（${minutesLabel(step.minutes)}）`,
            )
            .join("\n")}
        >
          拆解 {task.steps.length} 步
        </span>
      ) : null}
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
