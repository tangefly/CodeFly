import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatMessageRecord } from "@codefly/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/log.js";
import type { ExecService } from "../src/exec/service.js";
import { AppError } from "../src/http/errors.js";
import { MessageStore } from "../src/llm/messages.js";
import { SessionRunLock } from "../src/llm/run-lock.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { SessionStore } from "../src/session/store.js";
import { SettingsStore } from "../src/settings/store.js";

describe("DELETE /api/sessions/:id", () => {
  let dir: string;
  let app: FastifyInstance;
  let sessions: SessionStore;
  let messages: MessageStore;
  let audit: AuditLog;
  let lock: SessionRunLock;
  let sessionId: string;
  let cleanedSessionIds: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-session-delete-"));
    const workspace = path.join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    const dataDir = path.join(dir, "data");

    sessions = new SessionStore(path.join(dataDir, "sessions.json"));
    await sessions.init();
    messages = new MessageStore(path.join(dataDir, "messages.json"));
    await messages.init();
    audit = new AuditLog(path.join(dataDir, "audit.jsonl"));
    await audit.init();
    const settings = new SettingsStore(path.join(dataDir, "settings.json"));
    await settings.init();
    lock = new SessionRunLock();
    cleanedSessionIds = [];

    sessionId = (
      await sessions.create(workspace, "delete-me", "workspace-write")
    ).id;

    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({
          error: { code: error.code, message: error.message },
        });
      }
      return reply
        .code(500)
        .send({ error: { code: "INTERNAL", message: "internal" } });
    });

    const exec = {
      deleteSession: async (id: string) => {
        cleanedSessionIds.push(id);
      },
    } as unknown as ExecService;

    registerSessionRoutes(app, {
      sessions,
      settings,
      audit,
      messages,
      lock,
      exec,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("deletes the session, its messages, and its transient state", async () => {
    const now = new Date().toISOString();
    const message: ChatMessageRecord = {
      id: "m_test",
      sessionId,
      role: "user",
      content: "hello",
      status: "complete",
      createdAt: now,
      updatedAt: now,
    };
    await messages.appendMany(sessionId, [message]);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`,
    });

    expect(response.statusCode).toBe(204);
    expect(sessions.get(sessionId)).toBeUndefined();
    expect(messages.list(sessionId)).toEqual([]);
    expect(cleanedSessionIds).toEqual([sessionId]);

    const events = await audit.recent(sessionId, 10);
    expect(events.at(-1)).toMatchObject({
      type: "session.deleted",
      sessionId,
    });
  });

  it("returns 404 for an unknown session", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/sessions/s_missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "SESSION_NOT_FOUND" },
    });
  });

  it("refuses to delete a session with a run in flight", async () => {
    lock.acquire(sessionId, "agent");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "SESSION_BUSY" },
    });
    expect(sessions.get(sessionId)).toBeDefined();
    expect(cleanedSessionIds).toEqual([]);
    lock.release(sessionId);
  });
});
