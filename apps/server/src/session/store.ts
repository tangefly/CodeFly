import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentSession,
  ApprovalPolicy,
  ChatSession,
  DenialRecord,
  SandboxMode,
  Session,
  SessionKind,
} from "@codefly/protocol";
import { AppError, isNotFound } from "../http/errors.js";
import { canonicalizeExisting } from "../fs/canonicalize.js";
import { presetForMode } from "../policy/presets.js";

interface StoredSession {
  id?: unknown;
  title?: unknown;
  titleSource?: unknown;
  kind?: unknown;
  workspaceRoot?: unknown;
  mode?: unknown;
  approvalPolicy?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastDenial?: unknown;
}

interface SessionFile {
  sessions?: StoredSession[];
}

const CHAT_DEFAULT_TITLE = "新对话";

function isMode(value: unknown): value is SandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function isTitleSource(
  value: unknown,
): value is "default" | "user" | "auto" {
  return value === "default" || value === "user" || value === "auto";
}

function asIso(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asDenial(value: unknown): DenialRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<DenialRecord>;
  if (
    typeof record.command !== "string" ||
    !isMode(record.mode) ||
    typeof record.at !== "string"
  ) {
    return null;
  }
  return { command: record.command, mode: record.mode, at: record.at };
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    const now = new Date().toISOString();
    try {
      const parsed = JSON.parse(raw) as SessionFile;
      for (const session of parsed.sessions ?? []) {
        if (typeof session.id !== "string") continue;
        // Sessions written before the chat/agent split always have a
        // workspace and are treated as agent sessions.
        const kind = session.kind === "chat" ? "chat" : "agent";
        const approvalPolicy =
          session.approvalPolicy === "never" ? "never" : "ask";
        const mode = isMode(session.mode) ? session.mode : "workspace-write";
        const createdAt = asIso(session.createdAt, now);
        const updatedAt = asIso(session.updatedAt, now);

        if (kind === "chat") {
          const title =
            typeof session.title === "string" && session.title.trim() !== ""
              ? session.title
              : CHAT_DEFAULT_TITLE;
          const titleSource = isTitleSource(session.titleSource)
            ? session.titleSource
            : title === CHAT_DEFAULT_TITLE
              ? "default"
              : "user";
          this.sessions.set(session.id, {
            id: session.id,
            kind: "chat",
            title,
            titleSource,
            workspaceRoot: null,
            mode,
            approvalPolicy,
            createdAt,
            updatedAt,
            lastDenial: null,
          });
          continue;
        }

        if (typeof session.workspaceRoot !== "string") continue;
        const workspaceRoot = session.workspaceRoot;
        // Older records have no titleSource: treat a title equal to the
        // folder name as the untouched default so it can be auto-titled.
        const folderName = path.basename(workspaceRoot);
        const title =
          typeof session.title === "string" && session.title.trim() !== ""
            ? session.title
            : folderName || workspaceRoot;
        const titleSource = isTitleSource(session.titleSource)
          ? session.titleSource
          : title === folderName
            ? "default"
            : "user";
        this.sessions.set(session.id, {
          id: session.id,
          kind: "agent",
          title,
          titleSource,
          workspaceRoot,
          mode,
          approvalPolicy,
          createdAt,
          updatedAt,
          lastDenial: asDenial(session.lastDenial),
        });
      }
    } catch (error) {
      console.error("[sessions] ignoring corrupt sessions.json", error);
    }
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getOrThrow(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new AppError("SESSION_NOT_FOUND", `unknown session: ${id}`, 404);
    return session;
  }

  getAgentOrThrow(id: string): AgentSession {
    const session = this.getOrThrow(id);
    if (session.kind !== "agent") {
      throw new AppError(
        "WRONG_SESSION_KIND",
        "该会话是对话会话，不能执行 Agent 操作。",
        400,
      );
    }
    return session;
  }

  getChatOrThrow(id: string): ChatSession {
    const session = this.getOrThrow(id);
    if (session.kind !== "chat") {
      throw new AppError(
        "WRONG_SESSION_KIND",
        "该会话是 Agent 会话，不能用于普通对话。",
        400,
      );
    }
    return session;
  }

  /**
   * Creates a chat session (no workspace) or an agent session (a workspace
   * directory is required and canonicalized).
   */
  async create(
    workspaceRootInput: string | undefined,
    title: string | undefined,
    defaultMode: SandboxMode,
    kind: SessionKind = "agent",
  ): Promise<Session> {
    const preset = presetForMode(defaultMode);
    const now = new Date().toISOString();
    const customTitle = title?.trim() ?? "";

    if (kind === "chat") {
      const session: ChatSession = {
        id: `s_${randomUUID()}`,
        kind: "chat",
        title: customTitle !== "" ? customTitle : CHAT_DEFAULT_TITLE,
        titleSource: customTitle !== "" ? "user" : "default",
        workspaceRoot: null,
        mode: preset.mode,
        approvalPolicy: preset.approvalPolicy,
        createdAt: now,
        updatedAt: now,
        lastDenial: null,
      };
      this.sessions.set(session.id, session);
      await this.persist();
      return session;
    }

    if (
      workspaceRootInput === undefined ||
      workspaceRootInput.trim() === ""
    ) {
      throw new AppError(
        "INVALID_WORKSPACE",
        "agent sessions require a workspace directory",
        400,
      );
    }
    if (!path.isAbsolute(workspaceRootInput)) {
      throw new AppError("INVALID_WORKSPACE", "workspaceRoot must be an absolute path", 400);
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await canonicalizeExisting(workspaceRootInput);
    } catch {
      throw new AppError(
        "INVALID_WORKSPACE",
        `workspaceRoot does not exist or is not accessible: ${workspaceRootInput}`,
        400,
      );
    }

    const info = await stat(workspaceRoot);
    if (!info.isDirectory()) {
      throw new AppError("INVALID_WORKSPACE", "workspaceRoot must be a directory", 400);
    }
    if (workspaceRoot === path.parse(workspaceRoot).root) {
      throw new AppError(
        "INVALID_WORKSPACE",
        "workspaceRoot must not be the filesystem root; choose a project directory",
        400,
      );
    }

    const session: AgentSession = {
      id: `s_${randomUUID()}`,
      kind: "agent",
      title:
        customTitle !== ""
          ? customTitle
          : path.basename(workspaceRoot) || workspaceRoot,
      titleSource: customTitle !== "" ? "user" : "default",
      workspaceRoot,
      mode: preset.mode,
      approvalPolicy: preset.approvalPolicy,
      createdAt: now,
      updatedAt: now,
      lastDenial: null,
    };

    this.sessions.set(session.id, session);
    await this.persist();
    return session;
  }

  /** Replaces the title (auto-generated from the first exchange). */
  async updateTitle(id: string, title: string): Promise<Session> {
    const session = this.getOrThrow(id);
    const trimmed = title.trim();
    if (trimmed === "") return session;
    session.title = trimmed.slice(0, 120);
    session.titleSource = "auto";
    session.updatedAt = new Date().toISOString();
    await this.persist();
    return session;
  }

  async delete(id: string): Promise<void> {
    if (!this.sessions.delete(id)) return;
    await this.persist();
  }

  async updatePermissions(
    id: string,
    mode: SandboxMode,
    approvalPolicy: ApprovalPolicy,
  ): Promise<Session> {
    const session = this.getOrThrow(id);
    session.mode = mode;
    session.approvalPolicy = approvalPolicy;
    session.updatedAt = new Date().toISOString();
    await this.persist();
    return session;
  }

  async recordDenial(id: string, command: string, mode: SandboxMode): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastDenial = { command, mode, at: new Date().toISOString() };
    session.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async clearDenial(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastDenial = null;
    session.updatedAt = new Date().toISOString();
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot: SessionFile = { sessions: this.list() };
    const data = JSON.stringify(snapshot, null, 2);
    this.persistQueue = this.persistQueue
      .then(async () => {
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, data, "utf8");
        await rename(tmp, this.file);
      })
      .catch((error: unknown) => {
        console.error("[sessions] failed to persist", error);
      });
    return this.persistQueue;
  }
}
