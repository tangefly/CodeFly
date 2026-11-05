import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArxivPaper } from "@codefly/protocol";
import {
  PaperLibraryStore,
  paperBibtex,
} from "../src/paper/library-store.js";

const arxivPaper: ArxivPaper = {
  arxivId: "2501.01234",
  version: 2,
  title: "A Test Paper about Retrieval",
  authors: ["Ada Lovelace", "Alan Turing"],
  abstract: "We study retrieval augmented generation.",
  categories: ["cs.CL", "cs.AI"],
  primaryCategory: "cs.CL",
  publishedAt: "2025-01-02T00:00:00Z",
  updatedAt: "2025-01-03T00:00:00Z",
  pdfUrl: "https://arxiv.org/pdf/2501.01234v2",
  absUrl: "https://arxiv.org/abs/2501.01234",
  comment: null,
  journalRef: null,
  doi: "10.1000/test",
};

describe("PaperLibraryStore", () => {
  let dir: string;
  let file: string;
  let store: PaperLibraryStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-papers-"));
    file = path.join(dir, "library.json");
    store = new PaperLibraryStore(file);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("adds an arXiv paper and preserves user fields on refresh", async () => {
    const first = await store.upsertArxiv(arxivPaper, { tags: ["rag"] });
    expect(first.created).toBe(true);
    expect(first.paper.source).toBe("arxiv");
    expect(first.paper.citationKey).toBeTruthy();
    expect(first.paper.textStatus).toBe("none");

    await store.update(first.paper.id, {
      status: "reading",
      starred: true,
      tags: ["rag", "llm"],
      notes: "my notes",
    });

    const refreshed = await store.upsertArxiv({
      ...arxivPaper,
      version: 3,
      title: "A Test Paper about Retrieval (v3)",
      updatedAt: "2025-02-01T00:00:00Z",
    });
    expect(refreshed.created).toBe(false);
    expect(refreshed.paper.id).toBe(first.paper.id);
    expect(refreshed.paper.title).toContain("v3");
    expect(refreshed.paper.version).toBe(3);
    expect(refreshed.paper.status).toBe("reading");
    expect(refreshed.paper.starred).toBe(true);
    expect(refreshed.paper.tags).toEqual(["rag", "llm"]);
    expect(refreshed.paper.notes).toBe("my notes");

    expect(store.list().total).toBe(1);
  });

  it("filters by query, tag, status and collection", async () => {
    const { paper } = await store.upsertArxiv(arxivPaper, {
      tags: ["rag"],
      collections: ["thesis"],
    });
    await store.upsertArxiv(
      {
        ...arxivPaper,
        arxivId: "2501.05678",
        title: "Another Paper on Agents",
        authors: ["Grace Hopper"],
        abstract: "Agentic systems.",
        categories: ["cs.AI"],
      },
      { tags: ["agents"] },
    );
    await store.update(paper.id, { status: "read" });

    expect(store.list({ query: "retrieval" }).papers).toHaveLength(1);
    expect(store.list({ query: "grace" }).papers).toHaveLength(1);
    expect(store.list({ tags: ["rag"] }).papers).toHaveLength(1);
    expect(store.list({ status: "read" }).papers).toHaveLength(1);
    expect(store.list({ collection: "thesis" }).papers).toHaveLength(1);
    expect(store.list({ starred: true }).papers).toHaveLength(0);
    expect(
      store.list({ sort: "title" }).papers.map((paper) => paper.title),
    ).toEqual([
      "A Test Paper about Retrieval",
      "Another Paper on Agents",
    ]);
  });

  it("persists the library and reloads it", async () => {
    const { paper } = await store.upsertArxiv(arxivPaper);
    await store.update(paper.id, { notes: "persisted" });

    const reloaded = new PaperLibraryStore(file);
    await reloaded.init();
    const record = reloaded.get(paper.id);
    expect(record?.notes).toBe("persisted");
    expect(record?.arxivId).toBe("2501.01234");
  });

  it("resets stale pending text states on load", async () => {
    const { paper } = await store.upsertArxiv(arxivPaper);
    await store.setTextState(paper.id, {
      textStatus: "pending",
      error: "leftover",
    });

    const reloaded = new PaperLibraryStore(file);
    await reloaded.init();
    expect(reloaded.get(paper.id)?.textStatus).toBe("none");
    expect(reloaded.get(paper.id)?.extractionError).toBeNull();
  });

  it("deduplicates uploads by file hash", async () => {
    const uploaded = await store.createUpload({
      title: "Local Paper",
      authors: ["Someone"],
      fileHash: "abc123",
      fileName: "local.pdf",
    });
    expect(store.getByHash("abc123")?.id).toBe(uploaded.id);
    expect(store.getByHash("nope")).toBeUndefined();
  });

  it("exports BibTeX with the arXiv fields", async () => {
    const { paper } = await store.upsertArxiv(arxivPaper);
    const bibtex = paperBibtex(paper);
    expect(bibtex).toContain("@misc{");
    expect(bibtex).toContain("eprint = {2501.01234}");
    expect(bibtex).toContain("archivePrefix = {arXiv}");
    expect(bibtex).toContain("A Test Paper about Retrieval");
  });

  it("deletes papers", async () => {
    const { paper } = await store.upsertArxiv(arxivPaper);
    const deleted = await store.delete(paper.id);
    expect(deleted?.id).toBe(paper.id);
    expect(store.get(paper.id)).toBeUndefined();
    expect(store.list().total).toBe(0);
  });
});
