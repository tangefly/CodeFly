import { z } from "zod";
import {
  PAPER_READ_STATUSES,
  type AgentEvent,
  type AgentToolMeta,
  type ArxivPaper,
  type PaperRecord,
  type PaperSession,
  type PaperUpdateInput,
} from "@codefly/protocol";
import type { ToolResult } from "../agent/tools.js";
import type { LlmToolDefinition } from "../llm/client.js";
import type { ArxivClient } from "./arxiv-client.js";
import { normalizeArxivId } from "./arxiv-id.js";
import type { PaperLibraryStore } from "./library-store.js";
import { paperBibtex, paperMarkdown } from "./library-store.js";
import type { PaperTextStore } from "./text-store.js";

const MAX_TOOL_CONTENT_CHARS = 30_000;
const MAX_ABSTRACT_CHARS = 900;
const DEFAULT_SEARCH_RESULTS = 10;
const DEFAULT_READ_CHARS = 15_000;
const MAX_READ_CHARS = 40_000;
const DEFAULT_READ_PAGES = 6;

export interface PaperToolContext {
  session: PaperSession;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  progress: (text: string) => void;
  toolCallId: string;
  maxReadChars: number;
  /** Adds a paper to this session's working set. */
  addToContext: (paperId: string) => Promise<PaperSession>;
}

export interface PaperToolExecutorOptions {
  library: PaperLibraryStore;
  text: PaperTextStore;
  arxiv: ArxivClient;
}

function parseArgs<T>(
  schema: z.ZodType<T>,
  raw: string,
): { ok: true; data: T } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === "" ? "{}" : raw);
  } catch {
    return { ok: false, message: "Tool arguments must be valid JSON." };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `Invalid tool arguments: ${details}` };
  }
  return { ok: true, data: result.data };
}

function toolError(message: string, meta: AgentToolMeta = {}): ToolResult {
  return { content: message, status: "error", meta: { kind: "error", ...meta } };
}

function toolCancelled(meta: AgentToolMeta = {}): ToolResult {
  return { content: "Operation cancelled.", status: "cancelled", meta };
}

function truncate(content: string): string {
  if (content.length <= MAX_TOOL_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_TOOL_CONTENT_CHARS)}\n\n[... truncated; result too large for the model context]`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "(unknown)";
  if (authors.length <= 4) return authors.join(", ");
  return `${authors.slice(0, 4).join(", ")} et al.`;
}

function formatArxivPaper(paper: ArxivPaper, index?: number): string {
  const abstract =
    paper.abstract.length > MAX_ABSTRACT_CHARS
      ? `${paper.abstract.slice(0, MAX_ABSTRACT_CHARS)}…`
      : paper.abstract;
  const prefix = index === undefined ? "" : `${index + 1}. `;
  return [
    `${prefix}${paper.title}`,
    `   Authors: ${formatAuthors(paper.authors)}`,
    `   Published: ${paper.publishedAt.slice(0, 10)} · Updated: ${paper.updatedAt.slice(0, 10)}`,
    `   arXiv: ${paper.arxivId}${paper.version === null ? "" : `v${paper.version}`} · ${paper.categories.join(", ")}`,
    `   PDF: ${paper.pdfUrl}`,
    `   Abstract: ${abstract}`,
  ].join("\n");
}

/** Tool metadata only needs display fields; keep large notes out of messages.json. */
function leanPaper(paper: PaperRecord): PaperRecord {
  return { ...paper, notes: "", summary: "" };
}

function formatPaperRecord(paper: PaperRecord): string {
  const details = [
    `id: ${paper.id}`,
    paper.arxivId ? `arXiv: ${paper.arxivId}` : "local upload",
    `status: ${paper.status}`,
    paper.tags.length > 0 ? `tags: ${paper.tags.join(", ")}` : null,
    paper.pageCount !== null ? `pages: ${paper.pageCount}` : null,
    paper.starred ? "starred" : null,
    paper.textStatus !== "ready" ? `text: ${paper.textStatus}` : null,
  ].filter((item): item is string => item !== null);
  return [
    `${paper.title}`,
    `   ${details.join(" · ")}`,
    `   Authors: ${formatAuthors(paper.authors)}`,
    `   Published: ${(paper.publishedAt ?? "").slice(0, 10) || "unknown"}`,
    paper.summary.trim() !== ""
      ? `   Summary: ${collapse(paper.summary).slice(0, 500)}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function refSchema() {
  return {
    paper_id: z.string().trim().min(1).max(200).optional(),
    arxiv_id: z.string().trim().min(1).max(500).optional(),
    url: z.string().trim().min(1).max(4096).optional(),
  };
}

const arxivSearchArgs = z
  .object({
    query: z.string().trim().max(1000).optional(),
    categories: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
    /** YYYY-MM-DD. */
    date_from: z.string().trim().max(30).optional(),
    /** YYYY-MM-DD. */
    date_to: z.string().trim().max(30).optional(),
    sort: z.enum(["relevance", "submitted"]).optional(),
    max_results: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.query !== undefined && value.query !== "") ||
      (value.categories !== undefined && value.categories.length > 0),
    { message: "provide query, categories, or both" },
  );

const arxivGetArgs = z
  .object({
    arxiv_id: z.string().trim().min(1).max(500),
  })
  .strict();

const paperOutlineArgs = z.object(refSchema()).strict();

const paperReadArgs = z
  .object({
    ...refSchema(),
    /** 1-based pages: "1-5", "1,3,5", "1-3,7". */
    pages: z.string().trim().max(200).optional(),
    section: z.string().trim().min(1).max(200).optional(),
    max_chars: z.number().int().min(1000).max(MAX_READ_CHARS).optional(),
  })
  .strict();

const paperSearchArgs = z
  .object({
    ...refSchema(),
    query: z.string().trim().min(1).max(2000),
    max_hits: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const libraryAddArgs = z
  .object({
    ...refSchema(),
    tags: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    collections: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    status: z.enum(PAPER_READ_STATUSES).optional(),
  })
  .strict();

const librarySearchArgs = z
  .object({
    query: z.string().trim().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    status: z.enum(PAPER_READ_STATUSES).optional(),
    starred: z.boolean().optional(),
    collection: z.string().trim().max(64).optional(),
    sort: z.enum(["added", "published", "title", "lastRead"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const libraryUpdateArgs = z
  .object({
    paper_id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500).optional(),
    authors: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    add_tags: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    remove_tags: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    collections: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    add_collections: z
      .array(z.string().trim().min(1).max(64))
      .max(64)
      .optional(),
    remove_collections: z
      .array(z.string().trim().min(1).max(64))
      .max(64)
      .optional(),
    status: z.enum(PAPER_READ_STATUSES).optional(),
    starred: z.boolean().optional(),
    notes: z.string().max(200_000).optional(),
    summary: z.string().max(200_000).optional(),
    citation_key: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const libraryExportArgs = z
  .object({
    format: z.enum(["bibtex", "markdown"]).optional(),
    paper_ids: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    collection: z.string().trim().max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const DEFINITIONS: Record<string, LlmToolDefinition> = {
  arxiv_search: {
    type: "function",
    function: {
      name: "arxiv_search",
      description:
        "Search arXiv for papers. Use this to discover recent papers, not web_search: results are structured with arXiv IDs, authors, categories, dates, abstracts and PDF URLs. The query supports arXiv syntax such as ti:, au:, abs:, cat:, boolean terms, and quoted phrases. Use categories (e.g. cs.CL, cs.AI, cs.LG) plus date_from/date_to to narrow recent work. Results are not added to the library automatically; call library_add or paper_read with an arXiv ID.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Free-text query, or arXiv field syntax (ti:, au:, abs:, cat:, AND/OR).",
          },
          categories: {
            type: "array",
            items: { type: "string" },
            maxItems: 8,
            description: "arXiv categories, e.g. [\"cs.CL\", \"cs.LG\"].",
          },
          date_from: {
            type: "string",
            description: "Earliest submission date, YYYY-MM-DD.",
          },
          date_to: {
            type: "string",
            description: "Latest submission date, YYYY-MM-DD.",
          },
          sort: {
            type: "string",
            enum: ["relevance", "submitted"],
            description: "Sort by relevance (default) or newest submission.",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Number of results (default 10).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  arxiv_get: {
    type: "function",
    function: {
      name: "arxiv_get",
      description:
        "Get metadata and the abstract for one arXiv paper by ID or URL. Does not download the PDF or add it to the library.",
      parameters: {
        type: "object",
        properties: {
          arxiv_id: {
            type: "string",
            description:
              "arXiv ID or URL, e.g. 2501.01234, 2501.01234v2, https://arxiv.org/abs/2501.01234.",
          },
        },
        required: ["arxiv_id"],
        additionalProperties: false,
      },
    },
  },
  paper_outline: {
    type: "function",
    function: {
      name: "paper_outline",
      description:
        "Download (if needed), extract and outline a paper: title, page count, character count and detected sections with page ranges. Call this before reading a long paper, then use paper_read with a section or page range. Accepts paper_id, arxiv_id or an arXiv URL; an arXiv paper is added to the library automatically.",
      parameters: {
        type: "object",
        properties: {
          paper_id: {
            type: "string",
            description: "Library paper id (p_...).",
          },
          arxiv_id: {
            type: "string",
            description: "arXiv ID or URL.",
          },
          url: {
            type: "string",
            description: "arXiv URL (alias for arxiv_id).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  paper_read: {
    type: "function",
    function: {
      name: "paper_read",
      description:
        "Read extracted text from a paper by page range or section. Text extraction can lose equations, tables and figure details, and multi-column order can be imperfect: rely on the abstract and your reading, and do not invent numbers. Defaults to the first pages; prefer reading one section at a time. Accepts paper_id, arxiv_id or an arXiv URL.",
      parameters: {
        type: "object",
        properties: {
          paper_id: {
            type: "string",
            description: "Library paper id (p_...).",
          },
          arxiv_id: {
            type: "string",
            description: "arXiv ID or URL.",
          },
          url: {
            type: "string",
            description: "arXiv URL (alias for arxiv_id).",
          },
          pages: {
            type: "string",
            description:
              "1-based page range, e.g. \"1-5\", \"1,3,5\", \"1-3,7\". Defaults to the first pages.",
          },
          section: {
            type: "string",
            description:
              "Section title or a case-insensitive fragment, e.g. \"Method\" or \"Experiments\".",
          },
          max_chars: {
            type: "integer",
            minimum: 1000,
            maximum: MAX_READ_CHARS,
            description: `Maximum characters to return (default ${DEFAULT_READ_CHARS}).`,
          },
        },
        additionalProperties: false,
      },
    },
  },
  paper_search: {
    type: "function",
    function: {
      name: "paper_search",
      description:
        "Search inside one paper's extracted text and return matching excerpts with page numbers. Use this to locate a specific method, dataset, result or quote without reading the whole paper.",
      parameters: {
        type: "object",
        properties: {
          paper_id: {
            type: "string",
            description: "Library paper id (p_...).",
          },
          arxiv_id: {
            type: "string",
            description: "arXiv ID or URL.",
          },
          url: {
            type: "string",
            description: "arXiv URL (alias for arxiv_id).",
          },
          query: {
            type: "string",
            description: "Literal text to find (case-insensitive).",
          },
          max_hits: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum excerpts to return (default 20).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  library_add: {
    type: "function",
    function: {
      name: "library_add",
      description:
        "Add a paper to the global library, or bring an existing library paper into the current conversation context. For an arXiv ID/URL the metadata is fetched and deduplicated. Optionally set tags, collections and reading status. Adding does not download the PDF; paper_read/paper_outline do that lazily.",
      parameters: {
        type: "object",
        properties: {
          paper_id: {
            type: "string",
            description: "Existing library paper id.",
          },
          arxiv_id: {
            type: "string",
            description: "arXiv ID or URL to add.",
          },
          url: {
            type: "string",
            description: "arXiv URL (alias for arxiv_id).",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 64,
            description: "Tags to add.",
          },
          collections: {
            type: "array",
            items: { type: "string" },
            maxItems: 64,
            description: "Collections to add.",
          },
          status: {
            type: "string",
            enum: [...PAPER_READ_STATUSES],
            description: "Reading status (default unread).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  library_search: {
    type: "function",
    function: {
      name: "library_search",
      description:
        "Search the global paper library by title, authors, abstract, notes, summary, tags or arXiv ID. Supports tag/status/collection filters. Returns paper ids that can be used with paper_read, paper_search or library_update.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Free-text query.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 32,
            description: "Require all of these tags.",
          },
          status: {
            type: "string",
            enum: [...PAPER_READ_STATUSES],
            description: "Reading status filter.",
          },
          starred: {
            type: "boolean",
            description: "Only starred papers when true.",
          },
          collection: {
            type: "string",
            description: "Collection filter.",
          },
          sort: {
            type: "string",
            enum: ["added", "published", "title", "lastRead"],
            description: "Sort order; defaults to recently added.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum results (default 20).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  library_update: {
    type: "function",
    function: {
      name: "library_update",
      description:
        "Organize a library paper: change tags/collections, reading status, star, user notes or the model-written structured summary. Use add_tags/remove_tags (and collection variants) for incremental edits; tags/collections replace the whole list. Write structured reading notes into summary after reading a paper so later turns do not need the full text.",
      parameters: {
        type: "object",
        properties: {
          paper_id: {
            type: "string",
            description: "Library paper id.",
          },
          title: { type: "string" },
          authors: {
            type: "array",
            items: { type: "string" },
            maxItems: 100,
          },
          tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 64,
            description: "Replace all tags.",
          },
          add_tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 64,
          },
          remove_tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 64,
          },
          collections: {
            type: "array",
            items: { type: "string" },
            maxItems: 64,
            description: "Replace all collections.",
          },
          add_collections: {
            type: "array",
            items: { type: "string" },
            maxItems: 64,
          },
          remove_collections: {
            type: "array",
            items: { type: "string" },
            maxItems: 64,
          },
          status: {
            type: "string",
            enum: [...PAPER_READ_STATUSES],
          },
          starred: { type: "boolean" },
          notes: {
            type: "string",
            description: "User-authored notes (Markdown).",
          },
          summary: {
            type: "string",
            description:
              "Model-written structured notes (Markdown): TL;DR, problem, method, experiments, limitations, relevance, key quotes with pages.",
          },
          citation_key: {
            type: ["string", "null"],
            description: "BibTeX citation key.",
          },
        },
        required: ["paper_id"],
        additionalProperties: false,
      },
    },
  },
  library_export: {
    type: "function",
    function: {
      name: "library_export",
      description:
        "Export library papers as BibTeX or a Markdown reading list. Returns the text; it does not write a file.",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["bibtex", "markdown"],
            description: "Export format; default markdown.",
          },
          paper_ids: {
            type: "array",
            items: { type: "string" },
            maxItems: 200,
            description: "Specific papers; defaults to the whole library.",
          },
          collection: {
            type: "string",
            description: "Only papers in this collection.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Maximum papers (default 50).",
          },
        },
        additionalProperties: false,
      },
    },
  },
};

function parsePageRange(input: string): { start: number; end: number } | null {
  const trimmed = input.trim();
  const match = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(trimmed);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return null;
  }
  return { start, end };
}

function parsePages(input: string): Array<{ start: number; end: number }> | null {
  const parts = input
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  const ranges = parts.map(parsePageRange);
  if (ranges.some((range) => range === null)) return null;
  return ranges as Array<{ start: number; end: number }>;
}

/** Paper-session tool executor. All tools are read-only except library_add/update. */
export class PaperToolExecutor {
  private readonly options: PaperToolExecutorOptions;

  constructor(options: PaperToolExecutorOptions) {
    this.options = options;
  }

  definitions(): LlmToolDefinition[] {
    return Object.values(DEFINITIONS);
  }

  async execute(
    name: string,
    rawArguments: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    switch (name) {
      case "arxiv_search":
        return this.arxivSearch(rawArguments, ctx);
      case "arxiv_get":
        return this.arxivGet(rawArguments, ctx);
      case "paper_outline":
        return this.paperOutline(rawArguments, ctx);
      case "paper_read":
        return this.paperRead(rawArguments, ctx);
      case "paper_search":
        return this.paperSearch(rawArguments, ctx);
      case "library_add":
        return this.libraryAdd(rawArguments, ctx);
      case "library_search":
        return this.librarySearch(rawArguments, ctx);
      case "library_update":
        return this.libraryUpdate(rawArguments, ctx);
      case "library_export":
        return this.libraryExport(rawArguments, ctx);
      default:
        return toolError(`Unknown paper tool: ${name}`);
    }
  }

  private async resolvePaper(
    args: { paper_id?: string; arxiv_id?: string; url?: string },
    ctx: PaperToolContext,
  ): Promise<PaperRecord> {
    if (args.paper_id !== undefined) {
      const paper = this.options.library.get(args.paper_id);
      if (paper === undefined) {
        throw new Error(`论文库中找不到 ${args.paper_id}。`);
      }
      await ctx.addToContext(paper.id);
      return paper;
    }

    const ref = args.arxiv_id ?? args.url;
    if (ref === undefined) {
      throw new Error("请提供 paper_id、arxiv_id 或 url。");
    }
    const normalized = normalizeArxivId(ref);
    if (normalized === null) {
      throw new Error(`无法识别 arXiv 标识：${ref}`);
    }
    const existing = this.options.library.getByArxivId(normalized);
    if (existing !== undefined) {
      await ctx.addToContext(existing.id);
      return existing;
    }
    const arxivPaper = await this.options.arxiv.getById(ref, ctx.signal);
    const { paper } = await this.options.library.upsertArxiv(arxivPaper);
    await ctx.addToContext(paper.id);
    return paper;
  }

  private async arxivSearch(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(arxivSearchArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "arxiv" });
    const args = parsed.data;
    try {
      const papers = await this.options.arxiv.search({
        query: args.query ?? "",
        categories: args.categories,
        dateFrom: args.date_from,
        dateTo: args.date_to,
        sort: args.sort,
        maxResults: args.max_results ?? DEFAULT_SEARCH_RESULTS,
        signal: ctx.signal,
      });
      if (papers.length === 0) {
        return {
          content: "No arXiv papers matched this query.",
          status: "complete",
          meta: {
            kind: "arxiv",
            query: args.query ?? "",
            resultCount: 0,
            data: { results: [] },
          },
        };
      }
      const content = truncate(
        `arXiv search results (${papers.length}):\n\n${papers
          .map((paper, index) => formatArxivPaper(paper, index))
          .join("\n\n")}`,
      );
      return {
        content,
        status: "complete",
        meta: {
          kind: "arxiv",
          query: args.query ?? args.categories?.join(", ") ?? "",
          resultCount: papers.length,
          data: { results: papers },
        },
      };
    } catch (error) {
      if (ctx.signal.aborted) {
        return toolCancelled({ kind: "arxiv", query: args.query ?? "" });
      }
      return toolError(
        `arXiv search failed: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "arxiv", query: args.query ?? "" },
      );
    }
  }

  private async arxivGet(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(arxivGetArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "arxiv" });
    try {
      const paper = await this.options.arxiv.getById(
        parsed.data.arxiv_id,
        ctx.signal,
      );
      const local = this.options.library.getByArxivId(paper.arxivId);
      const content = truncate(
        `${formatArxivPaper(paper)}\n   Library: ${
          local === undefined ? "not added" : `${local.id} (${local.status})`
        }`,
      );
      return {
        content,
        status: "complete",
        meta: {
          kind: "arxiv",
          arxivId: paper.arxivId,
          paperTitle: paper.title,
          authors: paper.authors,
          publishedAt: paper.publishedAt,
          data: { paper, paperId: local?.id ?? null },
        },
      };
    } catch (error) {
      if (ctx.signal.aborted) return toolCancelled({ kind: "arxiv" });
      return toolError(
        `arXiv lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "arxiv" },
      );
    }
  }

  private async paperOutline(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(paperOutlineArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "paper" });
    try {
      const paper = await this.resolvePaper(parsed.data, ctx);
      const outline = await this.options.text.outline(
        paper.id,
        ctx.signal,
        ctx.progress,
      );
      const updated = this.options.library.get(paper.id) ?? paper;
      const sectionLines = outline.sections
        .map(
          (section, index) =>
            `${index + 1}. ${section.title} — pages ${section.startPage}-${section.endPage}`,
        )
        .join("\n");
      const content = truncate(
        [
          `Paper outline: ${updated.title}`,
          `Paper ID: ${updated.id}${updated.arxivId ? ` · arXiv: ${updated.arxivId}` : ""}`,
          `Pages: ${outline.pageCount} · Characters: ${outline.charCount}`,
          `Authors: ${formatAuthors(updated.authors)}`,
          "",
          "Sections:",
          sectionLines,
          "",
          "Use paper_read with paper_id and a section or pages to read. Use paper_search to find a specific term.",
        ].join("\n"),
      );
      return {
        content,
        status: "complete",
        meta: {
          kind: "paper",
          paperId: updated.id,
          arxivId: updated.arxivId ?? undefined,
          paperTitle: updated.title,
          pageCount: outline.pageCount,
          charCount: outline.charCount,
          data: { outline, paper: leanPaper(updated) },
        },
      };
    } catch (error) {
      if (ctx.signal.aborted) return toolCancelled({ kind: "paper" });
      return toolError(
        `Cannot outline paper: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "paper" },
      );
    }
  }

  private async paperRead(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(paperReadArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "paper" });
    const args = parsed.data;
    if (args.pages !== undefined && args.section !== undefined) {
      return toolError("Provide either pages or section, not both.", {
        kind: "paper",
      });
    }
    try {
      const paper = await this.resolvePaper(args, ctx);
      const maxChars = Math.min(
        MAX_READ_CHARS,
        args.max_chars ?? DEFAULT_READ_CHARS,
        ctx.maxReadChars,
      );

      let read: {
        text: string;
        startPage: number;
        endPage: number;
        chars: number;
        sectionTitle: string | null;
      };

      if (args.section !== undefined) {
        const result = await this.options.text.readSection(
          paper.id,
          args.section,
          maxChars,
          ctx.signal,
          ctx.progress,
        );
        if (result.section === null) {
          const outline = await this.options.text.outline(
            paper.id,
            ctx.signal,
            ctx.progress,
          );
          return toolError(
            `找不到章节「${args.section}」。可用章节：${outline.sections
              .map((section) => section.title)
              .join(" / ")}`,
            { kind: "paper", paperId: paper.id },
          );
        }
        read = {
          text: result.text,
          startPage: result.startPage,
          endPage: result.endPage,
          chars: result.chars,
          sectionTitle: result.section.title,
        };
      } else {
        let start = 1;
        let end = DEFAULT_READ_PAGES;
        if (args.pages !== undefined) {
          const ranges = parsePages(args.pages);
          if (ranges === null) {
            return toolError(
              'Invalid pages format. Use "1-5", "1,3,5" or "1-3,7".',
              { kind: "paper" },
            );
          }
          start = Math.min(...ranges.map((range) => range.start));
          end = Math.max(...ranges.map((range) => range.end));
        }
        const result = await this.options.text.readPages(
          paper.id,
          start,
          end,
          maxChars,
          ctx.signal,
          ctx.progress,
        );
        read = { ...result, sectionTitle: null };
      }

      if (this.options.library.get(paper.id)?.status === "unread") {
        await this.options.library.update(paper.id, { status: "reading" });
      }
      await this.options.library.markRead(paper.id);
      const updated = this.options.library.get(paper.id) ?? paper;
      const label =
        read.sectionTitle === null
          ? `pages ${read.startPage}-${read.endPage}`
          : `section "${read.sectionTitle}" (pages ${read.startPage}-${read.endPage})`;
      const header = [
        `Paper: ${updated.title}`,
        `Paper ID: ${updated.id}${updated.arxivId ? ` · arXiv: ${updated.arxivId}` : ""}`,
        `Reading: ${label} · ${read.chars} chars`,
      ].join("\n");
      return {
        content: truncate(`${header}\n\n${read.text}`),
        status: "complete",
        meta: {
          kind: "paper",
          paperId: updated.id,
          arxivId: updated.arxivId ?? undefined,
          paperTitle: updated.title,
          pageRange:
            read.startPage === read.endPage
              ? String(read.startPage)
              : `${read.startPage}-${read.endPage}`,
          pageCount: updated.pageCount ?? undefined,
          charCount: read.chars,
          libraryStatus: updated.status,
          data: {
            paper: leanPaper(updated),
            startPage: read.startPage,
            endPage: read.endPage,
            section: read.sectionTitle,
            chars: read.chars,
          },
        },
      };
    } catch (error) {
      if (ctx.signal.aborted) {
        return toolCancelled({ kind: "paper", paperId: args.paper_id });
      }
      return toolError(
        `Cannot read paper: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "paper", paperId: args.paper_id },
      );
    }
  }

  private async paperSearch(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(paperSearchArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "paper" });
    try {
      const paper = await this.resolvePaper(parsed.data, ctx);
      const hits = await this.options.text.search(
        paper.id,
        parsed.data.query,
        parsed.data.max_hits ?? 20,
        320,
        ctx.signal,
        ctx.progress,
      );
      const content =
        hits.length === 0
          ? `No matches for "${parsed.data.query}" in ${paper.title}.`
          : truncate(
              `Matches for "${parsed.data.query}" in ${paper.title} (${hits.length}):\n\n${hits
                .map(
                  (hit, index) => `${index + 1}. [page ${hit.page}] ${hit.excerpt}`,
                )
                .join("\n\n")}`,
            );
      return {
        content,
        status: "complete",
        meta: {
          kind: "paper",
          paperId: paper.id,
          arxivId: paper.arxivId ?? undefined,
          paperTitle: paper.title,
          query: parsed.data.query,
          matches: hits.length,
          data: { hits },
        },
      };
    } catch (error) {
      if (ctx.signal.aborted) return toolCancelled({ kind: "paper" });
      return toolError(
        `Paper search failed: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "paper" },
      );
    }
  }

  private async libraryAdd(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(libraryAddArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "library" });
    const args = parsed.data;

    try {
      if (args.paper_id !== undefined) {
        const existing = this.options.library.get(args.paper_id);
        if (existing === undefined) {
          return toolError(`论文库中找不到 ${args.paper_id}。`, {
            kind: "library",
          });
        }
        const paper = await this.options.library.update(existing.id, {
          ...(args.tags !== undefined
            ? { tags: [...new Set([...existing.tags, ...args.tags])] }
            : {}),
          ...(args.collections !== undefined
            ? {
                collections: [
                  ...new Set([...existing.collections, ...args.collections]),
                ],
              }
            : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
        });
        await ctx.addToContext(paper.id);
        return this.libraryResult(paper, "added to context");
      }

      const ref = args.arxiv_id ?? args.url;
      if (ref === undefined) {
        return toolError("请提供 paper_id、arxiv_id 或 url。", {
          kind: "library",
        });
      }
      const normalized = normalizeArxivId(ref);
      if (normalized === null) {
        return toolError(`无法识别 arXiv 标识：${ref}`, { kind: "library" });
      }
      let paper = this.options.library.getByArxivId(normalized);
      let created = false;
      if (paper === undefined) {
        const arxivPaper = await this.options.arxiv.getById(ref, ctx.signal);
        const result = await this.options.library.upsertArxiv(arxivPaper, {
          tags: args.tags,
          collections: args.collections,
          status: args.status,
        });
        paper = result.paper;
        created = result.created;
      } else {
        paper = await this.options.library.update(paper.id, {
          ...(args.tags !== undefined
            ? { tags: [...new Set([...paper.tags, ...args.tags])] }
            : {}),
          ...(args.collections !== undefined
            ? {
                collections: [
                  ...new Set([...paper.collections, ...args.collections]),
                ],
              }
            : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
        });
      }
      await ctx.addToContext(paper.id);
      return this.libraryResult(
        paper,
        created ? "added to library" : "already in library",
      );
    } catch (error) {
      if (ctx.signal.aborted) return toolCancelled({ kind: "library" });
      return toolError(
        `Cannot add paper: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "library" },
      );
    }
  }

  private libraryResult(paper: PaperRecord, action: string): ToolResult {
    return {
      content: truncate(
        `Library paper ${paper.id} (${action}):\n${formatPaperRecord(paper)}`,
      ),
      status: "complete",
      meta: {
        kind: "library",
        paperId: paper.id,
        arxivId: paper.arxivId ?? undefined,
        paperTitle: paper.title,
        authors: paper.authors,
        publishedAt: paper.publishedAt,
        tags: paper.tags,
        libraryStatus: paper.status,
        data: { action, paper: leanPaper(paper) },
      },
    };
  }

  private async librarySearch(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(librarySearchArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "library" });
    const args = parsed.data;
    try {
      const result = this.options.library.list({
        query: args.query,
        tags: args.tags,
        status: args.status,
        starred: args.starred,
        collection: args.collection,
        sort: args.sort,
        limit: args.limit ?? 20,
      });
      const content =
        result.papers.length === 0
          ? "No library papers matched."
          : truncate(
              `Library results (${result.papers.length}/${result.total}):\n\n${result.papers
                .map((paper, index) => `${index + 1}. ${formatPaperRecord(paper)}`)
                .join("\n\n")}`,
            );
      return {
        content,
        status: "complete",
        meta: {
          kind: "library",
          query: args.query,
          resultCount: result.papers.length,
          data: { papers: result.papers.map(leanPaper), total: result.total },
        },
      };
    } catch (error) {
      return toolError(
        `Library search failed: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "library" },
      );
    }
  }

  private async libraryUpdate(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(libraryUpdateArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "library" });
    const args = parsed.data;
    const current = this.options.library.get(args.paper_id);
    if (current === undefined) {
      return toolError(`论文库中找不到 ${args.paper_id}。`, {
        kind: "library",
      });
    }

    const patch: PaperUpdateInput = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.authors !== undefined) patch.authors = args.authors;
    if (args.tags !== undefined) patch.tags = args.tags;
    if (args.add_tags !== undefined || args.remove_tags !== undefined) {
      const remove = new Set(
        (args.remove_tags ?? []).map((tag) => tag.toLowerCase()),
      );
      const tags = new Set(
        (args.tags ?? current.tags).filter(
          (tag) => !remove.has(tag.toLowerCase()),
        ),
      );
      for (const tag of args.add_tags ?? []) tags.add(tag);
      patch.tags = [...tags];
    }
    if (args.collections !== undefined) patch.collections = args.collections;
    if (
      args.add_collections !== undefined ||
      args.remove_collections !== undefined
    ) {
      const remove = new Set(
        (args.remove_collections ?? []).map((item) => item.toLowerCase()),
      );
      const collections = new Set(
        (args.collections ?? current.collections).filter(
          (item) => !remove.has(item.toLowerCase()),
        ),
      );
      for (const item of args.add_collections ?? []) collections.add(item);
      patch.collections = [...collections];
    }
    if (args.status !== undefined) patch.status = args.status;
    if (args.starred !== undefined) patch.starred = args.starred;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.summary !== undefined) patch.summary = args.summary;
    if (args.citation_key !== undefined) patch.citationKey = args.citation_key;

    try {
      const paper = await this.options.library.update(current.id, patch);
      await ctx.addToContext(paper.id);
      return {
        content: `Updated ${paper.id}:\n${formatPaperRecord(paper)}`,
        status: "complete",
        meta: {
          kind: "library",
          paperId: paper.id,
          arxivId: paper.arxivId ?? undefined,
          paperTitle: paper.title,
          tags: paper.tags,
          libraryStatus: paper.status,
          data: { action: "updated", paper: leanPaper(paper) },
        },
      };
    } catch (error) {
      return toolError(
        `Library update failed: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "library", paperId: current.id },
      );
    }
  }

  private async libraryExport(
    raw: string,
    ctx: PaperToolContext,
  ): Promise<ToolResult> {
    const parsed = parseArgs(libraryExportArgs, raw);
    if (!parsed.ok) return toolError(parsed.message, { kind: "library" });
    const args = parsed.data;
    const format = args.format ?? "markdown";
    let papers: PaperRecord[];
    if (args.paper_ids !== undefined && args.paper_ids.length > 0) {
      papers = args.paper_ids
        .map((id) => this.options.library.get(id))
        .filter((paper): paper is PaperRecord => paper !== undefined);
    } else {
      papers = this.options.library.list({
        collection: args.collection,
        limit: args.limit ?? 50,
        sort: "added",
      }).papers;
    }
    const content =
      format === "bibtex"
        ? truncate(papers.map(paperBibtex).join("\n\n"))
        : truncate(paperMarkdown(papers));
    return {
      content,
      status: "complete",
      meta: {
        kind: "library",
        resultCount: papers.length,
        data: { format, count: papers.length },
      },
    };
  }
}

