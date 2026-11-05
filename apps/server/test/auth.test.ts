import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSecurity } from "../src/auth.js";
import { AppError } from "../src/http/errors.js";

async function makeApp() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });
  // The real server registers @fastify/multipart; a parser is enough here.
  app.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  registerSecurity(app, "token");
  app.post("/api/papers/upload", async () => ({ ok: true }));
  app.post("/api/papers", async () => ({ ok: true }));
  return app;
}

describe("registerSecurity", () => {
  it("accepts JSON bodies with a valid bearer token", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/papers",
      headers: { authorization: "Bearer token" },
      payload: { arxivId: "2501.01234" },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("allows multipart only on the paper upload endpoint", async () => {
    const app = await makeApp();
    const allowed = await app.inject({
      method: "POST",
      url: "/api/papers/upload",
      headers: {
        authorization: "Bearer token",
        "content-type": "multipart/form-data; boundary=----codefly",
      },
      payload: "--x--",
    });
    expect(allowed.statusCode).toBe(200);

    const denied = await app.inject({
      method: "POST",
      url: "/api/papers",
      headers: {
        authorization: "Bearer token",
        "content-type": "multipart/form-data; boundary=----codefly",
      },
      payload: "--x--",
    });
    expect(denied.statusCode).toBe(415);
    await app.close();
  });

  it("rejects a missing or invalid token", async () => {
    const app = await makeApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/papers",
      payload: {},
    });
    expect(missing.statusCode).toBe(401);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/papers",
      headers: { authorization: "Bearer wrong" },
      payload: {},
    });
    expect(invalid.statusCode).toBe(401);
    await app.close();
  });
});
