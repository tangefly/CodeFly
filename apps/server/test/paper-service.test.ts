import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  ArxivPaper,
  AuditEvent,
  PaperSession,
} from "@codefly/protocol";
import type { AuditLog } from "../src/audit/log.js";
import type {
  LlmChatMessage,
  LlmClientLike,
  LlmCompleteResult,
  LlmStreamResult,
  LlmToolDefinition,
  StreamChatOptions,
} from "../src/llm/client.js";
import {
  LlmConfigStore,
  type LlmInternalConfig,
} from "../src/llm/config-store.js";
import { MessageStore } from "../src/llm/messages.js";
import { SessionRunLock } from "../src/llm/run-lock.js";
import { SessionStore } from "../src/session/store.js";
import type { ArxivClient } from "../src/paper/arxiv-client.js";
import { PaperLibraryStore } from "../src/paper/library-store.js";
import { PaperService } from "../src/paper/service.js";
import type { PaperTextStore } from "../src/paper/text-store.js";
import { PaperToolExecutor } from "../src/paper/tools.js";

const arxivPaper: ArxivPaper = {
  arxivId: "2501.01234",
  version: 1,
  title: "A Test Paper about Retrieval",
  authors: ["Ada Lovelace"],
  abstract: "We study retrieval augmented generation.",
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

class FakePaperClient implements LlmClientLike {
  calls: LlmChatMessage[][] = [];
  toolSets: LlmToolDefinition[][] = [];
  private count = 0;

  async streamChat(
    _config: LlmInternalConfig,
    messages: LlmChatMessage[],
    onDelta: (text: string) => void,
    _signal: AbortSignal,
    options?: StreamChatOptions,
  ): Promise<LlmStreamResult> {
    this.calls.push(messages);
    this.toolSets.push(options?.tools ?? []);
    if (this.count === 0) {
      this.count += 1;
      onDelta("adding");
      return {
        content: "adding",
        finishReason: "tool_calls",
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        toolCalls: [
          {
            id: "call_1",
            name: "library_add",
            arguments: '{"arxiv_id":"2501.01234","tags":["rag"]}',
          },
        ],
      };
    }
    onDelta("done");
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }

  async complete(): Promise<LlmCompleteResult> {
    return { content: "OK", latencyMs: 1, model: "test-model" };
  }
}

function fakeText(): PaperTextStore {
  return {
    outline: async (paperId: string) => ({
      paperId,
      pageCount: 4,
      charCount: 12_000,
      sections: [{ title: "Abstract", startPage: 1, endPage: 1 }],
    }),
    readPages: async (
      _paperId: string,
      startPage: number,
      endPage: number,
    ) => ({
      text: "paper content",
      startPage,
      endPage,
      chars: 100,
    }),
    readSection: async () => ({
      text: "section content",
      section: { title: "Abstract", startPage: 1, endPage: 1 },
      startPage: 1,
      endPage: 1,
      chars: 100,
    }),
    search: async () => [{ page: 1, excerpt: "retrieval" }],
  } as unknown as PaperTextStore;
}

function fakeArxiv(): ArxivClient {
  return {
    search: async () => [arxivPaper],
    getById: async () => arxivPaper,
    downloadPdf: async () => "/tmp/paper.pdf",
  } as unknown as ArxivClient;
}

describe("PaperService", () => {
  let dir: string;
  let sessions: SessionStore;
  let library: PaperLibraryStore;
  let messages: MessageStore;
  let client: FakePaperClient;
  let service: PaperService;
  let session: PaperSession;
  let auditEvents: AuditEvent[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-paper-service-"));
    sessions = new SessionStore(path.join(dir, "sessions.json"));
    await sessions.init();
    session = (await sessions.create(
      undefined,
      "paper test",
      "read-only",
      "paper",
    )) as PaperSession;

    const llmConfig = new LlmConfigStore(path.join(dir, "llm.json"));
    await llmConfig.init();
    await llmConfig.update({
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "key",
    });
    messages = new MessageStore(path.join(dir, "messages.json"));
    await messages.init();
    library = new PaperLibraryStore(path.join(dir, "library.json"));
    await library.init();
    client = new FakePaperClient();
    auditEvents = [];
    const audit = {
      append: async (event: AuditEvent) => {
        auditEvents.push({ ...event, ts: new Date().toISOString() });
      },
      recent: async () => [],
    } as unknown as AuditLog;
    const arxiv = fakeArxiv();
    service = new PaperService({
      messages,
      llmConfig,
      audit,
      client,
      lock: new SessionRunLock(),
      sessions,
      library,
      text: fakeText(),
      arxiv,
      tools: new PaperToolExecutor({
        library,
        text: fakeText(),
        arxiv,
      }),
      maxSteps: 10,
      maxReadChars: 20_000,
      historyBudgetChars: 100_000,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a paper tool and persists the turn", async () => {
    const events: AgentEvent[] = [];
    await service.run(session, "add this paper", new AbortController().signal, (event) =>
      events.push(event),
    );

    const records = messages.list(session.id);
    expect(records.map((record) => record.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(records[2]).toMatchObject({
      toolName: "library_add",
      status: "complete",
    });
    expect(records[3]).toMatchObject({ content: "done" });

    const paper = library.getByArxivId("2501.01234");
    expect(paper).toBeDefined();
    expect(paper?.tags).toEqual(["rag"]);
    expect(sessions.getPaperOrThrow(session.id).paperIds).toContain(paper?.id);

    expect(events.map((event) => event.type)).toContain("agent.tool.finished");
    expect(events.map((event) => event.type)).toContain("session.updated");
    expect(events.at(-1)).toMatchObject({ type: "agent.done" });

    expect(client.toolSets[0]?.map((tool) => tool.function.name)).toEqual([
      "arxiv_search",
      "arxiv_get",
      "paper_outline",
      "paper_read",
      "paper_search",
      "library_add",
      "library_search",
      "library_update",
      "library_export",
    ]);
    const system = client.calls[0]?.[0];
    expect(system?.role).toBe("system");
    expect(String(system?.content)).toContain("论文库");
    expect(String(client.calls[0]?.[1]?.content)).toBe("add this paper");
    const toolResult = client.calls[1]?.find((message) => message.role === "tool");
    expect(String(toolResult?.content)).toContain("A Test Paper about Retrieval");
    expect(auditEvents.some((event) => event.type === "paper.run")).toBe(true);
  });
});
