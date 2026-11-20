import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { AppError } from "../http/errors.js";

let cachedAvailability: boolean | undefined;

/** Host ripgrep is optional; the JS walker remains the fallback. */
export function ripgrepAvailable(): boolean {
  if (cachedAvailability !== undefined) return cachedAvailability;
  try {
    const result = spawnSync("rg", ["--version"], {
      stdio: "ignore",
      timeout: 2_000,
    });
    cachedAvailability = result.status === 0;
  } catch {
    cachedAvailability = false;
  }
  return cachedAvailability;
}

export type GrepMode = "content" | "files_with_matches" | "count";

export interface RipgrepGrepOptions {
  root: string;
  rootIsFile?: boolean;
  pattern: string;
  glob?: string;
  caseInsensitive?: boolean;
  fixedStrings?: boolean;
  includeIgnored?: boolean;
  /** Directory names excluded unless includeIgnored is set. */
  excludeDirs?: readonly string[];
  maxResults: number;
  contextLines?: number;
  mode: GrepMode;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface RipgrepResult {
  lines: string[];
  matchCount: number;
  stopReason: "max" | "signal" | "timeout" | null;
}

function targetFor(
  root: string,
  isFile: boolean,
): { cwd: string; target: string } {
  return isFile
    ? { cwd: path.dirname(root), target: path.basename(root) }
    : { cwd: path.resolve(root), target: "." };
}

function normalizeLine(line: string): string {
  return line.startsWith("./") ? line.slice(2) : line;
}

function isMatchLine(line: string): boolean {
  // rg --context uses `path:line:text` for matches and `path-line-text` for
  // context; `--` is a group separator.
  return /^[^:]+:\d+:/.test(line);
}

function runRipgrep(
  args: string[],
  options: {
    cwd: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxResults: number;
    count: (line: string) => number;
  },
): Promise<RipgrepResult> {
  return new Promise<RipgrepResult>((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let matchCount = 0;
    let stopReason: RipgrepResult["stopReason"] = null;
    let stderr = "";
    let settled = false;

    const finish = (kind: "resolve" | "reject", value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (kind === "resolve") resolve(value as RipgrepResult);
      else reject(value);
    };

    const stop = (reason: RipgrepResult["stopReason"]): void => {
      stopReason ??= reason;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    };

    const onAbort = (): void => stop("signal");
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) stop("signal");

    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    timer.unref?.();

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = normalizeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (line !== "--") {
          lines.push(line);
          matchCount += options.count(line);
        }
        if (matchCount >= options.maxResults) {
          stop("max");
          break;
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish("reject", error);
    });
    child.on("close", (code) => {
      if (buffer !== "") {
        const line = normalizeLine(buffer);
        if (line !== "--") {
          lines.push(line);
          matchCount += options.count(line);
        }
      }
      if (code === 2 && stopReason === null) {
        finish(
          "reject",
          new AppError(
            "GREP_FAILED",
            stderr.trim() || "ripgrep failed",
            400,
          ),
        );
        return;
      }
      finish("resolve", { lines, matchCount, stopReason });
    });
  });
}

export function ripgrepGrep(options: RipgrepGrepOptions): Promise<RipgrepResult> {
  const location = targetFor(options.root, options.rootIsFile === true);
  const args = [
    "--no-heading",
    "--line-number",
    "--color",
    "never",
    "--no-messages",
    "--hidden",
  ];
  if (options.includeIgnored === true) args.push("--no-ignore");
  else {
    for (const dir of options.excludeDirs ?? []) {
      args.push("--glob", `!${dir}/**`);
    }
  }
  if (options.caseInsensitive === true) args.push("-i");
  if (options.fixedStrings === true) args.push("-F");
  if (options.glob !== undefined && options.glob !== "") {
    args.push("--glob", options.glob);
  }
  if (options.mode === "content") {
    args.push("--with-filename");
    if ((options.contextLines ?? 0) > 0) {
      args.push("--context", String(options.contextLines));
    }
  } else if (options.mode === "files_with_matches") {
    args.push("--files-with-matches");
  } else {
    args.push("--count");
  }
  args.push("--", options.pattern, location.target);

  return runRipgrep(args, {
    cwd: location.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxResults: options.maxResults,
    count: (line) => {
      if (options.mode === "content") return isMatchLine(line) ? 1 : 0;
      if (options.mode === "count") {
        const match = /:(\d+)$/.exec(line);
        return match === null ? 1 : Number(match[1]);
      }
      return 1;
    },
  });
}

export interface RipgrepGlobOptions {
  root: string;
  pattern: string;
  includeIgnored?: boolean;
  /** Directory names excluded unless includeIgnored is set. */
  excludeDirs?: readonly string[];
  maxMatches: number;
  signal: AbortSignal;
  timeoutMs?: number;
}

export function ripgrepGlob(options: RipgrepGlobOptions): Promise<RipgrepResult> {
  const location = targetFor(options.root, false);
  const args = ["--files", "--hidden", "--no-messages"];
  if (options.includeIgnored === true) args.push("--no-ignore");
  else {
    for (const dir of options.excludeDirs ?? []) {
      args.push("--glob", `!${dir}/**`);
    }
  }
  args.push("--glob", options.pattern, location.target);

  return runRipgrep(args, {
    cwd: location.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxResults: options.maxMatches,
    count: () => 1,
  });
}
