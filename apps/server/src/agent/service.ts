import type {
  AgentEvent,
  AgentSession,
  AgentToolCall,
  AgentToolName,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import type { ExecService } from "../exec/service.js";
import type { LlmClientLike } from "../llm/client.js";
import {
  recordsToLlmMessages,
  runToolLoop,
  type ToolCallContext,
} from "../llm/tool-loop.js";
import {
  DEFAULT_AGENT_PROMPT,
  type AgentConfigStore,
  type AgentInternalSettings,
} from "./config-store.js";
import type { LlmConfigStore } from "../llm/config-store.js";
import type { MessageStore } from "../llm/messages.js";
import type { SessionRunLock } from "../llm/run-lock.js";
import { agentContextMessages } from "./context.js";
import { toolGuidanceSection } from "./tool-guidance.js";
import type {
  AgentToolExecutorLike,
  ToolExecutionContext,
  ToolResult,
} from "./tools.js";

/** Tools that only read state and can safely run concurrently. */
const READ_ONLY_TOOL_NAMES = new Set<string>([
  "read_file",
  "read_image",
  "list_files",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
]);

export interface AgentServiceDeps {
  messages: MessageStore;
  llmConfig: LlmConfigStore;
  agentConfig: AgentConfigStore;
  audit: AuditLog;
  client: LlmClientLike;
  tools: AgentToolExecutorLike;
  lock: SessionRunLock;
  exec: ExecService;
  dataDir: string;
  maxReadBytes: number;
  maxWriteBytes: number;
}

export class AgentService {
  private readonly deps: AgentServiceDeps;

  constructor(deps: AgentServiceDeps) {
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
    session: AgentSession,
    content: string,
    clientSignal: AbortSignal,
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    this.assertReady(session.id);
    if (clientSignal.aborted) return;

    const config = this.deps.llmConfig.getInternal();
    const settings = this.deps.agentConfig.getInternal();
    const toolDefinitions = this.deps.tools.definitions(settings.enabledTools);
    const enabledTools = new Set<string>(settings.enabledTools);
    const prior = this.deps.messages.list(session.id);
    const system = buildSystemPrompt(settings);
    const contextMessages = await agentContextMessages(
      session,
      settings.enabledTools,
    );

    await runToolLoop(
      {
        runKind: "agent",
        sessionId: session.id,
        config,
        maxSteps: settings.maxSteps,
        systemPrompt: system,
        toolDefinitions,
        contextMessages,
        messages: this.deps.messages,
        lock: this.deps.lock,
        audit: this.deps.audit,
        client: this.deps.client,
        priorMessages: recordsToLlmMessages(prior),
        isParallelTool: (name) =>
          enabledTools.has(name) && READ_ONLY_TOOL_NAMES.has(name),
        executeTool: (call, context) =>
          this.executeToolCall(session, settings, call, context),
        auditType: "agent.run",
        auditExtra: { enabledTools: settings.enabledTools },
      },
      content,
      clientSignal,
      emit,
    );
  }

  private async executeToolCall(
    session: AgentSession,
    settings: AgentInternalSettings,
    call: AgentToolCall,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    if (!settings.enabledTools.includes(call.name as AgentToolName)) {
      return {
        content: `Tool "${call.name}" is not enabled for this agent session.`,
        status: "error",
        meta: { kind: "error" },
      };
    }

    const toolContext: ToolExecutionContext = {
      session,
      dataDir: this.deps.dataDir,
      maxReadBytes: this.deps.maxReadBytes,
      maxWriteBytes: this.deps.maxWriteBytes,
      commandTimeoutMs: settings.commandTimeoutMs,
      exec: this.deps.exec,
      audit: this.deps.audit,
      signal: context.signal,
      emit: context.emit,
      toolCallId: context.toolCallId,
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
 * Stable system prompt: user persona prefix, the harness-owned base prompt,
 * guidance for the currently enabled tools, and the persona suffix. Volatile
 * facts (workspace, permissions, tool list) live in the per-run runtime
 * context message instead, so this prompt only changes when guidance does.
 */
function buildSystemPrompt(settings: AgentInternalSettings): string {
  return [
    settings.personaPrefix.trim(),
    DEFAULT_AGENT_PROMPT,
    toolGuidanceSection(settings.enabledTools),
    settings.personaSuffix.trim(),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}
