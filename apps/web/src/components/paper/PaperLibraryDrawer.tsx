import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Download,
  FileText,
  Loader2,
  Plus,
  Search,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import type { PaperReadStatus, PaperRecord } from "@codefly/protocol";
import { api } from "../../lib/api.js";
import { useAppStore } from "../../lib/store.js";
import { cn } from "../../lib/utils.js";
import { Button, Modal } from "../ui.js";

const STATUS_LABEL: Record<PaperReadStatus, string> = {
  unread: "未读",
  reading: "在读",
  read: "已读",
};

const STATUS_STYLE: Record<PaperReadStatus, string> = {
  unread: "border-border bg-muted/40 text-muted-foreground",
  reading: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  read: "border-primary/30 bg-primary/10 text-primary",
};

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function downloadText(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function PaperLibraryDrawer() {
  const open = useAppStore((state) => state.ui.paperLibraryOpen);
  const close = useAppStore((state) => state.closePaperLibrary);
  const papers = useAppStore((state) => state.papers);
  const paperIndex = useAppStore((state) => state.paperIndex);
  const paperTotal = useAppStore((state) => state.paperTotal);
  const paperTags = useAppStore((state) => state.paperTags);
  const paperCollections = useAppStore((state) => state.paperCollections);
  const paperLoading = useAppStore((state) => state.paperLoading);
  const paperUploading = useAppStore((state) => state.paperUploading);
  const paperQuery = useAppStore((state) => state.paperQuery);
  const setPaperQuery = useAppStore((state) => state.setPaperQuery);
  const paperDetailId = useAppStore((state) => state.paperDetailId);
  const openPaperDetail = useAppStore((state) => state.openPaperDetail);
  const closePaperDetail = useAppStore((state) => state.closePaperDetail);
  const updatePaper = useAppStore((state) => state.updatePaper);
  const deletePaper = useAppStore((state) => state.deletePaper);
  const uploadPaper = useAppStore((state) => state.uploadPaper);
  const extractPaper = useAppStore((state) => state.extractPaper);
  const addPaperToContext = useAppStore((state) => state.addPaperToContext);

  const [query, setQuery] = useState(paperQuery.query);
  const [fallback, setFallback] = useState<PaperRecord | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    authors: "",
    tags: "",
    status: "unread" as PaperReadStatus,
    notes: "",
    summary: "",
  });
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(paperQuery.query);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(
    () =>
      papers.find((paper) => paper.id === paperDetailId) ??
      (paperDetailId !== null ? paperIndex[paperDetailId] : undefined) ??
      (fallback?.id === paperDetailId ? fallback : null),
    [papers, paperIndex, paperDetailId, fallback],
  );

  useEffect(() => {
    if (paperDetailId === null) {
      setFallback(null);
      return;
    }
    if (paperIndex[paperDetailId] !== undefined) return;
    let cancelled = false;
    api
      .getPaper(paperDetailId)
      .then(({ paper }) => {
        if (!cancelled) setFallback(paper);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [paperDetailId, paperIndex]);

  useEffect(() => {
    if (selected === null) return;
    setDraft({
      title: selected.title,
      authors: selected.authors.join(", "),
      tags: selected.tags.join(", "),
      status: selected.status,
      notes: selected.notes,
      summary: selected.summary,
    });
    setPendingDelete(false);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitSearch = (): void => {
    setPaperQuery({ query: query.trim() });
  };

  const saveDraft = async (): Promise<void> => {
    if (selected === null || saving) return;
    setSaving(true);
    const ok = await updatePaper(selected.id, {
      title: draft.title.trim() || selected.title,
      authors: splitList(draft.authors),
      tags: splitList(draft.tags),
      status: draft.status,
      notes: draft.notes,
      summary: draft.summary,
    });
    setSaving(false);
    if (ok) setFallback(null);
  };

  const openPdf = async (paper: PaperRecord): Promise<void> => {
    try {
      const blob = await api.paperPdf(paper.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      useAppStore
        .getState()
        .notify(
          "error",
          error instanceof Error ? error.message : "无法打开 PDF",
        );
    }
  };

  const runExtract = async (): Promise<void> => {
    if (selected === null || extracting) return;
    setExtracting(true);
    await extractPaper(selected.id);
    setExtracting(false);
    setFallback(null);
  };

  const exportLibrary = async (
    format: "bibtex" | "markdown",
  ): Promise<void> => {
    try {
      const result = await api.exportPapers({ format });
      downloadText(
        result.content,
        format === "bibtex" ? "papers.bib" : "papers.md",
      );
    } catch (error) {
      useAppStore
        .getState()
        .notify(
          "error",
          error instanceof Error ? error.message : "导出失败",
        );
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="论文库"
      description={`${paperTotal} 篇论文 · 标签、阅读状态、笔记与结构化摘要`}
      className="max-w-6xl"
    >
      <div className="flex min-h-[28rem] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitSearch();
                }
              }}
              placeholder="搜索标题、作者、摘要、笔记、标签或 arXiv ID"
              className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground/45 focus:border-primary/40 focus:outline-none"
            />
          </div>
          <Button size="sm" variant="outline" onClick={submitSearch}>
            搜索
          </Button>
          <select
            value={paperQuery.status}
            onChange={(event) =>
              setPaperQuery({
                status: event.target.value as PaperReadStatus | "",
              })
            }
            className="h-8 rounded-lg border border-border bg-background px-2 text-[11px] text-foreground focus:outline-none"
          >
            <option value="">全部状态</option>
            <option value="unread">未读</option>
            <option value="reading">在读</option>
            <option value="read">已读</option>
          </select>
          {paperTags.length > 0 ? (
            <select
              value={paperQuery.tag}
              onChange={(event) =>
                setPaperQuery({ tag: event.target.value })
              }
              className="h-8 max-w-[10rem] rounded-lg border border-border bg-background px-2 text-[11px] text-foreground focus:outline-none"
            >
              <option value="">全部标签</option>
              {paperTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          ) : null}
          {paperCollections.length > 0 ? (
            <select
              value={paperQuery.collection}
              onChange={(event) =>
                setPaperQuery({ collection: event.target.value })
              }
              className="h-8 max-w-[10rem] rounded-lg border border-border bg-background px-2 text-[11px] text-foreground focus:outline-none"
            >
              <option value="">全部集合</option>
              {paperCollections.map((collection) => (
                <option key={collection} value={collection}>
                  {collection}
                </option>
              ))}
            </select>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadPaper(file);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={paperUploading}
              onClick={() => fileRef.current?.click()}
            >
              {paperUploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              上传 PDF
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void exportLibrary("bibtex")}
              title="导出 BibTeX"
            >
              <Download className="h-3.5 w-3.5" />
              BibTeX
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void exportLibrary("markdown")}
              title="导出 Markdown 阅读列表"
            >
              <Download className="h-3.5 w-3.5" />
              Markdown
            </Button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/40">
            {paperLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                加载论文库…
              </div>
            ) : papers.length === 0 ? (
              <div className="px-5 py-16 text-center text-xs leading-6 text-muted-foreground/70">
                <BookOpen className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
                没有匹配的论文。
                <br />
                可以让论文助手检索 arXiv，或上传本地 PDF。
              </div>
            ) : (
              <ul className="divide-y divide-border/50">
                {papers.map((paper) => {
                  const active = paper.id === paperDetailId;
                  return (
                    <li key={paper.id}>
                      <button
                        type="button"
                        onClick={() => openPaperDetail(paper.id)}
                        className={cn(
                          "w-full px-3 py-2.5 text-left transition-colors",
                          active
                            ? "bg-primary/10"
                            : "hover:bg-muted/30",
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={cn(
                              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[9px]",
                              active
                                ? "border-primary/30 bg-primary/15 text-primary"
                                : "border-border bg-muted/30 text-muted-foreground/60",
                            )}
                          >
                            <FileText className="h-3 w-3" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="line-clamp-2 text-xs font-medium leading-5 text-foreground">
                              {paper.title}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9px] text-muted-foreground/60">
                              <span className="truncate">
                                {paper.authors.slice(0, 2).join(", ") ||
                                  "unknown"}
                              </span>
                              <span>·</span>
                              <span>
                                {(paper.publishedAt ?? "").slice(0, 4) ||
                                  "n.d."}
                              </span>
                              {paper.arxivId ? (
                                <>
                                  <span>·</span>
                                  <span className="font-mono">
                                    {paper.arxivId}
                                  </span>
                                </>
                              ) : null}
                              <span
                                className={cn(
                                  "ml-auto rounded-full border px-1 py-px",
                                  STATUS_STYLE[paper.status],
                                )}
                              >
                                {STATUS_LABEL[paper.status]}
                              </span>
                            </span>
                            {paper.tags.length > 0 ? (
                              <span className="mt-1 flex flex-wrap gap-1">
                                {paper.tags.slice(0, 4).map((tag) => (
                                  <span
                                    key={tag}
                                    className="rounded bg-muted/50 px-1 py-px text-[8px] text-muted-foreground/70"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </span>
                          {paper.starred ? (
                            <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/40 p-3">
            {selected === null ? (
              <div className="flex h-full min-h-[18rem] flex-col items-center justify-center text-center text-xs leading-6 text-muted-foreground/60">
                <FileText className="mb-2 h-6 w-6 text-muted-foreground/30" />
                选择左侧论文查看详情、笔记与操作
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <input
                    value={draft.title}
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        title: event.target.value,
                      }))
                    }
                    className="min-w-0 flex-1 rounded border border-transparent bg-transparent text-sm font-semibold text-foreground hover:border-border focus:border-primary/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label={selected.starred ? "取消星标" : "添加星标"}
                    onClick={() =>
                      void updatePaper(selected.id, {
                        starred: !selected.starred,
                      })
                    }
                    className="rounded p-1 hover:bg-muted/50"
                  >
                    <Star
                      className={cn(
                        "h-4 w-4",
                        selected.starred
                          ? "fill-warning text-warning"
                          : "text-muted-foreground/50",
                      )}
                    />
                  </button>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-[10px] text-muted-foreground/60">
                    作者（逗号分隔）
                    <input
                      value={draft.authors}
                      onChange={(event) =>
                        setDraft((value) => ({
                          ...value,
                          authors: event.target.value,
                        }))
                      }
                      className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[11px] text-foreground focus:border-primary/40 focus:outline-none"
                    />
                  </label>
                  <label className="block text-[10px] text-muted-foreground/60">
                    标签（逗号分隔）
                    <input
                      value={draft.tags}
                      onChange={(event) =>
                        setDraft((value) => ({
                          ...value,
                          tags: event.target.value,
                        }))
                      }
                      className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[11px] text-foreground focus:border-primary/40 focus:outline-none"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {(["unread", "reading", "read"] as const).map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() =>
                        setDraft((value) => ({ ...value, status }))
                      }
                      className={cn(
                        "rounded-full border px-2 py-1 text-[10px] transition-colors",
                        draft.status === status
                          ? STATUS_STYLE[status]
                          : "border-border bg-transparent text-muted-foreground/60 hover:bg-muted/40",
                      )}
                    >
                      {STATUS_LABEL[status]}
                    </button>
                  ))}
                  {selected.arxivId ? (
                    <a
                      href={selected.absUrl ?? `https://arxiv.org/abs/${selected.arxivId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1 text-[10px] text-primary/80 hover:text-primary"
                    >
                      arXiv
                      <ArrowUpRight className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openPdf(selected)}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    打开 PDF
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={extracting || selected.textStatus === "pending"}
                    onClick={() => void runExtract()}
                  >
                    {extracting || selected.textStatus === "pending" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <BookOpen className="h-3.5 w-3.5" />
                    )}
                    {selected.textStatus === "ready" ? "重新解析" : "解析文本"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void addPaperToContext(selected.id)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    加入当前上下文
                  </Button>
                  {pendingDelete ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        void deletePaper(selected.id);
                        setPendingDelete(false);
                        closePaperDetail();
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      确认删除
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger/80 hover:text-danger"
                      onClick={() => setPendingDelete(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </Button>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 text-[9px] text-muted-foreground/60">
                  <span>
                    {selected.pageCount !== null
                      ? `${selected.pageCount} 页`
                      : "未解析"}
                  </span>
                  {selected.charCount !== null ? (
                    <span>· {Math.round(selected.charCount / 1000)}k 字符</span>
                  ) : null}
                  {selected.textStatus === "error" ? (
                    <span className="text-danger/80">
                      · 解析失败：{selected.extractionError}
                    </span>
                  ) : null}
                  {selected.fileHash ? <span>· 本地 PDF</span> : null}
                </div>

                <details className="rounded-lg border border-border/60 bg-card/40 p-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                    摘要
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground/85">
                    {selected.abstract || "（无摘要）"}
                  </p>
                </details>

                <label className="block text-[10px] text-muted-foreground/60">
                  结构化笔记（AI summary）
                  <textarea
                    value={draft.summary}
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        summary: event.target.value,
                      }))
                    }
                    rows={5}
                    className="mt-1 w-full resize-y rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground focus:border-primary/40 focus:outline-none"
                    placeholder="TL;DR / 问题 / 方法 / 实验 / 局限 / 相关性"
                  />
                </label>

                <label className="block text-[10px] text-muted-foreground/60">
                  我的笔记
                  <textarea
                    value={draft.notes}
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        notes: event.target.value,
                      }))
                    }
                    rows={4}
                    className="mt-1 w-full resize-y rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground focus:border-primary/40 focus:outline-none"
                    placeholder="记录自己的理解、疑问和想法"
                  />
                </label>

                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={saving}
                    onClick={() => void saveDraft()}
                  >
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    保存修改
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
