import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalPolicy, SandboxMode, Session } from "@codefly/protocol";
import { AppError, isNotFound } from "../http/errors.js";
import { canonicalizeExisting } from "../fs/canonicalize.js";
import { presetForMode } from "../policy/presets.js";

interface SessionFile {
  sessions: Session[];
}

function isMode(value: unknown): value is SandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
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

    try {
      const parsed = JSON.parse(raw) as SessionFile;
      for (const session of parsed.sessions ?? []) {
        if (
          typeof session.id === "string" &&
          typeof session.workspaceRoot === "string" &&
          isMode(session.mode)
        ) {
          this.sessions.set(session.id, {
            ...session,
            approvalPolicy: session.approvalPolicy === "never" ? "never" : "ask",
            lastDenial: session.lastDenial ?? null,
          });
        }
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

  async create(
    workspaceRootInput: string,
    title: string | undefined,
    defaultMode: SandboxMode,
  ): Promise<Session> {
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

    const preset = presetForMode(defaultMode);
    const now = new Date().toISOString();
    const session: Session = {
      id: `s_${randomUUID()}`,
      title: title?.trim() || path.basename(workspaceRoot) || workspaceRoot,
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
