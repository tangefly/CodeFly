import type { FastifyInstance } from "fastify";
import {
  agentQuestionAnswerSchema,
  agentSettingsUpdateSchema,
  approvalDecisionSchema,
  chatSchema,
  type AgentEvent,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import type { ApprovalService } from "../approval/service.js";
import { AppError } from "../http/errors.js";
import { SSE_HEADERS, sseComment, sseFrame } from "../exec/sse.js";
import type { AgentConfigStore } from "../agent/config-store.js";
import type { AgentService } from "../agent/service.js";
import type { QuestionService } from "../interaction/questions.js";
import { waitForTitle, type SessionTitler } from "../llm/title.js";
import type { SessionStore } from "../session/store.js";

export interface AgentRouteDeps {
  sessions: SessionStore;
  agentConfig: AgentConfigStore;
  agent: AgentService;
  approvals: ApprovalService;
  questions: QuestionService;
  titler: SessionTitler;
  audit: AuditLog;
}

const AGENT_HEARTBEAT_MS = 15_000;

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): void {
  app.get("/api/agent/settings", async () => {
    return { settings: deps.agentConfig.getPublic() };
  });

  app.put("/api/agent/settings", async (request) => {
    const body = agentSettingsUpdateSchema.parse(request.body);
    const settings = await deps.agentConfig.update(body);
    await deps.audit.append({
      type: "settings.changed",
      scope: "agent",
      maxSteps: settings.maxSteps,
      commandTimeoutMs: settings.commandTimeoutMs,
      enabledTools: settings.enabledTools,
    });
    return { settings };
  });

  app.post("/api/agent/approvals/:approvalId", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = approvalDecisionSchema.parse(request.body);
    const decided = deps.approvals.decide(approvalId, body.decision);
    if (!decided) {
      throw new AppError(
        "APPROVAL_NOT_PENDING",
        "this approval is no longer pending",
        409,
      );
    }
    return { ok: true };
  });

  app.post("/api/agent/questions/:questionId/answer", async (request) => {
    const { questionId } = request.params as { questionId: string };
    const body = agentQuestionAnswerSchema.parse(request.body);
    const answered = deps.questions.answer(questionId, body.answers);
    if (!answered) {
      throw new AppError(
        "QUESTION_NOT_PENDING",
        "this question is no longer pending",
        409,
      );
    }
    return { ok: true };
  });

  app.post("/api/sessions/:id/agent", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = deps.sessions.getAgentOrThrow(id);
    const body = chatSchema.parse(request.body);
    deps.agent.assertReady(id);

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
    }, AGENT_HEARTBEAT_MS);
    heartbeat.unref?.();

    const onClose = (): void => {
      if (!finished) abort.abort();
    };
    reply.raw.on("close", onClose);

    try {
      if (!abort.signal.aborted) {
        await deps.agent.run(session, body.message, abort.signal, emit);
        // Name the session after its first exchange once the run is done.
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
        code: appError?.code ?? "AGENT_ERROR",
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
