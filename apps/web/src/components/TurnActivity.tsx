import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Loader2,
  Wrench,
} from "lucide-react";
import type {
  AssistantMessage,
  ChatMessage,
  ToolMessage,
} from "../lib/store.js";
import { cn, formatDuration } from "../lib/utils.js";
import { MessageBubble } from "./MessageBubble.js";
import { TOOL_LABEL } from "./ToolCard.js";

function toolSummary(tools: ToolMessage[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => {
      const label = TOOL_LABEL[name] ?? name;
      return count > 1 ? `${label} ×${count}` : label;
    })
    .join(" · ");
}

function statusMeta(
  live: boolean,
  failed: boolean,
  cancelled: boolean,
): { label: string; className: string } {
  if (live) {
    return {
      label: "执行中",
      className: "border-sky-400/30 bg-sky-400/10 text-sky-300",
    };
  }
  if (failed) {
    return {
      label: "有失败",
      className: "border-danger/35 bg-danger/10 text-danger",
    };
  }
  if (cancelled) {
    return {
      label: "已取消",
      className: "border-border bg-muted/40 text-muted-foreground",
    };
  }
  return {
    label: "完成",
    className: "border-primary/30 bg-primary/10 text-primary",
  };
}

/**
 * Folds one turn's intermediate work — tool-call steps, results, and the
 * reasoning between them — behind a single collapsible header, leaving the
 * model's final answer visible below it.
 *
 * The panel opens itself while the turn is running and folds back up once the
 * final answer finishes streaming, unless the user toggled it manually.
 */
export function TurnActivity({
  messages,
  final,
  busy,
}: {
  messages: ChatMessage[];
  final?: AssistantMessage;
  busy: boolean;
}) {
  const tools = useMemo(
    () =>
      messages.filter(
        (message): message is ToolMessage => message.kind === "tool",
      ),
    [messages],
  );
  const summary = useMemo(() => toolSummary(tools), [tools]);

  const live = messages.some(
    (message) =>
      (message.kind === "assistant" && message.streaming) ||
      (message.kind === "tool" && message.status === "running"),
  );
  const failed = messages.some(
    (message) =>
      (message.kind === "tool" && message.status === "error") ||
      (message.kind === "assistant" && Boolean(message.error)),
  );
  const cancelled = messages.some(
    (message) =>
      (message.kind === "tool" && message.status === "cancelled") ||
      (message.kind === "assistant" && message.cancelled),
  );
  const durationMs = tools.reduce(
    (total, tool) =>
      total +
      (typeof tool.meta?.durationMs === "number" ? tool.meta.durationMs : 0),
    0,
  );

  // A turn is settled once its final answer finished streaming. While the run
  // is still active but between steps (no final message yet), it stays open so
  // the panel does not flicker shut while the next tool call starts.
  const settled = !live && !final?.streaming && (!busy || final !== undefined);

  const [open, setOpen] = useState(!settled);
  const manual = useRef(false);

  useEffect(() => {
    if (!manual.current) setOpen(!settled);
  }, [settled]);

  const toggle = (): void => {
    manual.current = true;
    setOpen((value) => !value);
  };

  const status = statusMeta(live, failed, cancelled);

  return (
    <div className="cf-fade-up overflow-hidden rounded-xl border border-border/70 bg-card/40">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={open ? "收起工具调用" : "展开工具调用"}
        className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/20"
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-black/30 text-sky-300/90">
          <Wrench className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">工具调用</span>
            <span className="font-mono text-[9px] text-muted-foreground/60">
              {tools.length} 次
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {durationMs > 0 ? (
                <span className="font-mono text-[9px] text-muted-foreground/50">
                  {formatDuration(durationMs)}
                </span>
              ) : null}
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] font-medium",
                  status.className,
                )}
              >
                {live ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : failed || cancelled ? (
                  <AlertTriangle className="h-2.5 w-2.5" />
                ) : (
                  <Check className="h-2.5 w-2.5" />
                )}
                {status.label}
              </span>
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground/60 transition-transform",
                  open && "rotate-90",
                )}
              />
            </span>
          </span>
          {!open && summary !== "" ? (
            <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground/45">
              {summary}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-border/60 bg-[#080a0f] p-2.5">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
