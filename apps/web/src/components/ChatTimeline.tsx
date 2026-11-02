import { useEffect, useRef, type ReactNode } from "react";
import { Plus, Sparkles, Terminal, Zap } from "lucide-react";
import {
  selectCurrentMessages,
  selectCurrentSession,
  useAppStore,
  type ChatMessage,
} from "../lib/store.js";
import { MessageBubble } from "./MessageBubble.js";
import { Button } from "./ui.js";

const EMPTY: ChatMessage[] = [];

export function ChatTimeline() {
  const session = useAppStore(selectCurrentSession);
  const messages = useAppStore(selectCurrentMessages) ?? EMPTY;
  const openNewSession = useAppStore((state) => state.openNewSession);
  const sendChat = useAppStore((state) => state.sendChat);
  const sendAgent = useAppStore((state) => state.sendAgent);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const llmSettings = useAppStore((state) => state.llmSettings);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    stickToBottom.current = true;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [session?.id]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto overscroll-contain px-4 py-6 sm:px-6"
    >
      {!session ? (
        <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
            <Terminal className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">还没有会话</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              创建会话并绑定一个本机工作区目录。聊天与 Agent 工具都通过本机服务运行。
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
              title="和模型聊天"
              hint={
                llmSettings?.configured
                  ? `模型：${llmSettings.model}`
                  : "需要先配置模型 API"
              }
              onClick={() => {
                if (llmSettings?.configured) {
                  void sendChat("你好，请简单介绍一下你自己。");
                } else {
                  openLlmSettings();
                }
              }}
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
        <div className="mx-auto flex max-w-3xl flex-col gap-5 pb-2">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
      )}
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
