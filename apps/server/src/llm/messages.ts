import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessageRecord, ChatMessageStatus, ChatRole } from "@codefly/protocol";
import { isNotFound } from "../http/errors.js";

interface MessagesFile {
  messages: Record<string, ChatMessageRecord[]>;
}

const ROLES = new Set<ChatRole>(["system", "user", "assistant", "tool"]);
const STATUSES = new Set<ChatMessageStatus>([
  "complete",
  "streaming",
  "error",
  "cancelled",
]);

function isRecord(value: unknown): value is ChatMessageRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ChatMessageRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.role === "string" &&
    ROLES.has(record.role as ChatRole) &&
    typeof record.content === "string" &&
    typeof record.status === "string" &&
    STATUSES.has(record.status as ChatMessageStatus) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function copy(record: ChatMessageRecord): ChatMessageRecord {
  return { ...record };
}

/**
 * Persisted chat history per session. Only chat messages live here; exec
 * cards are UI-only for now. Writes are serialized and the file is
 * rewritten atomically.
 */
export class MessageStore {
  private readonly bySession = new Map<string, ChatMessageRecord[]>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly maxPerSession = 500,
  ) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) console.error("[messages] ignoring unreadable messages.json");
      return;
    }

    let changed = false;
    try {
      const parsed = JSON.parse(raw) as MessagesFile;
      for (const [sessionId, records] of Object.entries(parsed.messages ?? {})) {
        if (!Array.isArray(records)) continue;
        const valid: ChatMessageRecord[] = [];
        for (const record of records) {
          if (!isRecord(record) || record.sessionId !== sessionId) continue;
          if (record.status === "streaming") {
            valid.push({
              ...record,
              status: "cancelled",
              error: record.error ?? "服务重启，生成已中断",
              updatedAt: new Date().toISOString(),
            });
            changed = true;
          } else {
            valid.push(copy(record));
          }
        }
        if (valid.length > 0) {
          this.bySession.set(sessionId, valid.slice(-this.maxPerSession));
        }
      }
    } catch {
      console.error("[messages] ignoring corrupt messages.json");
      return;
    }

    if (changed) await this.persist();
  }

  list(sessionId: string): ChatMessageRecord[] {
    return (this.bySession.get(sessionId) ?? []).map(copy);
  }

  async appendMany(sessionId: string, records: ChatMessageRecord[]): Promise<void> {
    if (records.length === 0) return;
    const existing = this.bySession.get(sessionId) ?? [];
    const next = [...existing, ...records.map(copy)];
    this.bySession.set(sessionId, next.slice(-this.maxPerSession));
    await this.persist();
  }

  async delete(sessionId: string): Promise<void> {
    if (!this.bySession.delete(sessionId)) return;
    await this.persist();
  }

  async update(
    sessionId: string,
    messageId: string,
    patch: Partial<ChatMessageRecord>,
  ): Promise<ChatMessageRecord | null> {
    const list = this.bySession.get(sessionId);
    if (!list) return null;
    const index = list.findIndex((record) => record.id === messageId);
    if (index < 0) return null;

    const updated: ChatMessageRecord = {
      ...list[index]!,
      ...patch,
      id: list[index]!.id,
      sessionId,
      updatedAt: new Date().toISOString(),
    };
    list[index] = updated;
    await this.persist();
    return copy(updated);
  }

  private persist(): Promise<void> {
    const snapshot: MessagesFile = { messages: {} };
    for (const [sessionId, records] of this.bySession) {
      snapshot.messages[sessionId] = records;
    }
    const data = JSON.stringify(snapshot, null, 2);

    this.persistQueue = this.persistQueue
      .then(async () => {
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, data, "utf8");
        await rename(tmp, this.file);
      })
      .catch((error: unknown) => {
        console.error("[messages] failed to persist", error);
      });
    return this.persistQueue;
  }
}
