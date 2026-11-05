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
  PaperContextInput,
  PaperListResponse,
  PaperOutline,
  PaperRecord,
  PaperUpdateInput,
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
  if (
    init.body !== undefined &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
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

  listPapers(query: {
    query?: string;
    tags?: string[];
    status?: string;
    starred?: boolean;
    collection?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<PaperListResponse> {
    const params = new URLSearchParams();
    if (query.query) params.set("query", query.query);
    if (query.tags && query.tags.length > 0) {
      params.set("tags", query.tags.join(","));
    }
    if (query.status) params.set("status", query.status);
    if (query.starred !== undefined) {
      params.set("starred", query.starred ? "true" : "false");
    }
    if (query.collection) params.set("collection", query.collection);
    if (query.sort) params.set("sort", query.sort);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const suffix = params.toString() === "" ? "" : `?${params.toString()}`;
    return request(`/api/papers${suffix}`);
  },

  getPaper(paperId: string): Promise<{ paper: PaperRecord }> {
    return request(`/api/papers/${paperId}`);
  },

  paperTags(): Promise<{ tags: string[]; collections: string[] }> {
    return request("/api/papers/tags");
  },

  addPaper(input: {
    arxivId?: string;
    url?: string;
    tags?: string[];
    collections?: string[];
    status?: string;
  }): Promise<{ paper: PaperRecord; created: boolean }> {
    return request("/api/papers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updatePaper(
    paperId: string,
    input: PaperUpdateInput,
  ): Promise<{ paper: PaperRecord }> {
    return request(`/api/papers/${paperId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },

  deletePaper(paperId: string): Promise<void> {
    return request(`/api/papers/${paperId}`, { method: "DELETE" });
  },

  uploadPaper(form: FormData): Promise<{ paper: PaperRecord; created: boolean }> {
    return request("/api/papers/upload", {
      method: "POST",
      body: form,
    });
  },

  extractPaper(
    paperId: string,
  ): Promise<{ paper: PaperRecord; outline: PaperOutline }> {
    return request(`/api/papers/${paperId}/extract`, {
      method: "POST",
      body: "{}",
    });
  },

  exportPapers(input: {
    format: "bibtex" | "markdown";
    ids?: string[];
    collection?: string;
  }): Promise<{ format: string; count: number; content: string }> {
    const params = new URLSearchParams({ format: input.format });
    if (input.ids && input.ids.length > 0) {
      params.set("ids", input.ids.join(","));
    }
    if (input.collection) params.set("collection", input.collection);
    return request(`/api/papers/export?${params.toString()}`);
  },

  updatePaperContext(
    sessionId: string,
    input: PaperContextInput,
  ): Promise<{ session: Session }> {
    return request(`/api/sessions/${sessionId}/paper-context`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },

  async paperPdf(paperId: string): Promise<Blob> {
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`/api/papers/${paperId}/pdf`, { headers });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      throw new ApiError(
        response.status,
        payload?.error?.code ?? "HTTP_ERROR",
        payload?.error?.message ?? response.statusText,
      );
    }
    return response.blob();
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
