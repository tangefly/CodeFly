import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent } from "@codefly/protocol";

/**
 * Append-only JSONL audit log. Appends are serialized so concurrent execs
 * never interleave partial lines.
 */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
  }

  append(event: Omit<AuditEvent, "ts"> & { ts?: string }): Promise<void> {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    this.queue = this.queue
      .then(() => appendFile(this.file, line, "utf8"))
      .catch((error: unknown) => {
        console.error("[audit] failed to append event", error);
      });
    return this.queue;
  }

  async recent(sessionId: string, limit: number): Promise<AuditEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }

    const events: AuditEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AuditEvent;
        if (parsed.sessionId === sessionId) events.push(parsed);
      } catch {
        // Ignore a torn line from a crash rather than failing the API.
      }
    }
    return events.slice(-limit);
  }
}
