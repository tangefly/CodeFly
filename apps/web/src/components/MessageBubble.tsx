import { useEffect, useState } from "react";
import { Brain, Check, ChevronDown, Copy, Info, Sparkles } from "lucide-react";
import type { ChatMessage } from "../lib/store.js";
import { formatTokens } from "../lib/token-stats.js";
import { cn } from "../lib/utils.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import { ToolCard } from "./ToolCard.js";
import { Button } from "./ui.js";

function UserMessage({ id, text }: { id: string; text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div className="group flex justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label={copied ? "已复制消息" : "复制消息"}
        title={copied ? "已复制" : "复制消息"}
        onClick={copy}
        className="mt-1 h-7 w-7 shrink-0 text-muted-foreground/70 opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-primary" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      <div
        data-user-message-id={id}
        className="max-w-[86%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/20 bg-primary/10 px-4 py-2.5 text-[14px] leading-6 text-foreground"
      >
        {text}
      </div>
    </div>
  );
}

function ReasoningBlock({
  text,
  streaming,
  tokens,
}: {
  text: string;
  streaming: boolean;
  tokens?: number;
}) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/30"
      >
        <Brain
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            streaming && "animate-pulse text-primary",
          )}
        />
        <span className="font-medium">
          {streaming ? "正在思考…" : "思考过程"}
        </span>
        {tokens !== undefined && tokens > 0 ? (
          <span className="font-mono text-[9px] text-muted-foreground/50">
            {formatTokens(tokens)} tok
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 py-2">
          {text.trim() !== "" ? (
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-muted-foreground/85">
              {text}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground/60">
              等待模型输出…
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.kind === "tool") {
    return <ToolCard message={message} />;
  }

  if (message.kind === "system") {
    return (
      <div className="flex justify-center py-0.5">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/25 px-3 py-1 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" />
          {message.text}
        </div>
      </div>
    );
  }

  if (message.kind === "user") {
    return <UserMessage id={message.id} text={message.text} />;
  }

  const hasReasoning = Boolean(message.reasoning?.trim());

  // A tool-call-only assistant step has no prose; the tool cards below carry
  // the useful content. Keep it visible when it has reasoning worth showing.
  if (
    !message.text &&
    !message.streaming &&
    message.toolCalls?.length &&
    !hasReasoning
  ) {
    return null;
  }

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        {hasReasoning ? (
          <ReasoningBlock
            text={message.reasoning ?? ""}
            streaming={message.streaming}
            tokens={message.usage?.reasoningTokens}
          />
        ) : null}
        {message.text ? (
          <MarkdownRenderer text={message.text} streaming={message.streaming} />
        ) : message.streaming ? (
          <div className="flex items-center gap-1.5 pt-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary/80" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary/60 [animation-delay:120ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary/40 [animation-delay:240ms]" />
          </div>
        ) : hasReasoning ? null : (
          <p className="pt-0.5 text-xs text-muted-foreground/60">
            {message.error ? "未收到回复" : message.cancelled ? "生成已停止" : "（空响应）"}
          </p>
        )}
        {message.streaming && message.text ? (
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
            <span className="inline-block h-3 w-0.5 animate-pulse bg-primary/80" />
            正在写入…
          </div>
        ) : null}
        {message.error ? (
          <div className="mt-2 rounded-lg border border-danger/25 bg-danger/5 px-2.5 py-1.5 text-[11px] leading-5 text-danger/90">
            ⚠️ {message.error}
          </div>
        ) : null}
        {message.cancelled && !message.streaming && message.text ? (
          <div className="mt-1.5 text-[10px] text-muted-foreground/60">
            生成已停止
          </div>
        ) : null}
      </div>
    </div>
  );
}
