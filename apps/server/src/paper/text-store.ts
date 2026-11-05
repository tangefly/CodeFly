import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PaperOutline, PaperRecord, PaperSection } from "@codefly/protocol";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { isNotFound } from "../http/errors.js";
import type { ArxivClient } from "./arxiv-client.js";
import type { ExtractedPaperText, PdfExtractor } from "./pdf-extractor.js";
import type { PaperLibraryStore } from "./library-store.js";

interface StoredText {
  version: 1;
  paperId: string;
  arxivVersion: number | null;
  pages: string[];
  sections: PaperSection[];
  charCount: number;
  extractedAt: string;
}

export interface PaperTextStoreOptions {
  pdfDir: string;
  textDir: string;
  library: PaperLibraryStore;
  arxiv: ArxivClient;
  extractor: PdfExtractor;
  maxPdfBytes: number;
  maxReadChars: number;
}

export interface TextProgress {
  (message: string): void;
}

export interface PaperSearchHit {
  page: number;
  excerpt: string;
}

function isStoredText(value: unknown): value is StoredText {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoredText>;
  return (
    record.version === 1 &&
    typeof record.paperId === "string" &&
    Array.isArray(record.pages) &&
    record.pages.every((page) => typeof page === "string") &&
    Array.isArray(record.sections) &&
    typeof record.charCount === "number"
  );
}

/** Owns downloaded PDFs and the extracted per-page text cache. */
export class PaperTextStore {
  private readonly options: PaperTextStoreOptions;
  private readonly pending = new Map<string, Promise<StoredText>>();

  constructor(options: PaperTextStoreOptions) {
    this.options = options;
  }

  pdfPath(paperId: string): string {
    return path.join(this.options.pdfDir, `${paperId}.pdf`);
  }

  private textPath(paperId: string): string {
    return path.join(this.options.textDir, `${paperId}.json`);
  }

  /** Finds the local PDF, including the legacy arXiv-id filename cache. */
  async localPdfPath(paperId: string): Promise<string | null> {
    const candidates = [this.pdfPath(paperId)];
    const paper = this.options.library.get(paperId);
    if (paper?.arxivId !== null && paper?.arxivId !== undefined) {
      candidates.push(
        path.join(this.options.pdfDir, `${paper.arxivId}.pdf`),
      );
    }
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (info.isFile() && info.size > 4) return candidate;
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }

  async hasPdf(paperId: string): Promise<boolean> {
    return (await this.localPdfPath(paperId)) !== null;
  }

  /** Downloads the PDF when it is not cached. Uploaded PDFs must already exist. */
  async ensurePdf(
    paperId: string,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (options.force !== true) {
      const existing = await this.localPdfPath(paperId);
      if (existing !== null) return existing;
    }
    const paper = this.options.library.get(paperId);
    if (paper === undefined) throw new Error(`论文不存在：${paperId}`);
    if (paper.source !== "arxiv" || paper.arxivId === null) {
      throw new Error("本地 PDF 文件缺失，请重新上传。");
    }
    return this.options.arxiv.downloadPdf(
      {
        arxivId: paper.arxivId,
        version: paper.version,
        pdfUrl: paper.pdfUrl,
      },
      this.options.pdfDir,
      { force: options.force, signal: options.signal, file: `${paperId}.pdf` },
    );
  }

  /** Saves an uploaded PDF under the paper's id. */
  async storeUploadedPdf(paperId: string, buffer: Buffer): Promise<string> {
    if (buffer.length > this.options.maxPdfBytes) {
      throw new Error(
        `PDF 超过大小上限（${Math.round(this.options.maxPdfBytes / 1024 / 1024)} MB）。`,
      );
    }
    await mkdir(this.options.pdfDir, { recursive: true });
    const target = this.pdfPath(paperId);
    const tmp = path.join(
      this.options.pdfDir,
      `.codefly-upload-${process.pid}-${randomUUID()}`,
    );
    await writeFile(tmp, buffer, { mode: 0o600 });
    try {
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    return target;
  }

  private async readStored(
    paperId: string,
  ): Promise<StoredText | null> {
    try {
      const raw = await readFile(this.textPath(paperId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      return isStoredText(parsed) && parsed.paperId === paperId ? parsed : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      return null;
    }
  }

  /**
   * Ensures the PDF is local and extracted. Concurrent calls for the same
   * paper share one extraction.
   */
  async ensureText(
    paperId: string,
    progress: TextProgress = () => undefined,
    signal?: AbortSignal,
  ): Promise<StoredText> {
    const existing = this.pending.get(paperId);
    if (existing !== undefined) return existing;

    const promise = this.doEnsureText(paperId, progress, signal).finally(() => {
      this.pending.delete(paperId);
    });
    this.pending.set(paperId, promise);
    return promise;
  }

  private async doEnsureText(
    paperId: string,
    progress: TextProgress,
    signal?: AbortSignal,
  ): Promise<StoredText> {
    if (signal?.aborted) throw new Error("操作已取消。");
    const paper = this.options.library.get(paperId);
    if (paper === undefined) {
      throw new Error(`论文不存在：${paperId}`);
    }

    const stored = await this.readStored(paperId);
    const versionMatches = stored?.arxivVersion === paper.version;
    if (stored !== null && versionMatches && paper.textStatus === "ready") {
      return stored;
    }

    await this.options.library.setTextState(paperId, { textStatus: "pending" });

    try {
      const existingPdf = await this.localPdfPath(paperId);
      const needsVersionRefresh =
        existingPdf !== null &&
        stored !== null &&
        !versionMatches &&
        paper.source === "arxiv" &&
        paper.arxivId !== null;

      let pdfPath: string;
      if (existingPdf === null) {
        progress("正在从 arXiv 下载 PDF…");
        pdfPath = await this.ensurePdf(paperId, { signal });
      } else if (needsVersionRefresh) {
        // A newer arXiv version invalidates the cached PDF and text.
        progress("检测到论文新版本，正在重新下载 PDF…");
        pdfPath = await this.ensurePdf(paperId, { force: true, signal });
      } else {
        pdfPath = existingPdf;
      }
      if (signal?.aborted) throw new Error("操作已取消。");

      const info = await stat(pdfPath);
      if (info.size > this.options.maxPdfBytes) {
        throw new Error(
          `PDF 超过大小上限（${Math.round(this.options.maxPdfBytes / 1024 / 1024)} MB）。`,
        );
      }
      progress("正在解析 PDF 文本…");
      const buffer = await readFile(pdfPath);
      const extracted: ExtractedPaperText =
        await this.options.extractor.extract(buffer, signal);
      const next: StoredText = {
        version: 1,
        paperId,
        arxivVersion: paper.version,
        pages: extracted.pages,
        sections: extracted.sections,
        charCount: extracted.charCount,
        extractedAt: extracted.extractedAt,
      };
      await mkdir(this.options.textDir, { recursive: true });
      await atomicWriteFile(
        this.textPath(paperId),
        JSON.stringify(next, null, 2),
      );
      await this.options.library.setTextState(paperId, {
        textStatus: "ready",
        pageCount: extracted.pageCount,
        charCount: extracted.charCount,
        error: null,
      });
      return next;
    } catch (error) {
      if (!signal?.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.library
          .setTextState(paperId, { textStatus: "error", error: message })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async outline(
    paperId: string,
    signal?: AbortSignal,
    progress?: TextProgress,
  ): Promise<PaperOutline> {
    const text = await this.ensureText(paperId, progress, signal);
    return {
      paperId,
      pageCount: text.pages.length,
      charCount: text.charCount,
      sections: text.sections,
    };
  }

  /** Returns a page range (1-based, inclusive) capped for the model context. */
  async readPages(
    paperId: string,
    startPage: number,
    endPage: number,
    maxChars: number,
    signal?: AbortSignal,
    progress?: TextProgress,
  ): Promise<{ text: string; startPage: number; endPage: number; chars: number }> {
    const stored = await this.ensureText(paperId, progress, signal);
    const totalPages = stored.pages.length;
    const start = Math.min(totalPages, Math.max(1, Math.round(startPage)));
    const end = Math.min(totalPages, Math.max(start, Math.round(endPage)));
    const parts: string[] = [];
    let chars = 0;
    let actualEnd = start - 1;
    for (let page = start; page <= end; page += 1) {
      const header = `\n\n[page ${page}/${totalPages}]\n`;
      const content = stored.pages[page - 1] ?? "";
      const remaining = maxChars - chars - header.length;
      if (remaining <= 0) break;
      if (content.length > remaining) {
        parts.push(`${header}${content.slice(0, remaining)}\n[... page truncated]`);
        chars += header.length + remaining;
        actualEnd = page;
        break;
      }
      parts.push(`${header}${content}`);
      chars += header.length + content.length;
      actualEnd = page;
    }
    return {
      text: parts.join("").trim(),
      startPage: start,
      endPage: Math.max(start, actualEnd),
      chars,
    };
  }

  /** Reads a section by title (case-insensitive substring). */
  async readSection(
    paperId: string,
    sectionQuery: string,
    maxChars: number,
    signal?: AbortSignal,
    progress?: TextProgress,
  ): Promise<{
    text: string;
    section: PaperSection | null;
    startPage: number;
    endPage: number;
    chars: number;
  }> {
    const stored = await this.ensureText(paperId, progress, signal);
    const needle = sectionQuery.trim().toLowerCase();
    const section =
      stored.sections.find((entry) =>
        entry.title.toLowerCase().includes(needle),
      ) ?? null;
    if (section === null) {
      return {
        text: "",
        section: null,
        startPage: 0,
        endPage: 0,
        chars: 0,
      };
    }
    const read = await this.readPages(
      paperId,
      section.startPage,
      section.endPage,
      maxChars,
      signal,
      progress,
    );
    return { ...read, section };
  }

  async search(
    paperId: string,
    query: string,
    maxHits = 20,
    contextChars = 320,
    signal?: AbortSignal,
    progress?: TextProgress,
  ): Promise<PaperSearchHit[]> {
    const stored = await this.ensureText(paperId, progress, signal);
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const hits: PaperSearchHit[] = [];
    for (let index = 0; index < stored.pages.length; index += 1) {
      const page = stored.pages[index]!.replace(/\s+/g, " ");
      const lower = page.toLowerCase();
      let from = 0;
      while (hits.length < maxHits) {
        const found = lower.indexOf(needle, from);
        if (found < 0) break;
        const start = Math.max(0, found - contextChars / 2);
        const end = Math.min(page.length, found + needle.length + contextChars / 2);
        hits.push({
          page: index + 1,
          excerpt:
            (start > 0 ? "…" : "") +
            page.slice(start, end).trim() +
            (end < page.length ? "…" : ""),
        });
        from = found + needle.length;
      }
      if (hits.length >= maxHits) break;
    }
    return hits;
  }

  async getText(paperId: string): Promise<StoredText | null> {
    return this.readStored(paperId);
  }

  async delete(paperId: string): Promise<void> {
    await Promise.all([
      unlink(this.pdfPath(paperId)).catch(() => undefined),
      unlink(this.textPath(paperId)).catch(() => undefined),
    ]);
  }
}
