import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Loader2,
  Search,
  Terminal,
} from "lucide-react";
import type { ToolMessage } from "../lib/store.js";
import { cn, formatDuration } from "../lib/utils.js";
import { Button } from "./ui.js";

const TOOL_LABEL: Record<string, string> = {
  run_command: "运行命令",
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  list_files: "列出目录",
  grep: "搜索内容",
  glob: "查找文件",
};

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function statusMeta(message: ToolMessage): {
  label: string;
  className: string;
} {
  switch (message.status) {
    case "running":
      return {
        label: "执行中",
        className: "border-sky-400/30 bg-sky-400/10 text-sky-300",
      };
    case "cancelled":
      return {
        label: "已取消",
        className: "border-border bg-muted/40 text-muted-foreground",
      };
    case "error":
      return {
        label: "失败",
        className: "border-danger/35 bg-danger/10 text-danger",
      };
    default:
      return {
        label: "完成",
        className: "border-primary/30 bg-primary/10 text-primary",
      };
  }
}

export function ToolCard({ message }: { message: ToolMessage }) {
  const [copied, setCopied] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(message.status === "error");

  useEffect(() => {
    if (message.status === "error") setOutputOpen(true);
  }, [message.status]);
  const meta = message.meta ?? {};
  const args = parseArguments(message.arguments);
  const label = TOOL_LABEL[message.toolName] ?? message.toolName;
  const status = statusMeta(message);
  const command =
    typeof meta.command === "string"
      ? meta.command
      : typeof args.command === "string"
        ? args.command
        : undefined;
  const targetPath =
    typeof meta.path === "string"
      ? meta.path
      : typeof args.path === "string"
        ? args.path
        : undefined;
  const pattern =
    typeof args.pattern === "string" ? args.pattern : undefined;

  const copyText = (): void => {
    const text =
      message.toolName === "run_command"
        ? [meta.stdout, meta.stderr].filter(Boolean).join("\n") || message.content
        : message.content;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const Icon =
    message.toolName === "run_command"
      ? Terminal
      : message.toolName === "grep"
        ? Search
        : message.toolName === "list_files" ||
            message.toolName === "glob"
          ? Folder
          : message.toolName === "read_file" ||
              message.toolName === "write_file" ||
              message.toolName === "edit_file"
            ? FileText
            : AlertTriangle;

  const showFileContent =
    message.toolName === "read_file" ||
    message.toolName === "list_files" ||
    message.toolName === "write_file" ||
    message.toolName === "edit_file" ||
    message.toolName === "grep" ||
    message.toolName === "glob";

  /** Shared collapsible "result" section for file tools and unknown tools. */
  const renderCollapsibleResult = (label: string) => (
    <div className="border-t border-border/60 bg-[#080a0f]">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOutputOpen((value) => !value)}
          aria-expanded={outputOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={outputOpen ? "收起输出" : "展开输出"}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform",
              outputOpen && "rotate-90",
            )}
          />
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/60">
            {label}
          </span>
          {message.status === "error" ? (
            <span className="font-mono text-[9px] text-danger/80">失败</span>
          ) : null}
          {!outputOpen ? (
            <span className="truncate font-mono text-[9px] text-muted-foreground/45">
              点击展开
            </span>
          ) : null}
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="复制工具输出"
          title="复制工具输出"
          className="h-6 w-6 shrink-0 text-muted-foreground"
          onClick={copyText}
        >
          {copied ? (
            <Check className="h-3 w-3 text-primary" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      </div>
      {outputOpen ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-foreground/85">
          {message.content || "(empty)"}
        </pre>
      ) : null}
    </div>
  );

  return (
    <div className="cf-fade-up overflow-hidden rounded-xl border border-border bg-card/70">
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-black/30 text-sky-300/90">
          <Icon className="h-3 w-3" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">{label}</span>
            <span className="font-mono text-[9px] text-muted-foreground/60">
              {message.toolName}
            </span>
          </div>
          {command ? (
            <button
              type="button"
              onClick={() => setCommandOpen((value) => !value)}
              aria-expanded={commandOpen}
              title={commandOpen ? "收起完整命令" : "展开完整命令"}
              className="mt-0.5 flex w-full items-start gap-1.5 text-left"
            >
              <ChevronRight
                className={cn(
                  "mt-[3px] h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform",
                  commandOpen && "rotate-90",
                )}
              />
              <code
                className={cn(
                  "min-w-0 flex-1 font-mono text-[11px] text-foreground/75",
                  commandOpen
                    ? "max-h-60 overflow-auto whitespace-pre-wrap break-words"
                    : "truncate",
                )}
              >
                <span className="mr-1 text-primary/60">$</span>
                {command}
              </code>
            </button>
          ) : pattern ? (
            <code
              className="mt-0.5 block truncate font-mono text-[11px] text-foreground/75"
              title={targetPath}
            >
              {message.toolName === "grep" ? (
                <span className="text-primary/60">/</span>
              ) : null}
              {pattern}
              {message.toolName === "grep" ? (
                <span className="text-primary/60">/</span>
              ) : null}
              {targetPath ? (
                <span className="text-muted-foreground/60"> · {targetPath}</span>
              ) : null}
            </code>
          ) : targetPath ? (
            <code className="mt-0.5 block truncate font-mono text-[11px] text-foreground/75">
              {targetPath}
            </code>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {typeof meta.durationMs === "number" ? (
            <span className="text-[9px] text-muted-foreground/60">
              {formatDuration(meta.durationMs)}
            </span>
          ) : null}
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] font-medium",
              status.className,
            )}
          >
            {message.status === "running" ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : message.status === "complete" ? (
              <Check className="h-2.5 w-2.5" />
            ) : (
              <AlertTriangle className="h-2.5 w-2.5" />
            )}
            {status.label}
          </span>
        </div>
      </div>

      {message.status === "running" ? (
        <div className="flex items-center gap-2 border-t border-border/60 bg-[#080a0f] px-4 py-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin text-primary/80" />
          工具执行中…
        </div>
      ) : null}

      {message.toolName === "run_command" && message.status !== "running" ? (
        <div className="border-t border-border/60 bg-[#080a0f]">
          <div className="flex items-center gap-2 px-3 py-2">
            <button
              type="button"
              onClick={() => setOutputOpen((value) => !value)}
              aria-expanded={outputOpen}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={outputOpen ? "收起输出" : "展开输出"}
            >
              <ChevronRight
                className={cn(
                  "h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform",
                  outputOpen && "rotate-90",
                )}
              />
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/60">
                output
              </span>
              {typeof meta.exitCode === "number" ? (
                <span
                  className={cn(
                    "font-mono text-[9px]",
                    meta.exitCode === 0 ? "text-primary/80" : "text-danger/80",
                  )}
                >
                  exit {meta.exitCode}
                </span>
              ) : null}
              {!outputOpen ? (
                <span className="truncate font-mono text-[9px] text-muted-foreground/45">
                  点击展开
                </span>
              ) : null}
            </button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="复制工具输出"
              title="复制工具输出"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              onClick={copyText}
            >
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </div>
          {outputOpen ? (
            <>
              {typeof meta.stdout === "string" && meta.stdout !== "" ? (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-foreground/85">
                  {meta.stdout}
                </pre>
              ) : null}
              {typeof meta.stderr === "string" && meta.stderr !== "" ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-danger/15 px-3 py-2 font-mono text-[11px] leading-5 text-danger/90">
                  {meta.stderr}
                </pre>
              ) : null}
              {!meta.stdout && !meta.stderr ? (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-foreground/85">
                  {meta.exitCode === 0 && !meta.denied
                    ? "(no output)"
                    : message.content || "(no output)"}
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {showFileContent && message.status !== "running"
        ? renderCollapsibleResult("result")
        : null}

      {message.toolName !== "run_command" &&
      !showFileContent &&
      message.content &&
      message.status !== "running"
        ? renderCollapsibleResult("output")
        : null}
    </div>
  );
}
