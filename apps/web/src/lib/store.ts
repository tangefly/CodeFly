import { create } from "zustand";
import type {
  AgentEvent,
  AgentSettingsInput,
  AgentSettingsPublic,
  AgentToolCall,
  AgentToolMeta,
  ApprovalDecision,
  ApprovalRequest,
  AuditEvent,
  ChatEvent,
  ChatMessageRecord,
  ChatUsage,
  LlmSettingsInput,
  LlmSettingsPublic,
  LlmTestInput,
  LlmTestResult,
  SandboxMode,
  SandboxStatus,
  Session,
  Settings,
} from "@codefly/protocol";
import { api, asApiError, clearToken, getToken, saveToken } from "./api.js";
import { isAbortError, streamSse } from "./sse.js";
import { MODE_LABEL, uid } from "./utils.js";

interface BaseMessage {
  id: string;
  createdAt: number;
}

export interface UserMessage extends BaseMessage {
  kind: "user";
  text: string;
}

export interface AssistantMessage extends BaseMessage {
  kind: "assistant";
  text: string;
  /** Streamed reasoning/thinking text, when the provider returns it. */
  reasoning?: string;
  streaming: boolean;
  error?: string;
  cancelled?: boolean;
  model?: string;
  usage?: ChatUsage;
  durationMs?: number;
  firstTokenMs?: number;
  toolCalls?: AgentToolCall[];
}

export interface ToolMessage extends BaseMessage {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  arguments: string;
  content: string;
  status: "running" | "complete" | "error" | "cancelled";
  meta?: AgentToolMeta;
}

export interface SystemMessage extends BaseMessage {
  kind: "system";
  text: string;
}

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ToolMessage;

export type AppPhase = "loading" | "token-required" | "error" | "ready";

interface UiState {
  sidebarOpen: boolean;
  newSessionOpen: boolean;
  settingsOpen: boolean;
  auditOpen: boolean;
  llmSettingsOpen: boolean;
  agentSettingsOpen: boolean;
}

interface Notification {
  id: number;
  kind: "info" | "error";
  message: string;
}

export interface AppState {
  phase: AppPhase;
  error: string | null;
  notification: Notification | null;
  sessions: Session[];
  currentSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  approvals: ApprovalRequest[];
  settings: Settings | null;
  llmSettings: LlmSettingsPublic | null;
  agentSettings: AgentSettingsPublic | null;
  sandbox: SandboxStatus | null;
  dev: boolean;
  audit: AuditEvent[];
  /** Per-session chat request in flight, including before the first token. */
  chatBusy: Record<string, boolean>;
  /** Per-session agent run in flight. */
  agentBusy: Record<string, boolean>;
  ui: UiState;

  init(): Promise<void>;
  setToken(token: string): Promise<void>;
  selectSession(id: string): void;
  ensureMessagesLoaded(sessionId: string): Promise<void>;
  createSession(workspaceRoot: string, title?: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  updatePermissions(mode: SandboxMode, confirmRisk?: boolean): Promise<boolean>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  sendChat(text: string): Promise<void>;
  cancelChat(): void;
  sendAgent(text: string): Promise<void>;
  cancelAgent(): void;
  saveLlmSettings(input: LlmSettingsInput): Promise<boolean>;
  testLlm(input: LlmTestInput): Promise<LlmTestResult>;
  saveAgentSettings(input: AgentSettingsInput): Promise<boolean>;
  refreshAudit(): Promise<void>;
  saveDefaultPreset(mode: SandboxMode): Promise<boolean>;
  notify(kind: Notification["kind"], message: string): void;
  clearNotification(): void;
  toggleSidebar(): void;
  closeSidebar(): void;
  openNewSession(): void;
  closeNewSession(): void;
  openSettings(): void;
  closeSettings(): void;
  openLlmSettings(): void;
  closeLlmSettings(): void;
  openAgentSettings(): void;
  closeAgentSettings(): void;
  openAudit(): void;
  closeAudit(): void;
}

const CURRENT_SESSION_KEY = "codefly.currentSession";

const chatAborters = new Map<string, AbortController>();
const agentAborters = new Map<string, AbortController>();
const loadedSessionIds = new Set<string>();

type Setter = (updater: (state: AppState) => Partial<AppState>) => void;
type Getter = () => AppState;

function withMessages(
  state: AppState,
  sessionId: string,
  updater: (list: ChatMessage[]) => ChatMessage[],
): Partial<AppState> {
  return {
    messages: {
      ...state.messages,
      [sessionId]: updater(state.messages[sessionId] ?? []),
    },
  };
}

function patchAssistant(
  state: AppState,
  sessionId: string,
  messageId: string,
  updater: (message: AssistantMessage) => AssistantMessage,
): Partial<AppState> {
  return withMessages(state, sessionId, (list) =>
    list.map((message) =>
      message.id === messageId && message.kind === "assistant"
        ? updater(message)
        : message,
    ),
  );
}

function systemMessage(text: string): SystemMessage {
  return { id: uid(), kind: "system", text, createdAt: Date.now() };
}

function storedToUi(record: ChatMessageRecord, live = false): ChatMessage | null {
  const parsed = Date.parse(record.createdAt);
  const createdAt = Number.isNaN(parsed) ? Date.now() : parsed;
  if (record.role === "user") {
    return { id: record.id, kind: "user", text: record.content, createdAt };
  }
  if (record.role === "assistant") {
    const interrupted = record.status === "streaming" && !live;
    return {
      id: record.id,
      kind: "assistant",
      text: record.content,
      reasoning: record.reasoning,
      streaming: live && record.status === "streaming",
      error: record.status === "error" ? record.error : undefined,
      cancelled: record.status === "cancelled" || interrupted,
      model: record.model,
      usage: record.usage,
      durationMs: record.durationMs,
      firstTokenMs: record.firstTokenMs,
      toolCalls: record.toolCalls,
      createdAt,
    };
  }
  if (record.role === "tool") {
    const status =
      record.status === "streaming"
        ? "running"
        : record.status === "error"
          ? "error"
          : record.status === "cancelled"
            ? "cancelled"
            : "complete";
    return {
      id: record.id,
      kind: "tool",
      toolCallId: record.toolCallId ?? "",
      toolName: record.toolName ?? "tool",
      arguments: record.toolArguments ?? "",
      content: record.content,
      status,
      meta: record.meta,
      createdAt,
    };
  }
  return null;
}

function appendStoredMessages(
  state: AppState,
  sessionId: string,
  records: ChatMessageRecord[],
): Partial<AppState> {
  const ui = records
    .map((record) => storedToUi(record, true))
    .filter((message): message is ChatMessage => message !== null);
  return withMessages(state, sessionId, (list) => [...list, ...ui]);
}

function settleStreaming(
  state: AppState,
  sessionId: string,
  update: { error?: string; cancelled?: boolean },
): Partial<AppState> {
  return withMessages(state, sessionId, (list) =>
    list.map((message) =>
      message.kind === "assistant" && message.streaming
        ? {
            ...message,
            streaming: false,
            ...(update.error !== undefined ? { error: update.error } : {}),
            ...(update.cancelled ? { cancelled: true } : {}),
          }
        : message,
    ),
  );
}

function settleAgentStreaming(
  state: AppState,
  sessionId: string,
  update: { error?: string; cancelled?: boolean },
): Partial<AppState> {
  return withMessages(state, sessionId, (list) =>
    list.map((message) => {
      if (message.kind === "assistant" && message.streaming) {
        return {
          ...message,
          streaming: false,
          ...(update.error !== undefined ? { error: update.error } : {}),
          ...(update.cancelled ? { cancelled: true } : {}),
        };
      }
      if (message.kind === "tool" && message.status === "running") {
        return {
          ...message,
          status: update.cancelled ? "cancelled" : "error",
          content: message.content || update.error || "",
        };
      }
      return message;
    }),
  );
}

function upsertStoredMessage(
  state: AppState,
  sessionId: string,
  record: ChatMessageRecord,
  live = true,
): Partial<AppState> {
  const message = storedToUi(record, live);
  if (!message) return {};
  return withMessages(state, sessionId, (list) => {
    const index = list.findIndex((candidate) => candidate.id === message.id);
    if (index < 0) return [...list, message];
    const next = [...list];
    next[index] = { ...list[index], ...message } as ChatMessage;
    return next;
  });
}

export const useAppStore = create<AppState>()((set, get) => ({
  phase: "loading",
  error: null,
  notification: null,
  sessions: [],
  currentSessionId: null,
  messages: {},
  approvals: [],
  settings: null,
  llmSettings: null,
  agentSettings: null,
  sandbox: null,
  dev: false,
  audit: [],
  chatBusy: {},
  agentBusy: {},
  ui: {
    sidebarOpen: false,
    newSessionOpen: false,
    settingsOpen: false,
    auditOpen: false,
    llmSettingsOpen: false,
    agentSettingsOpen: false,
  },

  init: async () => {
    if (!getToken()) {
      set({ phase: "token-required" });
      return;
    }

    set({ phase: "loading", error: null });
    try {
      const [health, sessionsResponse, settingsResponse, llmResponse, agentResponse] =
        await Promise.all([
          api.health(),
          api.listSessions(),
          api.getSettings(),
          api.getLlmSettings(),
          api.getAgentSettings(),
        ]);

      const sessions = sessionsResponse.sessions;
      const remembered =
        typeof localStorage === "undefined"
          ? null
          : localStorage.getItem(CURRENT_SESSION_KEY);
      const current =
        sessions.find((session) => session.id === get().currentSessionId)?.id ??
        sessions.find((session) => session.id === remembered)?.id ??
        sessions[0]?.id ??
        null;

      set({
        phase: "ready",
        error: null,
        sessions,
        currentSessionId: current,
        settings: settingsResponse.settings,
        llmSettings: llmResponse.settings,
        agentSettings: agentResponse.settings,
        sandbox: health.sandbox,
        dev: health.dev,
      });

      if (current) void get().ensureMessagesLoaded(current);
    } catch (error) {
      const apiError = asApiError(error);
      if (apiError.status === 401) {
        clearToken();
        set({ phase: "token-required", error: "令牌无效或已过期，请重新输入。" });
      } else {
        set({ phase: "error", error: apiError.message });
      }
    }
  },

  setToken: async (token: string) => {
    saveToken(token);
    await get().init();
  },

  selectSession: (id: string) => {
    if (!get().sessions.some((session) => session.id === id)) return;
    try {
      localStorage.setItem(CURRENT_SESSION_KEY, id);
    } catch {
      // localStorage can be unavailable; selection still works in memory.
    }
    set({ currentSessionId: id, ui: { ...get().ui, sidebarOpen: false } });
    void get().ensureMessagesLoaded(id);
  },

  ensureMessagesLoaded: async (sessionId: string) => {
    if (loadedSessionIds.has(sessionId)) return;

    loadedSessionIds.add(sessionId);
    try {
      const { messages } = await api.messages(sessionId);
      const ui = messages
        .map((record) => storedToUi(record))
        .filter((message): message is ChatMessage => message !== null);

      set((state) => {
        const existing = state.messages[sessionId] ?? [];
        const existingIds = new Set(existing.map((message) => message.id));
        const older = ui.filter((message) => !existingIds.has(message.id));
        return {
          messages: { ...state.messages, [sessionId]: [...older, ...existing] },
        };
      });
    } catch (error) {
      loadedSessionIds.delete(sessionId);
      get().notify(
        "error",
        `加载聊天记录失败：${asApiError(error).message}`,
      );
    }
  },

  createSession: async (workspaceRoot: string, title?: string) => {
    try {
      const { session } = await api.createSession(workspaceRoot, title);
      loadedSessionIds.add(session.id);
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
        messages: {
          ...state.messages,
          [session.id]: [
            systemMessage(`会话已创建，工作区：${session.workspaceRoot}`),
          ],
        },
        ui: { ...state.ui, newSessionOpen: false, sidebarOpen: false },
      }));
      try {
        localStorage.setItem(CURRENT_SESSION_KEY, session.id);
      } catch {
        // Ignore storage failures.
      }
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  deleteSession: async (sessionId: string) => {
    const state = get();
    if (
      state.chatBusy[sessionId] ||
      state.agentBusy[sessionId] ||
      chatAborters.has(sessionId) ||
      agentAborters.has(sessionId)
    ) {
      get().notify("info", "当前会话正在执行回合，请先停止后再删除");
      return false;
    }

    try {
      await api.deleteSession(sessionId);
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }

    loadedSessionIds.delete(sessionId);
    const remaining = get().sessions.filter((session) => session.id !== sessionId);
    const wasCurrent = get().currentSessionId === sessionId;
    const nextId = wasCurrent
      ? (remaining[0]?.id ?? null)
      : get().currentSessionId;

    set((current) => {
      const messages = { ...current.messages };
      delete messages[sessionId];
      const chatBusy = { ...current.chatBusy };
      delete chatBusy[sessionId];
      const agentBusy = { ...current.agentBusy };
      delete agentBusy[sessionId];
      return {
        sessions: remaining,
        currentSessionId: nextId,
        messages,
        chatBusy,
        agentBusy,
        approvals: current.approvals.filter(
          (approval) => approval.sessionId !== sessionId,
        ),
      };
    });

    try {
      if (nextId) localStorage.setItem(CURRENT_SESSION_KEY, nextId);
      else localStorage.removeItem(CURRENT_SESSION_KEY);
    } catch {
      // Ignore storage failures.
    }

    if (nextId) void get().ensureMessagesLoaded(nextId);
    get().notify("info", "会话已删除");
    return true;
  },

  updatePermissions: async (mode: SandboxMode, confirmRisk?: boolean) => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return false;
    try {
      const { session } = await api.updatePermissions(sessionId, {
        mode,
        confirmRisk: confirmRisk === true ? true : undefined,
      });
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === session.id ? session : candidate,
        ),
        ...withMessages(state, session.id, (list) => [
          ...list,
          systemMessage(`权限已切换为「${MODE_LABEL[session.mode]}」`),
        ]),
      }));
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  decideApproval: async (approvalId: string, decision: ApprovalDecision) => {
    const approval = get().approvals.find((candidate) => candidate.id === approvalId);
    if (!approval) return;
    try {
      await api.decideApproval(approval.execId, decision);
      set((state) => ({
        approvals: state.approvals.filter((candidate) => candidate.id !== approvalId),
      }));
    } catch (error) {
      const apiError = asApiError(error);
      get().notify("error", apiError.message);
      if (apiError.code === "APPROVAL_NOT_PENDING") {
        set((state) => ({
          approvals: state.approvals.filter((candidate) => candidate.id !== approvalId),
        }));
      }
    }
  },

  sendChat: async (text: string) => {
    const state = get();
    const sessionId = state.currentSessionId;
    if (!sessionId) return;
    const content = text.trim();
    if (!content) return;

    if (!state.llmSettings?.configured) {
      get().notify("info", "聊天需要先配置模型 API");
      get().openLlmSettings();
      return;
    }
    if (
      state.chatBusy[sessionId] ||
      state.agentBusy[sessionId] ||
      chatAborters.has(sessionId) ||
      agentAborters.has(sessionId)
    ) {
      get().notify("info", "当前会话正在执行回合，请等待结束或先停止");
      return;
    }

    const controller = new AbortController();
    chatAborters.set(sessionId, controller);
    set((current) => ({
      chatBusy: { ...current.chatBusy, [sessionId]: true },
    }));

    let finished = false;
    try {
      await streamSse<ChatEvent>({
        url: `/api/sessions/${sessionId}/chat`,
        method: "POST",
        body: { message: content },
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "chat.started") {
            set((current) =>
              appendStoredMessages(current, sessionId, [
                event.userMessage,
                event.assistantMessage,
              ]),
            );
          } else if (event.type === "chat.delta") {
            set((current) =>
              patchAssistant(current, sessionId, event.messageId, (message) => ({
                ...message,
                text: message.text + event.data,
              })),
            );
          } else if (event.type === "chat.reasoning") {
            set((current) =>
              patchAssistant(current, sessionId, event.messageId, (message) => ({
                ...message,
                reasoning: (message.reasoning ?? "") + event.data,
              })),
            );
          } else if (event.type === "chat.done") {
            finished = true;
            set((current) =>
              patchAssistant(current, sessionId, event.message.id, (message) => ({
                ...message,
                text: event.message.content || message.text,
                streaming: false,
                error: undefined,
                cancelled: false,
                model: event.message.model,
                usage: event.message.usage ?? event.usage ?? message.usage,
                durationMs: event.message.durationMs ?? message.durationMs,
                firstTokenMs: event.message.firstTokenMs ?? message.firstTokenMs,
              })),
            );
          } else if (event.type === "chat.error") {
            finished = true;
            if (event.messageId === "") {
              get().notify("error", event.message);
            } else {
              set((current) =>
                patchAssistant(current, sessionId, event.messageId, (message) => ({
                  ...message,
                  streaming: false,
                  error: event.message,
                  cancelled: false,
                })),
              );
            }
          }
        },
      });

      if (!finished) {
        set((current) =>
          settleStreaming(current, sessionId, { cancelled: true }),
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        set((current) =>
          settleStreaming(current, sessionId, { cancelled: true }),
        );
      } else {
        const message = asApiError(error).message;
        set((current) => settleStreaming(current, sessionId, { error: message }));
        get().notify("error", message);
      }
    } finally {
      chatAborters.delete(sessionId);
      set((current) => ({
        chatBusy: { ...current.chatBusy, [sessionId]: false },
      }));
    }
  },

  cancelChat: () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    chatAborters.get(sessionId)?.abort();
  },

  saveLlmSettings: async (input: LlmSettingsInput) => {
    try {
      const { settings } = await api.updateLlmSettings(input);
      set({ llmSettings: settings });
      get().notify("info", "模型配置已保存");
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  testLlm: async (input: LlmTestInput) => {
    return api.testLlm(input);
  },

  sendAgent: async (text: string) => {
    const state = get();
    const sessionId = state.currentSessionId;
    if (!sessionId) return;
    const content = text.trim();
    if (!content) return;

    if (!state.llmSettings?.configured) {
      get().notify("info", "Agent 需要先配置模型 API");
      get().openLlmSettings();
      return;
    }
    if (
      state.chatBusy[sessionId] ||
      state.agentBusy[sessionId] ||
      chatAborters.has(sessionId) ||
      agentAborters.has(sessionId)
    ) {
      get().notify("info", "当前会话正在执行回合，请等待结束或先停止");
      return;
    }

    const controller = new AbortController();
    agentAborters.set(sessionId, controller);
    set((current) => ({
      agentBusy: { ...current.agentBusy, [sessionId]: true },
    }));

    let finished = false;
    const approvalsAdded = new Set<string>();
    try {
      await streamSse<AgentEvent>({
        url: `/api/sessions/${sessionId}/agent`,
        method: "POST",
        body: { message: content },
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.type) {
            case "agent.started":
              set((current) =>
                upsertStoredMessage(current, sessionId, event.userMessage),
              );
              break;
            case "agent.step":
              set((current) =>
                upsertStoredMessage(current, sessionId, event.message, true),
              );
              break;
            case "agent.delta":
              set((current) =>
                patchAssistant(current, sessionId, event.messageId, (message) => ({
                  ...message,
                  text: message.text + event.data,
                })),
              );
              break;
            case "agent.reasoning":
              set((current) =>
                patchAssistant(current, sessionId, event.messageId, (message) => ({
                  ...message,
                  reasoning: (message.reasoning ?? "") + event.data,
                })),
              );
              break;
            case "agent.message":
              set((current) =>
                upsertStoredMessage(current, sessionId, event.message),
              );
              break;
            case "agent.tool.started":
            case "agent.tool.finished":
              set((current) =>
                upsertStoredMessage(current, sessionId, event.message),
              );
              break;
            case "agent.approval_required": {
              const approval: ApprovalRequest = {
                id: event.approvalId,
                kind: "exec",
                toolName: "run_command",
                sessionId,
                execId: event.execId,
                currentMode: event.currentMode,
                requestedMode: event.requestedMode,
                command: event.command,
                justification: event.justification,
                createdAt: new Date().toISOString(),
                expiresAt: event.expiresAt,
              };
              approvalsAdded.add(approval.id);
              set((current) => ({
                approvals: [
                  ...current.approvals.filter(
                    (candidate) => candidate.id !== approval.id,
                  ),
                  approval,
                ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
              }));
              break;
            }
            case "agent.approval_decided":
              set((current) => ({
                approvals: current.approvals.filter(
                  (candidate) => candidate.id !== event.approvalId,
                ),
              }));
              break;
            case "agent.done":
              finished = true;
              set((current) =>
                upsertStoredMessage(current, sessionId, event.message),
              );
              break;
            case "agent.error": {
              finished = true;
              const messageId = event.messageId;
              if (messageId) {
                set((current) =>
                  patchAssistant(
                    current,
                    sessionId,
                    messageId,
                    (message) => ({
                      ...message,
                      streaming: false,
                      error: event.message,
                    }),
                  ),
                );
              } else {
                get().notify("error", event.message);
              }
              break;
            }
          }
        },
      });

      if (!finished) {
        set((current) =>
          settleAgentStreaming(current, sessionId, { cancelled: true }),
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        set((current) =>
          settleAgentStreaming(current, sessionId, { cancelled: true }),
        );
      } else {
        const message = asApiError(error).message;
        set((current) =>
          settleAgentStreaming(current, sessionId, { error: message }),
        );
        get().notify("error", message);
      }
    } finally {
      agentAborters.delete(sessionId);
      set((current) => ({
        agentBusy: { ...current.agentBusy, [sessionId]: false },
        ...(approvalsAdded.size > 0
          ? {
              approvals: current.approvals.filter(
                (approval) => !approvalsAdded.has(approval.id),
              ),
            }
          : {}),
      }));
    }
  },

  cancelAgent: () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    agentAborters.get(sessionId)?.abort();
  },

  saveAgentSettings: async (input: AgentSettingsInput) => {
    try {
      const { settings } = await api.updateAgentSettings(input);
      set({ agentSettings: settings });
      get().notify("info", "Agent 配置已保存");
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  refreshAudit: async () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) {
      set({ audit: [] });
      return;
    }
    try {
      const { events } = await api.audit(sessionId);
      set({ audit: events });
    } catch (error) {
      get().notify("error", asApiError(error).message);
    }
  },

  saveDefaultPreset: async (mode: SandboxMode) => {
    try {
      const { settings } = await api.updateSettings(mode);
      set({ settings });
      get().notify("info", "新会话默认权限已更新");
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  notify: (kind, message) => {
    const id = Date.now();
    set({ notification: { id, kind, message } });
    window.setTimeout(() => {
      if (get().notification?.id === id) set({ notification: null });
    }, 5000);
  },

  clearNotification: () => set({ notification: null }),

  toggleSidebar: () =>
    set((state) => ({ ui: { ...state.ui, sidebarOpen: !state.ui.sidebarOpen } })),
  closeSidebar: () =>
    set((state) => ({ ui: { ...state.ui, sidebarOpen: false } })),
  openNewSession: () =>
    set((state) => ({ ui: { ...state.ui, newSessionOpen: true } })),
  closeNewSession: () =>
    set((state) => ({ ui: { ...state.ui, newSessionOpen: false } })),
  openSettings: () =>
    set((state) => ({ ui: { ...state.ui, settingsOpen: true } })),
  closeSettings: () =>
    set((state) => ({ ui: { ...state.ui, settingsOpen: false } })),
  openLlmSettings: () =>
    set((state) => ({
      ui: { ...state.ui, llmSettingsOpen: true, settingsOpen: false },
    })),
  closeLlmSettings: () =>
    set((state) => ({ ui: { ...state.ui, llmSettingsOpen: false } })),
  openAgentSettings: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        agentSettingsOpen: true,
        settingsOpen: false,
        llmSettingsOpen: false,
      },
    })),
  closeAgentSettings: () =>
    set((state) => ({ ui: { ...state.ui, agentSettingsOpen: false } })),
  openAudit: () => {
    set((state) => ({ ui: { ...state.ui, auditOpen: true } }));
    void get().refreshAudit();
  },
  closeAudit: () => set((state) => ({ ui: { ...state.ui, auditOpen: false } })),
}));

export function selectCurrentSession(state: AppState): Session | null {
  return (
    state.sessions.find((session) => session.id === state.currentSessionId) ??
    null
  );
}

export function selectCurrentMessages(state: AppState): ChatMessage[] | undefined {
  return state.currentSessionId
    ? state.messages[state.currentSessionId]
    : undefined;
}
