import os from "node:os";
import path from "node:path";
import type { Session } from "@codefly/protocol";
import { canonicalizeExisting } from "../fs/canonicalize.js";

/**
 * Roots the *file tools* may write under the session's current mode.
 * `read-only` and `danger-full-access` are handled before this is consulted.
 */
export async function writableRoots(session: Session): Promise<string[]> {
  if (session.mode !== "workspace-write") return [];
  const candidates = [session.workspaceRoot, "/tmp", os.tmpdir()];
  const roots = new Set<string>();
  for (const candidate of candidates) {
    try {
      roots.add(await canonicalizeExisting(candidate));
    } catch {
      // A missing /tmp is not worth failing the request over; os.tmpdir()
      // below normally still exists.
      roots.add(path.resolve(candidate));
    }
  }
  return [...roots];
}
