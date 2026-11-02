import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError } from "./http/errors.js";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isApiPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return path === "/api" || path.startsWith("/api/");
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Local-only service hardening: bearer token, localhost Origin allow-list,
 * JSON Content-Type enforcement, and conservative response headers.
 */
export function registerSecurity(app: FastifyInstance, token: string): void {
  const expected = Buffer.from(token, "utf8");

  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header("Cross-Origin-Resource-Policy", "same-origin");

    const origin = request.headers.origin;
    if (origin) {
      let hostname: string;
      try {
        hostname = new URL(origin).hostname;
      } catch {
        throw new AppError("FORBIDDEN", "invalid Origin header", 403);
      }
      if (!LOCAL_HOSTNAMES.has(hostname)) {
        throw new AppError("FORBIDDEN", `origin not allowed: ${origin}`, 403);
      }
    }

    if (!isApiPath(request.url)) return;
    if (request.url.split("?")[0] === "/api/health") return;

    if (BODY_METHODS.has(request.method)) {
      const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        throw new AppError(
          "UNSUPPORTED_MEDIA_TYPE",
          "Content-Type must be application/json",
          415,
        );
      }
    }

    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new AppError("UNAUTHORIZED", "missing bearer token", 401);
    }

    const provided = Buffer.from(authorization.slice("Bearer ".length), "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AppError("UNAUTHORIZED", "invalid token", 401);
    }
  });
}
