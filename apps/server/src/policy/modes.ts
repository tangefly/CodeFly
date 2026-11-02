import type { SandboxMode } from "@codefly/protocol";

const MODE_RANK: Record<SandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

export function modeRank(mode: SandboxMode): number {
  return MODE_RANK[mode];
}

/** True when `requested` grants strictly more than `current`. */
export function isStrictlyWider(requested: SandboxMode, current: SandboxMode): boolean {
  return MODE_RANK[requested] > MODE_RANK[current];
}

/** Modes a denied operation may request, widest last. */
export function escalationTargets(current: SandboxMode): SandboxMode[] {
  const rank = MODE_RANK[current];
  return (Object.keys(MODE_RANK) as SandboxMode[])
    .filter((mode) => MODE_RANK[mode] > rank)
    .sort((a, b) => MODE_RANK[a] - MODE_RANK[b]);
}
