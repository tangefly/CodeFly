import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../src/http/errors.js";
import { registerFsRoutes } from "../src/routes/fs.js";

describe("GET /api/fs/browse", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-browse-"));
    await mkdir(path.join(dir, "project"));
    await mkdir(path.join(dir, "another"));
    await mkdir(path.join(dir, ".hidden"));
    await writeFile(path.join(dir, "notes.txt"), "x");

    app = Fastify();
    // Mirror the production error envelope for AppError.
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({
          error: { code: error.code, message: error.message },
        });
      }
      return reply.code(500).send({ error: { code: "INTERNAL", message: "internal" } });
    });
    // The browse route does not touch session/audit state.
    registerFsRoutes(app, {
      sessions: null as never,
      audit: null as never,
      dataDir: dir,
      maxReadBytes: 1024,
      maxWriteBytes: 1024,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists visible subdirectories sorted by name", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/fs/browse?path=${encodeURIComponent(dir)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: dir,
      parent: path.dirname(dir),
      entries: [
        { name: "another", path: path.join(dir, "another") },
        { name: "project", path: path.join(dir, "project") },
      ],
    });
  });

  it("rejects paths that are not directories", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/fs/browse?path=${encodeURIComponent(path.join(dir, "notes.txt"))}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "FS_NOT_A_DIRECTORY" },
    });
  });

  it("reports the filesystem root with a null parent", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/fs/browse?path=${encodeURIComponent(path.parse(dir).root)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: path.parse(dir).root,
      parent: null,
    });
  });
});
