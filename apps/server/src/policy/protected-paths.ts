import path from "node:path";
import { AppError } from "../http/errors.js";
import { isUnder } from "../fs/canonicalize.js";

/** Directory names the file tools must never write into. */
const PROTECTED_COMPONENTS = new Set([".git", ".claude", ".vscode", ".idea"]);

/** Shell startup files the file tools must never rewrite. */
const PROTECTED_BASENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zslogin",
  ".kshrc",
  ".cshrc",
  ".tcshrc",
  "config.fish",
  ".envrc",
]);

/**
 * Throws when a direct file-tool write targets a protected path. This is
 * independent of sandbox mode: `git` may still write `.git` through a shell
 * command, but the file tools may not edit repository internals.
 */
export function assertNotProtected(target: string, dataDir: string): void {
  const resolved = path.resolve(target);

  if (isUnder(resolved, dataDir)) {
    throw new AppError(
      "FS_PROTECTED",
      `refusing to write CodeFly's own data directory: ${resolved}`,
      403,
    );
  }

  const parts = resolved.split(path.sep).filter(Boolean);
  const blocked = parts.find((part) => PROTECTED_COMPONENTS.has(part));
  if (blocked) {
    throw new AppError(
      "FS_PROTECTED",
      `refusing to write protected path component "${blocked}": ${resolved}`,
      403,
    );
  }

  if (PROTECTED_BASENAMES.has(path.basename(resolved))) {
    throw new AppError(
      "FS_PROTECTED",
      `refusing to write shell startup file: ${resolved}`,
      403,
    );
  }
}
