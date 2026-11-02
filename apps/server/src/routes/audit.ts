import type { FastifyInstance } from "fastify";
import { auditQuerySchema } from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import type { SessionStore } from "../session/store.js";

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionStore; audit: AuditLog },
): void {
  app.get("/api/sessions/:id/audit", async (request) => {
    const { id } = request.params as { id: string };
    deps.sessions.getOrThrow(id);
    const query = auditQuerySchema.parse(request.query);
    const events = await deps.audit.recent(id, query.limit ?? 200);
    return { events };
  });
}
