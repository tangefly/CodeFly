import { useEffect, useRef, useState } from "react";
import { BookOpen, Library, Send, Sparkles, Square, X } from "lucide-react";
import {
  selectCurrentMessages,
  selectCurrentPaperSession,
  useAppStore,
  type ChatMessage,
} from "../../lib/store.js";
import { UsageBar } from "../UsageBar.js";
import { Button, Kbd } from "../ui.js";

const EMPTY: ChatMessage[] = [];

export function PaperComposer() {
  const session = useAppStore(selectCurrentPaperSession);
  const messages = useAppStore(selectCurrentMessages) ?? EMPTY;
  const sendPaper = useAppStore((state) => state.sendPaper);
  const cancelPaper = useAppStore((state) => state.cancelPaper);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const openPaperLibrary = useAppStore((state) => state.openPaperLibrary);
  const openPaperDetail = useAppStore((state) => state.openPaperDetail);
  const removePaperFromContext = useAppStore(
    (state) => state.removePaperFromContext,
  );
  const llmSettings = useAppStore((state) => state.llmSettings);
  const paperBusy = useAppStore((state) => state.paperBusy);
  const paperIndex = useAppStore((state) => state.paperIndex);

  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ready = Boolean(llmSettings?.configured);
  const streaming = session ? Boolean(paperBusy[session.id]) : false;
  const contextPapers = (session?.paperIds ?? [])
    .map((id) => paperIndex[id])
    .filter((paper) => paper !== undefined);

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

    void sendPaper(value);
    setText("");
    const element = textareaRef.current;
    if (element) element.style.height = "auto";
  };

  return (
    <div className="relative z-10 shrink-0 border-t border-border bg-gradient-to-t from-background via-background to-background/95 px-3 pb-3 pt-2.5 sm:px-6">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-card/60 px-2 py-1 text-[10px] font-medium text-primary">
            <BookOpen className="h-3 w-3" />
            论文助手
          </span>
          <span className="hidden text-[10px] text-muted-foreground/60 sm:inline">
            {ready
              ? "arXiv 检索 · PDF 分段阅读 · 笔记写入论文库"
              : "论文助手需要先配置模型 API"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7"
            onClick={openPaperLibrary}
          >
            <Library className="h-3.5 w-3.5" />
            论文库
          </Button>
        </div>

        {contextPapers.length > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground/50">上下文</span>
            {contextPapers.slice(0, 6).map((paper) => (
              <span
                key={paper.id}
                className="inline-flex max-w-[20rem] items-center gap-1 rounded-md border border-border/70 bg-card/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                <button
                  type="button"
                  onClick={() => {
                    openPaperLibrary();
                    openPaperDetail(paper.id);
                  }}
                  className="truncate hover:text-foreground"
                  title={paper.title}
                >
                  {paper.title}
                </button>
                <button
                  type="button"
                  aria-label="从当前上下文移除"
                  onClick={() => void removePaperFromContext(paper.id)}
                  className="text-muted-foreground/40 hover:text-danger"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
            {contextPapers.length > 6 ? (
              <span className="text-[10px] text-muted-foreground/50">
                +{contextPapers.length - 6}
              </span>
            ) : null}
          </div>
        ) : null}

        {!ready ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span>论文助手需要先配置 OpenAI-compatible 模型 API。</span>
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
                  ? "请先创建或选择一个论文会话"
                  : !ready
                    ? "请先配置模型 API"
                    : streaming
                      ? "论文助手正在工作…"
                      : "例如：找最近一周 cs.CL 的 RAG 论文并挑 3 篇总结"
              }
              spellCheck={false}
              className="max-h-[200px] min-h-[44px] w-full resize-none bg-transparent py-1 font-mono text-[13px] leading-6 text-foreground placeholder:font-sans placeholder:text-muted-foreground/45 focus:outline-none disabled:cursor-not-allowed"
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
                <Button variant="outline" size="sm" onClick={cancelPaper}>
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
