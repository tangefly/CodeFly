import type { FastifyInstance } from "fastify";
import {
  approvalDecisionSchema,
  execSchema,
} from "@codefly/protocol";
import { AppError } from "../http/errors.js";
import { SSE_HEADERS, sseComment, sseFrame } from "../exec/sse.js";
import type { ExecService } from "../exec/service.js";
import type { SessionStore } from "../session/store.js";

export interface ExecRouteDeps {
  sessions: SessionStore;
  exec: ExecService;
}

const HEARTBEAT_MS = 15_000;

export function registerExecRoutes(
  app: FastifyInstance,
  deps: ExecRouteDeps,
): void {
  app.post("/api/sessions/:id/exec", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = execSchema.parse(request.body);
    const session = deps.sessions.getOrThrow(id);
    const record = await deps.exec.create(session, body);

    reply.code(202);
    return { execId: record.id, status: record.status };
  });

  app.get("/api/exec/:execId/events", async (request, reply) => {
    const { execId } = request.params as { execId: string };
    const record = deps.exec.getRecord(execId);
    if (!record) {
      throw new AppError("EXEC_NOT_FOUND", `unknown execution: ${execId}`, 404);
    }

    reply.hijack();
    reply.raw.writeHead(200, SSE_HEADERS);
    reply.raw.setTimeout(0);

    for (const buffered of deps.exec.snapshotEvents(record)) {
      reply.raw.write(sseFrame(buffered.id, buffered.event));
    }

    if (deps.exec.isTerminal(record)) {
      reply.raw.end();
      return reply;
    }

    const unsubscribe = deps.exec.subscribe(record, (event, id) => {
      if (!reply.raw.writableEnded) reply.raw.write(sseFrame(id, event));
    });

    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(sseComment("ping"));
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);

    return reply;
  });

  app.post("/api/exec/:execId/approval", async (request) => {
    const { execId } = request.params as { execId: string };
    const body = approvalDecisionSchema.parse(request.body);
    const decided = deps.exec.decideApproval(execId, body.decision);
    if (!decided) {
      throw new AppError(
        "APPROVAL_NOT_PENDING",
        "this approval is no longer pending",
        409,
      );
    }
    return { ok: true };
  });

  app.post("/api/exec/:execId/cancel", async (request) => {
    const { execId } = request.params as { execId: string };
    const cancelled = deps.exec.cancel(execId);
    return { ok: true, cancelled };
  });
}
