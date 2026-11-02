import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  MessageSquare,
  Send,
  Settings2,
  Sparkles,
  Square,
} from "lucide-react";
import {
  selectCurrentMessages,
  selectCurrentSession,
  useAppStore,
} from "../lib/store.js";
import {
  computeSessionUsage,
  formatSpeed,
  formatTokens,
} from "../lib/token-stats.js";
import { cn } from "../lib/utils.js";
import { PermissionPicker } from "./PermissionPicker.js";
import { Button, Kbd } from "./ui.js";

type Tab = "chat" | "agent";

export function Composer() {
  const session = useAppStore(selectCurrentSession);
  const messages = useAppStore(selectCurrentMessages);
  const sendChat = useAppStore((state) => state.sendChat);
  const cancelChat = useAppStore((state) => state.cancelChat);
  const sendAgent = useAppStore((state) => state.sendAgent);
  const cancelAgent = useAppStore((state) => state.cancelAgent);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const openAgentSettings = useAppStore((state) => state.openAgentSettings);
  const llmSettings = useAppStore((state) => state.llmSettings);
  const agentSettings = useAppStore((state) => state.agentSettings);
  const chatBusy = useAppStore((state) => state.chatBusy);
  const agentBusy = useAppStore((state) => state.agentBusy);

  const [tab, setTab] = useState<Tab>("chat");
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ready = Boolean(llmSettings?.configured);
  const chatStreaming = session ? Boolean(chatBusy[session.id]) : false;
  const agentStreaming = session ? Boolean(agentBusy[session.id]) : false;
  const busy = chatStreaming || agentStreaming;
  const sessionUsage = useMemo(
    () => (messages ? computeSessionUsage(messages) : null),
    [messages],
  );

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text, tab]);

  const submit = (): void => {
    const value = text.trim();
    if (!value || !session) return;
    if (!ready) {
      openLlmSettings();
      return;
    }
    if (busy) return;

    if (tab === "chat") void sendChat(value);
    else void sendAgent(value);

    setText("");
    const element = textareaRef.current;
    if (element) element.style.height = "auto";
  };

  return (
    <div className="relative z-10 shrink-0 border-t border-border bg-gradient-to-t from-background via-background to-background/95 px-3 pb-3 pt-2.5 sm:px-6">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-2 flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card/60 p-0.5">
            <TabButton
              active={tab === "chat"}
              icon={<MessageSquare className="h-3 w-3" />}
              label="聊天"
              onClick={() => setTab("chat")}
            />
            <TabButton
              active={tab === "agent"}
              icon={<Bot className="h-3 w-3" />}
              label="Agent"
              onClick={() => setTab("agent")}
            />
          </div>
          <span className="hidden text-[10px] text-muted-foreground/60 sm:inline">
            {tab === "chat"
              ? ready
                ? `模型：${llmSettings?.model} · 仅聊天，不会执行命令`
                : "聊天需要先配置模型 API"
              : ready
                ? `Agent · 最多 ${agentSettings?.maxSteps ?? 10} 步 · 工具在沙箱内执行`
                : "Agent 需要先配置模型 API"}
          </span>
        </div>

        {!ready ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span>
              {tab === "agent" ? "Agent" : "聊天"}模式需要先配置
              OpenAI-compatible 模型 API。
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-7"
              onClick={openLlmSettings}
            >
              配置模型 API
            </Button>
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
              placeholder={
                !session
                  ? "请先创建或选择一个会话"
                  : !ready
                    ? "请先配置模型 API"
                    : tab === "agent"
                      ? agentStreaming
                        ? "Agent 正在执行…"
                        : "描述一个任务，Enter 启动 Agent…"
                      : chatStreaming
                        ? "模型正在回复…"
                        : "输入消息，Enter 发送…"
              }
              spellCheck={false}
              className="max-h-[200px] min-h-[44px] w-full resize-none bg-transparent py-1 font-mono text-[13px] leading-6 text-foreground placeholder:font-sans placeholder:text-muted-foreground/45 focus:outline-none disabled:cursor-not-allowed"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5 pt-1">
            {tab === "chat" ? (
              <span
                className={cn(
                  "inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-[10px]",
                  ready ? "text-muted-foreground" : "text-warning",
                )}
              >
                <Sparkles className="h-3 w-3 shrink-0 text-primary" />
                <span className="truncate">
                  {ready ? llmSettings?.model : "未配置模型"}
                </span>
              </span>
            ) : (
              <PermissionPicker disabled={!session} placement="up" align="start" />
            )}
            {tab === "agent" ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Agent 设置"
                title="Agent 设置"
                onClick={openAgentSettings}
                className="h-8 w-8"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <span className="hidden items-center gap-1 text-[10px] text-muted-foreground/50 md:inline-flex">
              <Kbd>Enter</Kbd>
              {tab === "agent" ? "开始" : "发送"}
              <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>
              换行
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              {agentStreaming ? (
                <Button variant="outline" size="sm" onClick={cancelAgent}>
                  <Square className="h-3 w-3" />
                  停止
                </Button>
              ) : chatStreaming ? (
                <Button variant="outline" size="sm" onClick={cancelChat}>
                  <Square className="h-3 w-3" />
                  停止
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!session || !text.trim() || !ready || busy}
              >
                {tab === "agent" ? (
                  <>
                    <Bot className="h-3.5 w-3.5" />
                    开始
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" />
                    发送
                  </>
                )}
              </Button>
            </div>
          </div>
        </form>

        {sessionUsage ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 font-mono text-[10px] text-muted-foreground/55">
            <span className="font-sans text-muted-foreground/45">
              本会话用量
            </span>
            {sessionUsage.promptTokens > 0 ? (
              <span title={`${sessionUsage.promptTokens} prompt tokens`}>
                输入 {formatTokens(sessionUsage.promptTokens)} tok
              </span>
            ) : null}
            {sessionUsage.completionTokens > 0 ? (
              <span title={`${sessionUsage.completionTokens} completion tokens`}>
                输出 {formatTokens(sessionUsage.completionTokens)} tok
              </span>
            ) : null}
            {sessionUsage.promptTokens === 0 &&
            sessionUsage.completionTokens === 0 &&
            sessionUsage.totalTokens > 0 ? (
              <span title={`${sessionUsage.totalTokens} total tokens`}>
                合计 {formatTokens(sessionUsage.totalTokens)} tok
              </span>
            ) : null}
            {sessionUsage.speed !== null ? (
              <span title="按已上报用量的生成阶段耗时加权计算">
                {formatSpeed(sessionUsage.speed)} tok/s
              </span>
            ) : null}
            {sessionUsage.cacheHitRate !== null ? (
              <span title={`${sessionUsage.cachedTokens} cached prompt tokens`}>
                缓存命中 {Math.round(sessionUsage.cacheHitRate * 100)}%
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[10px] font-medium transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
