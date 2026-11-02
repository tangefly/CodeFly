import { spawnSync } from "node:child_process";
import type { SandboxProbe } from "@codefly/protocol";
import { AppError } from "../http/errors.js";
import type { ConfinedCommand, SandboxPolicy, SandboxRunner } from "./types.js";

function bwrapArgs(policy: SandboxPolicy): string[] {
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--unshare-pid",
    "--proc", "/proc",
    "--die-with-parent",
  ];
  if (policy.mode === "workspace-write") {
    args.push(
      "--tmpfs", "/tmp",
      "--bind", policy.workspaceRoot, policy.workspaceRoot,
    );
  }
  return args;
}

/**
 * Optional bubblewrap runner, preferred when the host allows unprivileged
 * user namespaces. The plan's MVP target host does not, so Landlock is the
 * primary path; this exists for other machines.
 */
export class BwrapRunner implements SandboxRunner {
  readonly name = "bwrap" as const;
  private verdict: SandboxProbe | null = null;

  probe(): SandboxProbe {
    if (this.verdict !== null) return this.verdict;
    try {
      const result = spawnSync(
        "bwrap",
        [
          ...bwrapArgs({ mode: "read-only", workspaceRoot: process.cwd() }),
          "--",
          "true",
        ],
        { timeout: 2000, stdio: "ignore" },
      );
      this.verdict = result.status === 0 ? "full" : "unusable";
    } catch {
      this.verdict = "unusable";
    }
    return this.verdict;
  }

  wrap(argv: string[], policy: SandboxPolicy): ConfinedCommand {
    if (this.probe() === "unusable") {
      throw new AppError(
        "SANDBOX_UNAVAILABLE",
        "bwrap is unusable on this host; refusing to execute without a sandbox",
        503,
      );
    }
    return {
      argv: ["bwrap", ...bwrapArgs(policy), "--", ...argv],
      enforcement: "full",
      denialSignatures: ["permission denied", "read-only file system", "operation not permitted"],
      runnerFailureSignatures: ["bwrap: "],
    };
  }
}
