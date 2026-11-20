import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "@codefly/protocol";
import { AppError } from "../src/http/errors.js";
import { registerScheduleRoutes } from "../src/routes/schedule.js";
import {
  ScheduleEmailConfigStore,
  ScheduleEmailService,
} from "../src/schedule/email.js";
import { ScheduleStore } from "../src/schedule/store.js";

describe("schedule management routes", () => {
  let dir: string;
  let app: FastifyInstance;
  let store: ScheduleStore;
  let emailConfig: ScheduleEmailConfigStore;
  let auditEvents: AuditEvent[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-schedule-routes-"));
    store = new ScheduleStore(dir);
    await store.init();
    emailConfig = new ScheduleEmailConfigStore(
      path.join(dir, "schedule", "email.json"),
    );
    await emailConfig.init();
    auditEvents = [];

    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({
          error: { code: error.code, message: error.message },
        });
      }
      return reply
        .code(500)
        .send({ error: { code: "INTERNAL", message: String(error) } });
    });
    registerScheduleRoutes(app, {
      sessions: {} as never,
      store,
      emailConfig,
      email: new ScheduleEmailService(emailConfig),
      schedule: {} as never,
      titler: {} as never,
      audit: {
        append: async (event: AuditEvent) => {
          auditEvents.push({ ...event, ts: new Date().toISOString() });
        },
        recent: async () => [],
      } as never,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the overview and manages memories through the UI API", async () => {
    const overview = await app.inject({
      method: "GET",
      url: "/api/schedule/overview?week_start=2026-11-16",
    });
    expect(overview.statusCode).toBe(200);
    const overviewBody = overview.json() as {
      overview: { weekStart: string; memories: unknown[] };
    };
    expect(overviewBody.overview.weekStart).toBe("2026-11-16");
    expect(overviewBody.overview.memories).toEqual([]);

    const created = await app.inject({
      method: "POST",
      url: "/api/schedule/memories",
      payload: {
        key: "scheduling_preferences",
        category: "preference",
        title: "排期偏好",
        content: "工作日 9-18",
        data: { timezone: "Asia/Shanghai", workdays: [1, 2, 3, 4, 5] },
      },
    });
    expect(created.statusCode).toBe(201);
    const memory = (created.json() as { memory: { id: string; key: string } })
      .memory;
    expect(memory.key).toBe("scheduling_preferences");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/schedule/memories/${memory.id}`,
      payload: { title: "新的标题", pinned: true },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { memory: { title: string } }).memory.title).toBe(
      "新的标题",
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/schedule/memories/${memory.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(store.getMemory(memory.id)).toBeUndefined();
    expect(auditEvents.filter((event) => event.type === "schedule.memory.changed"))
      .toHaveLength(3);
  });

  it("updates and deletes tasks", async () => {
    const task = await store.createTask({
      title: "写论文",
      estimatedMinutes: 120,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/schedule/tasks/${task.id}`,
      payload: { priority: "urgent", deadline: "2026-11-30" },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { task: { priority: string } }).task.priority).toBe(
      "urgent",
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/schedule/tasks/${task.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(store.getTask(task.id)).toBeUndefined();
  });

  it("stores email settings without returning the password", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/schedule/email/settings",
      payload: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        user: "me@example.com",
        password: "secret-password",
        from: "me@example.com",
        to: "me@example.com",
      },
    });
    expect(saved.statusCode).toBe(200);
    const settings = (
      saved.json() as {
        settings: {
          configured: boolean;
          hasPassword: boolean;
          password?: string;
        };
      }
    ).settings;
    expect(settings.configured).toBe(true);
    expect(settings.hasPassword).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("secret-password");

    const fetched = await app.inject({
      method: "GET",
      url: "/api/schedule/email/settings",
    });
    expect(fetched.statusCode).toBe(200);
    expect(JSON.stringify(fetched.json())).not.toContain("secret-password");
  });

  it("rejects unknown or unsafe export names", async () => {
    const unsafe = await app.inject({
      method: "GET",
      url: "/api/schedule/exports/not-a-week.png",
    });
    expect(unsafe.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/api/schedule/exports/week-2026-11-16-20260101-abcdef.png",
    });
    expect(missing.statusCode).toBe(404);
  });
});
