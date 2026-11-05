import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  paperContextSchema,
  paperCreateSchema,
  paperExportQuerySchema,
  paperQuerySchema,
  paperUpdateSchema,
  type PaperListResponse,
  type PaperQuery,
  type PaperRecord,
  type PaperUpdateInput,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import type { SessionStore } from "../session/store.js";
import type { ArxivClient } from "../paper/arxiv-client.js";
import { normalizeArxivId } from "../paper/arxiv-id.js";
import type { PaperLibraryStore } from "../paper/library-store.js";
import { paperBibtex, paperMarkdown } from "../paper/library-store.js";
import type { PaperTextStore } from "../paper/text-store.js";

export interface PaperRouteDeps {
  sessions: SessionStore;
  library: PaperLibraryStore;
  text: PaperTextStore;
  arxiv: ArxivClient;
  audit: AuditLog;
  maxPdfBytes: number;
}

function getPaperOrThrow(
  library: PaperLibraryStore,
  id: string,
): PaperRecord {
  const paper = library.get(id);
  if (paper === undefined) {
    throw new AppError("PAPER_NOT_FOUND", `论文库中找不到 ${id}。`, 404);
  }
  return paper;
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function fileField(
  fields: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = fields[name];
  const entry = Array.isArray(value) ? value[0] : value;
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null) {
    const candidate = (entry as { value?: unknown }).value;
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

export function registerPaperRoutes(
  app: FastifyInstance,
  deps: PaperRouteDeps,
): void {
  app.get("/api/papers", async (request) => {
    const query = paperQuerySchema.parse(request.query);
    const parsed: PaperQuery = {
      query: query.query,
      tags: parseList(query.tags),
      status: query.status,
      starred: query.starred === undefined ? undefined : query.starred === "true",
      collection: query.collection,
      arxivId: query.arxivId,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    };
    const result = deps.library.list(parsed);
    return {
      papers: result.papers,
      total: result.total,
    } satisfies PaperListResponse;
  });

  app.get("/api/papers/tags", async () => {
    return {
      tags: deps.library.tags(),
      collections: deps.library.collections(),
    };
  });

  app.get("/api/papers/export", async (request) => {
    const query = paperExportQuerySchema.parse(request.query);
    const ids = parseList(query.ids);
    let papers: PaperRecord[];
    if (ids !== undefined && ids.length > 0) {
      papers = ids
        .map((id) => deps.library.get(id))
        .filter((paper): paper is PaperRecord => paper !== undefined);
    } else {
      papers = deps.library.list({
        collection: query.collection,
        limit: 200,
        sort: "added",
      }).papers;
    }
    const format = query.format ?? "markdown";
    return {
      format,
      count: papers.length,
      content:
        format === "bibtex"
          ? papers.map(paperBibtex).join("\n\n")
          : paperMarkdown(papers),
    };
  });

  app.get("/api/papers/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { paper: getPaperOrThrow(deps.library, id) };
  });

  app.post("/api/papers", async (request, reply) => {
    const body = paperCreateSchema.parse(request.body);
    const ref = body.arxivId ?? body.url;
    if (ref === undefined) {
      throw new AppError("INVALID_ARXIV_ID", "请提供 arXiv ID 或 URL。", 400);
    }
    const normalized = normalizeArxivId(ref);
    if (normalized === null) {
      throw new AppError("INVALID_ARXIV_ID", `无法识别 arXiv 标识：${ref}`, 400);
    }

    const existing = deps.library.getByArxivId(normalized);
    if (existing !== undefined) {
      const paper = await deps.library.update(existing.id, {
        ...(body.tags !== undefined
          ? { tags: [...new Set([...existing.tags, ...body.tags])] }
          : {}),
        ...(body.collections !== undefined
          ? {
              collections: [
                ...new Set([...existing.collections, ...body.collections]),
              ],
            }
          : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      return { paper, created: false };
    }

    const arxivPaper = await deps.arxiv.getById(ref);
    const { paper, created } = await deps.library.upsertArxiv(arxivPaper, {
      tags: body.tags,
      collections: body.collections,
      status: body.status,
    });
    await deps.audit.append({
      type: "paper.added",
      paperId: paper.id,
      arxivId: paper.arxivId,
      title: paper.title,
    });
    reply.code(201);
    return { paper, created };
  });

  app.patch("/api/papers/:id", async (request) => {
    const { id } = request.params as { id: string };
    getPaperOrThrow(deps.library, id);
    const body = paperUpdateSchema.parse(request.body);
    const paper = await deps.library.update(id, body as PaperUpdateInput);
    await deps.audit.append({
      type: "paper.updated",
      paperId: paper.id,
      arxivId: paper.arxivId,
      fields: Object.keys(body),
    });
    return { paper };
  });

  app.delete("/api/papers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const paper = getPaperOrThrow(deps.library, id);
    await deps.library.delete(id);
    await deps.text.delete(id);

    // Drop the paper from every paper session's working context.
    for (const session of deps.sessions.list()) {
      if (session.kind !== "paper" || !session.paperIds.includes(id)) continue;
      await deps.sessions.updatePaperContext(
        session.id,
        session.paperIds.filter((paperId) => paperId !== id),
      );
    }

    await deps.audit.append({
      type: "paper.deleted",
      paperId: id,
      arxivId: paper.arxivId,
      title: paper.title,
    });
    return reply.code(204).send();
  });

  app.post("/api/papers/:id/extract", async (request) => {
    const { id } = request.params as { id: string };
    getPaperOrThrow(deps.library, id);
    const outline = await deps.text.outline(id);
    const paper = getPaperOrThrow(deps.library, id);
    await deps.audit.append({
      type: "paper.extracted",
      paperId: id,
      arxivId: paper.arxivId,
      pageCount: outline.pageCount,
      charCount: outline.charCount,
    });
    return { paper, outline };
  });

  app.get("/api/papers/:id/pdf", async (request, reply) => {
    const { id } = request.params as { id: string };
    const paper = getPaperOrThrow(deps.library, id);
    let pdfPath: string;
    try {
      pdfPath = await deps.text.ensurePdf(id);
    } catch (error) {
      throw new AppError(
        "PAPER_PDF_MISSING",
        error instanceof Error ? error.message : "无法获取 PDF。",
        404,
      );
    }

    const filename = `${(paper.arxivId ?? paper.title)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 100)}.pdf`;
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="${filename}"`)
      .send(createReadStream(pdfPath));
  });

  app.post("/api/papers/upload", async (request, reply) => {
    const part = await request.file({ limits: { fileSize: deps.maxPdfBytes } });
    if (part === undefined) {
      throw new AppError("UPLOAD_MISSING", "请选择要上传的 PDF 文件。", 400);
    }

    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      throw new AppError(
        "UPLOAD_TOO_LARGE",
        `PDF 超过大小上限（${Math.round(deps.maxPdfBytes / 1024 / 1024)} MB）。`,
        413,
      );
    }
    if (buffer.length > deps.maxPdfBytes) {
      throw new AppError(
        "UPLOAD_TOO_LARGE",
        `PDF 超过大小上限（${Math.round(deps.maxPdfBytes / 1024 / 1024)} MB）。`,
        413,
      );
    }
    if (
      buffer.length < 5 ||
      buffer.subarray(0, 5).toString("latin1") !== "%PDF-"
    ) {
      throw new AppError("UPLOAD_NOT_PDF", "上传的文件不是有效的 PDF。", 400);
    }

    const fields = part.fields as Record<string, unknown>;
    const titleField = fileField(fields, "title")?.trim();
    const authors = parseList(fileField(fields, "authors")) ?? [];
    const tags = parseList(fileField(fields, "tags"));
    const collections = parseList(fileField(fields, "collections"));
    const statusField = fileField(fields, "status");
    const status =
      statusField === "reading" || statusField === "read"
        ? statusField
        : statusField === "unread"
          ? "unread"
          : undefined;
    const hash = createHash("sha256").update(buffer).digest("hex");

    const existing = deps.library.getByHash(hash);
    if (existing !== undefined) {
      const patch: PaperUpdateInput = {
        ...(titleField !== undefined && titleField !== ""
          ? { title: titleField }
          : {}),
        ...(authors.length > 0 ? { authors } : {}),
        ...(tags !== undefined
          ? { tags: [...new Set([...existing.tags, ...tags])] }
          : {}),
        ...(collections !== undefined
          ? {
              collections: [
                ...new Set([...existing.collections, ...collections]),
              ],
            }
          : {}),
        ...(status !== undefined ? { status } : {}),
      };
      const paper = await deps.library.update(existing.id, patch);
      return { paper, created: false };
    }

    const fileName = part.filename || "paper.pdf";
    const fallbackTitle =
      fileName.replace(/\.pdf$/i, "").trim() || "Untitled paper";
    const paper = await deps.library.createUpload({
      title: titleField !== undefined && titleField !== "" ? titleField : fallbackTitle,
      authors,
      tags,
      collections,
      status,
      fileHash: hash,
      fileName,
    });
    await deps.text.storeUploadedPdf(paper.id, buffer);

    let updated = paper;
    try {
      const outline = await deps.text.outline(paper.id);
      updated = getPaperOrThrow(deps.library, paper.id);
      await deps.audit.append({
        type: "paper.extracted",
        paperId: paper.id,
        pageCount: outline.pageCount,
        charCount: outline.charCount,
      });
    } catch {
      updated = getPaperOrThrow(deps.library, paper.id);
    }

    await deps.audit.append({
      type: "paper.added",
      paperId: paper.id,
      title: paper.title,
      source: "upload",
      bytes: buffer.length,
    });
    reply.code(201);
    return { paper: updated, created: true };
  });

  app.patch("/api/sessions/:id/paper-context", async (request) => {
    const { id } = request.params as { id: string };
    const body = paperContextSchema.parse(request.body);
    const session = deps.sessions.getPaperOrThrow(id);

    let paperIds = body.paperIds ?? [...session.paperIds];
    if (body.add !== undefined) {
      paperIds = [...paperIds, ...body.add];
    }
    if (body.remove !== undefined) {
      const remove = new Set(body.remove);
      paperIds = paperIds.filter((paperId) => !remove.has(paperId));
    }
    paperIds = [...new Set(paperIds)];
    for (const paperId of paperIds) {
      if (deps.library.get(paperId) === undefined) {
        throw new AppError(
          "PAPER_NOT_FOUND",
          `论文库中找不到 ${paperId}。`,
          404,
        );
      }
    }

    const updated = await deps.sessions.updatePaperContext(id, paperIds);
    await deps.audit.append({
      type: "paper.context.changed",
      sessionId: id,
      add: body.add,
      remove: body.remove,
      paperIds: updated.paperIds,
    });
    return { session: updated };
  });
}
