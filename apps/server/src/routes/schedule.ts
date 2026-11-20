import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  chatSchema,
  scheduleEmailSendSchema,
  scheduleEmailSettingsSchema,
  scheduleEmailTestSchema,
  scheduleFixedEventCreateSchema,
  scheduleFixedEventUpdateSchema,
  scheduleOverviewQuerySchema,
  schedulePreferencesUpdateSchema,
  scheduleTaskUpdateSchema,
  type AgentEvent,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import { SSE_HEADERS, sseComment, sseFrame } from "../exec/sse.js";
import { waitForTitle, type SessionTitler } from "../llm/title.js";
import type { SessionStore } from "../session/store.js";
import type {
  ScheduleEmailConfigStore,
  ScheduleEmailService,
} from "../schedule/email.js";
import { buildScheduleAgenda } from "../schedule/agenda.js";
import {
  renderAgendaPng,
} from "../schedule/render.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ScheduleStore } from "../schedule/store.js";
import {
  nowClockInTimezone,
  rangeEndOf,
  todayInTimezone,
} from "../schedule/time.js";

export interface ScheduleRouteDeps {
  sessions: SessionStore;
  store: ScheduleStore;
  emailConfig: ScheduleEmailConfigStore;
  email: ScheduleEmailService;
  schedule: ScheduleService;
  titler: SessionTitler;
  audit: AuditLog;
}

const SCHEDULE_HEARTBEAT_MS = 15_000;

export function registerScheduleRunRoutes(
  app: FastifyInstance,
  deps: ScheduleRouteDeps,
): void {
  app.post("/api/sessions/:id/schedule", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = deps.sessions.getScheduleOrThrow(id);
    const body = chatSchema.parse(request.body);
    deps.schedule.assertReady(id);

    reply.hijack();
    reply.raw.writeHead(200, SSE_HEADERS);
    reply.raw.setTimeout(0);

    let seq = 0;
    let finished = false;
    const abort = new AbortController();

    const write = (chunk: string): void => {
      if (finished || reply.raw.writableEnded) return;
      try {
        reply.raw.write(chunk);
      } catch {
        // Client went away; the close handler aborts the run.
      }
    };

    const emit = (event: AgentEvent): void => {
      seq += 1;
      write(sseFrame(String(seq), event));
    };

    const heartbeat = setInterval(() => {
      write(sseComment("ping"));
    }, SCHEDULE_HEARTBEAT_MS);
    heartbeat.unref?.();

    const onClose = (): void => {
      if (!finished) abort.abort();
    };
    reply.raw.on("close", onClose);

    try {
      if (!abort.signal.aborted) {
        await deps.schedule.run(session, body.message, abort.signal, emit);
        const titled = await waitForTitle(
          deps.titler.maybeTitle(id, body.message),
        );
        if (titled !== null) {
          emit({ type: "session.updated", session: titled });
        }
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      emit({
        type: "agent.error",
        code: appError?.code ?? "SCHEDULE_ERROR",
        message:
          appError?.message ??
          (error instanceof Error ? error.message : String(error)),
      });
    } finally {
      finished = true;
      clearInterval(heartbeat);
      reply.raw.removeListener("close", onClose);
      if (!reply.raw.writableEnded) {
        try {
          reply.raw.end();
        } catch {
          // Socket already closed.
        }
      }
    }

    return reply;
  });
}

export function registerScheduleRoutes(
  app: FastifyInstance,
  deps: ScheduleRouteDeps,
): void {
  app.get("/api/schedule/overview", async (request) => {
    const query = scheduleOverviewQuerySchema.parse(request.query);
    return { overview: deps.store.overview(query.start_date) };
  });

  app.patch("/api/schedule/preferences", async (request) => {
    const body = schedulePreferencesUpdateSchema.parse(request.body);
    const preferences = await deps.store.updatePreferences(body);
    void deps.audit.append({
      type: "schedule.preferences.changed",
      action: "updated",
      source: "ui",
      rules: preferences.rules.length,
      bufferRatio: preferences.bufferRatio,
      gapMinutes: preferences.gapMinutes,
    });
    return { preferences };
  });

  app.post("/api/schedule/fixed-events", async (request, reply) => {
    const body = scheduleFixedEventCreateSchema.parse(request.body);
    const event = await deps.store.createFixedEvent(body);
    void deps.audit.append({
      type: "schedule.fixed_event.changed",
      action: "created",
      fixedEventId: event.id,
      title: event.title,
      source: "ui",
    });
    reply.code(201);
    return { event };
  });

  app.patch("/api/schedule/fixed-events/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = scheduleFixedEventUpdateSchema.parse(request.body);
    const event = await deps.store.updateFixedEvent(id, body);
    void deps.audit.append({
      type: "schedule.fixed_event.changed",
      action: "updated",
      fixedEventId: event.id,
      title: event.title,
      source: "ui",
    });
    return { event };
  });

  app.delete("/api/schedule/fixed-events/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const event = deps.store.getFixedEvent(id);
    const deleted = await deps.store.deleteFixedEvent(id);
    if (!deleted) {
      throw new AppError("FIXED_EVENT_NOT_FOUND", `unknown fixed event: ${id}`, 404);
    }
    void deps.audit.append({
      type: "schedule.fixed_event.changed",
      action: "deleted",
      fixedEventId: id,
      title: event?.title,
      source: "ui",
    });
    return reply.code(204).send();
  });

  app.patch("/api/schedule/tasks/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = scheduleTaskUpdateSchema.parse(request.body);
    const task = await deps.store.updateTask(id, body);
    void deps.audit.append({
      type: "schedule.task.changed",
      action: "updated",
      taskId: task.id,
      source: "ui",
    });
    return { task };
  });

  app.delete("/api/schedule/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = deps.store.getTask(id);
    const deleted = await deps.store.deleteTask(id);
    if (!deleted) {
      throw new AppError("TASK_NOT_FOUND", `unknown task: ${id}`, 404);
    }
    void deps.audit.append({
      type: "schedule.task.changed",
      action: "deleted",
      taskId: id,
      title: task?.title,
      source: "ui",
    });
    return reply.code(204).send();
  });

  app.get("/api/schedule/email/settings", async () => {
    return { settings: deps.emailConfig.getPublic() };
  });

  app.put("/api/schedule/email/settings", async (request) => {
    const body = scheduleEmailSettingsSchema.parse(request.body);
    const settings = await deps.emailConfig.update(body);
    void deps.audit.append({
      type: "settings.changed",
      source: "schedule-email",
      host: settings.host,
      from: settings.from,
      to: settings.to,
    });
    return { settings };
  });

  app.post("/api/schedule/email/test", async (request) => {
    const body = scheduleEmailTestSchema.parse(request.body);
    return { result: await deps.email.test(body) };
  });

  app.post("/api/schedule/email/send", async (request) => {
    const body = scheduleEmailSendSchema.parse(request.body);
    const preferences = deps.store.getPreferences();
    const today = todayInTimezone(preferences.timezone);
    const startDate = body.start_date ?? today;
    const days = body.days ?? 7;
    const endDate = rangeEndOf(startDate, days);
    const window = deps.store.getWindow(startDate, days);
    if (window === null) {
      throw new AppError(
        "PLAN_NOT_FOUND",
        `这个时间窗口还没有计划：${startDate} ~ ${endDate}`,
        404,
      );
    }
    const tasks = deps.store.listTasks({ includeDone: true, limit: 200 });
    const fixedEvents = deps.store.listFixedEvents();
    const summary = deps.store.summarizeWindow(window);
    const agenda = buildScheduleAgenda({
      window,
      tasks,
      fixedEvents,
      preferences,
      startDate,
      endDate,
      today,
      nowClock: nowClockInTimezone(preferences.timezone),
      summary,
    });
    const render = await renderAgendaPng({
      agenda,
      outputDir: deps.store.getExportsDir(),
    });
    const result = await deps.email.sendPlan({
      window,
      agenda,
      summary,
      png: render.buffer,
      fileName: `codefly-agenda-${startDate}.png`,
    });
    void deps.audit.append({
      type: "schedule.email.sent",
      rangeStart: startDate,
      rangeEnd: endDate,
      to: result.to,
      messageId: result.messageId,
      imagePath: render.filePath,
      source: "ui",
    });
    return {
      ok: true,
      to: result.to,
      messageId: result.messageId,
      imagePath: render.filePath,
    };
  });

  app.get("/api/schedule/exports/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!/^week-\d{4}-\d{2}-\d{2}-[A-Za-z0-9-]+\.png$/.test(name)) {
      throw new AppError("INVALID_EXPORT_NAME", "invalid export file name", 400);
    }
    const file = path.join(deps.store.getExportsDir(), name);
    try {
      const data = await readFile(file);
      return reply
        .type("image/png")
        .header("Cache-Control", "no-store")
        .send(data);
    } catch {
      throw new AppError("EXPORT_NOT_FOUND", `unknown export: ${name}`, 404);
    }
  });
}
