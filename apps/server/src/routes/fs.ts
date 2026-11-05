import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  fsEditSchema,
  fsPathQuerySchema,
  fsWriteSchema,
  type AgentSession,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError, isNotFound } from "../http/errors.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { assertWritable, denialMessage } from "../fs/fence.js";
import { isUnder } from "../fs/canonicalize.js";
import type { SessionStore } from "../session/store.js";

export interface FsRouteDeps {
  sessions: SessionStore;
  audit: AuditLog;
  dataDir: string;
  maxReadBytes: number;
  maxWriteBytes: number;
}

function resolvePath(session: AgentSession, input: string | undefined): string {
  if (input === undefined || input === "") return session.workspaceRoot;
  return path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(session.workspaceRoot, input);
}

/**
 * Relative paths are workspace-relative and may never traverse out, even
 * into another writable root such as /tmp. Absolute paths are fenced by the
 * mode's writable roots instead.
 */
function resolveWritePath(session: AgentSession, input: string): string {
  const resolved = resolvePath(session, input);
  if (!path.isAbsolute(input) && !isUnder(resolved, session.workspaceRoot)) {
    throw new AppError(
      "SANDBOX_DENIED",
      `${denialMessage(session.mode)}\n[relative paths must stay inside the workspace: ${resolved}]`,
      403,
    );
  }
  return resolved;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function registerFsRoutes(app: FastifyInstance, deps: FsRouteDeps): void {
  /**
   * Directory browser for the new-session workspace picker. A session does
   * not exist yet when that dialog opens, so this endpoint is intentionally
   * session-free; the global bearer-token hook still applies.
   */
  app.get("/api/fs/browse", async (request) => {
    const query = fsPathQuerySchema.parse(request.query);
    const home = homedir();
    const target =
      query.path === undefined || query.path.trim() === ""
        ? home
        : path.resolve(query.path);

    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if (isNotFound(error)) {
        throw new AppError("FS_NOT_FOUND", `path does not exist: ${target}`, 404);
      }
      throw error;
    }
    if (!info.isDirectory()) {
      throw new AppError(
        "FS_NOT_A_DIRECTORY",
        `path is not a directory: ${target}`,
        400,
      );
    }

    const entries = await readdir(target, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith("."))
        .map(async (entry) => {
          const entryPath = path.join(target, entry.name);
          if (!entry.isDirectory()) {
            if (!entry.isSymbolicLink()) return null;
            try {
              if (!(await stat(entryPath)).isDirectory()) return null;
            } catch {
              return null;
            }
          }
          return { name: entry.name, path: entryPath };
        }),
    );

    const directories = items
      .filter((item): item is { name: string; path: string } => item !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      path: target,
      parent: path.dirname(target) === target ? null : path.dirname(target),
      home,
      entries: directories,
    };
  });

  app.get("/api/sessions/:id/fs/list", async (request) => {
    const { id } = request.params as { id: string };
    const session = deps.sessions.getAgentOrThrow(id);
    const query = fsPathQuerySchema.parse(request.query);
    const target = resolvePath(session, query.path);

    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        throw new AppError("FS_NOT_FOUND", `path does not exist: ${target}`, 404);
      }
      throw error;
    }

    const items = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(target, entry.name);
        let size: number | null = null;
        let mtime: string | null = null;
        try {
          const info = await stat(entryPath);
          size = info.size;
          mtime = info.mtime.toISOString();
        } catch {
          // A dangling symlink or race; still list it.
        }
        return {
          name: entry.name,
          path: entryPath,
          type: entry.isDirectory()
            ? ("directory" as const)
            : entry.isFile()
              ? ("file" as const)
              : entry.isSymbolicLink()
                ? ("symlink" as const)
                : ("other" as const),
          size,
          mtime,
        };
      }),
    );

    items.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      if (a.type === "directory") return -1;
      if (b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    });

    return { path: target, entries: items };
  });

  app.get("/api/sessions/:id/fs/read", async (request) => {
    const { id } = request.params as { id: string };
    const session = deps.sessions.getAgentOrThrow(id);
    const query = fsPathQuerySchema.parse(request.query);
    const target = resolvePath(session, query.path);

    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if (isNotFound(error)) {
        throw new AppError("FS_NOT_FOUND", `file does not exist: ${target}`, 404);
      }
      throw error;
    }
    if (info.isDirectory()) {
      throw new AppError("FS_IS_DIRECTORY", `path is a directory: ${target}`, 400);
    }
    if (info.size > deps.maxReadBytes) {
      throw new AppError(
        "FS_TOO_LARGE",
        `file is ${info.size} bytes; the read limit is ${deps.maxReadBytes}`,
        413,
      );
    }

    const buffer = await readFile(target);
    if (buffer.includes(0)) {
      throw new AppError("FS_BINARY", `refusing to read binary file as UTF-8: ${target}`, 415);
    }

    return {
      path: target,
      content: buffer.toString("utf8"),
      size: buffer.byteLength,
      mtime: info.mtime.toISOString(),
    };
  });

  app.post("/api/sessions/:id/fs/write", async (request) => {
    const { id } = request.params as { id: string };
    const session = deps.sessions.getAgentOrThrow(id);
    const body = fsWriteSchema.parse(request.body);
    const size = byteLength(body.content);
    if (size > deps.maxWriteBytes) {
      throw new AppError(
        "FS_TOO_LARGE",
        `content is ${size} bytes; the write limit is ${deps.maxWriteBytes}`,
        413,
      );
    }

    const target = resolveWritePath(session, body.path);
    const { resolved } = await assertWritable(session, target, deps.dataDir);
    if (!path.isAbsolute(body.path) && !isUnder(resolved, session.workspaceRoot)) {
      throw new AppError(
        "SANDBOX_DENIED",
        `${denialMessage(session.mode)}\n[relative path resolved outside the workspace: ${resolved}]`,
        403,
      );
    }
    const bytes = await atomicWriteFile(resolved, body.content);

    await deps.audit.append({
      type: "fs.write",
      sessionId: id,
      op: "write",
      path: resolved,
      bytes,
      mode: session.mode,
    });

    return { path: resolved, bytes };
  });

  app.post("/api/sessions/:id/fs/edit", async (request) => {
    const { id } = request.params as { id: string };
    const session = deps.sessions.getAgentOrThrow(id);
    const body = fsEditSchema.parse(request.body);

    const target = resolveWritePath(session, body.path);
    const { resolved } = await assertWritable(session, target, deps.dataDir);
    if (!path.isAbsolute(body.path) && !isUnder(resolved, session.workspaceRoot)) {
      throw new AppError(
        "SANDBOX_DENIED",
        `${denialMessage(session.mode)}\n[relative path resolved outside the workspace: ${resolved}]`,
        403,
      );
    }

    let original: string;
    try {
      const buffer = await readFile(resolved);
      if (buffer.includes(0)) {
        throw new AppError("FS_BINARY", `refusing to edit binary file: ${resolved}`, 415);
      }
      original = buffer.toString("utf8");
    } catch (error) {
      if (isNotFound(error)) {
        throw new AppError("FS_NOT_FOUND", `file does not exist: ${resolved}`, 404);
      }
      throw error;
    }

    const occurrences = original.split(body.oldString).length - 1;
    if (occurrences === 0) {
      throw new AppError(
        "FS_OLD_STRING_NOT_FOUND",
        "oldString was not found in the file",
        409,
      );
    }
    if (occurrences > 1 && body.replaceAll !== true) {
      throw new AppError(
        "FS_OLD_STRING_NOT_UNIQUE",
        `oldString matches ${occurrences} places; pass replaceAll: true or use a more specific string`,
        409,
      );
    }

    const updated =
      body.replaceAll === true
        ? original.split(body.oldString).join(body.newString)
        : original.replace(body.oldString, body.newString);
    const bytes = await atomicWriteFile(resolved, updated);

    await deps.audit.append({
      type: "fs.write",
      sessionId: id,
      op: "edit",
      path: resolved,
      bytes,
      replacements: body.replaceAll === true ? occurrences : 1,
      mode: session.mode,
    });

    return { path: resolved, replacements: body.replaceAll === true ? occurrences : 1, bytes };
  });
}
