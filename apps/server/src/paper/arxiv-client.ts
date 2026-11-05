import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { ArxivPaper } from "@codefly/protocol";
import { arxivAbsUrl, arxivPdfUrl, parseArxivId } from "./arxiv-id.js";

const API_BASE = "https://export.arxiv.org/api/query";
const MAX_RESULTS = 50;
const SEARCH_CACHE_TTL_MS = 10 * 60_000;
const SEARCH_CACHE_MAX = 100;
const DOWNLOAD_MAX_REDIRECTS = 5;
const USER_AGENT = "CodeFly/0.1 (local paper assistant)";

export class ArxivError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArxivError";
    this.code = code;
  }
}

export interface ArxivSearchOptions {
  query: string;
  categories?: string[];
  /** YYYY-MM-DD or YYYYMMDD. */
  dateFrom?: string;
  /** YYYY-MM-DD or YYYYMMDD. */
  dateTo?: string;
  sort?: "relevance" | "submitted";
  maxResults?: number;
  start?: number;
  /** Aborts the upstream request when the user stops the run. */
  signal?: AbortSignal;
}

export interface ArxivClientOptions {
  /** Minimum delay between API request starts. arXiv asks for ~3 seconds. */
  minIntervalMs?: number;
  contactEmail?: string;
  maxPdfBytes?: number;
  downloadTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CacheEntry {
  at: number;
  papers: ArxivPaper[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null) {
    const text = (value as Record<string, unknown>)["#text"];
    if (typeof text === "string") return text;
  }
  return "";
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function dateStamp(input: string, endOfDay: boolean): string | null {
  const digits = input.replace(/[^0-9]/g, "");
  if (digits.length === 8) {
    return `${digits}${endOfDay ? "2359" : "0000"}`;
  }
  return null;
}

/** Builds an arXiv `search_query` from free text and convenience filters. */
export function buildArxivQuery(options: ArxivSearchOptions): string {
  const parts: string[] = [];
  const query = options.query.trim();
  if (query !== "") {
    // A query containing a field prefix or boolean operators is passed
    // through; otherwise treat the whole input as a free-text `all:` term.
    if (/(^|\s)(all|ti|au|abs|cat|co|jr|rn|id):/i.test(query)) {
      parts.push(`(${query})`);
    } else if (/\b(AND|OR|ANDNOT)\b/.test(query)) {
      parts.push(`(${query})`);
    } else {
      parts.push(`all:${query}`);
    }
  }
  for (const category of options.categories ?? []) {
    const trimmed = category.trim();
    if (trimmed !== "") parts.push(`cat:${trimmed}`);
  }
  const from = options.dateFrom
    ? dateStamp(options.dateFrom, false)
    : null;
  const to = options.dateTo ? dateStamp(options.dateTo, true) : null;
  if (from !== null || to !== null) {
    parts.push(
      `submittedDate:[${from ?? "190001010000"} TO ${to ?? "299912312359"}]`,
    );
  }
  return parts.join(" AND ");
}

function parseEntry(entry: Record<string, unknown>): ArxivPaper | null {
  const rawId = typeof entry.id === "string" ? entry.id : "";
  const parsed = parseArxivId(rawId);
  if (parsed === null) return null;

  const authors = asArray(entry.author)
    .map((author) =>
      typeof author === "object" && author !== null
        ? collapse(textValue((author as Record<string, unknown>).name))
        : collapse(textValue(author)),
    )
    .filter((name) => name !== "");

  const links = asArray(
    entry.link as
      | Record<string, unknown>
      | Array<Record<string, unknown>>
      | undefined,
  );
  let pdfUrl: string | null = null;
  let absUrl: string | null = null;
  for (const link of links) {
    const href = typeof link["@_href"] === "string" ? link["@_href"] : null;
    if (href === null) continue;
    const title = typeof link["@_title"] === "string" ? link["@_title"] : "";
    const type = typeof link["@_type"] === "string" ? link["@_type"] : "";
    const rel = typeof link["@_rel"] === "string" ? link["@_rel"] : "";
    if (title === "pdf" || type === "application/pdf") pdfUrl = href;
    else if (rel === "alternate" && absUrl === null) absUrl = href;
  }

  const categories = asArray(entry.category)
    .map((category) =>
      typeof category === "object" && category !== null
        ? (category as Record<string, unknown>)["@_term"]
        : undefined,
    )
    .filter((term): term is string => typeof term === "string" && term !== "");

  const primary =
    typeof entry.primary_category === "object" && entry.primary_category !== null
      ? (entry.primary_category as Record<string, unknown>)["@_term"]
      : undefined;

  const published = collapse(textValue(entry.published));
  const updated = collapse(textValue(entry.updated));
  const title = collapse(textValue(entry.title));
  if (title === "") return null;

  const baseId = parsed.id;
  return {
    arxivId: baseId,
    version: parsed.version,
    title,
    authors,
    abstract: collapse(textValue(entry.summary)),
    categories: [...new Set(categories)],
    primaryCategory:
      typeof primary === "string" && primary !== "" ? primary : null,
    publishedAt: published,
    updatedAt: updated === "" ? published : updated,
    pdfUrl: pdfUrl ?? arxivPdfUrl(baseId, parsed.version),
    absUrl: absUrl ?? arxivAbsUrl(baseId),
    comment: collapse(textValue(entry.comment)) || null,
    journalRef: collapse(textValue(entry.journal_ref)) || null,
    doi: collapse(textValue(entry.doi)) || null,
  };
}

function parseFeed(xml: string): ArxivPaper[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new ArxivError(
      "ARXIV_PARSE_FAILED",
      `无法解析 arXiv 响应：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const feed =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).feed
      : undefined;
  if (typeof feed !== "object" || feed === null) {
    throw new ArxivError("ARXIV_PARSE_FAILED", "arXiv 响应缺少 feed 元素。");
  }
  const entries = asArray(
    (feed as Record<string, unknown>).entry as
      | Record<string, unknown>
      | Array<Record<string, unknown>>
      | undefined,
  );
  return entries
    .map(parseEntry)
    .filter((paper): paper is ArxivPaper => paper !== null);
}

async function readCapped(
  response: Response,
  limit: number,
  onProgress?: () => void,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { buffer: Buffer.alloc(0), truncated: false };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    // Receiving data keeps the download alive; only a stalled connection
    // trips the timeout.
    onProgress?.();
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const chunk = Buffer.from(value);
    if (total + chunk.length > limit) {
      chunks.push(chunk.subarray(0, limit - total));
      total = limit;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { buffer: Buffer.concat(chunks, total), truncated };
}

function isAllowedDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "arxiv.org" ||
    host === "www.arxiv.org" ||
    host === "export.arxiv.org"
  );
}

/** arXiv API client with a global request queue, retries and a search cache. */
export class ArxivClient {
  private readonly minIntervalMs: number;
  private readonly maxPdfBytes: number;
  private readonly downloadTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly userAgent: string;
  private apiQueue: Promise<void> = Promise.resolve();
  private downloadQueue: Promise<void> = Promise.resolve();
  private lastApiStart = 0;
  private lastDownloadStart = 0;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ArxivClientOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 3000;
    this.maxPdfBytes = options.maxPdfBytes ?? 25 * 1024 * 1024;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.userAgent =
      options.contactEmail === undefined || options.contactEmail.trim() === ""
        ? USER_AGENT
        : `${USER_AGENT} (mailto:${options.contactEmail.trim()})`;
  }

  private enqueue<T>(
    queue: "api" | "download",
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = queue === "api" ? this.apiQueue : this.downloadQueue;
    const run = previous.then(async () => {
      const last =
        queue === "api" ? this.lastApiStart : this.lastDownloadStart;
      const waitMs = last + this.minIntervalMs - this.now();
      if (waitMs > 0) await delay(waitMs);
      if (queue === "api") this.lastApiStart = this.now();
      else this.lastDownloadStart = this.now();
      return task();
    });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    if (queue === "api") this.apiQueue = settled;
    else this.downloadQueue = settled;
    return run;
  }

  private async requestApi(
    url: URL,
    signal?: AbortSignal,
  ): Promise<ArxivPaper[]> {
    const cacheKey = url.toString();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && this.now() - cached.at < SEARCH_CACHE_TTL_MS) {
      return cached.papers;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) {
        throw new ArxivError("ARXIV_ABORTED", "arXiv 请求已取消。");
      }
      if (attempt > 0) await delay(1000 * 2 ** (attempt - 1));
      try {
        const timeout = AbortSignal.timeout(30_000);
        const response = await this.fetchImpl(url, {
          headers: {
            "user-agent": this.userAgent,
            accept: "application/atom+xml, application/xml;q=0.9",
          },
          signal:
            signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new ArxivError(
            "ARXIV_HTTP_ERROR",
            `arXiv 服务返回 HTTP ${response.status}，请稍后重试。`,
          );
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 500);
          throw new ArxivError(
            "ARXIV_HTTP_ERROR",
            `arXiv 请求失败（HTTP ${response.status}）${detail === "" ? "" : `：${detail}`}`,
          );
        }
        const xml = await response.text();
        const papers = parseFeed(xml);
        this.cache.set(cacheKey, { at: this.now(), papers });
        if (this.cache.size > SEARCH_CACHE_MAX) {
          const oldest = [...this.cache.entries()].sort(
            (a, b) => a[1].at - b[1].at,
          )[0];
          if (oldest !== undefined) this.cache.delete(oldest[0]);
        }
        return papers;
      } catch (error) {
        lastError = error;
        if (error instanceof ArxivError && error.code !== "ARXIV_HTTP_ERROR") {
          throw error;
        }
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new ArxivError("ARXIV_UNAVAILABLE", "无法连接 arXiv API。");
  }

  async search(options: ArxivSearchOptions): Promise<ArxivPaper[]> {
    const searchQuery = buildArxivQuery(options);
    if (searchQuery === "") {
      throw new ArxivError(
        "ARXIV_QUERY_EMPTY",
        "请提供检索关键词或 arXiv 分类（例如 cs.CL）。",
      );
    }
    const maxResults = Math.min(
      MAX_RESULTS,
      Math.max(1, options.maxResults ?? 10),
    );
    const params = new URLSearchParams({
      search_query: searchQuery,
      start: String(Math.max(0, options.start ?? 0)),
      max_results: String(maxResults),
      sortBy: options.sort === "submitted" ? "submittedDate" : "relevance",
      sortOrder: "descending",
    });
    const url = new URL(`${API_BASE}?${params.toString()}`);
    return this.enqueue("api", () => this.requestApi(url, options.signal));
  }

  async getById(idOrUrl: string, signal?: AbortSignal): Promise<ArxivPaper> {
    const parsed = parseArxivId(idOrUrl);
    if (parsed === null) {
      throw new ArxivError(
        "ARXIV_ID_INVALID",
        `无法识别 arXiv 标识：${idOrUrl}`,
      );
    }
    const idWithVersion =
      parsed.version === null ? parsed.id : `${parsed.id}v${parsed.version}`;
    const params = new URLSearchParams({ id_list: idWithVersion });
    const url = new URL(`${API_BASE}?${params.toString()}`);
    const papers = await this.enqueue("api", () =>
      this.requestApi(url, signal),
    );
    const paper = papers[0];
    if (paper === undefined) {
      throw new ArxivError(
        "ARXIV_NOT_FOUND",
        `arXiv 上找不到论文：${parsed.id}`,
      );
    }
    return paper;
  }

  /** Maps an aborted transfer to a message the UI can act on. */
  private downloadFailure(
    cause: unknown,
    stalled: boolean,
    signal: AbortSignal | undefined,
  ): Error {
    if (signal?.aborted) {
      return new ArxivError("ARXIV_ABORTED", "PDF 下载已取消。");
    }
    if (stalled) {
      return new ArxivError(
        "ARXIV_DOWNLOAD_TIMEOUT",
        `PDF 下载超时：${Math.max(1, Math.round(this.downloadTimeoutMs / 1000))} 秒内没有收到新数据，请检查网络或稍后重试。`,
      );
    }
    if (cause instanceof ArxivError) return cause;
    return new ArxivError(
      "ARXIV_DOWNLOAD_FAILED",
      `下载 arXiv PDF 失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  /**
   * Downloads the PDF into `pdfDir` and returns its local path. Existing files
   * are reused; the response is size-capped and checked for the PDF magic.
   *
   * The timeout is an inactivity timeout: it resets whenever body bytes
   * arrive, so a slow but healthy transfer is not cut off at a fixed total
   * duration.
   */
  async downloadPdf(
    paper: Pick<ArxivPaper, "arxivId" | "version"> & {
      pdfUrl: string | null;
    },
    pdfDir: string,
    options: { force?: boolean; signal?: AbortSignal; file?: string } = {},
  ): Promise<string> {
    await mkdir(pdfDir, { recursive: true });
    const target = path.join(
      pdfDir,
      options.file ?? `${paper.arxivId}.pdf`,
    );
    if (options.force !== true) {
      try {
        const existing = await stat(target);
        if (existing.isFile() && existing.size > 4) return target;
      } catch {
        // Not cached yet.
      }
    }

    const start = new URL(
      paper.pdfUrl ?? arxivPdfUrl(paper.arxivId, paper.version),
    );
    return this.enqueue("download", async () => {
      let current = start;
      for (let hop = 0; hop <= DOWNLOAD_MAX_REDIRECTS; hop += 1) {
        if (options.signal?.aborted) {
          throw new ArxivError("ARXIV_ABORTED", "PDF 下载已取消。");
        }
        if (current.protocol !== "https:" && current.protocol !== "http:") {
          throw new ArxivError(
            "ARXIV_DOWNLOAD_BLOCKED",
            `拒绝下载非 http(s) 链接：${current.toString()}`,
          );
        }
        if (!isAllowedDownloadHost(current.hostname)) {
          throw new ArxivError(
            "ARXIV_DOWNLOAD_BLOCKED",
            `拒绝从非 arXiv 域名下载：${current.hostname}`,
          );
        }

        const controller = new AbortController();
        let stalled = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const armIdleTimer = (): void => {
          if (idleTimer !== null) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            stalled = true;
            controller.abort();
          }, this.downloadTimeoutMs);
          idleTimer.unref?.();
        };
        const onAbort = (): void => controller.abort();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        armIdleTimer();
        try {
          let response: Response;
          try {
            response = await this.fetchImpl(current, {
              method: "GET",
              redirect: "manual",
              headers: {
                "user-agent": this.userAgent,
                accept: "application/pdf",
              },
              signal: controller.signal,
            });
          } catch (error) {
            throw this.downloadFailure(error, stalled, options.signal);
          }
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            await response.body?.cancel().catch(() => undefined);
            if (location === null) {
              throw new ArxivError(
                "ARXIV_DOWNLOAD_FAILED",
                "arXiv PDF 重定向缺少 Location 头。",
              );
            }
            current = new URL(location, current);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new ArxivError(
              "ARXIV_DOWNLOAD_FAILED",
              `下载 arXiv PDF 失败（HTTP ${response.status}）。`,
            );
          }

          let buffer: Buffer;
          let truncated: boolean;
          try {
            ({ buffer, truncated } = await readCapped(
              response,
              this.maxPdfBytes + 1,
              armIdleTimer,
            ));
          } catch (error) {
            throw this.downloadFailure(error, stalled, options.signal);
          }
          if (truncated || buffer.length > this.maxPdfBytes) {
            throw new ArxivError(
              "ARXIV_PDF_TOO_LARGE",
              `PDF 超过大小上限（${Math.round(this.maxPdfBytes / 1024 / 1024)} MB）。`,
            );
          }
          if (
            buffer.length < 5 ||
            buffer.subarray(0, 5).toString("latin1") !== "%PDF-"
          ) {
            throw new ArxivError(
              "ARXIV_NOT_PDF",
              "下载内容不是有效的 PDF 文件。",
            );
          }

          const tmp = path.join(
            pdfDir,
            `.codefly-pdf-${process.pid}-${randomUUID()}`,
          );
          await writeFile(tmp, buffer, { mode: 0o600 });
          try {
            await rename(tmp, target);
          } catch (error) {
            await unlink(tmp).catch(() => undefined);
            throw error;
          }
          return target;
        } finally {
          if (idleTimer !== null) clearTimeout(idleTimer);
          options.signal?.removeEventListener("abort", onAbort);
        }
      }
      throw new ArxivError(
        "ARXIV_DOWNLOAD_FAILED",
        "arXiv PDF 重定向次数过多。",
      );
    });
  }
}
