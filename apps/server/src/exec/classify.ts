/** Strips ANSI CSI and OSC sequences for the plain-text MVP renderer. */
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC, "").replace(ANSI_CSI, "");
}

/**
 * Returns the first stderr line that looks like the sandbox denied a write,
 * or null. Runner-owned diagnostics are never treated as sandbox denials.
 */
export function findDenial(
  text: string,
  denialSignatures: string[],
  runnerFailureSignatures: string[],
): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (runnerFailureSignatures.some((signature) => trimmed.includes(signature))) {
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (denialSignatures.some((signature) => lower.includes(signature.toLowerCase()))) {
      return trimmed.slice(0, 600);
    }
  }
  return null;
}

/**
 * A launcher-level failure exits 125 AND prints its own diagnostic prefix.
 * Exit 125 alone is not enough: the wrapped command may legitimately return
 * 125.
 */
export function isRunnerFailure(
  exitCode: number | null,
  stderrTail: string,
  runnerFailureSignatures: string[],
): boolean {
  return (
    exitCode === 125 &&
    runnerFailureSignatures.some((signature) => stderrTail.includes(signature))
  );
}
