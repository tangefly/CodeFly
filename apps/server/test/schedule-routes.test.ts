import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
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
      // Mirror the production error handler's ZodError mapping so invalid
      // payloads surface as 400 VALIDATION_ERROR like they do in the app.
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: { code: "VALIDATION_ERROR", message: "invalid request payload" },
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

  it("returns the overview and updates preferences through the UI API", async () => {
    const overview = await app.inject({
      method: "GET",
      url: "/api/schedule/overview?start_date=2026-11-16",
    });
    expect(overview.statusCode).toBe(200);
    const overviewBody = overview.json() as {
      overview: { rangeStart: string; preferencesConfigured: boolean };
    };
    expect(overviewBody.overview.rangeStart).toBe("2026-11-16");
    expect(overviewBody.overview.preferencesConfigured).toBe(false);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/schedule/preferences",
      payload: {
        timezone: "Asia/Shanghai",
        workdays: [1, 2, 3, 4, 5],
        workStart: "09:00",
        workEnd: "18:00",
        bufferRatio: 0,
        gapMinutes: 0,
        rules: ["十点前不排会"],
      },
    });
    expect(updated.statusCode).toBe(200);
    const body = updated.json() as {
      preferences: {
        bufferRatio: number;
        gapMinutes: number;
        rules: string[];
      };
    };
    expect(body.preferences.bufferRatio).toBe(0);
    expect(body.preferences.gapMinutes).toBe(0);
    expect(body.preferences.rules).toEqual(["十点前不排会"]);
    expect(store.getPreferences().rules).toEqual(["十点前不排会"]);
    expect(
      auditEvents.filter((event) => event.type === "schedule.preferences.changed"),
    ).toHaveLength(1);
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

  it("manages fixed events through the UI API and returns them in the overview", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/schedule/fixed-events",
      payload: {
        title: "缺 weekday",
        kind: "weekly",
        start: "09:00",
        end: "10:00",
      },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/schedule/fixed-events",
      payload: {
        title: "线上会议 A",
        kind: "weekly",
        weekday: 1,
        start: "16:00",
        end: "17:30",
        location: "线上",
      },
    });
    expect(created.statusCode).toBe(201);
    const event = (created.json() as { event: { id: string } }).event;

    const overview = await app.inject({
      method: "GET",
      url: "/api/schedule/overview?start_date=2026-11-16",
    });
    const overviewBody = overview.json() as {
      overview: { fixedEvents: Array<{ id: string; title: string }> };
    };
    expect(overviewBody.overview.fixedEvents).toHaveLength(1);
    expect(overviewBody.overview.fixedEvents[0]?.title).toBe("线上会议 A");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/schedule/fixed-events/${event.id}`,
      payload: { end: "18:00" },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { event: { end: string } }).event.end).toBe(
      "18:00",
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/schedule/fixed-events/${event.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(store.getFixedEvent(event.id)).toBeUndefined();
    expect(
      auditEvents.filter((item) => item.type === "schedule.fixed_event.changed"),
    ).toHaveLength(3);
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
