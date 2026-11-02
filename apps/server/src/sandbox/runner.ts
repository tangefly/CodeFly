import type { SandboxProbe, SandboxStatus } from "@codefly/protocol";
import { AppError } from "../http/errors.js";
import { BwrapRunner } from "./bwrap.js";
import { LandlockRunner } from "./landlock.js";
import type { ConfinedCommand, SandboxPolicy, SandboxRunner } from "./types.js";

export interface SelectedRunner {
  runner: SandboxRunner;
  probe: Exclude<SandboxProbe, "unusable">;
}

/**
 * Probes runners once per process and caches the selection. bwrap wins when
 * usable; otherwise Landlock. If neither works, non-full-access execution is
 * refused (fail-closed) rather than run unsandboxed.
 */
export class SandboxManager {
  private selected: SelectedRunner | null | undefined = undefined;

  init(): SelectedRunner | null {
    if (this.selected !== undefined) return this.selected;
    const candidates: SandboxRunner[] = [new BwrapRunner(), new LandlockRunner()];
    for (const candidate of candidates) {
      const verdict = candidate.probe();
      if (verdict !== "unusable") {
        this.selected = { runner: candidate, probe: verdict };
        return this.selected;
      }
    }
    this.selected = null;
    return null;
  }

  getRunner(): SelectedRunner | null {
    return this.init();
  }

  status(): SandboxStatus {
    const selected = this.init();
    if (selected) {
      return {
        available: true,
        runner: selected.runner.name,
        probe: selected.probe,
        enforcement: selected.probe === "partial" ? "partial" : "full",
        platform: `${process.platform}-${process.arch}`,
        details: `${selected.runner.name} functional probe: ${selected.probe}`,
      };
    }
    return {
      available: false,
      runner: null,
      probe: "unusable",
      enforcement: null,
      platform: `${process.platform}-${process.arch}`,
      details:
        "No usable sandbox runner (bwrap and Landlock both unusable). " +
        "Non-full-access execution is refused; no unsandboxed fallback exists.",
    };
  }

  wrap(argv: string[], policy: SandboxPolicy): ConfinedCommand {
    const selected = this.getRunner();
    if (!selected) {
      throw new AppError(
        "SANDBOX_UNAVAILABLE",
        "no usable sandbox runner; refusing to execute without a sandbox",
        503,
      );
    }
    return selected.runner.wrap(argv, policy);
  }
}
