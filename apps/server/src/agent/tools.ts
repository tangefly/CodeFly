import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  AgentEvent,
  AgentToolMeta,
  AgentToolName,
  ExecEvent,
  SandboxMode,
  Session,
} from "@codefly/protocol";
import { SANDBOX_MODES } from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError, isNotFound } from "../http/errors.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { isUnder } from "../fs/canonicalize.js";
import { assertWritable, denialMessage } from "../fs/fence.js";
import type { ExecService } from "../exec/service.js";
import type { LlmToolDefinition } from "../llm/client.js";

export interface ToolResult {
  content: string;
  status: "complete" | "error" | "cancelled";
  meta?: AgentToolMeta;
}

export interface ToolExecutionContext {
  session: Session;
  dataDir: string;
  maxReadBytes: number;
  maxWriteBytes: number;
  commandTimeoutMs: number;
  exec: ExecService;
  audit: AuditLog;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  toolCallId: string;
}

export interface AgentToolExecutorLike {
  definitions(enabledTools: AgentToolName[]): LlmToolDefinition[];
  execute(
    name: string,
    rawArguments: string,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult>;
}

const MAX_TOOL_CONTENT_CHARS = 30_000;
const MAX_TOOL_STREAM_CHARS = 100_000;
const MAX_MODEL_STREAM_CHARS = 12_000;
const MAX_TOOL_READ_CHARS = 60_000;
const MAX_LIST_ENTRIES = 500;
const MAX_EDIT_OPERATIONS = 100;
const DEFAULT_GREP_RESULTS = 200;
const MAX_GREP_RESULTS = 2_000;
const MAX_GREP_LINE_CHARS = 500;
const MAX_GLOB_MATCHES = 500;
const MAX_SCAN_FILES = 50_000;
const MAX_SCAN_DEPTH = 32;

/** Directories skipped by grep/glob unless include_ignored is set. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "dist",
  "build",
  ".next",
  "coverage",
  "target",
]);

const runCommandArgs = z
  .object({
    command: z.string().trim().min(1).max(100_000),
    cwd: z.string().max(4096).optional(),
    timeout_ms: z.number().int().min(1000).max(600_000).optional(),
    sandbox_permissions: z.enum(SANDBOX_MODES).optional(),
    justification: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const readFileArgs = z
  .object({
    path: z.string().min(1).max(4096),
    /** 1-based first line to return. */
    offset: z.number().int().min(1).optional(),
    /** Maximum number of lines to return. */
    limit: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

const writeFileArgs = z
  .object({
    path: z.string().min(1).max(4096),
    content: z.string(),
  })
  .strict();

const editOperation = z
  .object({
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  })
  .strict();

const editFileArgs = z
  .object({
    path: z.string().min(1).max(4096),
    /** Multiple edits applied in order; all-or-nothing. */
    edits: z.array(editOperation).min(1).max(MAX_EDIT_OPERATIONS).optional(),
    /** Single-edit compatibility form. */
    old_string: z.string().min(1).optional(),
    new_string: z.string().optional(),
    replace_all: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasEdits = value.edits !== undefined;
    const hasLegacy =
      value.old_string !== undefined ||
      value.new_string !== undefined ||
      value.replace_all !== undefined;
    if (hasEdits && hasLegacy) {
      ctx.addIssue({
        code: "custom",
        message: "provide either edits or old_string/new_string, not both",
      });
    }
    if (
      !hasEdits &&
      (value.old_string === undefined || value.new_string === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "provide edits, or both old_string and new_string",
      });
    }
  });

const listFilesArgs = z
  .object({
    path: z.string().max(4096).optional(),
  })
  .strict();

const grepArgs = z
  .object({
    pattern: z.string().min(1).max(10_000),
    path: z.string().max(4096).optional(),
    glob: z.string().max(4096).optional(),
    case_insensitive: z.boolean().optional(),
    fixed_strings: z.boolean().optional(),
    include_ignored: z.boolean().optional(),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(MAX_GREP_RESULTS)
      .optional(),
  })
  .strict();

const globArgs = z
  .object({
    pattern: z.string().min(1).max(4096),
    path: z.string().max(4096).optional(),
    include_ignored: z.boolean().optional(),
  })
  .strict();

const DEFINITIONS: Record<AgentToolName, LlmToolDefinition> = {
  run_command: {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command with bash -c inside the session workspace. The command runs in the Landlock sandbox: read + execute are allowed, writes are limited to the workspace and /tmp. stdin is unavailable. Use this to run tests, builds, git, and small scripts. Output is capped for the model.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Exact bash command to execute.",
          },
          cwd: {
            type: "string",
            description:
              "Working directory relative to the workspace (or absolute inside it). Defaults to the workspace root.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1000,
            maximum: 600000,
            description: "Optional timeout; capped by the agent setting.",
          },
          sandbox_permissions: {
            type: "string",
            enum: ["read-only", "workspace-write", "danger-full-access"],
            description:
              "Only use after this exact command was denied by the sandbox. Requests a one-shot wider mode; the user must approve it.",
          },
          justification: {
            type: "string",
            description:
              "Required with sandbox_permissions: explain why the wider access is needed.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file with line numbers (format: line_number<TAB>content). Relative paths resolve against the workspace; absolute paths are allowed. Use offset/limit to read a slice of a large file. The line-number prefix is display-only: never include it in edit_file old_string/new_string.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, relative to the workspace or absolute.",
          },
          offset: {
            type: "integer",
            minimum: 1,
            description: "1-based line number to start from. Defaults to 1.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100000,
            description:
              "Maximum number of lines to return. Defaults to the rest of the file.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file with UTF-8 content. Writes are fenced by the session permission (workspace + /tmp in workspace-write) and protected paths (.git, .claude, shell rc) are refused. File tools cannot request one-shot escalation.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path. Relative paths must stay inside the workspace.",
          },
          content: { type: "string", description: "Complete file content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  edit_file: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit an existing text file. Pass edits as an array of {old_string, new_string, replace_all?}; edits are applied in order. By default each old_string must occur exactly once; set replace_all to replace every occurrence. If any edit fails, nothing is written. A single {old_string, new_string} pair is also accepted for compatibility. Writes use the same fence as write_file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          edits: {
            type: "array",
            maxItems: MAX_EDIT_OPERATIONS,
            description:
              "Ordered list of replacements, applied atomically to the file content.",
            items: {
              type: "object",
              properties: {
                old_string: {
                  type: "string",
                  description: "Exact text to find (must match whitespace).",
                },
                new_string: {
                  type: "string",
                  description: "Replacement text.",
                },
                replace_all: {
                  type: "boolean",
                  description:
                    "Replace every occurrence instead of requiring uniqueness.",
                },
              },
              required: ["old_string", "new_string"],
              additionalProperties: false,
            },
          },
          old_string: {
            type: "string",
            description: "Single-edit form: exact text to find.",
          },
          new_string: {
            type: "string",
            description: "Single-edit form: replacement text.",
          },
          replace_all: {
            type: "boolean",
            description: "Single-edit form: replace every occurrence.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  list_files: {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List a directory. Relative paths resolve against the workspace; absolute paths are allowed. Returns type and name for up to 500 entries.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path; defaults to the workspace root.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  grep: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents recursively with a regular expression. Prefer this over running grep/rg through run_command. Skips .git, node_modules, dist and other build directories unless include_ignored is true. Returns path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Regular expression (JavaScript syntax), or literal text when fixed_strings is true.",
          },
          path: {
            type: "string",
            description:
              "File or directory to search; defaults to the workspace root. Relative paths resolve against the workspace.",
          },
          glob: {
            type: "string",
            description:
              "Optional glob filter for file paths, e.g. \"**/*.ts\" or \"src/**/*.{ts,tsx}\".",
          },
          case_insensitive: {
            type: "boolean",
            description: "Match case-insensitively.",
          },
          fixed_strings: {
            type: "boolean",
            description: "Treat pattern as literal text instead of a regular expression.",
          },
          include_ignored: {
            type: "boolean",
            description:
              "Also search .git, node_modules and other ignored directories.",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: MAX_GREP_RESULTS,
            description: `Maximum matches to return (default ${DEFAULT_GREP_RESULTS}).`,
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  glob: {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files by glob pattern. Supports *, ?, ** and {a,b}. Prefer this over find/ls through run_command. Returns matching paths relative to the search root.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Glob pattern matched against paths relative to the search root, e.g. \"**/*.ts\" or \"src/**/*.{ts,tsx}\". A pattern without / matches file names at any depth.",
          },
          path: {
            type: "string",
            description:
              "Directory to search; defaults to the workspace root. Relative paths resolve against the workspace.",
          },
          include_ignored: {
            type: "boolean",
            description:
              "Also search .git, node_modules and other ignored directories.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
};

function parseArgs<T>(
  schema: z.ZodType<T>,
  raw: string,
): { ok: true; data: T } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === "" ? "{}" : raw);
  } catch {
    return { ok: false, message: "Tool arguments must be valid JSON." };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `Invalid tool arguments: ${details}` };
  }
  return { ok: true, data: result.data };
}

function toolError(message: string, meta?: AgentToolMeta): ToolResult {
  return { content: message, status: "error", meta };
}

function appendCapped(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) return current;
  return (current + chunk).slice(0, limit);
}

function truncateContent(content: string): string {
  if (content.length <= MAX_TOOL_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_TOOL_CONTENT_CHARS)}\n\n[... truncated; result too large for the model context]`;
}

/** Caps one stream for the model while keeping the trailing notes visible. */
function formatStreamForModel(text: string): string {
  if (text.length <= MAX_MODEL_STREAM_CHARS) return text || "(empty)";
  return `${text.slice(0, MAX_MODEL_STREAM_CHARS)}\n[... ${text.length - MAX_MODEL_STREAM_CHARS} more characters omitted]`;
}

function resolveReadPath(session: Session, input: string | undefined): string {
  if (input === undefined || input === "") return session.workspaceRoot;
  return path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(session.workspaceRoot, input);
}

function resolveWritePath(session: Session, input: string): string {
  const resolved = path.resolve(
    path.isAbsolute(input) ? input : path.join(session.workspaceRoot, input),
  );
  if (!path.isAbsolute(input) && !isUnder(resolved, session.workspaceRoot)) {
    throw new AppError(
      "SANDBOX_DENIED",
      `${denialMessage(session.mode)}\n[relative paths must stay inside the workspace: ${resolved}]`,
      403,
    );
  }
  return resolved;
}

function fileErrorResult(error: unknown, session: Session): ToolResult {
  const appError = error instanceof AppError ? error : null;
  let message =
    appError?.message ??
    (error instanceof Error ? error.message : String(error));

  if (appError?.code === "SANDBOX_DENIED") {
    message +=
      "\n\nFile tools cannot request one-shot escalation. Ask the user to change the session permission, or use run_command (which can request approval).";
  }

  return {
    content: `File operation failed: ${appError ? `[${appError.code}] ` : ""}${message}`,
    status: "error",
    meta: { kind: "error", mode: session.mode, code: appError?.code },
  };
}

/** Splits text into lines, dropping the phantom line after a trailing newline. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

async function readFileResult(
  session: Session,
  input: { path: string; offset?: number; limit?: number },
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const target = resolveReadPath(session, input.path);
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (isNotFound(error)) {
      return toolError(`File does not exist: ${target}`, { kind: "read", path: target });
    }
    return toolError(
      `Cannot stat ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { kind: "read", path: target },
    );
  }
  if (info.isDirectory()) {
    return toolError(`Path is a directory: ${target}`, {
      kind: "read",
      path: target,
    });
  }
  if (info.size > ctx.maxReadBytes) {
    return toolError(
      `File is ${info.size} bytes; the tool read limit is ${ctx.maxReadBytes}. Use run_command with sed/head to read a portion.`,
      { kind: "read", path: target, bytes: info.size },
    );
  }

  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    return toolError(`Refusing to read binary file: ${target}`, {
      kind: "read",
      path: target,
    });
  }

  const allLines = splitLines(buffer.toString("utf8"));
  const totalLines = allLines.length;
  const start = input.offset ?? 1;

  if (totalLines === 0) {
    return {
      content: "(empty file)",
      status: "complete",
      meta: {
        kind: "read",
        path: target,
        bytes: buffer.byteLength,
        startLine: 1,
        endLine: 0,
        totalLines: 0,
        truncated: false,
      },
    };
  }
  if (start > totalLines) {
    return toolError(
      `offset ${start} is beyond the end of the file (${totalLines} lines).`,
      {
        kind: "read",
        path: target,
        bytes: buffer.byteLength,
        startLine: start,
        endLine: totalLines,
        totalLines,
      },
    );
  }

  const end = input.limit === undefined
    ? totalLines
    : Math.min(totalLines, start - 1 + input.limit);
  const width = String(end).length;
  const numbered = allLines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(width)}\t${line}`)
    .join("\n");

  const truncated = numbered.length > MAX_TOOL_READ_CHARS;
  const content = truncated
    ? `${numbered.slice(0, MAX_TOOL_READ_CHARS)}\n\n[... truncated at ${MAX_TOOL_READ_CHARS} characters; requested lines ${start}-${end} of ${totalLines}. Use offset/limit for a smaller range.]`
    : numbered;

  return {
    content,
    status: "complete",
    meta: {
      kind: "read",
      path: target,
      bytes: buffer.byteLength,
      startLine: start,
      endLine: end,
      totalLines,
      truncated,
    },
  };
}

async function listFilesResult(
  session: Session,
  input: string | undefined,
): Promise<ToolResult> {
  const target = resolveReadPath(session, input);
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return toolError(`Directory does not exist: ${target}`, {
        kind: "list",
        path: target,
      });
    }
    return toolError(
      `Cannot list ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { kind: "list", path: target },
    );
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const visible = entries.slice(0, MAX_LIST_ENTRIES);
  const lines = visible.map((entry) => {
    const kind = entry.isDirectory()
      ? "dir "
      : entry.isFile()
        ? "file"
        : entry.isSymbolicLink()
          ? "link"
          : "othr";
    return `${kind} ${entry.name}`;
  });
  const suffix =
    entries.length > visible.length
      ? `\n[... ${entries.length - visible.length} more entries not shown]`
      : "";
  const content = `directory: ${target}\n${lines.join("\n")}${suffix}`;

  return {
    content,
    status: "complete",
    meta: { kind: "list", path: target, entries: entries.length },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Expands one level of {a,b} alternatives, recursively. */
function expandBraces(pattern: string, depth = 0): string[] {
  if (depth >= 8) return [pattern];
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0) return [pattern];
  const body = pattern.slice(open + 1, close);
  const parts = body.split(",");
  if (parts.length < 2) return [pattern];
  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  return parts.flatMap((part) => expandBraces(`${before}${part}${after}`, depth + 1));
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  if (!normalized.includes("/")) source = `(?:.*/)?${source}`;
  return new RegExp(`^${source}$`);
}

function matchesAnyGlob(relPath: string, matchers: RegExp[]): boolean {
  const base = relPath.includes("/")
    ? relPath.slice(relPath.lastIndexOf("/") + 1)
    : relPath;
  return matchers.some((matcher) => matcher.test(relPath) || matcher.test(base));
}

type WalkStopReason = "signal" | "max-files" | "visitor" | null;

interface WalkStats {
  scanned: number;
  stopReason: WalkStopReason;
}

/**
 * Walks regular files under a directory in deterministic order. Symlinks are
 * not followed; heavy build/VCS directories are skipped unless requested.
 * The visitor returns true to stop the walk early.
 */
async function walkFiles(
  root: string,
  options: {
    includeIgnored: boolean;
    signal?: AbortSignal;
    maxFiles?: number;
    maxDepth?: number;
  },
  visit: (filePath: string, relPath: string) => Promise<boolean | void>,
): Promise<WalkStats> {
  const stats: WalkStats = { scanned: 0, stopReason: null };
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES;
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (stats.stopReason !== null) return;
    if (options.signal?.aborted) {
      stats.stopReason = "signal";
      return;
    }
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (stats.stopReason !== null) return;
      if (options.signal?.aborted) {
        stats.stopReason = "signal";
        return;
      }
      if (entry.isSymbolicLink()) continue;

      const childPath = path.join(dir, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!options.includeIgnored && IGNORED_DIRS.has(entry.name)) continue;
        await walk(childPath, childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      stats.scanned += 1;
      if (stats.scanned > maxFiles) {
        stats.stopReason = "max-files";
        return;
      }
      const stop = await visit(childPath, childRel);
      if (stop) {
        stats.stopReason = "visitor";
        return;
      }
    }
  };

  await walk(root, "", 0);
  return stats;
}

type SearchableFile =
  | { ok: true; text: string }
  | { ok: false; reason: "large" | "binary" | "unreadable" };

async function readSearchableText(
  filePath: string,
  maxBytes: number,
): Promise<SearchableFile> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!info.isFile() || info.size > maxBytes) {
    return { ok: false, reason: "large" };
  }

  let buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (buffer.includes(0)) return { ok: false, reason: "binary" };
  return { ok: true, text: buffer.toString("utf8") };
}

async function grepResult(
  rawArgs: string,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = parseArgs(grepArgs, rawArgs);
  if (!parsed.ok) return toolError(parsed.message, { kind: "grep" });
  const args = parsed.data;

  let regex: RegExp;
  try {
    regex = new RegExp(
      args.fixed_strings === true ? escapeRegExp(args.pattern) : args.pattern,
      args.case_insensitive === true ? "i" : "",
    );
  } catch (error) {
    return toolError(
      `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      { kind: "grep", pattern: args.pattern },
    );
  }

  const root = resolveReadPath(ctx.session, args.path);
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch (error) {
    if (isNotFound(error)) {
      return toolError(`Path does not exist: ${root}`, { kind: "grep", path: root });
    }
    return toolError(
      `Cannot access ${root}: ${error instanceof Error ? error.message : String(error)}`,
      { kind: "grep", path: root },
    );
  }

  const maxResults = args.max_results ?? DEFAULT_GREP_RESULTS;
  const matchers =
    args.glob === undefined
      ? null
      : expandBraces(args.glob).map(globToRegExp);
  const matches: string[] = [];
  let skipped = 0;
  let scanned = 0;
  let stopReason: WalkStopReason = null;

  const inspect = async (
    filePath: string,
    relPath: string,
  ): Promise<boolean | void> => {
    if (matchers !== null && !matchesAnyGlob(relPath, matchers)) return;
    const file = await readSearchableText(filePath, ctx.maxReadBytes);
    if (!file.ok) {
      skipped += 1;
      return;
    }

    const lines = file.text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index]!;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!regex.test(line)) continue;
      const display =
        line.length > MAX_GREP_LINE_CHARS
          ? `${line.slice(0, MAX_GREP_LINE_CHARS)}…`
          : line;
      matches.push(`${relPath}:${index + 1}: ${display}`);
      if (matches.length >= maxResults) return true;
    }
  };

  if (rootInfo.isFile()) {
    scanned = 1;
    await inspect(root, path.basename(root));
  } else if (rootInfo.isDirectory()) {
    const stats = await walkFiles(
      root,
      {
        includeIgnored: args.include_ignored === true,
        signal: ctx.signal,
      },
      inspect,
    );
    scanned = stats.scanned;
    stopReason = stats.stopReason;
  } else {
    return toolError(`Path is neither a file nor a directory: ${root}`, {
      kind: "grep",
      path: root,
    });
  }

  if (ctx.signal.aborted || stopReason === "signal") {
    return {
      content: matches.join("\n") || "(cancelled before any match)",
      status: "cancelled",
      meta: {
        kind: "grep",
        path: root,
        pattern: args.pattern,
        matches: matches.length,
      },
    };
  }

  const footer: string[] = [];
  if (matches.length >= maxResults) {
    footer.push(
      `[... stopped at ${maxResults} matches; narrow the pattern, path, or glob]`,
    );
  }
  if (stopReason === "max-files") {
    footer.push(
      `[... stopped after scanning ${MAX_SCAN_FILES} files; narrow the path or use glob]`,
    );
  }
  if (skipped > 0) {
    footer.push(
      `[... ${skipped} file(s) skipped (binary, too large, or unreadable)]`,
    );
  }

  const patternLabel =
    args.fixed_strings === true
      ? JSON.stringify(args.pattern)
      : `/${args.pattern}/`;
  const content =
    matches.length === 0
      ? [
          `No matches for ${patternLabel} under ${root}`,
          ...(footer.length > 0 ? ["", ...footer] : []),
        ].join("\n")
      : [...matches, ...(footer.length > 0 ? ["", ...footer] : [])].join("\n");

  return {
    content: truncateContent(content),
    status: "complete",
    meta: {
      kind: "grep",
      path: root,
      pattern: args.pattern,
      matches: matches.length,
      filesScanned: scanned,
      truncated: matches.length >= maxResults || stopReason === "max-files",
    },
  };
}

async function globResult(
  rawArgs: string,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = parseArgs(globArgs, rawArgs);
  if (!parsed.ok) return toolError(parsed.message, { kind: "glob" });
  const args = parsed.data;

  const matchers = expandBraces(args.pattern).map(globToRegExp);
  const root = resolveReadPath(ctx.session, args.path);
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch (error) {
    if (isNotFound(error)) {
      return toolError(`Path does not exist: ${root}`, { kind: "glob", path: root });
    }
    return toolError(
      `Cannot access ${root}: ${error instanceof Error ? error.message : String(error)}`,
      { kind: "glob", path: root },
    );
  }

  const matches: string[] = [];
  let scanned = 0;
  let stopReason: WalkStopReason = null;

  const inspect = async (
    _filePath: string,
    relPath: string,
  ): Promise<boolean | void> => {
    if (!matchesAnyGlob(relPath, matchers)) return;
    matches.push(relPath);
    if (matches.length >= MAX_GLOB_MATCHES) return true;
  };

  if (rootInfo.isFile()) {
    scanned = 1;
    const rel = path.basename(root);
    if (matchesAnyGlob(rel, matchers)) matches.push(rel);
  } else if (rootInfo.isDirectory()) {
    const stats = await walkFiles(
      root,
      {
        includeIgnored: args.include_ignored === true,
        signal: ctx.signal,
      },
      inspect,
    );
    scanned = stats.scanned;
    stopReason = stats.stopReason;
  } else {
    return toolError(`Path is neither a file nor a directory: ${root}`, {
      kind: "glob",
      path: root,
    });
  }

  if (ctx.signal.aborted || stopReason === "signal") {
    return {
      content: matches.join("\n") || "(cancelled before any match)",
      status: "cancelled",
      meta: {
        kind: "glob",
        path: root,
        pattern: args.pattern,
        matches: matches.length,
      },
    };
  }

  matches.sort((a, b) => a.localeCompare(b));
  const truncated = matches.length >= MAX_GLOB_MATCHES;
  const footer: string[] = [];
  if (truncated) {
    footer.push(
      `[... showing the first ${MAX_GLOB_MATCHES} matches; refine the pattern or path]`,
    );
  }
  if (stopReason === "max-files") {
    footer.push(
      `[... stopped after scanning ${MAX_SCAN_FILES} files; narrow the path]`,
    );
  }

  const content =
    matches.length === 0
      ? [
          `No files matched ${JSON.stringify(args.pattern)} under ${root}`,
          ...(footer.length > 0 ? ["", ...footer] : []),
        ].join("\n")
      : [...matches, ...(footer.length > 0 ? ["", ...footer] : [])].join("\n");

  return {
    content: truncateContent(content),
    status: "complete",
    meta: {
      kind: "glob",
      path: root,
      pattern: args.pattern,
      matches: matches.length,
      filesScanned: scanned,
      truncated: truncated || stopReason === "max-files",
    },
  };
}

async function writeFileResult(
  session: Session,
  input: { path: string; content: string },
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const size = Buffer.byteLength(input.content, "utf8");
  if (size > ctx.maxWriteBytes) {
    return toolError(
      `Content is ${size} bytes; the write limit is ${ctx.maxWriteBytes}.`,
      { kind: "write", path: input.path, bytes: size },
    );
  }

  try {
    const target = resolveWritePath(session, input.path);
    const { resolved } = await assertWritable(session, target, ctx.dataDir);
    if (
      !path.isAbsolute(input.path) &&
      !isUnder(resolved, session.workspaceRoot)
    ) {
      throw new AppError(
        "SANDBOX_DENIED",
        `${denialMessage(session.mode)}\n[relative path resolved outside the workspace: ${resolved}]`,
        403,
      );
    }
    const bytes = await atomicWriteFile(resolved, input.content);
    await ctx.audit.append({
      type: "fs.write",
      sessionId: session.id,
      op: "write",
      path: resolved,
      bytes,
      mode: session.mode,
      via: "agent",
    });
    return {
      content: `Wrote ${bytes} bytes to ${resolved}`,
      status: "complete",
      meta: {
        kind: "write",
        operation: "write",
        path: resolved,
        bytes,
        mode: session.mode,
      },
    };
  } catch (error) {
    return fileErrorResult(error, session);
  }
}

async function editFileResult(
  session: Session,
  input: {
    path: string;
    edits?: Array<{
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }>;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
  },
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  if (
    input.edits === undefined &&
    (input.old_string === undefined || input.new_string === undefined)
  ) {
    return toolError("provide edits, or both old_string and new_string", {
      kind: "edit",
      path: input.path,
    });
  }

  try {
    const target = resolveWritePath(session, input.path);
    const { resolved } = await assertWritable(session, target, ctx.dataDir);
    if (
      !path.isAbsolute(input.path) &&
      !isUnder(resolved, session.workspaceRoot)
    ) {
      throw new AppError(
        "SANDBOX_DENIED",
        `${denialMessage(session.mode)}\n[relative path resolved outside the workspace: ${resolved}]`,
        403,
      );
    }

    let original: string;
    try {
      const info = await stat(resolved);
      if (info.size > ctx.maxReadBytes) {
        return toolError(
          `File is ${info.size} bytes; the edit limit is ${ctx.maxReadBytes}.`,
          { kind: "edit", path: resolved, bytes: info.size },
        );
      }
      const buffer = await readFile(resolved);
      if (buffer.includes(0)) {
        return toolError(`Refusing to edit binary file: ${resolved}`, {
          kind: "edit",
          path: resolved,
        });
      }
      original = buffer.toString("utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return toolError(`File does not exist: ${resolved}`, {
          kind: "edit",
          path: resolved,
        });
      }
      throw error;
    }

    const operations = input.edits ?? [
      {
        old_string: input.old_string!,
        new_string: input.new_string!,
        replace_all: input.replace_all,
      },
    ];

    // All edits are applied in memory; the file is only written when every
    // operation succeeds, so a bad edit never leaves a partial result.
    let updated = original;
    let totalReplacements = 0;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      const label =
        operations.length > 1 ? `edit ${index + 1}/${operations.length}: ` : "";
      const occurrences = updated.split(operation.old_string).length - 1;
      if (occurrences === 0) {
        return toolError(
          `${label}old_string was not found in the file. No changes were written.`,
          { kind: "edit", path: resolved },
        );
      }
      if (occurrences > 1 && operation.replace_all !== true) {
        return toolError(
          `${label}old_string matches ${occurrences} places; pass replace_all: true or use a more specific string. No changes were written.`,
          { kind: "edit", path: resolved },
        );
      }

      updated =
        operation.replace_all === true
          ? updated.split(operation.old_string).join(operation.new_string)
          : updated.replace(operation.old_string, () => operation.new_string);
      totalReplacements += operation.replace_all === true ? occurrences : 1;
    }

    const bytes = await atomicWriteFile(resolved, updated);

    await ctx.audit.append({
      type: "fs.write",
      sessionId: session.id,
      op: "edit",
      path: resolved,
      bytes,
      replacements: totalReplacements,
      edits: operations.length,
      mode: session.mode,
      via: "agent",
    });

    return {
      content: `Applied ${operations.length} edit(s) (${totalReplacements} replacement(s)) to ${resolved}`,
      status: "complete",
      meta: {
        kind: "edit",
        operation: "edit",
        path: resolved,
        bytes,
        replacements: totalReplacements,
        edits: operations.length,
        mode: session.mode,
      },
    };
  } catch (error) {
    return fileErrorResult(error, session);
  }
}

async function runCommandResult(
  rawArgs: string,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = parseArgs(runCommandArgs, rawArgs);
  if (!parsed.ok) {
    return toolError(parsed.message, { kind: "command" });
  }
  const args = parsed.data;
  const timeoutMs = Math.min(
    args.timeout_ms ?? ctx.commandTimeoutMs,
    ctx.commandTimeoutMs,
  );

  let record;
  try {
    record = await ctx.exec.create(ctx.session, {
      command: args.command,
      cwd: args.cwd,
      timeoutMs,
      sandboxPermissions: args.sandbox_permissions,
      justification: args.justification,
    });
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    return toolError(
      appError?.message ??
        (error instanceof Error ? error.message : String(error)),
      {
        kind: "command",
        command: args.command,
        mode: ctx.session.mode,
      },
    );
  }

  let stdout = "";
  let stderr = "";
  let denialMessageText = "";
  let runner = "none";
  let startedMode: SandboxMode = ctx.session.mode;
  type ExitEvent = Extract<ExecEvent, { type: "exec.exit" }>;
  type ErrorEvent = Extract<ExecEvent, { type: "exec.error" }>;
  const captured: { exit: ExitEvent | null; error: ErrorEvent | null } = {
    exit: null,
    error: null,
  };
  let aborted = false;
  const startedAt = Date.now();

  await new Promise<void>((resolve) => {
    let finished = false;
    let unsubscribe = (): void => undefined;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      unsubscribe();
      ctx.signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = (): void => {
      aborted = true;
      try {
        ctx.exec.cancel(record.id);
      } catch {
        // The process may already have exited.
      }
      finish();
    };

    unsubscribe = ctx.exec.subscribe(record, (event) => {
      switch (event.type) {
        case "stdout":
          stdout = appendCapped(stdout, event.data, MAX_TOOL_STREAM_CHARS);
          break;
        case "stderr":
          stderr = appendCapped(stderr, event.data, MAX_TOOL_STREAM_CHARS);
          break;
        case "exec.started":
          startedMode = event.mode;
          runner = event.runner;
          break;
        case "exec.denied":
          denialMessageText = event.message;
          break;
        case "exec.error":
          captured.error = event;
          break;
        case "approval.required":
          ctx.emit({
            type: "agent.approval_required",
            approvalId: event.approvalId,
            execId: event.execId,
            toolCallId: ctx.toolCallId,
            command: event.command,
            currentMode: event.currentMode,
            requestedMode: event.requestedMode,
            justification: event.justification,
            expiresAt: event.expiresAt,
          });
          break;
        case "approval.decided":
          ctx.emit({
            type: "agent.approval_decided",
            approvalId: event.approvalId,
            outcome: event.outcome,
            reason: event.reason,
          });
          break;
        case "exec.exit":
          captured.exit = event;
          finish();
          break;
        default:
          break;
      }
    });

    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  });

  const exitEvent = captured.exit;
  const errorEvent = captured.error;
  const durationMs = exitEvent?.durationMs ?? Date.now() - startedAt;
  const exitCode = exitEvent?.code ?? null;
  const cancelled = aborted || exitEvent?.cancelled === true;
  const truncated =
    exitEvent?.truncated === true ||
    stdout.length >= MAX_TOOL_STREAM_CHARS ||
    stderr.length >= MAX_TOOL_STREAM_CHARS;

  const contentParts = [
    `command: ${args.command}`,
    `exit_code: ${exitCode === null ? "(none)" : exitCode}`,
    `duration_ms: ${durationMs}`,
    `stdout:\n${formatStreamForModel(stdout)}`,
    `stderr:\n${formatStreamForModel(stderr)}`,
  ];
  if (denialMessageText !== "") {
    contentParts.push(
      `\n[sandbox denied under ${startedMode} mode]\n${denialMessageText}\n` +
        "To retry, call run_command again with the exact same command plus sandbox_permissions and justification; the user will be asked for a one-shot approval.",
    );
  }
  if (errorEvent !== null) {
    contentParts.push(
      `\n[exec ${errorEvent.code}]\n${errorEvent.message}`,
    );
  }
  if (exitEvent?.timedOut) contentParts.push("\n[timeout]");
  if (truncated) {
    contentParts.push(
      "\n[output truncated for the model; the UI may show more via spill paths]",
    );
  }
  if (cancelled) contentParts.push("\n[cancelled]");

  const status: ToolResult["status"] = cancelled
    ? "cancelled"
    : denialMessageText !== "" ||
        errorEvent !== null ||
        exitCode === null ||
        exitCode !== 0
      ? "error"
      : "complete";

  return {
    content: truncateContent(contentParts.join("\n")),
    status,
    meta: {
      kind: "command",
      command: args.command,
      cwd: args.cwd ?? ctx.session.workspaceRoot,
      exitCode,
      durationMs,
      mode: startedMode,
      runner,
      stdout: stdout.slice(0, MAX_TOOL_STREAM_CHARS),
      stderr: stderr.slice(0, MAX_TOOL_STREAM_CHARS),
      denied: denialMessageText !== "",
      truncated,
      spillPaths: exitEvent?.spillPaths ?? [],
    },
  };
}

export class AgentToolExecutor implements AgentToolExecutorLike {
  definitions(enabledTools: AgentToolName[]): LlmToolDefinition[] {
    return enabledTools
      .map((name) => DEFINITIONS[name])
      .filter((definition): definition is LlmToolDefinition => Boolean(definition));
  }

  async execute(
    name: string,
    rawArguments: string,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    switch (name) {
      case "run_command":
        return runCommandResult(rawArguments, ctx);
      case "read_file": {
        const parsed = parseArgs(readFileArgs, rawArguments);
        if (!parsed.ok) return toolError(parsed.message, { kind: "read" });
        return readFileResult(ctx.session, parsed.data, ctx);
      }
      case "write_file": {
        const parsed = parseArgs(writeFileArgs, rawArguments);
        if (!parsed.ok) return toolError(parsed.message, { kind: "write" });
        return writeFileResult(ctx.session, parsed.data, ctx);
      }
      case "edit_file": {
        const parsed = parseArgs(editFileArgs, rawArguments);
        if (!parsed.ok) return toolError(parsed.message, { kind: "edit" });
        return editFileResult(ctx.session, parsed.data, ctx);
      }
      case "list_files": {
        const parsed = parseArgs(listFilesArgs, rawArguments);
        if (!parsed.ok) return toolError(parsed.message, { kind: "list" });
        return listFilesResult(ctx.session, parsed.data.path);
      }
      case "grep":
        return grepResult(rawArguments, ctx);
      case "glob":
        return globResult(rawArguments, ctx);
      default:
        return toolError(`Unknown tool: ${name}`, { kind: "error" });
    }
  }
}
