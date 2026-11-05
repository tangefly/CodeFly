import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArxivPaper, PaperSession } from "@codefly/protocol";
import type { ArxivClient } from "../src/paper/arxiv-client.js";
import { PaperLibraryStore } from "../src/paper/library-store.js";
import type { PaperTextStore } from "../src/paper/text-store.js";
import {
  PaperToolExecutor,
  type PaperToolContext,
} from "../src/paper/tools.js";

const arxivPaper: ArxivPaper = {
  arxivId: "2501.01234",
  version: 2,
  title: "A Test Paper about Retrieval",
  authors: ["Ada Lovelace", "Alan Turing"],
  abstract: "We study retrieval augmented generation.",
  categories: ["cs.CL"],
  primaryCategory: "cs.CL",
  publishedAt: "2025-01-02T00:00:00Z",
  updatedAt: "2025-01-03T00:00:00Z",
  pdfUrl: "https://arxiv.org/pdf/2501.01234v2",
  absUrl: "https://arxiv.org/abs/2501.01234",
  comment: null,
  journalRef: null,
  doi: null,
};

function fakeText(): PaperTextStore {
  return {
    outline: async (paperId: string) => ({
      paperId,
      pageCount: 8,
      charCount: 32_000,
      sections: [
        { title: "Abstract", startPage: 1, endPage: 1 },
        { title: "1 Introduction", startPage: 2, endPage: 2 },
        { title: "2 Method", startPage: 3, endPage: 5 },
      ],
    }),
    readPages: async (
      _paperId: string,
      startPage: number,
      endPage: number,
      _maxChars: number,
    ) => ({
      text: `content of pages ${startPage}-${endPage}`,
      startPage,
      endPage,
      chars: 120,
    }),
    readSection: async () => ({
      text: "method content",
      section: { title: "2 Method", startPage: 3, endPage: 5 },
      startPage: 3,
      endPage: 5,
      chars: 120,
    }),
    search: async () => [{ page: 4, excerpt: "the method uses retrieval" }],
  } as unknown as PaperTextStore;
}

function fakeArxiv(): ArxivClient {
  return {
    search: async () => [arxivPaper],
    getById: async () => arxivPaper,
    downloadPdf: async () => "/tmp/paper.pdf",
  } as unknown as ArxivClient;
}

describe("PaperToolExecutor", () => {
  let dir: string;
  let library: PaperLibraryStore;
  let executor: PaperToolExecutor;
  let session: PaperSession;
  let contextIds: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-paper-tools-"));
    library = new PaperLibraryStore(path.join(dir, "library.json"));
    await library.init();
    executor = new PaperToolExecutor({
      library,
      text: fakeText(),
      arxiv: fakeArxiv(),
    });
    session = {
      id: "s_paper",
      kind: "paper",
      title: "paper",
      workspaceRoot: null,
      paperIds: [],
      mode: "read-only",
      approvalPolicy: "never",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastDenial: null,
    };
    contextIds = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function context(): PaperToolContext {
    return {
      session,
      signal: new AbortController().signal,
      emit: () => undefined,
      progress: () => undefined,
      toolCallId: "call_test",
      maxReadChars: 20_000,
      addToContext: async (paperId) => {
        contextIds.push(paperId);
        session = { ...session, paperIds: [...session.paperIds, paperId] };
        return session;
      },
    };
  }

  it("searches arXiv and exposes structured results", async () => {
    const result = await executor.execute(
      "arxiv_search",
      JSON.stringify({ query: "retrieval", categories: ["cs.CL"] }),
      context(),
    );
    expect(result.status).toBe("complete");
    expect(result.meta?.kind).toBe("arxiv");
    expect(result.meta?.resultCount).toBe(1);
    const data = result.meta?.data as { results: ArxivPaper[] };
    expect(data.results[0]?.arxivId).toBe("2501.01234");
    expect(result.content).toContain("A Test Paper about Retrieval");
    expect(result.content).toContain("arXiv: 2501.01234");
  });

  it("gets one paper and adds it to the library on demand", async () => {
    const fetched = await executor.execute(
      "arxiv_get",
      JSON.stringify({ arxiv_id: "2501.01234" }),
      context(),
    );
    expect(fetched.meta?.paperTitle).toBe("A Test Paper about Retrieval");
    expect(library.list().total).toBe(0);

    const added = await executor.execute(
      "library_add",
      JSON.stringify({
        arxiv_id: "2501.01234",
        tags: ["rag"],
        status: "reading",
      }),
      context(),
    );
    expect(added.status).toBe("complete");
    expect(library.list().total).toBe(1);
    const paper = library.getByArxivId("2501.01234");
    expect(paper?.tags).toEqual(["rag"]);
    expect(paper?.status).toBe("reading");
    expect(contextIds).toEqual([paper?.id]);
  });

  it("outlines, reads, searches and updates a paper", async () => {
    const outline = await executor.execute(
      "paper_outline",
      JSON.stringify({ arxiv_id: "2501.01234" }),
      context(),
    );
    expect(outline.status).toBe("complete");
    expect(outline.content).toContain("Sections:");
    expect(outline.content).toContain("2 Method");
    const paperId = outline.meta?.paperId as string;
    expect(paperId).toBeTruthy();

    const read = await executor.execute(
      "paper_read",
      JSON.stringify({ paper_id: paperId, pages: "1-2" }),
      context(),
    );
    expect(read.status).toBe("complete");
    expect(read.meta?.pageRange).toBe("1-2");
    expect(read.content).toContain("content of pages 1-2");

    const section = await executor.execute(
      "paper_read",
      JSON.stringify({ paper_id: paperId, section: "Method" }),
      context(),
    );
    expect(section.content).toContain("method content");

    const search = await executor.execute(
      "paper_search",
      JSON.stringify({ paper_id: paperId, query: "retrieval" }),
      context(),
    );
    expect(search.meta?.matches).toBe(1);
    expect(search.content).toContain("page 4");

    const updated = await executor.execute(
      "library_update",
      JSON.stringify({
        paper_id: paperId,
        add_tags: ["method"],
        remove_tags: ["rag"],
        status: "read",
        starred: true,
        summary: "## TL;DR\nA summary.",
      }),
      context(),
    );
    expect(updated.status).toBe("complete");
    const record = library.get(paperId);
    expect(record?.tags).toEqual(["method"]);
    expect(record?.status).toBe("read");
    expect(record?.starred).toBe(true);
    expect(record?.summary).toContain("TL;DR");
  });

  it("searches and exports the library", async () => {
    await executor.execute(
      "library_add",
      JSON.stringify({ arxiv_id: "2501.01234", tags: ["rag"] }),
      context(),
    );
    const search = await executor.execute(
      "library_search",
      JSON.stringify({ query: "retrieval", tags: ["rag"] }),
      context(),
    );
    expect(search.meta?.resultCount).toBe(1);
    expect(search.content).toContain("2501.01234");

    const exported = await executor.execute(
      "library_export",
      JSON.stringify({ format: "bibtex" }),
      context(),
    );
    expect(exported.status).toBe("complete");
    expect(exported.content).toContain("@misc{");
    expect(exported.content).toContain("eprint = {2501.01234}");
  });

  it("rejects invalid arguments", async () => {
    const result = await executor.execute(
      "arxiv_search",
      JSON.stringify({ sort: "submitted" }),
      context(),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("Invalid tool arguments");
  });
});
