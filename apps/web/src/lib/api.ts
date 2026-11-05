import type {
  AgentSettingsInput,
  AgentSettingsPublic,
  ApprovalDecision,
  AuditEvent,
  ChatMessageRecord,
  HealthResponse,
  LlmSettingsInput,
  LlmSettingsPublic,
  LlmTestInput,
  LlmTestResult,
  SandboxMode,
  SearchSettingsInput,
  SearchSettingsPublic,
  SearchTestInput,
  SearchTestResult,
  Session,
  SessionKind,
  Settings,
  WorkspaceBrowseResponse,
} from "@codefly/protocol";

const TOKEN_KEY = "codefly.token";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Reads `?token=` once, stores it, and strips it from the address bar. */
export function bootstrapToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; details?: unknown } }
      | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "HTTP_ERROR",
      payload?.error?.message ?? response.statusText,
      payload?.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health(): Promise<HealthResponse> {
    return request("/api/health");
  },

  listSessions(): Promise<{ sessions: Session[] }> {
    return request("/api/sessions");
  },

  createSession(input: {
    kind?: SessionKind;
    workspaceRoot?: string;
    title?: string;
  }): Promise<{ session: Session }> {
    return request("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  deleteSession(sessionId: string): Promise<void> {
    return request(`/api/sessions/${sessionId}`, { method: "DELETE" });
  },

  cancelRun(
    sessionId: string,
  ): Promise<{ cancelled: boolean; kind: "chat" | "agent" | null }> {
    return request(`/api/sessions/${sessionId}/cancel`, {
      method: "POST",
      body: "{}",
    });
  },

  browseWorkspaces(path?: string): Promise<WorkspaceBrowseResponse> {
    const query =
      path === undefined || path.trim() === ""
        ? ""
        : `?path=${encodeURIComponent(path)}`;
    return request(`/api/fs/browse${query}`);
  },

  updatePermissions(
    sessionId: string,
    body: { mode: SandboxMode; approvalPolicy?: "ask" | "never"; confirmRisk?: boolean },
  ): Promise<{ session: Session }> {
    return request(`/api/sessions/${sessionId}/permissions`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  decideApproval(execId: string, decision: ApprovalDecision): Promise<{ ok: boolean }> {
    return request(`/api/exec/${execId}/approval`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  },

  audit(sessionId: string, limit = 200): Promise<{ events: AuditEvent[] }> {
    return request(`/api/sessions/${sessionId}/audit?limit=${limit}`);
  },

  getSettings(): Promise<{ settings: Settings }> {
    return request("/api/settings");
  },

  getLlmSettings(): Promise<{ settings: LlmSettingsPublic }> {
    return request("/api/llm/settings");
  },

  updateLlmSettings(
    input: LlmSettingsInput,
  ): Promise<{ settings: LlmSettingsPublic }> {
    return request("/api/llm/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  testLlm(input: LlmTestInput): Promise<LlmTestResult> {
    return request("/api/llm/test", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getSearchSettings(): Promise<{ settings: SearchSettingsPublic }> {
    return request("/api/search/settings");
  },

  updateSearchSettings(
    input: SearchSettingsInput,
  ): Promise<{ settings: SearchSettingsPublic }> {
    return request("/api/search/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  testSearch(input: SearchTestInput): Promise<SearchTestResult> {
    return request("/api/search/test", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getAgentSettings(): Promise<{ settings: AgentSettingsPublic }> {
    return request("/api/agent/settings");
  },

  updateAgentSettings(
    input: AgentSettingsInput,
  ): Promise<{ settings: AgentSettingsPublic }> {
    return request("/api/agent/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  messages(sessionId: string): Promise<{ messages: ChatMessageRecord[] }> {
    return request(`/api/sessions/${sessionId}/messages`);
  },

  updateSettings(defaultPreset: SandboxMode): Promise<{ settings: Settings }> {
    return request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ defaultPreset }),
    });
  },
};

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(
    0,
    "NETWORK_ERROR",
    error instanceof Error ? error.message : String(error),
  );
}
