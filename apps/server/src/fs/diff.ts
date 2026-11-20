interface DiffOp {
  type: " " | "-" | "+";
  line: string;
  oldLine: number;
  newLine: number;
}

export interface UnifiedDiff {
  /** Empty when the contents are identical. */
  diff: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Bounded LCS; large files fall back to a coarse replace summary. */
function diffOps(before: string[], after: string[]): { ops: DiffOp[]; truncated: boolean } {
  const n = before.length;
  const m = after.length;
  const ops: DiffOp[] = [];
  let oldLine = 1;
  let newLine = 1;
  const push = (type: DiffOp["type"], line: string): void => {
    ops.push({ type, line, oldLine, newLine });
    if (type !== "+") oldLine += 1;
    if (type !== "-") newLine += 1;
  };

  if (n * m > 4_000_000) {
    for (const line of before) push("-", line);
    for (const line of after) push("+", line);
    return { ops, truncated: true };
  }

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (before[i] === after[j]) {
        dp[i * width + j] = dp[(i + 1) * width + j + 1]! + 1;
      } else {
        dp[i * width + j] = Math.max(
          dp[(i + 1) * width + j]!,
          dp[i * width + j + 1]!,
        );
      }
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      push(" ", before[i]!);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      push("-", before[i]!);
      i += 1;
    } else {
      push("+", after[j]!);
      j += 1;
    }
  }
  while (i < n) {
    push("-", before[i]!);
    i += 1;
  }
  while (j < m) {
    push("+", after[j]!);
    j += 1;
  }
  return { ops, truncated: false };
}

function formatHunk(ops: DiffOp[]): string {
  const first = ops[0]!;
  const oldCount = ops.filter((op) => op.type !== "+").length;
  const newCount = ops.filter((op) => op.type !== "-").length;
  const oldStart = oldCount === 0 ? first.oldLine - 1 : first.oldLine;
  const newStart = newCount === 0 ? first.newLine - 1 : first.newLine;
  return [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...ops.map((op) => `${op.type}${op.line}`),
  ].join("\n");
}

/**
 * Produces a unified diff with three context lines. The result is bounded so a
 * huge rewrite cannot blow up a tool result or the UI.
 */
export function unifiedDiff(
  filePath: string,
  before: string,
  after: string,
  options: { context?: number; maxChars?: number } = {},
): UnifiedDiff {
  if (before === after) {
    return { diff: "", additions: 0, deletions: 0, truncated: false };
  }
  const context = options.context ?? 3;
  const maxChars = options.maxChars ?? 24_000;
  const { ops, truncated } = diffOps(splitLines(before), splitLines(after));
  const additions = ops.filter((op) => op.type === "+").length;
  const deletions = ops.filter((op) => op.type === "-").length;

  const hunks: string[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.type === " ") {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    while (end < ops.length) {
      if (ops[end]!.type !== " ") {
        end += 1;
        continue;
      }
      let probe = end;
      while (probe < ops.length && ops[probe]!.type === " ") probe += 1;
      if (probe < ops.length && probe - end <= context * 2) {
        end = probe;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    hunks.push(formatHunk(ops.slice(start, stop)));
    index = stop;
  }

  const body = hunks.join("\n");
  const header = `--- a/${filePath}\n+++ b/${filePath}`;
  let diff = `${header}\n${body}`;
  let clipped = truncated;
  if (diff.length > maxChars) {
    diff = `${diff.slice(0, maxChars)}\n[... diff truncated at ${maxChars} characters]`;
    clipped = true;
  }
  return { diff, additions, deletions, truncated: clipped };
}
