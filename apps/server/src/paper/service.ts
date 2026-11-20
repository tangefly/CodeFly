import type {
  AgentEvent,
  AgentToolCall,
  ChatMessageRecord,
  PaperSession,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import type { LlmChatMessage, LlmClientLike } from "../llm/client.js";
import type { LlmConfigStore } from "../llm/config-store.js";
import type { MessageStore } from "../llm/messages.js";
import { loadPromptFile } from "../prompt-file.js";
import type { SessionRunLock } from "../llm/run-lock.js";
import {
  recordsToLlmMessages,
  runToolLoop,
  toolContentForModel,
  type ToolCallContext,
} from "../llm/tool-loop.js";
import type { SessionStore } from "../session/store.js";
import type { ToolResult } from "../agent/tools.js";
import type { ArxivClient } from "./arxiv-client.js";
import type { PaperLibraryStore } from "./library-store.js";
import type { PaperTextStore } from "./text-store.js";
import type { PaperToolContext, PaperToolExecutor } from "./tools.js";

export const DEFAULT_PAPER_PROMPT = loadPromptFile(import.meta.url);

export interface PaperServiceDeps {
  messages: MessageStore;
  llmConfig: LlmConfigStore;
  audit: AuditLog;
  client: LlmClientLike;
  lock: SessionRunLock;
  sessions: SessionStore;
  library: PaperLibraryStore;
  text: PaperTextStore;
  arxiv: ArxivClient;
  tools: PaperToolExecutor;
  maxSteps: number;
  maxReadChars: number;
  historyBudgetChars: number;
}

/** Read-only paper tools may run concurrently; library writes stay ordered. */
const READ_ONLY_PAPER_TOOLS = new Set<string>([
  "arxiv_search",
  "arxiv_get",
  "paper_outline",
  "paper_read",
  "paper_search",
  "library_search",
  "library_export",
]);

const MAX_CONTEXT_PAPERS = 20;

export class PaperService {
  private readonly deps: PaperServiceDeps;

  constructor(deps: PaperServiceDeps) {
    this.deps = deps;
  }

  assertReady(sessionId: string): void {
    if (!this.deps.llmConfig.isConfigured()) {
      throw new AppError(
        "LLM_NOT_CONFIGURED",
        "尚未配置模型 API。请先填写 Base URL 与 Model。",
        400,
      );
    }
    if (this.deps.lock.isBusy(sessionId)) {
      throw new AppError(
        "SESSION_BUSY",
        "当前会话正在执行回合，请等待结束或先停止。",
        409,
      );
    }
  }

  isBusy(sessionId: string): boolean {
    return this.deps.lock.isBusy(sessionId);
  }

  async run(
    session: PaperSession,
    content: string,
    clientSignal: AbortSignal,
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    this.assertReady(session.id);
    if (clientSignal.aborted) return;

    const config = this.deps.llmConfig.getInternal();
    const toolDefinitions = this.deps.tools.definitions();
    const prior = this.deps.messages.list(session.id);
    const contextMessages = [
      runtimeContextMessage(
        session,
        this.deps.library,
        toolDefinitions.map((definition) => definition.function.name),
      ),
    ];

    await runToolLoop(
      {
        runKind: "paper",
        sessionId: session.id,
        config,
        maxSteps: this.deps.maxSteps,
        systemPrompt: DEFAULT_PAPER_PROMPT,
        toolDefinitions,
        contextMessages,
        messages: this.deps.messages,
        lock: this.deps.lock,
        audit: this.deps.audit,
        client: this.deps.client,
        priorMessages: paperHistoryForModel(prior, this.deps.historyBudgetChars),
        isParallelTool: (name) => READ_ONLY_PAPER_TOOLS.has(name),
        executeTool: (call, context) =>
          this.executeToolCall(session, call, context, emit),
        auditType: "paper.run",
        auditExtra: { paperIds: session.paperIds },
      },
      content,
      clientSignal,
      emit,
    );
  }

  private async executeToolCall(
    session: PaperSession,
    call: AgentToolCall,
    context: ToolCallContext,
    emit: (event: AgentEvent) => void,
  ): Promise<ToolResult> {
    const addToContext = async (paperId: string): Promise<PaperSession> => {
      const current = this.deps.sessions.getPaperOrThrow(session.id);
      if (current.paperIds.includes(paperId)) return current;
      const updated = await this.deps.sessions.addPaperToContext(
        session.id,
        paperId,
      );
      void this.deps.audit.append({
        type: "paper.context.changed",
        sessionId: session.id,
        add: paperId,
        paperIds: updated.paperIds,
      });
      emit({ type: "session.updated", session: updated });
      return updated;
    };

    const toolContext: PaperToolContext = {
      session,
      signal: context.signal,
      emit,
      progress: context.progress,
      toolCallId: context.toolCallId,
      maxReadChars: this.deps.maxReadChars,
      addToContext,
    };

    try {
      return await this.deps.tools.execute(
        call.name,
        call.arguments,
        toolContext,
      );
    } catch (error) {
      return {
        content: `Tool execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        status: "error",
        meta: { kind: "error" },
      };
    }
  }
}

/**
 * Volatile per-run facts (date, library stats, session papers, tool list) as
 * one ephemeral user-role message. The system prompt stays stable; the model
 * always sees exactly the latest snapshot.
 */
function runtimeContextMessage(
  session: PaperSession,
  library: PaperLibraryStore,
  availableTools: string[],
): LlmChatMessage {
  const contextLines: string[] = [];
  for (const paperId of session.paperIds.slice(0, MAX_CONTEXT_PAPERS)) {
    const paper = library.get(paperId);
    if (paper === undefined) continue;
    const details = [
      paper.arxivId ? `arXiv ${paper.arxivId}` : "local PDF",
      paper.status,
      paper.pageCount !== null ? `${paper.pageCount} pages` : null,
      paper.tags.length > 0 ? `tags: ${paper.tags.join(",")}` : null,
      paper.summary.trim() !== "" ? "has structured notes" : null,
    ].filter((item): item is string => item !== null);
    contextLines.push(
      `- ${paper.id} · ${paper.title} (${details.join(" · ")})`,
    );
  }

  const stats = library.list({ limit: 1 }).total;
  return {
    role: "user",
    content: `<runtime_context>
Current environment (refreshed every turn):
- Date: ${new Date().toISOString().slice(0, 10)}
- Library: ${stats} papers
- Papers in this session's context:
${contextLines.length > 0 ? contextLines.join("\n") : "- (empty — add papers with library_add or by reading an arXiv ID)"}
- Enabled tools: ${availableTools.length > 0 ? availableTools.join(", ") : "(none)"}
</runtime_context>`,
  };
}

/**
 * Keeps the newest turns intact and replaces stale full-text reads with short
 * stubs once the history exceeds the paper budget. The UI records are untouched.
 */
export function paperHistoryForModel(
  records: ChatMessageRecord[],
  budgetChars: number,
): ReturnType<typeof recordsToLlmMessages> {
  const totalChars = records.reduce(
    (total, record) => total + record.content.length,
    0,
  );
  if (totalChars <= budgetChars) {
    return recordsToLlmMessages(records);
  }

  const userIndices = records
    .map((record, index) => (record.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  // Keep the current (last) user turn verbatim and compact older reads first.
  const protectedIndex =
    userIndices.length > 0 ? userIndices[userIndices.length - 1]! : 0;

  const compactable: ChatMessageRecord[] = [];
  for (let index = 0; index < protectedIndex; index += 1) {
    const record = records[index]!;
    if (
      record.role === "tool" &&
      typeof record.toolName === "string" &&
      (record.toolName === "paper_read" ||
        record.toolName === "paper_search" ||
        record.toolName === "arxiv_search" ||
        record.toolName === "library_search")
    ) {
      compactable.push(record);
    }
  }

  const compacted = new Set<string>();
  let remaining = totalChars;
  // Oldest first. Full-text reads are the largest and should go first.
  for (const record of compactable) {
    if (remaining <= budgetChars) break;
    if (record.content.length < 1000) continue;
    compacted.add(record.id);
    remaining -= record.content.length;
    remaining += stubFor(record).length;
  }

  // A single very long reading turn can still exceed the budget. Keep the two
  // most recent full-text reads and stub the earlier ones.
  if (remaining > budgetChars) {
    const reads = records.filter(
      (record) => record.role === "tool" && record.toolName === "paper_read",
    );
    const keep = new Set(reads.slice(-2).map((record) => record.id));
    for (const record of reads) {
      if (remaining <= budgetChars) break;
      if (keep.has(record.id) || compacted.has(record.id)) continue;
      if (record.content.length < 1000) continue;
      compacted.add(record.id);
      remaining -= record.content.length;
      remaining += stubFor(record).length;
    }
  }

  return recordsToLlmMessages(records, {
    toolContent: (record) =>
      compacted.has(record.id)
        ? stubFor(record)
        : toolContentForModel(record.content, record.meta),
  });
}

function stubFor(record: ChatMessageRecord): string {
  const meta = record.meta;
  const title =
    typeof meta?.paperTitle === "string"
      ? meta.paperTitle
      : typeof meta?.paperId === "string"
        ? meta.paperId
        : record.toolName ?? "tool";
  const pages =
    typeof meta?.pageRange === "string" ? ` pages ${meta.pageRange}` : "";
  return `[Older tool output omitted from model context: ${record.toolName ?? "tool"} · ${title}${pages} · ${record.content.length} chars. Call paper_read again if this content is needed.]`;
}
