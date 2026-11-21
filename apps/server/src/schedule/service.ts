import type {
  AgentEvent,
  AgentToolCall,
  ChatMessageRecord,
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
  toolContentForModel,
  type ToolCallContext,
} from "../llm/tool-loop.js";
import { loadPromptFile } from "../prompt-file.js";
import type { SessionStore } from "../session/store.js";
import type { ToolResult } from "../agent/tools.js";
import type { QuestionServiceLike } from "../interaction/ask-user-question.js";
import type { ScheduleEmailConfigStore } from "./email.js";
import type { ScheduleStore } from "./store.js";
import type { ScheduleToolContext, ScheduleToolExecutor } from "./tools.js";
import { nowClockInTimezone, todayInTimezone, weekdayLabel } from "./time.js";

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
  questions: QuestionServiceLike;
  maxSteps: number;
  historyBudgetChars: number;
}

const READ_ONLY_SCHEDULE_TOOLS = new Set<string>([
  "preferences_get",
  "task_list",
  "fixed_event_list",
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
        priorMessages: scheduleHistoryForModel(
          prior,
          this.deps.historyBudgetChars,
        ),
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
      messageId: context.messageId,
      questions: this.deps.questions,
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
 * status, registered fixed events, backlog size and this week's plan. The
 * system prompt stays stable.
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
  const planBlocks = overview.window?.blocks.length ?? 0;
  const unscheduled = overview.window?.unscheduled.length ?? 0;
  const fixedEvents = overview.fixedEvents;
  const weeklyFixed = fixedEvents.filter((event) => event.kind === "weekly");
  const onceFixed = fixedEvents.filter((event) => event.kind === "once");
  const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const MAX_LISTED_EVENTS = 15;
  const fixedList = fixedEvents
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, MAX_LISTED_EVENTS)
    .map((event) => {
      const when =
        event.kind === "weekly"
          ? (WEEKDAY_LABELS[(event.weekday ?? 1) - 1] ?? "")
          : `${event.date ?? ""}`;
      const location =
        event.location.trim() === "" ? "" : ` @${event.location.trim()}`;
      return `${when} ${event.start}-${event.end} ${event.title}${location}`;
    });

  const lines = [
    `<runtime_context>`,
    `Current environment (refreshed every turn, never persisted):`,
    `- Now: ${new Date().toISOString()} · local ${today} ${weekdayLabel(
      today,
    )} ${nowClockInTimezone(preferences.timezone)} · timezone ${preferences.timezone}`,
    `- Rolling window (today → +6 days): ${overview.rangeStart} ~ ${overview.rangeEnd}`,
    `- Scheduling preferences: ${
      overview.preferencesConfigured
        ? `configured · workdays ${preferences.workdays.join(",")} · ${preferences.workStart}-${preferences.workEnd} · breaks ${
            preferences.breaks.length === 0
              ? "none"
              : preferences.breaks
                  .map(
                    (brk) =>
                      `${brk.label === "" ? "" : brk.label}${brk.start}-${brk.end}`,
                  )
                  .join(",")
          } · max focus ${preferences.maxFocusMinutes}m · daily limit ${preferences.dailyFocusLimitMinutes}m · buffer ${Math.round(
            preferences.bufferRatio * 100,
          )}% · gap ${preferences.gapMinutes}m`
        : "NOT CONFIGURED — ask the user with ask_user_question and save with preferences_update"
    }`,
    `- Scheduling rules (${
      preferences.rules.length
    }): ${
      preferences.rules.length === 0
        ? "none"
        : preferences.rules.join("; ")
    }`,
    `- Fixed events (${fixedEvents.length} total · ${weeklyFixed.length} weekly · ${onceFixed.length} one-off): ${
      fixedList.length === 0
        ? "none registered — register courses/meetings with fixed_event_upsert; a week with only fixed events can still be planned"
        : fixedList.join("; ") +
          (fixedEvents.length > MAX_LISTED_EVENTS
            ? `; …and ${fixedEvents.length - MAX_LISTED_EVENTS} more`
            : "")
    }`,
    `- Active tasks: ${activeTasks.length} · remaining ${Math.round(
      remaining / 6,
    ) / 10}h`,
    upcoming.length > 0
      ? `- Upcoming deadlines: ${upcoming.join("; ")}`
      : `- Upcoming deadlines: none`,
    `- This window's plan: ${
      overview.window === null
        ? "none"
        : `${planBlocks} blocks · ${unscheduled} unscheduled · warnings ${overview.window.warnings.length}`
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

/**
 * Schedule tool results that dump a whole plan or task list; they go stale as
 * soon as the next plan/CRUD call lands.
 */
const STALE_DUMP_TOOLS = new Set<string>([
  "plan_schedule",
  "plan_replan",
  "plan_get",
  "plan_render",
  "plan_email",
  "task_list",
]);

/**
 * Keeps the newest turns intact and replaces stale plan/task dumps with short
 * stubs once the history exceeds the schedule budget (same pattern as the
 * paper service). The UI records are untouched: only the model-facing content
 * of old tool results changes.
 */
export function scheduleHistoryForModel(
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

  // Never compact the current turn: everything before the last user message.
  const lastUserIndex = records.findLastIndex(
    (record) => record.role === "user",
  );
  const protectedIndex = lastUserIndex >= 0 ? lastUserIndex : 0;

  const compactable = records.slice(0, protectedIndex).filter(
    (record) =>
      record.role === "tool" &&
      typeof record.toolName === "string" &&
      STALE_DUMP_TOOLS.has(record.toolName),
  );

  const compacted = new Set<string>();
  let remaining = totalChars;
  // Oldest first: the earliest snapshots are the stalest.
  for (const record of compactable) {
    if (remaining <= budgetChars) break;
    if (record.content.length < 1000) continue;
    compacted.add(record.id);
    remaining -= record.content.length;
    remaining += stubFor(record).length;
  }

  // The most recent dump results carry the block/task ids the next turn is
  // most likely to reference; keep the last two verbatim and only go older.
  if (remaining > budgetChars) {
    const dumps = records.filter(
      (record) =>
        record.role === "tool" &&
        typeof record.toolName === "string" &&
        STALE_DUMP_TOOLS.has(record.toolName),
    );
    const keep = new Set(dumps.slice(-2).map((record) => record.id));
    for (const record of dumps) {
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
  const rangeStart = record.meta?.rangeStart;
  const rangeEnd = record.meta?.rangeEnd;
  const range =
    typeof rangeStart === "string" && typeof rangeEnd === "string"
      ? ` · ${rangeStart}~${rangeEnd}`
      : "";
  return `[Older schedule output omitted from model context: ${record.toolName ?? "tool"}${range} · ${record.content.length} chars. Call ${record.toolName ?? "plan_get"} again if this content is still needed.]`;
}
