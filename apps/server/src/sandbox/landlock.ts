import os from "node:os";
import {
  grantArgs,
  launcherPath,
  probe as probeLauncher,
} from "@deepseek-ai/node-addon-system/landlock-run";
import type { SandboxProbe } from "@codefly/protocol";
import { AppError } from "../http/errors.js";
import type { ConfinedCommand, SandboxPolicy, SandboxRunner } from "./types.js";

/**
 * Landlock launcher runner. Grants read+execute beneath `/` and write only
 * beneath the mode's writable roots (plus /dev/null, so `>/dev/null` works).
 *
 * Network and reads are deliberately unrestricted; Landlock only confines
 * filesystem writes.
 */
export class LandlockRunner implements SandboxRunner {
  readonly name = "landlock" as const;
  private verdict: SandboxProbe | null = null;

  probe(): SandboxProbe {
    if (this.verdict === null) {
      try {
        this.verdict = probeLauncher(launcherPath(), { timeoutMs: 2000 });
      } catch {
        this.verdict = "unusable";
      }
    }
    return this.verdict;
  }

  wrap(argv: string[], policy: SandboxPolicy): ConfinedCommand {
    const verdict = this.probe();
    if (verdict === "unusable") {
      throw new AppError(
        "SANDBOX_UNAVAILABLE",
        "landlock-run launcher is unusable on this host; refusing to execute without a sandbox",
        503,
      );
    }

    const readWrite = ["/dev/null"];
    if (policy.mode === "workspace-write") {
      readWrite.push(policy.workspaceRoot, "/tmp", os.tmpdir());
      readWrite.push(...(policy.readWritePaths ?? []));
    }

    return {
      argv: [
        launcherPath(),
        ...grantArgs({ readOnly: ["/"], readWrite: dedupe(readWrite) }),
        "--",
        ...argv,
      ],
      enforcement: verdict === "partial" ? "partial" : "full",
      denialSignatures: ["permission denied", "read-only file system", "operation not permitted"],
      runnerFailureSignatures: ["landlock-run: "],
    };
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
