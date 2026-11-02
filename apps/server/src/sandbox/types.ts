import type {
  Enforcement,
  RunnerName,
  SandboxMode,
  SandboxProbe,
} from "@codefly/protocol";

export interface SandboxPolicy {
  mode: SandboxMode;
  workspaceRoot: string;
  /**
   * Extra files/directories granted read-write in `workspace-write` mode.
   * Used for explicit device passthrough (e.g. GPU nodes); ignored in every
   * other mode.
   */
  readWritePaths?: readonly string[];
}

export interface ConfinedCommand {
  argv: string[];
  enforcement: Enforcement;
  denialSignatures: string[];
  runnerFailureSignatures: string[];
}

export interface SandboxRunner {
  readonly name: RunnerName;
  probe(): SandboxProbe;
  wrap(argv: string[], policy: SandboxPolicy): ConfinedCommand;
}
