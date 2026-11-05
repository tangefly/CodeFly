import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PAPER_READ_STATUSES,
  type ArxivPaper,
  type PaperQuery,
  type PaperReadStatus,
  type PaperRecord,
  type PaperTextStatus,
  type PaperUpdateInput,
} from "@codefly/protocol";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { isNotFound } from "../http/errors.js";
import { normalizeArxivId } from "./arxiv-id.js";

interface LibraryFile {
  version?: unknown;
  papers?: unknown;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asStringArray(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed.slice(0, 64));
    if (result.length >= max) break;
  }
  return result;
}

export function normalizeTags(value: unknown): string[] {
  return asStringArray(value, 64);
}

function asStatus(value: unknown): PaperReadStatus {
  return PAPER_READ_STATUSES.includes(value as PaperReadStatus)
    ? (value as PaperReadStatus)
    : "unread";
}

function asTextStatus(value: unknown): PaperTextStatus {
  return value === "pending" || value === "ready" || value === "error"
    ? value
    : "none";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/** Rough BibTeX key: first author's surname, year, first title word. */
function makeCitationKey(input: {
  authors: string[];
  publishedAt: string | null;
  title: string;
  arxivId: string | null;
}): string {
  const firstAuthor = input.authors[0] ?? "";
  const surname =
    firstAuthor.trim().split(/\s+/).at(-1)?.replace(/[^a-zA-Z0-9]/g, "") ??
    "paper";
  const year = (input.publishedAt ?? "").slice(0, 4) || "nd";
  const titleWord =
    input.title
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .trim()
      .split(/\s+/)
      .find((word) => word.length > 2) ?? "work";
  const suffix = input.arxivId?.replace(/[^a-zA-Z0-9]/g, "").slice(-4) ?? "";
  return `${surname}${year}${titleWord.toLowerCase()}${suffix}`.slice(0, 120);
}

function normalizeRecord(raw: unknown): PaperRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.trim() === "") return null;
  const title = asString(raw.title).trim();
  if (title === "") return null;
  const now = new Date().toISOString();
  const authors = asStringArray(raw.authors, 100);
  const arxivId = asNullableString(raw.arxivId);
  const publishedAt = asNullableString(raw.publishedAt);
  return {
    id: raw.id,
    source: raw.source === "upload" ? "upload" : "arxiv",
    arxivId,
    version: asNumber(raw.version),
    title,
    authors,
    abstract: asString(raw.abstract),
    categories: asStringArray(raw.categories, 32),
    primaryCategory: asNullableString(raw.primaryCategory),
    publishedAt,
    arxivUpdatedAt: asNullableString(raw.arxivUpdatedAt),
    journalRef: asNullableString(raw.journalRef),
    doi: asNullableString(raw.doi),
    comment: asNullableString(raw.comment),
    pdfUrl: asNullableString(raw.pdfUrl),
    absUrl: asNullableString(raw.absUrl),
    addedAt: asNullableString(raw.addedAt) ?? now,
    modifiedAt: asNullableString(raw.modifiedAt) ?? now,
    lastReadAt: asNullableString(raw.lastReadAt),
    status: asStatus(raw.status),
    starred: asBoolean(raw.starred),
    tags: asStringArray(raw.tags, 64),
    collections: asStringArray(raw.collections, 64),
    notes: asString(raw.notes),
    summary: asString(raw.summary),
    citationKey: asNullableString(raw.citationKey),
    textStatus: asTextStatus(raw.textStatus),
    pageCount: asNumber(raw.pageCount),
    charCount: asNumber(raw.charCount),
    extractionError: asNullableString(raw.extractionError),
    fileHash: asNullableString(raw.fileHash),
    fileName: asNullableString(raw.fileName),
  };
}

function copy(record: PaperRecord): PaperRecord {
  return {
    ...record,
    authors: [...record.authors],
    categories: [...record.categories],
    tags: [...record.tags],
    collections: [...record.collections],
  };
}

function matchesQuery(record: PaperRecord, query: PaperQuery): boolean {
  if (query.status !== undefined && record.status !== query.status) return false;
  if (query.starred !== undefined && record.starred !== query.starred) {
    return false;
  }
  if (
    query.collection !== undefined &&
    query.collection !== "" &&
    !record.collections.includes(query.collection)
  ) {
    return false;
  }
  if (query.arxivId !== undefined && query.arxivId !== "") {
    const normalized = normalizeArxivId(query.arxivId);
    if (normalized === null || record.arxivId !== normalized) return false;
  }
  if (query.tags !== undefined && query.tags.length > 0) {
    const tags = new Set(record.tags.map((tag) => tag.toLowerCase()));
    if (!query.tags.every((tag) => tags.has(tag.toLowerCase()))) return false;
  }
  const text = query.query?.trim().toLowerCase();
  if (text !== undefined && text !== "") {
    const haystack = [
      record.title,
      record.authors.join(" "),
      record.abstract,
      record.tags.join(" "),
      record.collections.join(" "),
      record.notes,
      record.summary,
      record.arxivId ?? "",
      record.doi ?? "",
    ]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  return true;
}

function compare(a: PaperRecord, b: PaperRecord, sort: PaperQuery["sort"]): number {
  if (sort === "title") return a.title.localeCompare(b.title);
  if (sort === "published") {
    const left = a.publishedAt ?? "";
    const right = b.publishedAt ?? "";
    if (left !== right) return right.localeCompare(left);
    return b.addedAt.localeCompare(a.addedAt);
  }
  if (sort === "lastRead") {
    const left = a.lastReadAt ?? "";
    const right = b.lastReadAt ?? "";
    if (left !== right) return right.localeCompare(left);
    return b.addedAt.localeCompare(a.addedAt);
  }
  return b.addedAt.localeCompare(a.addedAt);
}

/** Global paper library persisted as one JSON file, matching the other stores. */
export class PaperLibraryStore {
  private readonly papers = new Map<string, PaperRecord>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as LibraryFile;
      if (!Array.isArray(parsed.papers)) return;
      for (const entry of parsed.papers) {
        const record = normalizeRecord(entry);
        if (record !== null) this.papers.set(record.id, record);
      }
    } catch {
      console.error("[papers] ignoring corrupt library.json");
      return;
    }

    // No extraction can be in flight before the store is loaded, so any
    // "pending" entry is left over from a cancelled run or a stopped process.
    // Leaving it pending disables re-extraction in the UI forever.
    let repaired = false;
    for (const record of this.papers.values()) {
      if (record.textStatus === "pending") {
        record.textStatus = "none";
        record.extractionError = null;
        repaired = true;
      }
    }
    if (repaired) await this.persist();
  }

  list(query: PaperQuery = {}): { papers: PaperRecord[]; total: number } {
    const matched = [...this.papers.values()]
      .filter((record) => matchesQuery(record, query))
      .sort((a, b) => compare(a, b, query.sort));
    const offset = query.offset ?? 0;
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    return {
      papers: matched.slice(offset, offset + limit).map(copy),
      total: matched.length,
    };
  }

  all(): PaperRecord[] {
    return [...this.papers.values()]
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      .map(copy);
  }

  get(id: string): PaperRecord | undefined {
    const record = this.papers.get(id);
    return record === undefined ? undefined : copy(record);
  }

  getOrThrow(id: string): PaperRecord {
    const record = this.papers.get(id);
    if (record === undefined) {
      throw new Error(`paper not found: ${id}`);
    }
    return copy(record);
  }

  getByArxivId(arxivId: string): PaperRecord | undefined {
    const normalized = normalizeArxivId(arxivId);
    if (normalized === null) return undefined;
    for (const record of this.papers.values()) {
      if (record.arxivId === normalized) return copy(record);
    }
    return undefined;
  }

  getByHash(hash: string): PaperRecord | undefined {
    for (const record of this.papers.values()) {
      if (record.fileHash === hash) return copy(record);
    }
    return undefined;
  }

  /** Adds or refreshes an arXiv paper, preserving all user-authored fields. */
  async upsertArxiv(
    paper: ArxivPaper,
    extra: {
      tags?: string[];
      collections?: string[];
      status?: PaperReadStatus;
    } = {},
  ): Promise<{ paper: PaperRecord; created: boolean }> {
    const existing = this.getByArxivId(paper.arxivId);
    const now = new Date().toISOString();

    if (existing !== undefined) {
      const record = this.papers.get(existing.id)!;
      record.version = paper.version;
      record.title = paper.title;
      record.authors = paper.authors;
      record.abstract = paper.abstract;
      record.categories = paper.categories;
      record.primaryCategory = paper.primaryCategory;
      record.publishedAt = paper.publishedAt;
      record.arxivUpdatedAt = paper.updatedAt;
      record.journalRef = paper.journalRef;
      record.doi = paper.doi;
      record.comment = paper.comment;
      record.pdfUrl = paper.pdfUrl;
      record.absUrl = paper.absUrl;
      record.modifiedAt = now;
      if (record.citationKey === null) {
        record.citationKey = makeCitationKey(record);
      }
      record.tags = normalizeTags([...record.tags, ...(extra.tags ?? [])]);
      record.collections = normalizeTags([
        ...record.collections,
        ...(extra.collections ?? []),
      ]);
      if (extra.status !== undefined) record.status = extra.status;
      await this.persist();
      return { paper: copy(record), created: false };
    }

    const record: PaperRecord = {
      id: `p_${randomUUID()}`,
      source: "arxiv",
      arxivId: paper.arxivId,
      version: paper.version,
      title: paper.title,
      authors: paper.authors,
      abstract: paper.abstract,
      categories: paper.categories,
      primaryCategory: paper.primaryCategory,
      publishedAt: paper.publishedAt,
      arxivUpdatedAt: paper.updatedAt,
      journalRef: paper.journalRef,
      doi: paper.doi,
      comment: paper.comment,
      pdfUrl: paper.pdfUrl,
      absUrl: paper.absUrl,
      addedAt: now,
      modifiedAt: now,
      lastReadAt: null,
      status: extra.status ?? "unread",
      starred: false,
      tags: normalizeTags(extra.tags),
      collections: normalizeTags(extra.collections),
      notes: "",
      summary: "",
      citationKey: makeCitationKey(paper),
      textStatus: "none",
      pageCount: null,
      charCount: null,
      extractionError: null,
      fileHash: null,
      fileName: null,
    };
    this.papers.set(record.id, record);
    await this.persist();
    return { paper: copy(record), created: true };
  }

  async createUpload(input: {
    title: string;
    authors: string[];
    abstract?: string;
    tags?: string[];
    collections?: string[];
    status?: PaperReadStatus;
    fileHash: string;
    fileName: string;
  }): Promise<PaperRecord> {
    const now = new Date().toISOString();
    const record: PaperRecord = {
      id: `p_${randomUUID()}`,
      source: "upload",
      arxivId: null,
      version: null,
      title: input.title.trim() || input.fileName,
      authors: asStringArray(input.authors, 100),
      abstract: input.abstract ?? "",
      categories: [],
      primaryCategory: null,
      publishedAt: null,
      arxivUpdatedAt: null,
      journalRef: null,
      doi: null,
      comment: null,
      pdfUrl: null,
      absUrl: null,
      addedAt: now,
      modifiedAt: now,
      lastReadAt: null,
      status: input.status ?? "unread",
      starred: false,
      tags: normalizeTags(input.tags),
      collections: normalizeTags(input.collections),
      notes: "",
      summary: "",
      citationKey: makeCitationKey({
        authors: input.authors,
        publishedAt: null,
        title: input.title,
        arxivId: null,
      }),
      textStatus: "pending",
      pageCount: null,
      charCount: null,
      extractionError: null,
      fileHash: input.fileHash,
      fileName: input.fileName,
    };
    this.papers.set(record.id, record);
    await this.persist();
    return copy(record);
  }

  async update(id: string, patch: PaperUpdateInput): Promise<PaperRecord> {
    const record = this.papers.get(id);
    if (record === undefined) throw new Error(`paper not found: ${id}`);

    if (patch.title !== undefined) record.title = patch.title;
    if (patch.authors !== undefined) {
      record.authors = asStringArray(patch.authors, 100);
    }
    if (patch.abstract !== undefined) record.abstract = patch.abstract;
    if (patch.tags !== undefined) record.tags = normalizeTags(patch.tags);
    if (patch.collections !== undefined) {
      record.collections = normalizeTags(patch.collections);
    }
    if (patch.status !== undefined) record.status = asStatus(patch.status);
    if (patch.starred !== undefined) record.starred = patch.starred === true;
    if (patch.notes !== undefined) record.notes = patch.notes;
    if (patch.summary !== undefined) record.summary = patch.summary;
    if (patch.citationKey !== undefined) {
      record.citationKey = asNullableString(patch.citationKey);
    }
    record.modifiedAt = new Date().toISOString();
    await this.persist();
    return copy(record);
  }

  async setTextState(
    id: string,
    state: {
      textStatus: PaperTextStatus;
      pageCount?: number | null;
      charCount?: number | null;
      error?: string | null;
    },
  ): Promise<PaperRecord> {
    const record = this.papers.get(id);
    if (record === undefined) throw new Error(`paper not found: ${id}`);
    record.textStatus = state.textStatus;
    if (state.pageCount !== undefined) record.pageCount = state.pageCount;
    if (state.charCount !== undefined) record.charCount = state.charCount;
    record.extractionError =
      state.error === undefined ? record.extractionError : state.error;
    record.modifiedAt = new Date().toISOString();
    await this.persist();
    return copy(record);
  }

  async markRead(id: string): Promise<PaperRecord | null> {
    const record = this.papers.get(id);
    if (record === undefined) return null;
    record.lastReadAt = new Date().toISOString();
    await this.persist();
    return copy(record);
  }

  async delete(id: string): Promise<PaperRecord | null> {
    const record = this.papers.get(id);
    if (record === undefined) return null;
    this.papers.delete(id);
    await this.persist();
    return copy(record);
  }

  tags(): string[] {
    const counts = new Map<string, number>();
    for (const record of this.papers.values()) {
      for (const tag of record.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  }

  collections(): string[] {
    const counts = new Map<string, number>();
    for (const record of this.papers.values()) {
      for (const collection of record.collections) {
        counts.set(collection, (counts.get(collection) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([collection]) => collection);
  }

  private persist(): Promise<void> {
    const data = JSON.stringify(
      { version: 1, papers: [...this.papers.values()] },
      null,
      2,
    );
    this.persistQueue = this.persistQueue
      .then(() => atomicWriteFile(this.file, data))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error("[papers] failed to persist library", error);
      });
    return this.persistQueue;
  }
}

export function paperBibtex(record: PaperRecord): string {
  const year = (record.publishedAt ?? "").slice(0, 4);
  const key =
    record.citationKey ??
    makeCitationKey({
      authors: record.authors,
      publishedAt: record.publishedAt,
      title: record.title,
      arxivId: record.arxivId,
    });
  const fields: Array<[string, string | null]> = [
    ["title", record.title],
    ["author", record.authors.join(" and ") || null],
    ["year", year || null],
    ["eprint", record.arxivId],
    ["archivePrefix", record.arxivId !== null ? "arXiv" : null],
    ["primaryClass", record.primaryCategory],
    ["doi", record.doi],
    ["journal", record.journalRef],
    ["url", record.absUrl],
  ];
  const body = fields
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== "")
    .map(([name, value]) => `  ${name} = {${value.replace(/[{}]/g, "")}}`)
    .join(",\n");
  return `@misc{${key},\n${body}\n}`;
}

export function paperMarkdown(records: PaperRecord[]): string {
  if (records.length === 0) return "（论文库为空）";
  const lines = [
    "# 论文库",
    "",
    `导出 ${records.length} 篇`,
    "",
    "| 状态 | 标题 | 作者 | 发布 | arXiv | 标签 |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const record of records) {
    const authors =
      record.authors.length > 3
        ? `${record.authors.slice(0, 3).join(", ")} et al.`
        : record.authors.join(", ");
    lines.push(
      `| ${record.status} | ${record.title.replace(/\|/g, "\\|")} | ${authors.replace(/\|/g, "\\|")} | ${(record.publishedAt ?? "").slice(0, 10)} | ${record.arxivId ?? ""} | ${record.tags.join(", ")} |`,
    );
  }
  return lines.join("\n");
}
