import type { FastifyInstance } from "fastify";
import { chatSchema, type AgentEvent } from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import { SSE_HEADERS, sseComment, sseFrame } from "../exec/sse.js";
import { waitForTitle, type SessionTitler } from "../llm/title.js";
import type { SessionStore } from "../session/store.js";
import type { PaperService } from "../paper/service.js";

export interface PaperRouteDeps {
  sessions: SessionStore;
  paper: PaperService;
  titler: SessionTitler;
  audit: AuditLog;
}

const PAPER_HEARTBEAT_MS = 15_000;

export function registerPaperRunRoutes(
  app: FastifyInstance,
  deps: PaperRouteDeps,
): void {
  app.post("/api/sessions/:id/paper", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = deps.sessions.getPaperOrThrow(id);
    const body = chatSchema.parse(request.body);
    deps.paper.assertReady(id);

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
    }, PAPER_HEARTBEAT_MS);
    heartbeat.unref?.();

    const onClose = (): void => {
      if (!finished) abort.abort();
    };
    reply.raw.on("close", onClose);

    try {
      if (!abort.signal.aborted) {
        await deps.paper.run(session, body.message, abort.signal, emit);
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
        code: appError?.code ?? "PAPER_ERROR",
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
