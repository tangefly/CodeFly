import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { AppError, isNotFound } from "../http/errors.js";

/**
 * Writes `content` to `target` atomically: a sibling temp file, fsync, then
 * rename over the target. The caller must already have fenced `target`.
 */
export async function atomicWriteFile(
  target: string,
  content: string,
): Promise<number> {
  const data = Buffer.from(content, "utf8");
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });

  let mode = 0o644;
  try {
    const existing = await stat(target);
    if (existing.isDirectory()) {
      throw new AppError("FS_IS_DIRECTORY", `target is a directory: ${target}`, 400);
    }
    mode = existing.mode & 0o777;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const tmp = path.join(dir, `.codefly-write-${process.pid}-${randomUUID()}`);
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }

  // Best-effort directory fsync so the rename itself is durable.
  try {
    const dirHandle = await open(dir, constants.O_RDONLY);
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is unsupported on some filesystems; the write already
    // succeeded.
  }

  return data.byteLength;
}
