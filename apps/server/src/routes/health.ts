import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "@codefly/protocol";
import type { SandboxManager } from "../sandbox/runner.js";

export function registerHealthRoute(
  app: FastifyInstance,
  deps: { sandbox: SandboxManager; version: string; dev: boolean },
): void {
  app.get("/api/health", async (): Promise<HealthResponse> => {
    return {
      ok: true,
      version: deps.version,
      uptimeMs: Math.round(process.uptime() * 1000),
      sandbox: deps.sandbox.status(),
      dev: deps.dev,
    };
  });
}
