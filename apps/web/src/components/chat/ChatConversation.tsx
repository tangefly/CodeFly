import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Loader2, MessageSquare, Plus, Sparkles } from "lucide-react";
import {
  selectCurrentChatSession,
  selectCurrentMessages,
  useAppStore,
  type ChatMessage,
  type UserMessage,
} from "../../lib/store.js";
import { cn } from "../../lib/utils.js";
import { MessageBubble } from "../MessageBubble.js";
import { Button } from "../ui.js";

const EMPTY: ChatMessage[] = [];
/** Distance from the bottom under which scrolling down re-attaches. */
const STICK_THRESHOLD_PX = 48;
const TOUCH_DETACH_PX = 6;

export function ChatConversation() {
  const session = useAppStore(selectCurrentChatSession);
  const messages = useAppStore(selectCurrentMessages) ?? EMPTY;
  const createChatSession = useAppStore((state) => state.createChatSession);
  const chatCreating = useAppStore((state) => state.chatCreating);
  const sendChat = useAppStore((state) => state.sendChat);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const llmSettings = useAppStore((state) => state.llmSettings);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const scrollFrame = useRef<number | null>(null);
  const activeFrame = useRef<number | null>(null);
  const lastScrollTop = useRef(0);
  const touchStartY = useRef<number | null>(null);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);

  const ready = Boolean(llmSettings?.configured);

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
    if (scrollFrame.current === null) {
      scrollFrame.current = window.requestAnimationFrame(() => {
        scrollFrame.current = null;
        const element = scrollRef.current;
        if (!element || !stickToBottom.current) return;
        if (element.scrollTop < lastScrollTop.current) {
          stickToBottom.current = false;
          return;
        }
        element.scrollTop = element.scrollHeight;
        lastScrollTop.current = element.scrollTop;
      });
    }
  }, [messages]);

  const detachFromBottom = (): void => {
    const element = scrollRef.current;
    if (element && element.scrollHeight > element.clientHeight + 1) {
      stickToBottom.current = false;
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
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

  const startChat = (message: string): void => {
    if (!ready) {
      openLlmSettings();
      return;
    }
    void sendChat(message);
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
              <MessageSquare className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">开始一段对话</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                对话不绑定工作区，也不会执行命令或读写文件。
              </p>
            </div>
            <Button
              variant="primary"
              disabled={chatCreating}
              onClick={() => void createChatSession()}
            >
              {chatCreating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {chatCreating ? "创建中…" : "新建对话"}
            </Button>
          </div>
        ) : messages.length === 0 ? (
          <div className="mx-auto flex max-w-2xl flex-col items-center justify-center gap-6 py-14 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary shadow-[0_0_40px_-12px_var(--primary)]">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold">有什么想聊的？</h2>
              <p className="mx-auto max-w-md text-sm leading-6 text-muted-foreground">
                {ready
                  ? `当前模型：${llmSettings?.model ?? "未配置"}。消息只会在本机与模型服务之间传输。`
                  : "还没有配置模型 API，配置后即可开始对话。"}
              </p>
            </div>

            {!ready ? (
              <Button variant="primary" onClick={openLlmSettings}>
                配置模型 API
              </Button>
            ) : null}

            <div className="grid w-full gap-2 sm:grid-cols-3">
              <SuggestionCard
                icon={<MessageSquare className="h-4 w-4" />}
                title="认识一下"
                hint="介绍一下你自己"
                onClick={() => startChat("你好，请简单介绍一下你自己。")}
              />
              <SuggestionCard
                icon={<Sparkles className="h-4 w-4" />}
                title="解释概念"
                hint="什么是事件循环"
                onClick={() =>
                  startChat("用简单的语言解释一下什么是事件循环。")
                }
              />
              <SuggestionCard
                icon={<Sparkles className="h-4 w-4" />}
                title="获取建议"
                hint="如何提高代码质量"
                onClick={() =>
                  startChat("给我三个提高代码质量的建议，并举例说明。")
                }
              />
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-5 pb-2">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
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
      <span className="mt-2 block truncate text-[10px] text-muted-foreground/80">
        {hint}
      </span>
    </button>
  );
}
