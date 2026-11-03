import { readFile, readdir, stat } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
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
const DEFAULT_SEARCH_COUNT = 10;
const MAX_SEARCH_COUNT = 50;
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_SEARCH_CONTENT_CHARS = 4_000;
const MAX_SEARCH_ERROR_CHARS = 2_000;
const DEFAULT_FETCH_CHARS = 20_000;
const MAX_FETCH_CHARS = 100_000;
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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

const webSearchArgs = z
  .object({
    /** Search query; DeepSeek supports site:, lang:, after:, before:, quotes. */
    query: z.string().trim().min(1).max(128),
    count: z.number().int().min(1).max(MAX_SEARCH_COUNT).optional(),
    /** Return full page text in addition to the ~600-800 char summary. */
    need_content: z.boolean().optional(),
    /** Optional original user question that motivated the search. */
    ori_question: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const webFetchArgs = z
  .object({
    url: z.string().trim().min(1).max(4096),
    /** Max characters of decoded page text returned to the model. */
    max_chars: z
      .number()
      .int()
      .min(500)
      .max(MAX_FETCH_CHARS)
      .optional(),
  })
  .strict();

const readImageArgs = z
  .object({
    path: z.string().trim().min(1).max(4096),
  })
  .strict();

const searchResultSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().optional(),
    snippet: z.string().optional(),
    summary: z.string().optional(),
    content: z.string().optional(),
    site_name: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    rerank_score: z.number().optional(),
    authority: z.number().optional(),
  })
  .passthrough();

const searchResponseSchema = z
  .object({
    results: z.array(searchResultSchema).default([]),
  })
  .passthrough();

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
  web_search: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live web through the DeepSeek Search API. Returns ranked results with title, URL, summary, site, date and score. Use it for current information outside the workspace: library releases, official docs, package versions, error messages, news. Supports search operators in query: site:, -site:, \"exact phrase\", -word, lang:zh,en, after:2025-01-01, before:2026-01-01. Full page text is omitted by default because summaries are written for models; set need_content=true only when the summary is not enough. Requires a DeepSeek model provider configured in the model API settings.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query of 1-128 characters, optionally using DeepSeek search operators.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_COUNT,
            description: `Number of results to return (default ${DEFAULT_SEARCH_COUNT}).`,
          },
          need_content: {
            type: "boolean",
            description:
              "Also return each page's body as Markdown. Use sparingly: bodies can be long.",
          },
          ori_question: {
            type: "string",
            description:
              "Optional original user question (1-128 characters) that helps the search engine understand intent.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  web_fetch: {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch one HTTP(S) URL and return its readable text. Use it after web_search to read the full page behind a result, or when the user already gave you a URL (docs, raw source, an error page). HTML is converted to plain text; JSON and XML are returned as-is. Only public http(s) hosts are fetched: private, loopback and link-local addresses are refused, redirects are followed up to 5 hops, and the response is capped. Prefer this over run_command with curl/wget.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute http:// or https:// URL to fetch.",
          },
          max_chars: {
            type: "integer",
            minimum: 500,
            maximum: MAX_FETCH_CHARS,
            description: `Maximum characters of text to return (default ${DEFAULT_FETCH_CHARS}). Larger pages are truncated with a note.`,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  read_image: {
    type: "function",
    function: {
      name: "read_image",
      description:
        "Read a local image file (PNG, JPEG, GIF or WebP) and attach it to the conversation so you can inspect what it shows. Use it for screenshots, rendered charts, UI captures or any visual artifact you produced or found. Supports paths relative to the workspace or absolute paths. Images larger than 4 MiB (or the session read limit, if smaller) are refused.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Image path, relative to the workspace or absolute.",
          },
        },
        required: ["path"],
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

export interface WebSearchEndpoint {
  /** Full DeepSeek Search URL, e.g. https://api.deepseek.com/v1/tools/search. */
  url: string;
  apiKey: string;
}

export interface AgentToolExecutorOptions {
  /**
   * Resolves the DeepSeek Search endpoint from the active provider config.
   * Return null when the provider is not DeepSeek or has no API key.
   */
  searchEndpoint?: () => WebSearchEndpoint | null;
  /** Overrides DNS resolution for web_fetch (tests use a fake resolver). */
  resolveHost?: HostResolver;
}

/**
 * DeepSeek Search is served at <origin>/v1/tools/search. The chat base URL
 * may be the origin itself or include /v1, so only the host decides whether
 * the provider supports the search endpoint.
 */
export function deepseekSearchUrl(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "deepseek.com" && !host.endsWith(".deepseek.com")) return null;
  return `${url.protocol}//${url.host}/v1/tools/search`;
}

function redactText(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("[redacted]");
}

function searchHttpMessage(status: number): string {
  if (status === 400) return "DeepSeek Search request is invalid (HTTP 400)";
  if (status === 401) {
    return "DeepSeek Search authentication failed (HTTP 401); check the API key";
  }
  if (status === 402) {
    return "DeepSeek account balance is insufficient (HTTP 402)";
  }
  if (status === 403) {
    return "DeepSeek Search request was rejected by the security policy (HTTP 403)";
  }
  if (status === 408) {
    return "DeepSeek Search upstream read timed out (HTTP 408); retry later";
  }
  if (status === 413) {
    return "DeepSeek Search request body is too large (HTTP 413)";
  }
  if (status === 429) {
    return "DeepSeek Search rate limit exceeded (HTTP 429); retry later";
  }
  if (status >= 500) {
    return `DeepSeek Search service error (HTTP ${status}); retry later`;
  }
  return `DeepSeek Search returned an error (HTTP ${status})`;
}

async function readSearchErrorBody(
  response: Response,
  apiKey: string,
): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  const trimmed = redactText(text.trim(), apiKey).slice(0, MAX_SEARCH_ERROR_CHARS);
  if (trimmed === "") return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    const error = parsed.error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim() !== "") {
        return message.trim().slice(0, MAX_SEARCH_ERROR_CHARS);
      }
    }
  } catch {
    // Not an OpenAI-style error body; use the raw text.
  }
  return trimmed;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatSearchResults(
  query: string,
  results: Array<z.infer<typeof searchResultSchema>>,
  needContent: boolean,
): string {
  if (results.length === 0) return `No web results for "${query}".`;

  const blocks = results.map((result, index) => {
    const title = collapseWhitespace(result.title ?? "") || "(untitled)";
    const lines = [`${index + 1}. ${title}`, `   URL: ${result.url ?? ""}`];

    const details: string[] = [];
    if (result.site_name) details.push(result.site_name);
    if (result.date) details.push(result.date.slice(0, 10));
    if (typeof result.rerank_score === "number") {
      details.push(`score ${result.rerank_score.toFixed(2)}`);
    }
    if (typeof result.authority === "number" && result.authority >= 0) {
      details.push(`authority ${result.authority}`);
    }
    if (details.length > 0) lines.push(`   ${details.join(" · ")}`);

    const summary =
      collapseWhitespace(result.summary ?? "") ||
      collapseWhitespace(result.snippet ?? "");
    if (summary !== "") lines.push(`   Summary: ${summary}`);

    const body = result.content ?? "";
    if (needContent && body.trim() !== "") {
      const capped =
        body.length > MAX_SEARCH_CONTENT_CHARS
          ? `${body.slice(0, MAX_SEARCH_CONTENT_CHARS)}\n[... page content truncated]`
          : body;
      lines.push(
        "   Content:",
        ...capped.split("\n").map((line) => `   ${line}`),
      );
    }
    return lines.join("\n");
  });

  return `Web search: "${query}" — ${results.length} result(s)\n\n${blocks.join("\n\n")}`;
}

function cancelledSearch(
  meta: AgentToolMeta,
  startedAt: number,
): ToolResult {
  return {
    content: "Web search cancelled.",
    status: "cancelled",
    meta: { ...meta, durationMs: Date.now() - startedAt },
  };
}

async function webSearchResult(
  rawArgs: string,
  ctx: ToolExecutionContext,
  resolveEndpoint: () => WebSearchEndpoint | null,
): Promise<ToolResult> {
  const parsed = parseArgs(webSearchArgs, rawArgs);
  if (!parsed.ok) return toolError(parsed.message, { kind: "search" });
  const args = parsed.data;
  const startedAt = Date.now();
  const meta: AgentToolMeta = { kind: "search", query: args.query };

  const endpoint = resolveEndpoint();
  if (endpoint === null) {
    return toolError(
      "web_search is unavailable: it requires a DeepSeek model provider (Base URL on api.deepseek.com) with an API key. Change the provider in the model API settings or disable this tool.",
      meta,
    );
  }

  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal = AbortSignal.any([ctx.signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: args.query,
        count: args.count ?? DEFAULT_SEARCH_COUNT,
        need_content: args.need_content === true,
        ...(args.ori_question === undefined
          ? {}
          : { ori_question: args.ori_question }),
      }),
      signal,
    });
  } catch (error) {
    if (ctx.signal.aborted) return cancelledSearch(meta, startedAt);
    if (timeoutSignal.aborted) {
      return toolError(
        `DeepSeek Search timed out after ${SEARCH_TIMEOUT_MS} ms.`,
        { ...meta, durationMs: Date.now() - startedAt },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return toolError(
      `Cannot reach DeepSeek Search API: ${redactText(message, endpoint.apiKey)}`,
      { ...meta, durationMs: Date.now() - startedAt },
    );
  }

  if (!response.ok) {
    const detail = await readSearchErrorBody(response, endpoint.apiKey);
    return toolError(
      `${searchHttpMessage(response.status)}${detail === "" ? "" : `\n${detail}`}`,
      { ...meta, durationMs: Date.now() - startedAt },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (ctx.signal.aborted) return cancelledSearch(meta, startedAt);
    if (timeoutSignal.aborted) {
      return toolError(
        `DeepSeek Search timed out after ${SEARCH_TIMEOUT_MS} ms.`,
        { ...meta, durationMs: Date.now() - startedAt },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return toolError(
      `DeepSeek Search returned an invalid response: ${redactText(message, endpoint.apiKey)}`,
      { ...meta, durationMs: Date.now() - startedAt },
    );
  }

  const parsedResponse = searchResponseSchema.safeParse(payload);
  if (!parsedResponse.success) {
    return toolError("DeepSeek Search returned an unexpected response shape.", {
      ...meta,
      durationMs: Date.now() - startedAt,
    });
  }

  const results = parsedResponse.data.results;
  return {
    content: truncateContent(
      formatSearchResults(args.query, results, args.need_content === true),
    ),
    status: "complete",
    meta: {
      ...meta,
      resultCount: results.length,
      durationMs: Date.now() - startedAt,
      contentReturned: args.need_content === true,
    },
  };
}

/** Resolves a hostname to every address it points at; injectable for tests. */
export type HostResolver = (host: string) => Promise<string[]>;

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true });
  return records.map((record) => record.address);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function isBlockedIpv6(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip === "::" || ip === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped !== null) return isBlockedIpv4(mapped[1]!);
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  return ip.startsWith("ff");
}

function isBlockedAddress(address: string): boolean {
  return isIP(address) === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

const BLOCKED_HOSTNAMES = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

/**
 * Refuses loopback, private, link-local and other non-public targets, and
 * re-checks on every redirect hop to blunt DNS-rebinding and redirect tricks.
 */
async function assertPublicUrl(
  url: URL,
  resolveHost: HostResolver,
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http(s) URLs are supported (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("URLs with embedded credentials are not fetched");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") throw new Error("URL has no host");
  if (BLOCKED_HOSTNAMES.test(host)) {
    throw new Error(`refusing to fetch a private host: ${host}`);
  }
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new Error(`refusing to fetch a private address: ${host}`);
    }
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (error) {
    throw new Error(
      `cannot resolve host ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (addresses.length === 0) throw new Error(`cannot resolve host: ${host}`);
  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked !== undefined) {
    throw new Error(`refusing to fetch a private address: ${blocked}`);
  }
}

async function fetchWithRedirects(
  start: URL,
  resolveHost: HostResolver,
  signal: AbortSignal,
): Promise<{ response: Response; url: URL }> {
  let current = start;
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current, resolveHost);
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.any([signal, timeout]),
      headers: {
        "user-agent": "codefly-agent/0.1 (+web_fetch)",
        accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, current);
      continue;
    }
    return { response, url: current };
  }
  throw new Error(`too many redirects (> ${FETCH_MAX_REDIRECTS})`);
}

async function readBodyCapped(
  response: Response,
  limit: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const chunk = Buffer.from(value);
    if (total + chunk.length > limit) {
      chunks.push(chunk.subarray(0, limit - total));
      total = limit;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { buffer: Buffer.concat(chunks, total), truncated };
}

function charsetOf(contentType: string | null): string {
  const match = /charset\s*=\s*([^;]+)/i.exec(contentType ?? "");
  return match?.[1]?.trim().replace(/^["']|["']$/g, "").toLowerCase() ?? "";
}

function decodeText(buffer: Buffer, charset: string): string {
  if (charset !== "") {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch {
      // Unknown charset label: fall back to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  middot: "·",
  copy: "(c)",
  reg: "(R)",
  trade: "(TM)",
};

/** Decodes named and numeric HTML entities without a DOM dependency. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? whole;
  });
}

/** Converts an HTML document to readable plain text (no DOM/libxml). */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|li|tr|h[1-6]|pre|blockquote|table|ul|ol)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(text)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return "";
  return decodeHtmlEntities(match[1]!).replace(/\s+/g, " ").trim();
}

function isTextualContentType(contentType: string): boolean {
  return (
    contentType === "" ||
    /^text\//i.test(contentType) ||
    /^application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json)\b/i.test(contentType) ||
    /\+json\b/i.test(contentType) ||
    /\+xml\b/i.test(contentType)
  );
}

async function webFetchResult(
  rawArguments: string,
  ctx: ToolExecutionContext,
  resolveHost: HostResolver,
): Promise<ToolResult> {
  const parsed = parseArgs(webFetchArgs, rawArguments);
  if (!parsed.ok) return toolError(parsed.message, { kind: "fetch" });

  let target: URL;
  try {
    target = new URL(parsed.data.url);
  } catch {
    return toolError(`Invalid URL: ${parsed.data.url}`, {
      kind: "fetch",
      url: parsed.data.url,
    });
  }

  let response: Response;
  let finalUrl: URL;
  try {
    const fetched = await fetchWithRedirects(target, resolveHost, ctx.signal);
    response = fetched.response;
    finalUrl = fetched.url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Fetch failed for ${target.href}: ${message}`, {
      kind: "fetch",
      url: target.href,
    });
  }

  const contentType = response.headers.get("content-type");
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return toolError(
      `Fetch failed: HTTP ${response.status} ${response.statusText} for ${finalUrl.href}`,
      {
        kind: "fetch",
        url: finalUrl.href,
        statusCode: response.status,
        contentType: contentType ?? undefined,
      },
    );
  }
  if (!isTextualContentType(contentType ?? "")) {
    await response.body?.cancel().catch(() => undefined);
    return toolError(
      `Unsupported content type "${contentType}" for ${finalUrl.href}. web_fetch returns text only; download binary files with run_command (curl -o).`,
      {
        kind: "fetch",
        url: finalUrl.href,
        statusCode: response.status,
        contentType: contentType ?? undefined,
      },
    );
  }

  const { buffer, truncated: bodyTruncated } = await readBodyCapped(
    response,
    FETCH_MAX_BYTES,
  );
  if (buffer.subarray(0, 512).includes(0)) {
    return toolError(
      `Fetched ${finalUrl.href} looks binary (content-type ${contentType ?? "unknown"}). web_fetch returns text only; download it with run_command (curl -o).`,
      {
        kind: "fetch",
        url: finalUrl.href,
        statusCode: response.status,
        contentType: contentType ?? undefined,
      },
    );
  }
  const raw = decodeText(buffer, charsetOf(contentType));
  const isHtml =
    /html/i.test(contentType ?? "") || /^\s*<(!doctype|html)/i.test(raw);
  const title = isHtml ? htmlTitle(raw) : "";
  const body = isHtml ? htmlToText(raw) : raw.trim();
  const maxChars = parsed.data.max_chars ?? DEFAULT_FETCH_CHARS;
  const clipped = body.length > maxChars;
  const shown = clipped ? body.slice(0, maxChars) : body;

  const header = [
    `Fetched ${finalUrl.href}`,
    `HTTP ${response.status} · ${contentType ?? "unknown content type"} · ${buffer.length} bytes`,
    title === "" ? null : `Title: ${title}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  const tail =
    shown === ""
      ? "(no readable text)"
      : `${shown}${clipped ? `\n\n[... truncated at ${maxChars} characters; ${body.length} total. Raise max_chars or fetch a narrower URL.]` : ""}`;

  return {
    content: truncateContent(`${header}\n\n${tail}`),
    status: "complete",
    meta: {
      kind: "fetch",
      url: finalUrl.href,
      statusCode: response.status,
      contentType: contentType ?? "unknown",
      bytes: buffer.length,
      title,
      truncated: bodyTruncated || clipped,
    },
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 4) === "GIF8") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Reads width/height straight from the container header (PNG/GIF/JPEG/WebP). */
export function imageDimensions(
  buffer: Buffer,
  mime: string,
): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1]!;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) return null;
        const isSof =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc;
        if (isSof) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
      return null;
    }
    if (mime === "image/webp" && buffer.length >= 30) {
      const kind = buffer.toString("ascii", 12, 16);
      if (kind === "VP8X") {
        const width = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16));
        const height = 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16));
        return { width, height };
      }
      if (kind === "VP8 " && buffer.length >= 30) {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function readImageResult(
  session: Session,
  input: { path: string },
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const target = resolveReadPath(session, input.path);
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (isNotFound(error)) {
      return toolError(`Image does not exist: ${target}`, {
        kind: "image",
        path: target,
      });
    }
    return toolError(
      `Cannot stat ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { kind: "image", path: target },
    );
  }
  if (info.isDirectory()) {
    return toolError(`Path is a directory: ${target}`, {
      kind: "image",
      path: target,
    });
  }
  const limit = Math.min(MAX_IMAGE_BYTES, Math.max(ctx.maxReadBytes, 0));
  if (info.size > limit) {
    return toolError(
      `Image is ${info.size} bytes; the tool limit is ${limit}. Resize or crop it first.`,
      { kind: "image", path: target, bytes: info.size },
    );
  }

  const buffer = await readFile(target);
  const mime = sniffImageMime(buffer);
  if (mime === null) {
    return toolError(
      `Not a supported image: ${target}. Supported formats: PNG, JPEG, GIF, WebP.`,
      { kind: "image", path: target, bytes: buffer.length },
    );
  }
  const dimensions = imageDimensions(buffer, mime);
  const size =
    dimensions === null ? "unknown dimensions" : `${dimensions.width}x${dimensions.height}`;
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

  return {
    content: `Read image ${target} (${mime}, ${size}, ${buffer.length} bytes). The image is attached to this tool result; inspect it directly instead of guessing from the path.`,
    status: "complete",
    meta: {
      kind: "image",
      path: target,
      bytes: buffer.length,
      mime,
      width: dimensions?.width,
      height: dimensions?.height,
      imageDataUrl: dataUrl,
    },
  };
}

export class AgentToolExecutor implements AgentToolExecutorLike {
  private readonly searchEndpoint: () => WebSearchEndpoint | null;
  private readonly resolveHost: HostResolver;

  constructor(options: AgentToolExecutorOptions = {}) {
    this.searchEndpoint = options.searchEndpoint ?? (() => null);
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
  }

  private resolveSearchEndpoint(): WebSearchEndpoint | null {
    try {
      return this.searchEndpoint();
    } catch {
      return null;
    }
  }

  definitions(enabledTools: AgentToolName[]): LlmToolDefinition[] {
    const searchReady = this.resolveSearchEndpoint() !== null;
    return enabledTools
      .filter((name) => name !== "web_search" || searchReady)
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
      case "web_search":
        return webSearchResult(rawArguments, ctx, () =>
          this.resolveSearchEndpoint(),
        );
      case "web_fetch":
        return webFetchResult(rawArguments, ctx, this.resolveHost);
      case "read_image": {
        const parsed = parseArgs(readImageArgs, rawArguments);
        if (!parsed.ok) return toolError(parsed.message, { kind: "image" });
        return readImageResult(ctx.session, parsed.data, ctx);
      }
      default:
        return toolError(`Unknown tool: ${name}`, { kind: "error" });
    }
  }
}
