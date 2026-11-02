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
  })
  .strict();

const writeFileArgs = z
  .object({
    path: z.string().min(1).max(4096),
    content: z.string(),
  })
  .strict();

const editFileArgs = z
  .object({
    path: z.string().min(1).max(4096),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  })
  .strict();

const listFilesArgs = z
  .object({
    path: z.string().max(4096).optional(),
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
        "Read a UTF-8 text file. Relative paths resolve against the workspace; absolute paths are allowed. Large files are rejected or truncated for the model.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, relative to the workspace or absolute.",
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
        "Replace an exact string in an existing text file. By default old_string must occur exactly once; set replace_all to replace every occurrence. Writes use the same fence as write_file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          old_string: {
            type: "string",
            description: "Exact text to find (must match whitespace).",
          },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence instead of requiring uniqueness.",
          },
        },
        required: ["path", "old_string", "new_string"],
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

async function readFileResult(
  session: Session,
  input: string,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const target = resolveReadPath(session, input);
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
      `File is ${info.size} bytes; the tool read limit is ${ctx.maxReadBytes}. Use run_command with head/tail for a portion.`,
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

  const text = buffer.toString("utf8");
  const truncated = text.length > MAX_TOOL_READ_CHARS;
  const content = truncated
    ? `${text.slice(0, MAX_TOOL_READ_CHARS)}\n\n[... truncated: showing first ${MAX_TOOL_READ_CHARS} of ${text.length} characters]`
    : text;

  return {
    content,
    status: "complete",
    meta: {
      kind: "read",
      path: target,
      bytes: buffer.byteLength,
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
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  },
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
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

    const occurrences = original.split(input.old_string).length - 1;
    if (occurrences === 0) {
      return toolError("old_string was not found in the file.", {
        kind: "edit",
        path: resolved,
      });
    }
    if (occurrences > 1 && input.replace_all !== true) {
      return toolError(
        `old_string matches ${occurrences} places; pass replace_all: true or use a more specific string.`,
        { kind: "edit", path: resolved },
      );
    }

    const updated =
      input.replace_all === true
        ? original.split(input.old_string).join(input.new_string)
        : original.replace(input.old_string, input.new_string);
    const bytes = await atomicWriteFile(resolved, updated);
    const replacements = input.replace_all === true ? occurrences : 1;

    await ctx.audit.append({
      type: "fs.write",
      sessionId: session.id,
      op: "edit",
      path: resolved,
      bytes,
      replacements,
      mode: session.mode,
      via: "agent",
    });

    return {
      content: `Replaced ${replacements} occurrence(s) in ${resolved}`,
      status: "complete",
      meta: {
        kind: "edit",
        operation: "edit",
        path: resolved,
        bytes,
        replacements,
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
        return readFileResult(ctx.session, parsed.data.path, ctx);
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
      default:
        return toolError(`Unknown tool: ${name}`, { kind: "error" });
    }
  }
}
