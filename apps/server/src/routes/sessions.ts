import type { FastifyInstance } from "fastify";
import {
  createSessionSchema,
  permissionsSchema,
  updateSettingsSchema,
  type Session,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import type { SessionStore } from "../session/store.js";
import type { SettingsStore } from "../settings/store.js";

export interface SessionRouteDeps {
  sessions: SessionStore;
  settings: SettingsStore;
  audit: AuditLog;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionRouteDeps,
): void {
  app.post("/api/sessions", async (request, reply) => {
    const body = createSessionSchema.parse(request.body);
    const session = await deps.sessions.create(
      body.workspaceRoot,
      body.title,
      deps.settings.get().defaultPreset,
    );

    await deps.audit.append({
      type: "session.created",
      sessionId: session.id,
      workspaceRoot: session.workspaceRoot,
      mode: session.mode,
      approvalPolicy: session.approvalPolicy,
      title: session.title,
    });

    reply.code(201);
    return { session };
  });

  app.get("/api/sessions", async () => {
    return { sessions: deps.sessions.list() };
  });

  app.get("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { session: deps.sessions.getOrThrow(id) };
  });

  app.patch("/api/sessions/:id/permissions", async (request) => {
    const { id } = request.params as { id: string };
    const body = permissionsSchema.parse(request.body);
    const session = deps.sessions.getOrThrow(id);

    if (body.mode === "danger-full-access" && body.confirmRisk !== true) {
      throw new AppError(
        "CONFIRMATION_REQUIRED",
        "enabling danger-full-access requires confirmRisk: true; " +
          "commands will be able to read and write files outside the workspace",
        400,
      );
    }

    const approvalPolicy =
      body.approvalPolicy ??
      (body.mode === "danger-full-access" ? "never" : "ask");
    const before = { mode: session.mode, approvalPolicy: session.approvalPolicy };

    const updated: Session = await deps.sessions.updatePermissions(
      id,
      body.mode,
      approvalPolicy,
    );

    await deps.audit.append({
      type: "permission.changed",
      sessionId: id,
      from: before,
      to: { mode: updated.mode, approvalPolicy: updated.approvalPolicy },
      riskConfirmed: body.mode === "danger-full-access" ? true : undefined,
    });

    return { session: updated };
  });

  app.get("/api/settings", async () => {
    return { settings: deps.settings.get() };
  });

  app.patch("/api/settings", async (request) => {
    const parsed = updateSettingsSchema.parse(request.body);
    const settings = await deps.settings.setDefaultPreset(parsed.defaultPreset);

    await deps.audit.append({
      type: "settings.changed",
      defaultPreset: settings.defaultPreset,
    });

    return { settings };
  });
}
