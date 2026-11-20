import type {
  AgentEvent,
  AgentToolCall,
  ScheduleSession,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import type { LlmChatMessage, LlmClientLike } from "../llm/client.js";
import type { LlmConfigStore } from "../llm/config-store.js";
import type { MessageStore } from "../llm/messages.js";
import type { SessionRunLock } from "../llm/run-lock.js";
import {
  recordsToLlmMessages,
  runToolLoop,
  type ToolCallContext,
} from "../llm/tool-loop.js";
import { loadPromptFile } from "../prompt-file.js";
import type { SessionStore } from "../session/store.js";
import type { ToolResult } from "../agent/tools.js";
import type { ScheduleEmailConfigStore } from "./email.js";
import type { ScheduleStore } from "./store.js";
import type { ScheduleToolContext, ScheduleToolExecutor } from "./tools.js";
import { todayInTimezone, weekdayLabel } from "./time.js";

export const DEFAULT_SCHEDULE_PROMPT = loadPromptFile(import.meta.url);

export interface ScheduleServiceDeps {
  messages: MessageStore;
  llmConfig: LlmConfigStore;
  audit: AuditLog;
  client: LlmClientLike;
  lock: SessionRunLock;
  sessions: SessionStore;
  store: ScheduleStore;
  email: ScheduleEmailConfigStore;
  tools: ScheduleToolExecutor;
  maxSteps: number;
}

const READ_ONLY_SCHEDULE_TOOLS = new Set<string>([
  "memory_search",
  "task_list",
  "plan_get",
]);

export class ScheduleService {
  private readonly deps: ScheduleServiceDeps;

  constructor(deps: ScheduleServiceDeps) {
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
    session: ScheduleSession,
    content: string,
    clientSignal: AbortSignal,
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    this.assertReady(session.id);
    if (clientSignal.aborted) return;

    const config = this.deps.llmConfig.getInternal();
    const toolDefinitions = this.deps.tools.definitions();
    const prior = this.deps.messages.list(session.id);

    await runToolLoop(
      {
        runKind: "schedule",
        sessionId: session.id,
        config,
        maxSteps: this.deps.maxSteps,
        systemPrompt: DEFAULT_SCHEDULE_PROMPT,
        toolDefinitions,
        contextMessages: [
          runtimeContextMessage(
            this.deps.store,
            this.deps.email,
            toolDefinitions.map((definition) => definition.function.name),
          ),
        ],
        messages: this.deps.messages,
        lock: this.deps.lock,
        audit: this.deps.audit,
        client: this.deps.client,
        priorMessages: recordsToLlmMessages(prior),
        isParallelTool: (name) => READ_ONLY_SCHEDULE_TOOLS.has(name),
        executeTool: (call, context) =>
          this.executeToolCall(session, call, context),
        auditType: "schedule.run",
      },
      content,
      clientSignal,
      emit,
    );
  }

  private async executeToolCall(
    session: ScheduleSession,
    call: AgentToolCall,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const toolContext: ScheduleToolContext = {
      session,
      signal: context.signal,
      emit: context.emit,
      progress: context.progress,
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
 * Volatile facts refreshed every turn: current date/timezone, preference
 * status, backlog size and this week's plan. The system prompt stays stable.
 */
function runtimeContextMessage(
  store: ScheduleStore,
  email: ScheduleEmailConfigStore,
  availableTools: string[],
): LlmChatMessage {
  const preferences = store.getPreferences();
  const today = todayInTimezone(preferences.timezone);
  const overview = store.overview(today);
  const activeTasks = overview.tasks.filter(
    (task) =>
      (task.status === "todo" || task.status === "in_progress") &&
      task.remainingMinutes > 0,
  );
  const remaining = activeTasks.reduce(
    (total, task) => total + task.remainingMinutes,
    0,
  );
  const upcoming = activeTasks
    .filter((task) => task.deadline !== null)
    .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""))
    .slice(0, 5)
    .map((task) => `${task.title}（${task.deadline}）`);
  const planBlocks = overview.plan?.blocks.length ?? 0;
  const unscheduled = overview.plan?.unscheduled.length ?? 0;

  const lines = [
    `<runtime_context>`,
    `Current environment (refreshed every turn, never persisted):`,
    `- Now: ${new Date().toISOString()} · local date ${today} (${weekdayLabel(
      today,
    )}) · timezone ${preferences.timezone}`,
    `- This week: ${overview.weekStart} ~ ${overview.weekEnd}`,
    `- Scheduling preferences: ${
      overview.preferencesConfigured
        ? `configured · workdays ${preferences.workdays.join(",")} · ${preferences.workStart}-${preferences.workEnd} · max focus ${preferences.maxFocusMinutes}m · daily limit ${preferences.dailyFocusLimitMinutes}m`
        : "NOT CONFIGURED — ask the user and save memory key=scheduling_preferences"
    }`,
    `- Active tasks: ${activeTasks.length} · remaining ${Math.round(
      remaining / 6,
    ) / 10}h`,
    upcoming.length > 0
      ? `- Upcoming deadlines: ${upcoming.join("; ")}`
      : `- Upcoming deadlines: none`,
    `- Memories: ${overview.memories.length} documents`,
    `- This week's plan: ${
      overview.plan === null
        ? "none"
        : `${planBlocks} blocks · ${unscheduled} unscheduled · warnings ${overview.plan.warnings.length}`
    }`,
    `- Estimate calibration: ${
      overview.calibration.ratio === null
        ? "no completed-task history"
        : `${overview.calibration.completedTasks} completed · actual/estimate ${overview.calibration.ratio}`
    }`,
    `- Email: ${email.isConfigured() ? "configured" : "not configured"}`,
    `- Enabled tools: ${availableTools.length > 0 ? availableTools.join(", ") : "(none)"}`,
    `</runtime_context>`,
  ];
  return { role: "user", content: lines.join("\n") };
}
