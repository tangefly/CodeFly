import {
  Activity,
  CalendarDays,
  Mail,
  Menu,
  Settings,
} from "lucide-react";
import {
  selectCurrentScheduleSession,
  useAppStore,
} from "../../lib/store.js";
import { Button } from "../ui.js";

export function ScheduleTopBar() {
  const session = useAppStore(selectCurrentScheduleSession);
  const overview = useAppStore((state) => state.scheduleOverview);
  const emailSettings = useAppStore((state) => state.scheduleEmailSettings);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const openSettings = useAppStore((state) => state.openSettings);
  const openAudit = useAppStore((state) => state.openAudit);
  const openSchedulePanel = useAppStore((state) => state.openSchedulePanel);
  const openEmailSettings = useAppStore(
    (state) => state.openScheduleEmailSettings,
  );

  const activeTasks =
    overview?.tasks.filter(
      (task) =>
        (task.status === "todo" || task.status === "in_progress") &&
        task.remainingMinutes > 0,
    ).length ?? 0;

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        aria-label="打开日程会话列表"
        onClick={toggleSidebar}
        className="lg:hidden"
      >
        <Menu className="h-4 w-4" />
      </Button>

      <div className="min-w-0 flex-1">
        {session ? (
          <>
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{session.title}</h1>
              <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-px text-[9px] text-primary">
                日程助手
              </span>
            </div>
            {overview ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground/70">
                <span className="font-mono">
                  {overview.rangeStart} ~ {overview.rangeEnd}
                </span>
                <span>·</span>
                <span>{activeTasks} 项待办</span>
                <span>·</span>
                <span>
                  {overview.window
                    ? `${overview.window.blocks.length} 个时段`
                    : "尚未生成计划"}
                </span>
                <span>·</span>
                <span
                  className={
                    overview.preferencesConfigured
                      ? "text-primary/80"
                      : "text-warning/90"
                  }
                >
                  偏好{overview.preferencesConfigured ? "已配置" : "待配置"}
                </span>
              </div>
            ) : (
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                排期偏好 · 7 天日程 · 动态重排 · PNG / 邮件
              </p>
            )}
          </>
        ) : (
          <div>
            <h1 className="text-sm font-semibold">日程助手</h1>
            <p className="text-[10px] text-muted-foreground/70">
              选择或新建一个日程会话
            </p>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={openSchedulePanel}
          className="h-8"
        >
          <CalendarDays className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">日程面板</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="邮件设置"
          title={
            emailSettings?.configured
              ? `邮件已配置：${emailSettings.to}`
              : "配置邮件"
          }
          onClick={openEmailSettings}
        >
          <Mail
            className={
              emailSettings?.configured
                ? "h-4 w-4 text-primary"
                : "h-4 w-4"
            }
          />
        </Button>
        <div className="mx-1 hidden h-5 w-px bg-border sm:block" />
        <Button
          variant="ghost"
          size="icon"
          aria-label="审计日志"
          title="审计日志"
          disabled={!session}
          onClick={openAudit}
        >
          <Activity className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="设置"
          title="设置"
          onClick={openSettings}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
