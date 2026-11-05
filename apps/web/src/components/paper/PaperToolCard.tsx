import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Library,
  Loader2,
  Plus,
  Search,
  Star,
} from "lucide-react";
import type {
  ArxivPaper,
  PaperOutline,
  PaperRecord,
} from "@codefly/protocol";
import type { ToolMessage } from "../../lib/store.js";
import { useAppStore } from "../../lib/store.js";
import { PAPER_TOOL_LABEL } from "../../lib/tool-labels.js";
import { cn, formatDuration } from "../../lib/utils.js";
import { Button } from "../ui.js";

interface PaperToolData {
  results?: ArxivPaper[];
  paper?: ArxivPaper | PaperRecord;
  papers?: PaperRecord[];
  paperId?: string | null;
  action?: string;
  outline?: PaperOutline;
  hits?: Array<{ page: number; excerpt: string }>;
  startPage?: number;
  endPage?: number;
  section?: string | null;
  chars?: number;
  format?: string;
  total?: number;
}

const STATUS_LABEL: Record<string, string> = {
  unread: "未读",
  reading: "在读",
  read: "已读",
};

function isArxivPaper(value: unknown): value is ArxivPaper {
  return (
    typeof value === "object" &&
    value !== null &&
    "arxivId" in value &&
    typeof (value as ArxivPaper).arxivId === "string"
  );
}

function isPaperRecord(value: unknown): value is PaperRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as PaperRecord).id === "string" &&
    "status" in value
  );
}

function statusMeta(message: ToolMessage): {
  label: string;
  className: string;
} {
  if (message.status === "running") {
    return {
      label: "执行中",
      className: "border-sky-400/30 bg-sky-400/10 text-sky-300",
    };
  }
  if (message.status === "cancelled") {
    return {
      label: "已取消",
      className: "border-border bg-muted/40 text-muted-foreground",
    };
  }
  if (message.status === "error") {
    return {
      label: "失败",
      className: "border-danger/35 bg-danger/10 text-danger",
    };
  }
  return {
    label: "完成",
    className: "border-primary/30 bg-primary/10 text-primary",
  };
}

export function PaperToolCard({ message }: { message: ToolMessage }) {
  const meta = message.meta ?? {};
  const data = (meta.data ?? {}) as PaperToolData;
  const addPaperByArxiv = useAppStore((state) => state.addPaperByArxiv);
  const addPaperToContext = useAppStore((state) => state.addPaperToContext);
  const openPaperLibrary = useAppStore((state) => state.openPaperLibrary);
  const openPaperDetail = useAppStore((state) => state.openPaperDetail);
  const [busy, setBusy] = useState<string | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const label = PAPER_TOOL_LABEL[message.toolName] ?? message.toolName;
  const status = statusMeta(message);

  const addToLibrary = async (arxivId: string): Promise<void> => {
    setBusy(`add:${arxivId}`);
    await addPaperByArxiv(arxivId);
    setBusy(null);
  };

  const bringIntoContext = async (paperId: string): Promise<void> => {
    setBusy(`context:${paperId}`);
    await addPaperToContext(paperId);
    setBusy(null);
  };

  const addArxivToContext = async (arxivId: string): Promise<void> => {
    setBusy(`context-arxiv:${arxivId}`);
    const paper = await addPaperByArxiv(arxivId);
    if (paper !== null) await addPaperToContext(paper.id);
    setBusy(null);
  };

  const openLibraryPaper = (paperId: string): void => {
    openPaperLibrary();
    openPaperDetail(paperId);
  };

  const results = data.results ?? [];
  const paper = data.paper;
  const outline = data.outline;
  const hits = data.hits ?? [];

  return (
    <div className="cf-fade-up overflow-hidden rounded-xl border border-border bg-card/70">
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-black/30 text-primary/90">
          {message.toolName.startsWith("arxiv") ? (
            <Search className="h-3 w-3" />
          ) : message.toolName.startsWith("library") ? (
            <Library className="h-3 w-3" />
          ) : (
            <BookOpen className="h-3 w-3" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">{label}</span>
            <span className="font-mono text-[9px] text-muted-foreground/60">
              {message.toolName}
            </span>
            {typeof meta.resultCount === "number" ? (
              <span className="text-[9px] text-muted-foreground/60">
                · {meta.resultCount} 条
              </span>
            ) : null}
          </div>
          {meta.paperTitle ? (
            <p className="mt-0.5 truncate text-[11px] text-foreground/75">
              {meta.paperTitle}
            </p>
          ) : meta.query ? (
            <p className="mt-0.5 truncate font-mono text-[11px] text-foreground/70">
              “{meta.query}”
            </p>
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
          {message.progress ?? "论文工具执行中…"}
        </div>
      ) : null}

      {message.toolName === "arxiv_search" && results.length > 0 ? (
        <div className="space-y-2 border-t border-border/60 bg-[#080a0f] p-2.5">
          {results.map((result, index) => (
            <div
              key={`${result.arxivId}-${index}`}
              className="rounded-lg border border-border/60 bg-card/45 p-2.5"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 font-mono text-[10px] text-primary/70">
                  {index + 1}.
                </span>
                <a
                  href={result.absUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 text-xs font-medium leading-5 text-foreground hover:text-primary"
                >
                  {result.title}
                </a>
                <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                  {result.publishedAt.slice(0, 10)}
                </span>
              </div>
              <p className="mt-1 truncate text-[10px] text-muted-foreground/70">
                {result.authors.slice(0, 5).join(", ")}
                {result.authors.length > 5 ? " et al." : ""} ·{" "}
                <span className="font-mono">{result.arxivId}</span> ·{" "}
                {result.categories.join(", ")}
              </p>
              <p className="mt-1 line-clamp-3 text-[10px] leading-5 text-muted-foreground/80">
                {result.abstract}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy !== null}
                  onClick={() => void addToLibrary(result.arxivId)}
                >
                  {busy === `add:${result.arxivId}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  加入论文库
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy !== null}
                  onClick={() => void addArxivToContext(result.arxivId)}
                >
                  {busy === `context-arxiv:${result.arxivId}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <BookOpen className="h-3 w-3" />
                  )}
                  加入上下文
                </Button>
                <a
                  href={result.pdfUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-[10px] text-primary/80 hover:text-primary"
                >
                  PDF
                  <ArrowUpRight className="h-3 w-3" />
                </a>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {message.toolName === "arxiv_get" && isArxivPaper(paper) ? (
        <div className="border-t border-border/60 bg-[#080a0f] p-3">
          <div className="flex items-start gap-2">
            <a
              href={paper.absUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 text-xs font-medium leading-5 text-foreground hover:text-primary"
            >
              {paper.title}
            </a>
            <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
              {paper.arxivId}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            {paper.authors.join(", ")} · {paper.publishedAt.slice(0, 10)}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-[10px] leading-5 text-muted-foreground/80">
            {paper.abstract}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={busy !== null}
              onClick={() => void addToLibrary(paper.arxivId)}
            >
              <Plus className="h-3 w-3" />
              加入论文库
            </Button>
            {typeof data.paperId === "string" ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => openLibraryPaper(data.paperId as string)}
              >
                <Library className="h-3 w-3" />
                在论文库中查看
              </Button>
            ) : null}
            <a
              href={paper.pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-[10px] text-primary/80 hover:text-primary"
            >
              PDF
              <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
        </div>
      ) : null}

      {["paper_outline", "paper_read", "paper_search"].includes(
        message.toolName,
      ) ? (
        <div className="space-y-2 border-t border-border/60 bg-[#080a0f] p-3">
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/65">
            {meta.pageRange ? (
              <span className="rounded border border-border/60 px-1.5 py-0.5">
                第 {meta.pageRange} 页
              </span>
            ) : null}
            {typeof meta.charCount === "number" ? (
              <span>{Math.round(meta.charCount / 1000)}k 字符</span>
            ) : null}
            {typeof meta.libraryStatus === "string" ? (
              <span className="rounded-full border border-border px-1.5 py-px">
                {STATUS_LABEL[meta.libraryStatus] ?? meta.libraryStatus}
              </span>
            ) : null}
            {typeof meta.paperId === "string" ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-[10px]"
                onClick={() => openLibraryPaper(meta.paperId as string)}
              >
                <Library className="h-3 w-3" />
                论文库
              </Button>
            ) : null}
          </div>

          {outline !== undefined ? (
            <div className="space-y-1">
              {outline.sections.map((section, index) => (
                <div
                  key={`${section.title}-${index}`}
                  className="flex items-center gap-2 rounded border border-border/40 bg-card/30 px-2 py-1 text-[10px] text-muted-foreground/80"
                >
                  <span className="font-mono text-[9px] text-primary/60">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{section.title}</span>
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                    p{section.startPage}-{section.endPage}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {hits.length > 0 ? (
            <div className="space-y-1.5">
              {hits.map((hit, index) => (
                <div
                  key={`${hit.page}-${index}`}
                  className="rounded border border-border/40 bg-card/30 px-2 py-1.5 text-[10px] leading-5 text-muted-foreground/80"
                >
                  <span className="mr-1.5 rounded bg-muted/60 px-1 py-px font-mono text-[8px] text-muted-foreground/70">
                    p{hit.page}
                  </span>
                  {hit.excerpt}
                </div>
              ))}
            </div>
          ) : null}

          {message.content && message.status !== "running" ? (
            <div className="overflow-hidden rounded-lg border border-border/50">
              <button
                type="button"
                onClick={() => setOutputOpen((value) => !value)}
                className="flex w-full items-center gap-2 bg-card/30 px-2 py-1.5 text-left text-[10px] text-muted-foreground/70 hover:bg-muted/20"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 transition-transform",
                    outputOpen && "rotate-90",
                  )}
                />
                {message.toolName === "paper_read"
                  ? "阅读内容"
                  : message.toolName === "paper_search"
                    ? "检索结果"
                    : "目录详情"}
              </button>
              {outputOpen ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-[#05070b] px-2 py-1.5 font-mono text-[10px] leading-5 text-foreground/80">
                  {message.content}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {message.toolName.startsWith("library_") ? (
        <div className="space-y-2 border-t border-border/60 bg-[#080a0f] p-3">
          {isPaperRecord(paper) ? (
            <div className="rounded-lg border border-border/60 bg-card/40 p-2.5">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => openLibraryPaper(paper.id)}
                  className="min-w-0 flex-1 text-left text-xs font-medium leading-5 text-foreground hover:text-primary"
                >
                  {paper.title}
                </button>
                {paper.starred ? (
                  <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />
                ) : null}
                <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[9px] text-muted-foreground/70">
                  {STATUS_LABEL[paper.status] ?? paper.status}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                {paper.authors.slice(0, 4).join(", ")}
                {paper.authors.length > 4 ? " et al." : ""}
                {paper.arxivId ? ` · arXiv ${paper.arxivId}` : ""}
              </p>
              {paper.tags.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {paper.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-muted/50 px-1 py-px text-[8px] text-muted-foreground/70"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy !== null}
                  onClick={() => void bringIntoContext(paper.id)}
                >
                  {busy === `context:${paper.id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <BookOpen className="h-3 w-3" />
                  )}
                  加入上下文
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => openLibraryPaper(paper.id)}
                >
                  <Library className="h-3 w-3" />
                  在论文库中整理
                </Button>
              </div>
            </div>
          ) : null}

          {data.papers !== undefined && data.papers.length > 0 ? (
            <div className="space-y-1.5">
              {data.papers.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 rounded border border-border/40 bg-card/30 px-2 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => openLibraryPaper(entry.id)}
                    className="min-w-0 flex-1 truncate text-left text-[10px] text-foreground/80 hover:text-primary"
                    title={entry.title}
                  >
                    {entry.title}
                  </button>
                  <span className="shrink-0 text-[9px] text-muted-foreground/50">
                    {STATUS_LABEL[entry.status] ?? entry.status}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5"
                    onClick={() => void bringIntoContext(entry.id)}
                  >
                    <BookOpen className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {message.toolName === "library_export" && message.content ? (
            <div className="overflow-hidden rounded-lg border border-border/50">
              <button
                type="button"
                onClick={() => setOutputOpen((value) => !value)}
                className="flex w-full items-center gap-2 bg-card/30 px-2 py-1.5 text-left text-[10px] text-muted-foreground/70 hover:bg-muted/20"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 transition-transform",
                    outputOpen && "rotate-90",
                  )}
                />
                导出内容（{data.format === "bibtex" ? "BibTeX" : "Markdown"}）
              </button>
              {outputOpen ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-[#05070b] px-2 py-1.5 font-mono text-[10px] leading-5 text-foreground/80">
                  {message.content}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {message.status === "error" && message.content ? (
        <div className="border-t border-danger/20 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger/90">
          {message.content}
        </div>
      ) : null}

    </div>
  );
}
