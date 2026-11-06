import { create } from "zustand";
import type {
  AgentEvent,
  AgentSession,
  AgentSettingsInput,
  AgentSettingsPublic,
  AgentToolCall,
  AgentToolMeta,
  ApprovalDecision,
  ApprovalRequest,
  AuditEvent,
  ChatEvent,
  ChatMessageRecord,
  ChatSession,
  ChatUsage,
  LlmSettingsInput,
  LlmSettingsPublic,
  LlmTestInput,
  LlmTestResult,
  PaperReadStatus,
  PaperRecord,
  PaperSession,
  PaperUpdateInput,
  SandboxMode,
  SandboxStatus,
  SearchSettingsInput,
  SearchSettingsPublic,
  SearchTestInput,
  SearchTestResult,
  Session,
  SessionKind,
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
  /** Transient progress text from SSE; not persisted. */
  progress?: string;
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
  searchSettingsOpen: boolean;
  paperLibraryOpen: boolean;
}

interface Notification {
  id: number;
  kind: "info" | "error";
  message: string;
}

export interface AppState {
  phase: AppPhase;
  /** Which of the two independent UIs is active. */
  mode: SessionKind;
  error: string | null;
  notification: Notification | null;
  sessions: Session[];
  currentSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  approvals: ApprovalRequest[];
  settings: Settings | null;
  llmSettings: LlmSettingsPublic | null;
  searchSettings: SearchSettingsPublic | null;
  agentSettings: AgentSettingsPublic | null;
  sandbox: SandboxStatus | null;
  dev: boolean;
  audit: AuditEvent[];
  /** Per-session chat request in flight, including before the first token. */
  chatBusy: Record<string, boolean>;
  /** Per-session agent run in flight. */
  agentBusy: Record<string, boolean>;
  /** Per-session paper run in flight. */
  paperBusy: Record<string, boolean>;
  /** A chat session creation request is in flight. */
  chatCreating: boolean;
  /** A paper session creation request is in flight. */
  paperCreating: boolean;
  /** Filtered library view used by the drawer. */
  papers: PaperRecord[];
  /** Every paper seen so far, regardless of the active library filter. */
  paperIndex: Record<string, PaperRecord>;
  paperTotal: number;
  paperTags: string[];
  paperCollections: string[];
  paperLoading: boolean;
  paperUploading: boolean;
  paperDetailId: string | null;
  paperQuery: {
    query: string;
    status: PaperReadStatus | "";
    tag: string;
    collection: string;
    sort: "added" | "published" | "title" | "lastRead";
  };
  ui: UiState;

  init(): Promise<void>;
  setToken(token: string): Promise<void>;
  setMode(mode: SessionKind): void;
  selectSession(id: string): void;
  ensureMessagesLoaded(sessionId: string): Promise<void>;
  createSession(workspaceRoot: string, title?: string): Promise<boolean>;
  createChatSession(title?: string): Promise<boolean>;
  createPaperSession(title?: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  updatePermissions(mode: SandboxMode, confirmRisk?: boolean): Promise<boolean>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  sendChat(text: string): Promise<void>;
  cancelChat(): void;
  sendAgent(text: string): Promise<void>;
  cancelAgent(): void;
  sendPaper(text: string): Promise<void>;
  cancelPaper(): void;
  loadPapers(): Promise<void>;
  addPaperByArxiv(ref: string): Promise<PaperRecord | null>;
  updatePaper(paperId: string, patch: PaperUpdateInput): Promise<boolean>;
  deletePaper(paperId: string): Promise<boolean>;
  uploadPaper(file: File): Promise<boolean>;
  extractPaper(paperId: string): Promise<boolean>;
  addPaperToContext(paperId: string): Promise<boolean>;
  removePaperFromContext(paperId: string): Promise<boolean>;
  openPaperDetail(paperId: string): void;
  closePaperDetail(): void;
  openPaperLibrary(): void;
  closePaperLibrary(): void;
  setPaperQuery(patch: Partial<AppState["paperQuery"]>): void;
  saveLlmSettings(input: LlmSettingsInput): Promise<boolean>;
  testLlm(input: LlmTestInput): Promise<LlmTestResult>;
  saveSearchSettings(input: SearchSettingsInput): Promise<boolean>;
  testSearch(input: SearchTestInput): Promise<SearchTestResult>;
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
  openSearchSettings(): void;
  closeSearchSettings(): void;
  openAgentSettings(): void;
  closeAgentSettings(): void;
  openAudit(): void;
  closeAudit(): void;
}

const MODE_KEY = "codefly.mode";
const CURRENT_SESSION_KEYS: Record<SessionKind, string> = {
  chat: "codefly.currentSession.chat",
  agent: "codefly.currentSession.agent",
  paper: "codefly.currentSession.paper",
};
/** Key written before chat and agent were split; still read for agent mode. */
const LEGACY_CURRENT_SESSION_KEY = "codefly.currentSession";

const chatAborters = new Map<string, AbortController>();
const agentAborters = new Map<string, AbortController>();
const paperAborters = new Map<string, AbortController>();
const loadedSessionIds = new Set<string>();

function readStoredSessionId(kind: SessionKind): string | null {
  try {
    const stored = localStorage.getItem(CURRENT_SESSION_KEYS[kind]);
    if (stored !== null) return stored;
    if (kind === "agent") {
      return localStorage.getItem(LEGACY_CURRENT_SESSION_KEY);
    }
  } catch {
    // localStorage can be unavailable; selection still works in memory.
  }
  return null;
}

function storeCurrentSessionId(kind: SessionKind, id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(CURRENT_SESSION_KEYS[kind]);
    else localStorage.setItem(CURRENT_SESSION_KEYS[kind], id);
  } catch {
    // Ignore storage failures.
  }
}

function readStoredMode(): SessionKind {
  if (typeof window !== "undefined") {
    const hash = window.location.hash.replace(/^#\/?/, "");
    if (hash === "code") return "agent";
    if (hash === "agent") {
      // Legacy links keep working; the visible URL uses the new name.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#/code`,
      );
      return "agent";
    }
    if (hash === "chat" || hash === "paper") return hash;
  }
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored === "chat" || stored === "agent" || stored === "paper") {
      return stored;
    }
  } catch {
    // Ignore storage failures.
  }
  return "agent";
}

function writeStoredMode(mode: SessionKind): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
  if (typeof window === "undefined") return;
  const hashMode = mode === "agent" ? "code" : mode;
  const next = `${window.location.pathname}${window.location.search}#/${hashMode}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(null, "", next);
  }
}

function sessionMatchesMode(session: Session, mode: SessionKind): boolean {
  return session.kind === mode;
}

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

function upsertPaper(list: PaperRecord[], paper: PaperRecord): PaperRecord[] {
  const index = list.findIndex((candidate) => candidate.id === paper.id);
  if (index < 0) return [paper, ...list];
  const next = [...list];
  next[index] = paper;
  return next;
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

export const useAppStore = create<AppState>()((set, get) => {
  /**
   * Shared streaming loop for Agent and paper sessions. Their SSE event
   * contract is identical; only the endpoint and busy bookkeeping differ.
   */
  const streamToolRun = async (
    kind: "agent" | "paper",
    text: string,
  ): Promise<void> => {
    const state = get();
    const sessionId = state.currentSessionId;
    if (!sessionId) return;
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.kind !== kind) return;
    const content = text.trim();
    if (!content) return;

    if (!state.llmSettings?.configured) {
      get().notify(
        "info",
        kind === "paper" ? "论文助手需要先配置模型 API" : "Code 需要先配置模型 API",
      );
      get().openLlmSettings();
      return;
    }
    if (
      state.chatBusy[sessionId] ||
      state.agentBusy[sessionId] ||
      state.paperBusy[sessionId] ||
      chatAborters.has(sessionId) ||
      agentAborters.has(sessionId) ||
      paperAborters.has(sessionId)
    ) {
      get().notify("info", "当前会话正在执行回合，请等待结束或先停止");
      return;
    }

    const controller = new AbortController();
    const aborters = kind === "agent" ? agentAborters : paperAborters;
    aborters.set(sessionId, controller);
    if (kind === "agent") {
      set((current) => ({
        agentBusy: { ...current.agentBusy, [sessionId]: true },
      }));
    } else {
      set((current) => ({
        paperBusy: { ...current.paperBusy, [sessionId]: true },
      }));
    }

    let finished = false;
    const approvalsAdded = new Set<string>();
    try {
      await streamSse<AgentEvent>({
        url: `/api/sessions/${sessionId}/${kind}`,
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
            case "agent.tool.progress":
              set((current) =>
                withMessages(current, sessionId, (list) =>
                  list.map((message) =>
                    message.kind === "tool" && message.id === event.messageId
                      ? { ...message, progress: event.data }
                      : message,
                  ),
                ),
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
            case "session.updated":
              set((current) => ({
                sessions: current.sessions.map((candidate) =>
                  candidate.id === event.session.id ? event.session : candidate,
                ),
              }));
              break;
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
      aborters.delete(sessionId);
      if (kind === "agent") {
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
      } else {
        set((current) => ({
          paperBusy: { ...current.paperBusy, [sessionId]: false },
        }));
      }
    }
  };

  return {
  phase: "loading",
  mode: readStoredMode(),
  error: null,
  notification: null,
  sessions: [],
  currentSessionId: null,
  messages: {},
  approvals: [],
  settings: null,
  llmSettings: null,
  searchSettings: null,
  agentSettings: null,
  sandbox: null,
  dev: false,
  audit: [],
  chatBusy: {},
  agentBusy: {},
  paperBusy: {},
  chatCreating: false,
  paperCreating: false,
  papers: [],
  paperIndex: {},
  paperTotal: 0,
  paperTags: [],
  paperCollections: [],
  paperLoading: false,
  paperUploading: false,
  paperDetailId: null,
  paperQuery: {
    query: "",
    status: "",
    tag: "",
    collection: "",
    sort: "added",
  },
  ui: {
    sidebarOpen: false,
    newSessionOpen: false,
    settingsOpen: false,
    auditOpen: false,
    llmSettingsOpen: false,
    agentSettingsOpen: false,
    searchSettingsOpen: false,
    paperLibraryOpen: false,
  },

  init: async () => {
    if (!getToken()) {
      set({ phase: "token-required" });
      return;
    }

    set({ phase: "loading", error: null });
    try {
      const [
        health,
        sessionsResponse,
        settingsResponse,
        llmResponse,
        searchResponse,
        agentResponse,
        paperResponse,
        paperTagResponse,
      ] = await Promise.all([
        api.health(),
        api.listSessions(),
        api.getSettings(),
        api.getLlmSettings(),
        api.getSearchSettings(),
        api.getAgentSettings(),
        api.listPapers({ limit: 200 }),
        api.paperTags(),
      ]);

      const sessions = sessionsResponse.sessions;
      const mode = readStoredMode();
      const remembered = readStoredSessionId(mode);
      const candidates = sessions.filter((session) =>
        sessionMatchesMode(session, mode),
      );
      const current =
        sessions.find(
          (session) =>
            session.id === get().currentSessionId &&
            sessionMatchesMode(session, mode),
        )?.id ??
        candidates.find((session) => session.id === remembered)?.id ??
        candidates[0]?.id ??
        null;

      set({
        phase: "ready",
        mode,
        error: null,
        sessions,
        currentSessionId: current,
        settings: settingsResponse.settings,
        llmSettings: llmResponse.settings,
        searchSettings: searchResponse.settings,
        agentSettings: agentResponse.settings,
        papers: paperResponse.papers,
        paperIndex: Object.fromEntries(
          paperResponse.papers.map((paper) => [paper.id, paper]),
        ),
        paperTotal: paperResponse.total,
        paperTags: paperTagResponse.tags,
        paperCollections: paperTagResponse.collections,
        sandbox: health.sandbox,
        dev: health.dev,
      });
      writeStoredMode(mode);

      if (current) {
        storeCurrentSessionId(mode, current);
        void get().ensureMessagesLoaded(current);
      }
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

  setMode: (mode: SessionKind) => {
    const state = get();
    if (state.mode === mode) {
      set({ ui: { ...state.ui, sidebarOpen: false } });
      return;
    }

    writeStoredMode(mode);
    const candidates = state.sessions.filter((session) =>
      sessionMatchesMode(session, mode),
    );
    const remembered = readStoredSessionId(mode);
    const current =
      candidates.find((session) => session.id === remembered)?.id ??
      candidates[0]?.id ??
      null;

    set({
      mode,
      currentSessionId: current,
      ui: {
        ...state.ui,
        sidebarOpen: false,
        newSessionOpen: false,
      },
    });
    if (current) {
      storeCurrentSessionId(mode, current);
      void get().ensureMessagesLoaded(current);
    }
  },

  selectSession: (id: string) => {
    const session = get().sessions.find((candidate) => candidate.id === id);
    if (!session || session.kind !== get().mode) return;
    storeCurrentSessionId(session.kind, id);
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
      const { session } = await api.createSession({
        kind: "agent",
        workspaceRoot,
        title,
      });
      loadedSessionIds.add(session.id);
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
        messages: {
          ...state.messages,
          [session.id]: [
            systemMessage(`会话已创建，工作区：${session.workspaceRoot ?? ""}`),
          ],
        },
        ui: { ...state.ui, newSessionOpen: false, sidebarOpen: false },
      }));
      storeCurrentSessionId("agent", session.id);
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  createChatSession: async (title?: string) => {
    if (get().chatCreating) return false;
    set({ chatCreating: true });
    try {
      const { session } = await api.createSession({ kind: "chat", title });
      loadedSessionIds.add(session.id);
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
        chatCreating: false,
        messages: { ...state.messages, [session.id]: [] },
        ui: { ...state.ui, newSessionOpen: false, sidebarOpen: false },
      }));
      storeCurrentSessionId("chat", session.id);
      return true;
    } catch (error) {
      set({ chatCreating: false });
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  createPaperSession: async (title?: string) => {
    if (get().paperCreating) return false;
    set({ paperCreating: true });
    try {
      const { session } = await api.createSession({ kind: "paper", title });
      loadedSessionIds.add(session.id);
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
        paperCreating: false,
        messages: { ...state.messages, [session.id]: [] },
        ui: { ...state.ui, newSessionOpen: false, sidebarOpen: false },
      }));
      storeCurrentSessionId("paper", session.id);
      return true;
    } catch (error) {
      set({ paperCreating: false });
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  deleteSession: async (sessionId: string) => {
    const state = get();
    const target = state.sessions.find((session) => session.id === sessionId);
    if (!target) return false;
    if (
      state.chatBusy[sessionId] ||
      state.agentBusy[sessionId] ||
      state.paperBusy[sessionId] ||
      chatAborters.has(sessionId) ||
      agentAborters.has(sessionId) ||
      paperAborters.has(sessionId)
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
      ? (remaining.find((session) => session.kind === target.kind)?.id ?? null)
      : get().currentSessionId;

    set((current) => {
      const messages = { ...current.messages };
      delete messages[sessionId];
      const chatBusy = { ...current.chatBusy };
      delete chatBusy[sessionId];
      const agentBusy = { ...current.agentBusy };
      delete agentBusy[sessionId];
      const paperBusy = { ...current.paperBusy };
      delete paperBusy[sessionId];
      return {
        sessions: remaining,
        currentSessionId: nextId,
        messages,
        chatBusy,
        agentBusy,
        paperBusy,
        approvals: current.approvals.filter(
          (approval) => approval.sessionId !== sessionId,
        ),
      };
    });

    if (wasCurrent) storeCurrentSessionId(target.kind, nextId);

    if (nextId) void get().ensureMessagesLoaded(nextId);
    get().notify("info", "会话已删除");
    return true;
  },

  updatePermissions: async (mode: SandboxMode, confirmRisk?: boolean) => {
    const state = get();
    const session = state.sessions.find(
      (candidate) => candidate.id === state.currentSessionId,
    );
    if (!session || session.kind !== "agent") return false;
    try {
      const { session: updated } = await api.updatePermissions(session.id, {
        mode,
        confirmRisk: confirmRisk === true ? true : undefined,
      });
      set((current) => ({
        sessions: current.sessions.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
        ...withMessages(current, updated.id, (list) => [
          ...list,
          systemMessage(`权限已切换为「${MODE_LABEL[updated.mode]}」`),
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
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.kind !== "chat") return;
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
      state.paperBusy[sessionId] ||
      chatAborters.has(sessionId) ||
      agentAborters.has(sessionId) ||
      paperAborters.has(sessionId)
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
          } else if (event.type === "session.updated") {
            set((current) => ({
              sessions: current.sessions.map((session) =>
                session.id === event.session.id ? event.session : session,
              ),
            }));
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
    // Ask the server to abort the upstream model request as well; closing the
    // SSE connection is not always observed by every proxy hop.
    void api.cancelRun(sessionId).catch(() => undefined);
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

  saveSearchSettings: async (input: SearchSettingsInput) => {
    try {
      const { settings } = await api.updateSearchSettings(input);
      set({ searchSettings: settings });
      get().notify("info", "搜索 API 配置已保存");
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  testSearch: async (input: SearchTestInput) => {
    return api.testSearch(input);
  },

  sendAgent: (text: string) => streamToolRun("agent", text),

  cancelAgent: () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    // Same as chat: stop the server-side run even if the stream close is
    // swallowed, so the model request and any running tool are cancelled.
    void api.cancelRun(sessionId).catch(() => undefined);
    agentAborters.get(sessionId)?.abort();
  },

  sendPaper: (text: string) => streamToolRun("paper", text),

  cancelPaper: () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    void api.cancelRun(sessionId).catch(() => undefined);
    paperAborters.get(sessionId)?.abort();
  },

  loadPapers: async () => {
    const query = get().paperQuery;
    set({ paperLoading: true });
    try {
      const [response, tagResponse, allResponse] = await Promise.all([
        api.listPapers({
          query: query.query.trim() || undefined,
          status: query.status || undefined,
          tags: query.tag ? [query.tag] : undefined,
          collection: query.collection || undefined,
          sort: query.sort,
          limit: 200,
        }),
        api.paperTags(),
        api.listPapers({ limit: 200 }),
      ]);
      set((state) => {
        const index = { ...state.paperIndex };
        for (const paper of allResponse.papers) index[paper.id] = paper;
        for (const paper of response.papers) index[paper.id] = paper;
        return {
          papers: response.papers,
          paperIndex: index,
          paperTotal: allResponse.total,
          paperTags: tagResponse.tags,
          paperCollections: tagResponse.collections,
          paperLoading: false,
        };
      });
    } catch (error) {
      set({ paperLoading: false });
      get().notify("error", asApiError(error).message);
    }
  },

  setPaperQuery: (patch) => {
    set((state) => ({ paperQuery: { ...state.paperQuery, ...patch } }));
    void get().loadPapers();
  },

  addPaperByArxiv: async (ref: string) => {
    try {
      const { paper, created } = await api.addPaper({ arxivId: ref });
      set((state) => ({
        papers: upsertPaper(state.papers, paper),
        paperIndex: { ...state.paperIndex, [paper.id]: paper },
        paperTotal: state.paperIndex[paper.id]
          ? state.paperTotal
          : state.paperTotal + 1,
      }));
      get().notify("info", created ? "论文已加入论文库" : "论文已在论文库中");
      void get().loadPapers();
      return paper;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return null;
    }
  },

  updatePaper: async (paperId: string, patch: PaperUpdateInput) => {
    try {
      const { paper } = await api.updatePaper(paperId, patch);
      set((state) => ({
        papers: upsertPaper(state.papers, paper),
        paperIndex: { ...state.paperIndex, [paper.id]: paper },
      }));
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  deletePaper: async (paperId: string) => {
    try {
      await api.deletePaper(paperId);
      set((state) => {
        const paperIndex = { ...state.paperIndex };
        delete paperIndex[paperId];
        return {
          papers: state.papers.filter((paper) => paper.id !== paperId),
          paperIndex,
          paperTotal: Math.max(0, state.paperTotal - 1),
          paperDetailId:
            state.paperDetailId === paperId ? null : state.paperDetailId,
          sessions: state.sessions.map((session) =>
            session.kind === "paper" && session.paperIds.includes(paperId)
              ? {
                  ...session,
                  paperIds: session.paperIds.filter((id) => id !== paperId),
                }
              : session,
          ),
        };
      });
      get().notify("info", "论文已从论文库删除");
      void get().loadPapers();
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  uploadPaper: async (file: File) => {
    set({ paperUploading: true });
    try {
      const form = new FormData();
      form.append("file", file);
      const { paper } = await api.uploadPaper(form);
      set((state) => ({
        papers: upsertPaper(state.papers, paper),
        paperIndex: { ...state.paperIndex, [paper.id]: paper },
        paperTotal: state.paperIndex[paper.id]
          ? state.paperTotal
          : state.paperTotal + 1,
        paperUploading: false,
      }));
      get().notify("info", "PDF 已上传并加入论文库");
      void get().loadPapers();
      return true;
    } catch (error) {
      set({ paperUploading: false });
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  extractPaper: async (paperId: string) => {
    try {
      const { paper } = await api.extractPaper(paperId);
      set((state) => ({
        papers: upsertPaper(state.papers, paper),
        paperIndex: { ...state.paperIndex, [paper.id]: paper },
      }));
      get().notify("info", "PDF 文本解析完成");
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  addPaperToContext: async (paperId: string) => {
    const session = get().sessions.find(
      (candidate) => candidate.id === get().currentSessionId,
    );
    if (!session || session.kind !== "paper") {
      get().notify("info", "请先选择或创建一个论文会话");
      return false;
    }
    try {
      const { session: updated } = await api.updatePaperContext(session.id, {
        add: [paperId],
      });
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      }));
      get().notify("info", "已加入当前论文上下文");
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  removePaperFromContext: async (paperId: string) => {
    const session = get().sessions.find(
      (candidate) => candidate.id === get().currentSessionId,
    );
    if (!session || session.kind !== "paper") return false;
    try {
      const { session: updated } = await api.updatePaperContext(session.id, {
        remove: [paperId],
      });
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      }));
      return true;
    } catch (error) {
      get().notify("error", asApiError(error).message);
      return false;
    }
  },

  openPaperDetail: (paperId: string) => {
    set({ paperDetailId: paperId });
  },

  closePaperDetail: () => set({ paperDetailId: null }),

  openPaperLibrary: () => {
    set((state) => ({
      ui: { ...state.ui, paperLibraryOpen: true },
    }));
    void get().loadPapers();
  },

  closePaperLibrary: () =>
    set((state) => ({ ui: { ...state.ui, paperLibraryOpen: false } })),

  saveAgentSettings: async (input: AgentSettingsInput) => {
    try {
      const { settings } = await api.updateAgentSettings(input);
      set({ agentSettings: settings });
      get().notify("info", "Code 配置已保存");
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
      ui: {
        ...state.ui,
        llmSettingsOpen: true,
        settingsOpen: false,
        searchSettingsOpen: false,
      },
    })),
  closeLlmSettings: () =>
    set((state) => ({ ui: { ...state.ui, llmSettingsOpen: false } })),
  openSearchSettings: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        searchSettingsOpen: true,
        settingsOpen: false,
        llmSettingsOpen: false,
        agentSettingsOpen: false,
      },
    })),
  closeSearchSettings: () =>
    set((state) => ({ ui: { ...state.ui, searchSettingsOpen: false } })),
  openAgentSettings: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        agentSettingsOpen: true,
        settingsOpen: false,
        llmSettingsOpen: false,
        searchSettingsOpen: false,
      },
    })),
  closeAgentSettings: () =>
    set((state) => ({ ui: { ...state.ui, agentSettingsOpen: false } })),
  openAudit: () => {
    set((state) => ({ ui: { ...state.ui, auditOpen: true } }));
    void get().refreshAudit();
  },
  closeAudit: () => set((state) => ({ ui: { ...state.ui, auditOpen: false } })),
  };
});

export function selectCurrentSession(state: AppState): Session | null {
  return (
    state.sessions.find((session) => session.id === state.currentSessionId) ??
    null
  );
}

export function selectCurrentAgentSession(state: AppState): AgentSession | null {
  const session = selectCurrentSession(state);
  return session?.kind === "agent" ? session : null;
}

export function selectCurrentChatSession(state: AppState): ChatSession | null {
  const session = selectCurrentSession(state);
  return session?.kind === "chat" ? session : null;
}

export function selectCurrentPaperSession(state: AppState): PaperSession | null {
  const session = selectCurrentSession(state);
  return session?.kind === "paper" ? session : null;
}

export function selectCurrentMessages(state: AppState): ChatMessage[] | undefined {
  return state.currentSessionId
    ? state.messages[state.currentSessionId]
    : undefined;
}
