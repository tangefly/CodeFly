import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArxivPaper, PaperOutline } from "@codefly/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/log.js";
import { AppError } from "../src/http/errors.js";
import type { ArxivClient } from "../src/paper/arxiv-client.js";
import { PaperLibraryStore } from "../src/paper/library-store.js";
import type { PaperTextStore } from "../src/paper/text-store.js";
import { registerPaperRoutes } from "../src/routes/papers.js";
import { SessionStore } from "../src/session/store.js";

const arxivPaper: ArxivPaper = {
  arxivId: "2501.01234",
  version: 1,
  title: "A Test Paper",
  authors: ["Ada Lovelace"],
  abstract: "Abstract.",
  categories: ["cs.CL"],
  primaryCategory: "cs.CL",
  publishedAt: "2025-01-02T00:00:00Z",
  updatedAt: "2025-01-02T00:00:00Z",
  pdfUrl: "https://arxiv.org/pdf/2501.01234v1",
  absUrl: "https://arxiv.org/abs/2501.01234",
  comment: null,
  journalRef: null,
  doi: null,
};

describe("paper routes", () => {
  let dir: string;
  let app: FastifyInstance;
  let sessions: SessionStore;
  let library: PaperLibraryStore;
  let sessionId: string;
  let deletedPdfs: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-paper-routes-"));
    sessions = new SessionStore(path.join(dir, "sessions.json"));
    await sessions.init();
    sessionId = (
      await sessions.create(undefined, "papers", "read-only", "paper")
    ).id;
    library = new PaperLibraryStore(path.join(dir, "papers/library.json"));
    await library.init();
    const audit = new AuditLog(path.join(dir, "audit.jsonl"));
    await audit.init();
    deletedPdfs = [];

    const outline: PaperOutline = {
      paperId: "p",
      pageCount: 3,
      charCount: 9000,
      sections: [{ title: "Abstract", startPage: 1, endPage: 1 }],
    };
    const text = {
      outline: async (paperId: string) => ({ ...outline, paperId }),
      ensurePdf: async () => path.join(dir, "papers/paper.pdf"),
      delete: async (paperId: string) => {
        deletedPdfs.push(paperId);
      },
    } as unknown as PaperTextStore;
    const arxiv = {
      getById: async () => arxivPaper,
    } as unknown as ArxivClient;

    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({
          error: { code: error.code, message: error.message },
        });
      }
      return reply
        .code(500)
        .send({ error: { code: "INTERNAL", message: String(error) } });
    });
    registerPaperRoutes(app, {
      sessions,
      library,
      text,
      arxiv,
      audit,
      maxPdfBytes: 25 * 1024 * 1024,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("adds, lists, updates, extracts and deletes a paper", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/papers",
      payload: { arxivId: "2501.01234", tags: ["rag"] },
    });
    expect(created.statusCode).toBe(201);
    const paper = created.json().paper as { id: string; status: string };
    expect(paper.id).toMatch(/^p_/);
    expect(paper.status).toBe("unread");

    const list = await app.inject({ method: "GET", url: "/api/papers" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1 });
    expect(list.json().papers[0]).toMatchObject({
      arxivId: "2501.01234",
      tags: ["rag"],
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/papers/${paper.id}`,
      payload: { status: "reading", notes: "my notes", tags: ["rag", "llm"] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().paper).toMatchObject({
      status: "reading",
      notes: "my notes",
      tags: ["rag", "llm"],
    });

    const context = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/paper-context`,
      payload: { add: [paper.id] },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json().session.paperIds).toEqual([paper.id]);

    const extracted = await app.inject({
      method: "POST",
      url: `/api/papers/${paper.id}/extract`,
      payload: {},
    });
    expect(extracted.statusCode).toBe(200);
    expect(extracted.json().outline).toMatchObject({ pageCount: 3 });

    const exported = await app.inject({
      method: "GET",
      url: "/api/papers/export?format=bibtex",
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().content).toContain("eprint = {2501.01234}");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/papers/${paper.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(library.list().total).toBe(0);
    expect(deletedPdfs).toEqual([paper.id]);
    expect(sessions.getPaperOrThrow(sessionId).paperIds).toEqual([]);
  });

  it("rejects an unknown arXiv id and an unknown paper", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/papers",
      payload: { arxivId: "not-an-id" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("INVALID_ARXIV_ID");

    const missing = await app.inject({
      method: "GET",
      url: "/api/papers/p_missing",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("PAPER_NOT_FOUND");
  });
});
