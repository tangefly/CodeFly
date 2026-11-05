import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { PaperSection } from "@codefly/protocol";

export interface ExtractedPaperText {
  pageCount: number;
  pages: string[];
  sections: PaperSection[];
  charCount: number;
  extractedAt: string;
}

export interface PdfExtractorOptions {
  maxPages?: number;
  timeoutMs?: number;
}

interface WorkerResult {
  ok: boolean;
  pages?: string[];
  totalPages?: number;
  error?: string;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
(async () => {
  try {
    const { getDocumentProxy, extractText, getMeta } = await import(pathToFileURL(workerData.unpdfPath).href);
    const data = new Uint8Array(workerData.data);
    const pdf = await getDocumentProxy(data, {
      maxImageSize: 16 * 1024 * 1024,
      isEvalSupported: false,
    });
    const totalPages = pdf.numPages;
    if (totalPages > workerData.maxPages) {
      throw new Error("PDF 页数 " + totalPages + " 超过上限 " + workerData.maxPages);
    }
    const result = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    let meta = null;
    try {
      const info = await getMeta(pdf);
      meta = {
        title: typeof info?.info?.Title === "string" ? info.info.Title : null,
        author: typeof info?.info?.Author === "string" ? info.info.Author : null,
      };
    } catch {}
    parentPort.postMessage({ ok: true, pages, totalPages, meta });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
})();
`;

function cleanPage(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const STANDALONE_HEADINGS =
  /^(abstract|introduction|related work|background|method|methods|approach|experiments?|results?|evaluation|discussion|conclusions?|references|bibliography|appendix|acknowledge?ments?)$/i;

const NUMBERED_HEADING =
  /^(\d+(?:\.\d+)*)[.)]?\s+([A-Z][A-Za-z0-9][A-Za-z0-9 &,:/'\-()]{2,80})$/;

function looksLikeHeading(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.length > 100) return null;
  if (trimmed.endsWith(".") || trimmed.endsWith(",")) return null;
  const standalone = STANDALONE_HEADINGS.exec(trimmed);
  if (standalone !== null) return trimmed;
  const numbered = NUMBERED_HEADING.exec(trimmed);
  if (numbered !== null) return trimmed;
  if (/^(appendix|supplementary material)\b/i.test(trimmed) && trimmed.length < 80) {
    return trimmed;
  }
  return null;
}

/** Heuristic section index from page text; falls back to one full-text section. */
export function detectSections(pages: string[]): PaperSection[] {
  if (pages.length === 0) return [];
  const found: Array<{ title: string; page: number }> = [];
  for (let index = 0; index < pages.length; index += 1) {
    const pageNumber = index + 1;
    const lines = pages[index]!.split("\n");
    for (const line of lines) {
      const heading = looksLikeHeading(line);
      if (heading === null) continue;
      if (
        found.length > 0 &&
        found[found.length - 1]!.title.toLowerCase() === heading.toLowerCase()
      ) {
        continue;
      }
      found.push({ title: heading, page: pageNumber });
    }
  }

  if (found.length === 0) {
    return [{ title: "Full text", startPage: 1, endPage: pages.length }];
  }

  // Start from the first detected heading. If it is late, keep a page-1
  // section so the title/abstract area is still addressable.
  if (found[0]!.page > 1) {
    found.unshift({ title: "Title and abstract", page: 1 });
  }

  return found.map((entry, index) => {
    const next = found[index + 1];
    return {
      title: entry.title.slice(0, 120),
      startPage: entry.page,
      endPage: next === undefined ? pages.length : next.page,
    };
  });
}

/** Extracts page text in a worker thread so a malicious PDF cannot stall the server. */
export class PdfExtractor {
  private readonly maxPages: number;
  private readonly timeoutMs: number;
  private readonly unpdfPath: string;

  constructor(options: PdfExtractorOptions = {}) {
    this.maxPages = options.maxPages ?? 200;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.unpdfPath = createRequire(import.meta.url).resolve("unpdf");
  }

  async extract(
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<ExtractedPaperText> {
    const data = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    const result = await this.runWorker(
      data,
      this.maxPages,
      this.timeoutMs,
      this.unpdfPath,
      signal,
    );
    if (!result.ok || !Array.isArray(result.pages)) {
      throw new Error(result.error ?? "PDF 解析失败。");
    }
    const pages = result.pages.map(cleanPage);
    const totalPages = result.totalPages ?? pages.length;
    if (totalPages > this.maxPages) {
      throw new Error(
        `PDF 页数 ${totalPages} 超过上限 ${this.maxPages}。`,
      );
    }
    const sections = detectSections(pages);
    return {
      pageCount: pages.length,
      pages,
      sections,
      charCount: pages.reduce((total, page) => total + page.length, 0),
      extractedAt: new Date().toISOString(),
    };
  }

  private runWorker(
    data: ArrayBuffer,
    maxPages: number,
    timeoutMs: number,
    unpdfPath: string,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { data, maxPages, unpdfPath },
        transferList: [data],
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
          maxYoungGenerationSizeMb: 64,
        },
      });

      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        fail(new Error("PDF 解析已取消。"));
      };
      const finish = (result: WorkerResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void worker.terminate();
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void worker.terminate();
        reject(error);
      };

      const timer = setTimeout(() => {
        fail(new Error(`PDF 解析超过 ${timeoutMs} ms，已中止。`));
      }, timeoutMs);
      timer.unref?.();

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      worker.on("message", (message: WorkerResult) => {
        finish(message);
      });
      worker.on("error", (error) => fail(error));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) {
          fail(new Error(`PDF 解析进程异常退出（code ${code}）。`));
        }
      });
    });
  }
}
