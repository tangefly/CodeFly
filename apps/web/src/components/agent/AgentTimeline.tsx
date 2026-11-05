import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Plus, Sparkles, Terminal, Zap } from "lucide-react";
import {
  selectCurrentAgentSession,
  selectCurrentMessages,
  useAppStore,
  type AssistantMessage,
  type ChatMessage,
  type UserMessage,
} from "../../lib/store.js";
import { cn } from "../../lib/utils.js";
import { MessageBubble } from "../MessageBubble.js";
import { TurnActivity } from "../TurnActivity.js";
import { Button } from "../ui.js";

const EMPTY: ChatMessage[] = [];

type TimelineItem =
  | { kind: "message"; message: ChatMessage }
  | {
      kind: "turn";
      id: string;
      activity: ChatMessage[];
      answer?: AssistantMessage;
    };

/**
 * Splits the flat message list into turns. Everything the model did between
 * the user's question and its final answer (tool-call steps, tool results,
 * reasoning) becomes one foldable activity group; the final answer — the last
 * assistant message that requested no tools — stays visible.
 */
function buildTimeline(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;
    if (message.kind === "user" || message.kind === "system") {
      items.push({ kind: "message", message });
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [];
    while (
      index < messages.length &&
      messages[index]!.kind !== "user" &&
      messages[index]!.kind !== "system"
    ) {
      run.push(messages[index]!);
      index += 1;
    }

    let answerIndex = -1;
    for (let cursor = run.length - 1; cursor >= 0; cursor -= 1) {
      const candidate = run[cursor]!;
      if (candidate.kind === "assistant" && !candidate.toolCalls?.length) {
        answerIndex = cursor;
        break;
      }
    }
    const answer =
      answerIndex >= 0 && run[answerIndex]?.kind === "assistant"
        ? (run[answerIndex] as AssistantMessage)
        : undefined;
    const activity = run.filter((_, cursor) => cursor !== answerIndex);
    const hasTools = activity.some((entry) => entry.kind === "tool");

    if (!hasTools) {
      for (const entry of run) items.push({ kind: "message", message: entry });
      continue;
    }

    items.push({
      kind: "turn",
      id: activity[0]?.id ?? run[0]!.id,
      activity,
      answer,
    });
  }

  return items;
}

/** Distance from the bottom under which scrolling down re-attaches. */
const STICK_THRESHOLD_PX = 48;
const TOUCH_DETACH_PX = 6;

export function AgentTimeline() {
  const session = useAppStore(selectCurrentAgentSession);
  const messages = useAppStore(selectCurrentMessages) ?? EMPTY;
  const openNewSession = useAppStore((state) => state.openNewSession);
  const sendAgent = useAppStore((state) => state.sendAgent);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const setMode = useAppStore((state) => state.setMode);
  const llmSettings = useAppStore((state) => state.llmSettings);
  const agentBusy = useAppStore(
    (state) =>
      state.currentSessionId !== null &&
      state.agentBusy[state.currentSessionId] === true,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const activeFrame = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  /** Last known scrollTop, used to tell upward movement from stream growth. */
  const lastScrollTop = useRef(0);
  const touchStartY = useRef<number | null>(null);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);

  const questions = useMemo(
    () =>
      messages.filter(
        (message): message is UserMessage =>
          message.kind === "user" && message.text.trim() !== "",
      ),
    [messages],
  );
  const showQuestionNav = Boolean(session) && questions.length >= 2;
  /** Changes only when user messages are added, not on every stream delta. */
  const questionSignature = useMemo(
    () => questions.map((question) => question.id).join("|"),
    [questions],
  );
  const timeline = useMemo(() => buildTimeline(messages), [messages]);

  const updateActiveQuestion = (): void => {
    if (activeFrame.current !== null) return;
    activeFrame.current = window.requestAnimationFrame(() => {
      activeFrame.current = null;
      const element = scrollRef.current;
      if (!element) return;
      const nodes = element.querySelectorAll<HTMLElement>(
        "[data-user-message-id]",
      );
      if (nodes.length === 0) {
        setActiveQuestionId(null);
        return;
      }
      const threshold = element.getBoundingClientRect().top + 96;
      let current = nodes[0]?.dataset.userMessageId ?? null;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= threshold) {
          current = node.dataset.userMessageId ?? current;
        } else {
          break;
        }
      }
      setActiveQuestionId(current);
    });
  };

  useEffect(() => {
    return () => {
      if (activeFrame.current !== null) {
        window.cancelAnimationFrame(activeFrame.current);
      }
      if (scrollFrame.current !== null) {
        window.cancelAnimationFrame(scrollFrame.current);
      }
    };
  }, []);

  useEffect(() => {
    stickToBottom.current = true;
    setActiveQuestionId(null);
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      lastScrollTop.current = element.scrollTop;
    }
    updateActiveQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  useEffect(() => {
    updateActiveQuestion();
    // The active question depends on node positions, which only change when a
    // user message is added or the viewport scrolls. Streamed assistant text
    // must not force a layout read on every chunk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionSignature]);

  useEffect(() => {
    // Coalesce streamed deltas into one scroll per frame, and re-check the
    // user's intent at frame time so an upward scroll cannot be overridden.
    if (scrollFrame.current === null) {
      scrollFrame.current = window.requestAnimationFrame(() => {
        scrollFrame.current = null;
        const element = scrollRef.current;
        if (!element || !stickToBottom.current) return;
        if (element.scrollTop < lastScrollTop.current) {
          // The compositor can move the viewport before the wheel/scroll
          // handler runs. Treat that upward movement as user intent instead of
          // yanking the viewport back to the bottom.
          stickToBottom.current = false;
          return;
        }
        element.scrollTop = element.scrollHeight;
        lastScrollTop.current = element.scrollTop;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const detachFromBottom = (): void => {
    const element = scrollRef.current;
    if (element && element.scrollHeight > element.clientHeight + 1) {
      stickToBottom.current = false;
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    // Wheel-up is explicit user intent: detach before the next streamed delta
    // can snap the viewport back to the bottom.
    if (event.deltaY < 0) detachFromBottom();
  };

  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>): void => {
    touchStartY.current = event.touches[0]?.clientY ?? null;
  };

  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const y = event.touches[0]?.clientY;
    if (
      y !== undefined &&
      touchStartY.current !== null &&
      y > touchStartY.current + TOUCH_DETACH_PX
    ) {
      // Dragging the content down means the user is scrolling up.
      detachFromBottom();
    }
  };

  const onTouchEnd = (): void => {
    touchStartY.current = null;
  };

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (element.scrollTop < lastScrollTop.current) {
      // Upward movement always detaches, even by a sub-pixel amount close to
      // the bottom; otherwise one wheel notch would immediately re-stick.
      stickToBottom.current = false;
    } else {
      stickToBottom.current = distance <= STICK_THRESHOLD_PX;
    }
    lastScrollTop.current = element.scrollTop;
    updateActiveQuestion();
  };

  const jumpToQuestion = (id: string): void => {
    const element = scrollRef.current;
    if (!element) return;
    const target = Array.from(
      element.querySelectorAll<HTMLElement>("[data-user-message-id]"),
    ).find((node) => node.dataset.userMessageId === id);
    if (!target) return;
    stickToBottom.current = false;
    setActiveQuestionId(id);
    const top =
      target.getBoundingClientRect().top -
      element.getBoundingClientRect().top +
      element.scrollTop -
      24;
    element.scrollTo({ top, behavior: "smooth" });
    target.classList.add("cf-jump-highlight");
    window.setTimeout(() => {
      target.classList.remove("cf-jump-highlight");
    }, 800);
  };

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ overflowAnchor: "none" }}
        className={cn(
          "h-full overflow-y-auto overscroll-contain px-4 py-6 sm:px-6",
          showQuestionNav && "md:pr-14",
        )}
      >
      {!session ? (
        <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
            <Terminal className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">还没有 Agent 会话</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              创建会话并绑定一个本机工作区目录。Agent 工具都通过本机服务在沙箱内运行。
            </p>
          </div>
          <Button variant="primary" onClick={openNewSession}>
            <Plus className="h-4 w-4" />
            新建会话
          </Button>
        </div>
      ) : messages.length === 0 ? (
        <div className="mx-auto flex max-w-2xl flex-col items-center justify-center gap-6 py-14 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary shadow-[0_0_40px_-12px_var(--primary)]">
            <Zap className="h-6 w-6" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold">本地安全执行，从这里开始</h2>
            <p className="mx-auto max-w-md text-sm leading-6 text-muted-foreground">
              Agent 会在 Landlock 沙箱内运行命令与文件工具，写操作被限制在工作区与{" "}
              <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">/tmp</code>
              。默认权限为「工作区内修改」，越界命令需要一次性审批。
            </p>
          </div>
          <div className="grid w-full gap-2 sm:grid-cols-3">
            <SuggestionCard
              icon={<Terminal className="h-4 w-4" />}
              title="让 Agent 看看工作区"
              hint="列出内容并总结"
              onClick={() => {
                if (llmSettings?.configured) {
                  void sendAgent("请列出当前工作区的内容，并简要总结项目结构。");
                } else {
                  openLlmSettings();
                }
              }}
            />
            <SuggestionCard
              icon={<Zap className="h-4 w-4" />}
              title="运行 Node 检查"
              hint='node -e "console.log(2 ** 100)"'
              onClick={() => {
                if (llmSettings?.configured) {
                  void sendAgent(
                    '运行 node -e "console.log(2 ** 100)" 并告诉我结果。',
                  );
                } else {
                  openLlmSettings();
                }
              }}
            />
            <SuggestionCard
              icon={<Sparkles className="h-4 w-4" />}
              title="切换到对话模式"
              hint={
                llmSettings?.configured
                  ? `模型：${llmSettings.model}`
                  : "需要先配置模型 API"
              }
              onClick={() => setMode("chat")}
            />
          </div>
          <p className="max-w-md text-[11px] leading-5 text-muted-foreground/70">
            当前会话工作区：
            <span className="ml-1 break-all font-mono text-foreground/70">
              {session.workspaceRoot}
            </span>
          </p>
        </div>
      ) : (
        <div className="mx-auto flex max-w-5xl flex-col gap-5 pb-2">
          {timeline.map((item, index) =>
            item.kind === "message" ? (
              <MessageBubble key={item.message.id} message={item.message} />
            ) : (
              <div key={item.id} className="flex flex-col gap-3">
                <TurnActivity
                  messages={item.activity}
                  final={item.answer}
                  busy={agentBusy && index === timeline.length - 1}
                />
                {item.answer ? (
                  <MessageBubble message={item.answer} />
                ) : null}
              </div>
            ),
          )}
        </div>
      )}
      </div>

      {showQuestionNav ? (
        <nav
          aria-label="用户提问导航"
          className="absolute right-3 top-1/2 z-20 hidden max-h-[70%] -translate-y-1/2 flex-col items-end gap-1 overflow-y-auto overflow-x-hidden py-1 md:flex"
        >
          {questions.map((question, index) => {
            const preview = question.text.replace(/\s+/g, " ").trim();
            const active = question.id === activeQuestionId;
            return (
              <button
                key={question.id}
                type="button"
                title={preview}
                aria-label={`跳转到第 ${index + 1} 个问题：${preview.slice(0, 60)}`}
                aria-current={active ? "true" : undefined}
                onClick={() => jumpToQuestion(question.id)}
                className={cn(
                  "group/nav flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full border py-1 pl-1 pr-1.5 text-[10px] shadow-lg backdrop-blur transition-colors",
                  active
                    ? "border-primary/45 bg-primary/10 text-primary"
                    : "border-border/70 bg-card/90 text-muted-foreground hover:border-primary/35 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[9px] font-medium",
                    active ? "bg-primary/20 text-primary" : "bg-muted/70",
                  )}
                >
                  {index + 1}
                </span>
                <span className="max-w-0 overflow-hidden whitespace-nowrap text-left opacity-0 transition-all duration-200 group-hover/nav:max-w-[11rem] group-hover/nav:pr-1 group-hover/nav:opacity-100 group-focus-visible/nav:max-w-[11rem] group-focus-visible/nav:pr-1 group-focus-visible/nav:opacity-100">
                  {preview}
                </span>
              </button>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}

function SuggestionCard({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group rounded-xl border border-border bg-card/60 p-3 text-left transition-colors hover:border-primary/35 hover:bg-card"
    >
      <span className="flex items-center gap-2 text-xs font-medium text-foreground">
        <span className="text-primary/80">{icon}</span>
        {title}
      </span>
      <span className="mt-2 block truncate font-mono text-[10px] text-muted-foreground/80">
        {hint}
      </span>
    </button>
  );
}
