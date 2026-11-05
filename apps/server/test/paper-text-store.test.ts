import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaperRecord, PaperTextStatus } from "@codefly/protocol";
import type { ArxivClient } from "../src/paper/arxiv-client.js";
import type { PaperLibraryStore } from "../src/paper/library-store.js";
import type { PdfExtractor } from "../src/paper/pdf-extractor.js";
import { PaperTextStore } from "../src/paper/text-store.js";

describe("PaperTextStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-paper-text-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeStore(initialStatus: PaperTextStatus) {
    const paper = {
      id: "p_test",
      source: "arxiv",
      arxivId: "2501.01234",
      version: 1,
      pdfUrl: "https://arxiv.org/pdf/2501.01234v1",
      textStatus: initialStatus,
    } as unknown as PaperRecord;
    const updates: Array<{
      textStatus: PaperTextStatus;
      error?: string | null;
    }> = [];
    const library = {
      get: (id: string) => (id === paper.id ? paper : undefined),
      setTextState: async (
        _id: string,
        state: {
          textStatus: PaperTextStatus;
          pageCount?: number | null;
          charCount?: number | null;
          error?: string | null;
        },
      ) => {
        updates.push({ textStatus: state.textStatus, error: state.error });
        paper.textStatus = state.textStatus;
        return paper;
      },
    } as unknown as PaperLibraryStore;

    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const arxiv = {
      downloadPdf: (
        _paper: unknown,
        _pdfDir: string,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<string>((_resolve, reject) => {
          markStarted();
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    } as unknown as ArxivClient;
    const extractor = {
      extract: async () => {
        throw new Error("extraction should not start");
      },
    } as unknown as PdfExtractor;

    const store = new PaperTextStore({
      pdfDir: path.join(dir, "pdf"),
      textDir: path.join(dir, "text"),
      library,
      arxiv,
      extractor,
      maxPdfBytes: 25 * 1024 * 1024,
      maxReadChars: 20_000,
    });
    return { store, updates, started };
  }

  it("restores the previous status when extraction is cancelled", async () => {
    const { store, updates, started } = makeStore("ready");
    const controller = new AbortController();
    const pending = store.ensureText(
      "p_test",
      () => undefined,
      controller.signal,
    );

    await started;
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");

    // The UI disables re-extraction while a paper is "pending", so cancelling
    // must leave it in a retryable state.
    expect(updates.map((update) => update.textStatus)).toEqual([
      "pending",
      "ready",
    ]);
  });
});
