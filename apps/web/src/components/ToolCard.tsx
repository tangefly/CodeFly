import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Globe,
  Image as ImageIcon,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  Search,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import type { ToolMessage } from "../lib/store.js";
import { PAPER_TOOL_LABEL, isPaperTool } from "../lib/tool-labels.js";
import { cn, formatDuration } from "../lib/utils.js";
import { PaperToolCard } from "./paper/PaperToolCard.js";
import { Button } from "./ui.js";

export const TOOL_LABEL: Record<string, string> = {
  ...PAPER_TOOL_LABEL,
  run_command: "运行命令",
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  apply_patch: "应用补丁",
  list_files: "列出目录",
  grep: "搜索内容",
  glob: "查找文件",
  web_search: "联网搜索",
  web_fetch: "抓取网页",
  read_image: "查看图片",
  job_output: "作业输出",
  job_list: "作业列表",
  job_kill: "停止作业",
  write_stdin: "写入输入",
  todo_write: "任务清单",
  ask_user_question: "询问用户",
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
  if (isPaperTool(message.toolName)) {
    return <PaperToolCard message={message} />;
  }
  return <StandardToolCard message={message} />;
}

function StandardToolCard({ message }: { message: ToolMessage }) {
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
  const diff = typeof meta.diff === "string" && meta.diff !== "" ? meta.diff : undefined;
  const todos = Array.isArray(meta.todos)
    ? (meta.todos as Array<{ content: string; status: string }>)
    : undefined;
  const jobId = typeof meta.jobId === "string" ? meta.jobId : undefined;
  const jobRunning = meta.running === true;
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
  const searchQuery =
    message.toolName === "web_search"
      ? typeof args.query === "string"
        ? args.query
        : typeof meta.query === "string"
          ? meta.query
          : undefined
      : undefined;
  const fetchUrl =
    message.toolName === "web_fetch"
      ? typeof args.url === "string"
        ? args.url
        : typeof meta.url === "string"
          ? meta.url
          : undefined
      : undefined;
  const imageDataUrl =
    message.toolName === "read_image" && typeof meta.imageDataUrl === "string"
      ? meta.imageDataUrl
      : undefined;

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
    message.toolName === "run_command" ||
    message.toolName === "job_output" ||
    message.toolName === "job_list" ||
    message.toolName === "job_kill" ||
    message.toolName === "write_stdin"
      ? SquareTerminal
      : message.toolName === "todo_write"
        ? ListTodo
        : message.toolName === "ask_user_question"
          ? MessageCircleQuestion
          : message.toolName === "web_search" || message.toolName === "web_fetch"
            ? Globe
            : message.toolName === "read_image"
              ? ImageIcon
              : message.toolName === "grep"
                ? Search
                : message.toolName === "list_files" ||
                    message.toolName === "glob"
                  ? Folder
                  : message.toolName === "read_file" ||
                      message.toolName === "write_file" ||
                      message.toolName === "edit_file" ||
                      message.toolName === "apply_patch"
                    ? FileText
                    : AlertTriangle;

  const showFileContent =
    message.toolName === "read_file" ||
    message.toolName === "list_files" ||
    message.toolName === "write_file" ||
    message.toolName === "edit_file" ||
    message.toolName === "apply_patch" ||
    message.toolName === "grep" ||
    message.toolName === "glob" ||
    message.toolName === "web_search" ||
    message.toolName === "web_fetch";

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
          ) : fetchUrl ? (
            <a
              href={fetchUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 block truncate font-mono text-[11px] text-foreground/75 hover:text-primary"
              title={fetchUrl}
            >
              {fetchUrl}
              {typeof meta.statusCode === "number" ? (
                <span className="text-muted-foreground/60">
                  {" "}
                  · HTTP {meta.statusCode}
                </span>
              ) : null}
            </a>
          ) : searchQuery ? (
            <code
              className="mt-0.5 block truncate font-mono text-[11px] text-foreground/75"
              title={searchQuery}
            >
              <span className="text-primary/60">“</span>
              {searchQuery}
              <span className="text-primary/60">”</span>
              {typeof meta.resultCount === "number" ? (
                <span className="text-muted-foreground/60">
                  {" "}
                  · {meta.resultCount} 条结果
                </span>
              ) : null}
            </code>
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

      {todos ? <TodoChecklist todos={todos} /> : null}

      {diff ? <DiffView diff={diff} /> : null}

      {jobId ? (
        <div className="flex items-center gap-2 border-t border-border/60 bg-[#080a0f] px-3.5 py-2 font-mono text-[10px] text-muted-foreground/80">
          <SquareTerminal className="h-3 w-3 text-sky-300/80" />
          <span>job {jobId}</span>
          <span
            className={cn(
              "rounded-full border px-1.5 py-px text-[9px]",
              jobRunning
                ? "border-sky-400/30 bg-sky-400/10 text-sky-300"
                : "border-border bg-muted/40 text-muted-foreground",
            )}
          >
            {jobRunning ? "运行中" : "已结束"}
          </span>
          {typeof meta.exitCode === "number" ? (
            <span>exit {meta.exitCode}</span>
          ) : null}
        </div>
      ) : null}

      {message.toolName === "ask_user_question" && message.status === "running" ? (
        <div className="flex items-center gap-2 border-t border-border/60 bg-[#080a0f] px-4 py-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin text-primary/80" />
          等待用户回答…
        </div>
      ) : null}

      {imageDataUrl ? (
        <div className="border-t border-border/60 bg-[#080a0f] p-3">
          <img
            src={imageDataUrl}
            alt={targetPath ?? "image"}
            className="max-h-72 w-auto max-w-full rounded-md border border-border/60 object-contain"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-muted-foreground/60">
            {typeof meta.width === "number" && typeof meta.height === "number" ? (
              <span>
                {meta.width}×{meta.height}
              </span>
            ) : null}
            {typeof meta.mime === "string" ? <span>{meta.mime}</span> : null}
            {typeof meta.bytes === "number" ? (
              <span>{Math.round(meta.bytes / 1024)} KB</span>
            ) : null}
          </div>
        </div>
      ) : null}

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

function TodoChecklist({
  todos,
}: {
  todos: Array<{ content: string; status: string }>;
}) {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return (
    <div className="border-t border-border/60 bg-muted/10 px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/60">
        <ListTodo className="h-3 w-3" />
        todo · {completed}/{todos.length}
      </div>
      <ul className="space-y-1">
        {todos.map((todo, index) => (
          <li
            key={`${index}-${todo.content}`}
            className={cn(
              "flex items-start gap-2 text-[11px] leading-5",
              todo.status === "completed" && "text-muted-foreground/60",
            )}
          >
            <span
              className={cn(
                "mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[8px]",
                todo.status === "completed"
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : todo.status === "in_progress"
                    ? "border-sky-400/50 bg-sky-400/10 text-sky-300"
                    : "border-border text-transparent",
              )}
            >
              {todo.status === "completed" ? (
                <Check className="h-2.5 w-2.5" />
              ) : todo.status === "in_progress" ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                "·"
              )}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1",
                todo.status === "completed" && "line-through",
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <div className="max-h-72 overflow-auto border-t border-border/60 bg-[#080a0f] px-3 py-2 font-mono text-[11px] leading-5">
      {lines.map((line, index) => {
        const className =
          line.startsWith("+++") || line.startsWith("---")
            ? "text-muted-foreground/60"
            : line.startsWith("@@")
              ? "text-sky-300/90"
              : line.startsWith("+")
                ? "text-primary/90"
                : line.startsWith("-")
                  ? "text-danger/90"
                  : "text-foreground/70";
        return (
          <div key={index} className={cn("whitespace-pre-wrap break-words", className)}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}
