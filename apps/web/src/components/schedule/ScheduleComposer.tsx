import { useEffect, useRef, useState } from "react";
import { CalendarDays, Send, Sparkles, Square } from "lucide-react";
import {
  selectCurrentMessages,
  selectCurrentScheduleSession,
  useAppStore,
  type ChatMessage,
} from "../../lib/store.js";
import { UsageBar } from "../UsageBar.js";
import { Button, Kbd } from "../ui.js";

const EMPTY: ChatMessage[] = [];

export function ScheduleComposer() {
  const session = useAppStore(selectCurrentScheduleSession);
  const messages = useAppStore(selectCurrentMessages) ?? EMPTY;
  const overview = useAppStore((state) => state.scheduleOverview);
  const sendSchedule = useAppStore((state) => state.sendSchedule);
  const cancelSchedule = useAppStore((state) => state.cancelSchedule);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const llmSettings = useAppStore((state) => state.llmSettings);
  const scheduleBusy = useAppStore((state) => state.scheduleBusy);

  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ready = Boolean(llmSettings?.configured);
  const streaming = session ? Boolean(scheduleBusy[session.id]) : false;
  const needsPreferences = overview !== null && !overview.preferencesConfigured;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  const submit = (): void => {
    const value = text.trim();
    if (!value || !session) return;
    if (!ready) {
      openLlmSettings();
      return;
    }
    if (streaming) return;

    void sendSchedule(value);
    setText("");
    const element = textareaRef.current;
    if (element) element.style.height = "auto";
  };

  return (
    <div className="relative z-10 shrink-0 border-t border-border bg-gradient-to-t from-background via-background to-background/95 px-3 pb-3 pt-2.5 sm:px-6">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-card/60 px-2 py-1 text-[10px] font-medium text-primary">
            <CalendarDays className="h-3 w-3" />
            日程助手
          </span>
          <span className="hidden text-[10px] text-muted-foreground/60 sm:inline">
            {ready
              ? "排期偏好 · 任务排期 · 动态重排 · PNG / 邮件"
              : "日程助手需要先配置模型 API"}
          </span>
        </div>

        {!ready ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span>日程助手需要先配置 OpenAI-compatible 模型 API。</span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-7"
              onClick={openLlmSettings}
            >
              配置模型 API
            </Button>
          </div>
        ) : needsPreferences ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-[11px] text-primary">
            <CalendarDays className="h-3.5 w-3.5 shrink-0" />
            <span>
              首次使用：直接告诉助手你的工作日、上下班时间和休息时间，它会保存为结构化偏好。
            </span>
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="rounded-2xl border border-border bg-card/70 shadow-[0_12px_40px_-24px_rgba(0,0,0,0.9)] transition-colors focus-within:border-primary/35"
        >
          <div className="flex items-start gap-2 px-3 pt-2.5">
            <span className="mt-1.5 select-none font-mono text-xs text-primary/70">
              ›
            </span>
            <textarea
              ref={textareaRef}
              value={text}
              rows={1}
              disabled={!session || !ready}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  submit();
                }
              }}
              spellCheck={false}
              className="max-h-[200px] min-h-[44px] w-full resize-none bg-transparent py-1 font-mono text-[13px] leading-6 text-foreground placeholder:font-sans placeholder:text-muted-foreground/45 focus:outline-none disabled:cursor-not-allowed"
              placeholder={
                session
                  ? "例如：把我的课程表和每周例会排成未来 7 天日程；或：这周要写完论文初稿，帮我排一下；或：今天的任务没做完，往后挪。"
                  : "请先选择或新建一个日程会话"
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5 pt-1">
            <span className="hidden items-center gap-1 text-[10px] text-muted-foreground/50 md:inline-flex">
              <Kbd>Enter</Kbd>
              发送
              <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>
              换行
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              {streaming ? (
                <Button variant="outline" size="sm" onClick={cancelSchedule}>
                  <Square className="h-3 w-3" />
                  停止
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!session || !text.trim() || !ready || streaming}
              >
                <Send className="h-3.5 w-3.5" />
                发送
              </Button>
            </div>
          </div>
        </form>

        <UsageBar messages={messages} />
      </div>
    </div>
  );
}
