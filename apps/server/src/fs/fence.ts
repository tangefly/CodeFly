import type { AgentSession, SandboxMode } from "@codefly/protocol";
import { AppError } from "../http/errors.js";
import { assertNotProtected } from "../policy/protected-paths.js";
import { writableRoots } from "../policy/writable-roots.js";
import { canonicalizeForWrite, isUnder } from "./canonicalize.js";

export function denialMessage(mode: SandboxMode): string {
  return [
    `[sandbox: file access denied under ${mode} mode]`,
    "[sandbox: escalation available — retry this exact operation once with sandbox_permissions + justification; the approval prompt asks the user]",
  ].join("\n");
}

export interface FenceResult {
  /** Canonical path the write must actually use. */
  resolved: string;
}

/**
 * Enforces the session's write mode for direct file tools. Reads are not
 * fenced (matching the plan's local-agent threat model).
 */
export async function assertWritable(
  session: AgentSession,
  target: string,
  dataDir: string,
): Promise<FenceResult> {
  if (session.mode === "read-only") {
    throw new AppError("SANDBOX_DENIED", denialMessage(session.mode), 403);
  }

  if (session.mode === "danger-full-access") {
    // Resolve symlinks even in full-access mode so protected paths cannot be
    // reached through an alias.
    const resolved = await canonicalizeForWrite(target);
    assertNotProtected(resolved, dataDir);
    return { resolved };
  }

  const resolved = await canonicalizeForWrite(target);
  const roots = await writableRoots(session);
  if (!roots.some((root) => isUnder(resolved, root))) {
    throw new AppError(
      "SANDBOX_DENIED",
      `${denialMessage(session.mode)}\n[target: ${resolved}]`,
      403,
    );
  }

  assertNotProtected(resolved, dataDir);
  return { resolved };
}
