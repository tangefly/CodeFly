import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  chatSchema,
  scheduleEmailSendSchema,
  scheduleEmailSettingsSchema,
  scheduleEmailTestSchema,
  scheduleMemoryCreateSchema,
  scheduleMemoryUpdateSchema,
  scheduleOverviewQuerySchema,
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
import { renderWeekPng } from "../schedule/render.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ScheduleStore } from "../schedule/store.js";
import { isValidDate, mondayOf, todayInTimezone, weekEndOf } from "../schedule/time.js";

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
    return { overview: deps.store.overview(query.week_start) };
  });

  app.post("/api/schedule/memories", async (request, reply) => {
    const body = scheduleMemoryCreateSchema.parse(request.body);
    const memory = await deps.store.createMemory({
      key: body.key,
      category: body.category,
      title: body.title,
      content: body.content,
      data: body.data,
      tags: body.tags,
      pinned: body.pinned,
    });
    void deps.audit.append({
      type: "schedule.memory.changed",
      action: "created",
      memoryId: memory.id,
      key: memory.key,
      source: "ui",
    });
    reply.code(201);
    return { memory };
  });

  app.patch("/api/schedule/memories/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = scheduleMemoryUpdateSchema.parse(request.body);
    const memory = await deps.store.updateMemory(id, body);
    void deps.audit.append({
      type: "schedule.memory.changed",
      action: "updated",
      memoryId: memory.id,
      key: memory.key,
      source: "ui",
    });
    return { memory };
  });

  app.delete("/api/schedule/memories/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const memory = deps.store.getMemory(id);
    const deleted = await deps.store.deleteMemory(id);
    if (!deleted) {
      throw new AppError("MEMORY_NOT_FOUND", `unknown memory: ${id}`, 404);
    }
    void deps.audit.append({
      type: "schedule.memory.changed",
      action: "deleted",
      memoryId: id,
      key: memory?.key,
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
    const weekStart = mondayOf(body.week_start ?? today);
    if (!isValidDate(weekStart)) {
      throw new AppError("INVALID_WEEK", "invalid week_start", 400);
    }
    const plan = deps.store.getPlan(weekStart) ?? null;
    if (plan === null) {
      throw new AppError(
        "PLAN_NOT_FOUND",
        `这一周还没有计划：${weekStart}`,
        404,
      );
    }
    const tasks = deps.store.listTasks({ includeDone: true, limit: 200 });
    const summary = deps.store.summarize(plan, preferences);
    const render = await renderWeekPng({
      plan,
      tasks,
      preferences,
      weekStart,
      weekEnd: weekEndOf(weekStart),
      summary,
      outputDir: deps.store.getExportsDir(),
    });
    const result = await deps.email.sendPlan({
      plan,
      summary,
      png: render.buffer,
      fileName: `codefly-week-${weekStart}.png`,
    });
    void deps.audit.append({
      type: "schedule.email.sent",
      weekStart,
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
