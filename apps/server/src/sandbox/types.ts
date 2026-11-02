import type {
  Enforcement,
  RunnerName,
  SandboxMode,
  SandboxProbe,
} from "@codefly/protocol";

export interface SandboxPolicy {
  mode: SandboxMode;
  workspaceRoot: string;
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
