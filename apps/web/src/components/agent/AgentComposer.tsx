import { useEffect, useRef, useState } from "react";
import { Bot, Send, Settings2, Sparkles, Square } from "lucide-react";
import { DEFAULT_AGENT_MAX_STEPS } from "@codefly/protocol";
import {
  selectCurrentAgentSession,
  selectCurrentMessages,
  useAppStore,
  type ChatMessage,
} from "../../lib/store.js";
import { PermissionPicker } from "../PermissionPicker.js";
import { UsageBar } from "../UsageBar.js";
import { Button, Kbd } from "../ui.js";

const EMPTY: ChatMessage[] = [];

export function AgentComposer() {
  const session = useAppStore(selectCurrentAgentSession);
  const messages = useAppStore(selectCurrentMessages) ?? EMPTY;
  const sendAgent = useAppStore((state) => state.sendAgent);
  const cancelAgent = useAppStore((state) => state.cancelAgent);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const openAgentSettings = useAppStore((state) => state.openAgentSettings);
  const llmSettings = useAppStore((state) => state.llmSettings);
  const agentSettings = useAppStore((state) => state.agentSettings);
  const agentBusy = useAppStore((state) => state.agentBusy);

  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ready = Boolean(llmSettings?.configured);
  const streaming = session ? Boolean(agentBusy[session.id]) : false;

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

    void sendAgent(value);
    setText("");
    const element = textareaRef.current;
    if (element) element.style.height = "auto";
  };

  return (
    <div className="relative z-10 shrink-0 border-t border-border bg-gradient-to-t from-background via-background to-background/95 px-3 pb-3 pt-2.5 sm:px-6">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-card/60 px-2 py-1 text-[10px] font-medium text-primary">
            <Bot className="h-3 w-3" />
            Code
          </span>
          <span className="hidden text-[10px] text-muted-foreground/60 sm:inline">
            {ready
              ? `最多 ${agentSettings?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS} 步 · 工具在沙箱内执行`
              : "Code 需要先配置模型 API"}
          </span>
        </div>

        {!ready ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span>Code 模式需要先配置 OpenAI-compatible 模型 API。</span>
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
                  ? "请先创建或选择一个 Code 会话"
                  : !ready
                    ? "请先配置模型 API"
                    : streaming
                      ? "Code 正在执行…"
                      : "描述一个任务，Enter 启动 Code…"
              }
              spellCheck={false}
              className="max-h-[200px] min-h-[44px] w-full resize-none bg-transparent py-1 font-mono text-[13px] leading-6 text-foreground placeholder:font-sans placeholder:text-muted-foreground/45 focus:outline-none disabled:cursor-not-allowed"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5 pt-1">
            <PermissionPicker disabled={!session} placement="up" align="start" />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Code 设置"
              title="Code 设置"
              onClick={openAgentSettings}
              className="h-8 w-8"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
            <span className="hidden items-center gap-1 text-[10px] text-muted-foreground/50 md:inline-flex">
              <Kbd>Enter</Kbd>
              开始
              <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>
              换行
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              {streaming ? (
                <Button variant="outline" size="sm" onClick={cancelAgent}>
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
                开始
              </Button>
            </div>
          </div>
        </form>

        <UsageBar messages={messages} />
      </div>
    </div>
  );
}
