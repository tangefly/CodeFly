import { realpath } from "node:fs/promises";
import path from "node:path";
import { errnoCode } from "../http/errors.js";

/**
 * Resolves a path that exists. Used for immutable workspace roots and
 * writable roots.
 */
export async function canonicalizeExisting(target: string): Promise<string> {
  return realpath(path.resolve(target));
}

/**
 * Canonicalizes a target that may not exist yet: resolve the deepest existing
 * ancestor with realpath, then append the remaining (non-existent) segments.
 * If the target itself is a symlink, realpath resolves it to the link target.
 */
export async function canonicalizeForWrite(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const suffix: string[] = [];
  let current = absolute;

  // Bounded: path depth is finite; this guard only exists to fail loudly on
  // a bug rather than spin.
  for (let depth = 0; depth < 512; depth += 1) {
    try {
      const resolved = await realpath(current);
      return suffix.length > 0
        ? path.join(resolved, ...suffix.reverse())
        : resolved;
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT") throw error;

      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.push(path.basename(current));
      current = parent;
    }
  }

  throw new Error(`path is too deep to canonicalize: ${absolute}`);
}

/** True when `child` equals or lies beneath `root` (both absolute). */
export function isUnder(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}
