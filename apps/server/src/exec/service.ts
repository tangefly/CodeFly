import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentSession,
  Enforcement,
  ExecEvent,
  ExecInput,
  RunnerName,
  SandboxMode,
} from "@codefly/protocol";
import type { ApprovalService } from "../approval/service.js";
import type { AuditLog } from "../audit/log.js";
import { AppError, isNotFound } from "../http/errors.js";
import { isUnder } from "../fs/canonicalize.js";
import { escalationTargets, isStrictlyWider } from "../policy/modes.js";
import type { SessionStore } from "../session/store.js";
import type { SandboxManager } from "../sandbox/runner.js";
import { findDenial, isRunnerFailure, stripAnsi } from "./classify.js";

export type ExecStatus =
  | "queued"
  | "awaiting-approval"
  | "running"
  | "exited"
  | "error"
  | "cancelled";

interface BufferedEvent {
  id: string;
  event: ExecEvent;
}

type Listener = (event: ExecEvent, eventId: string) => void;

interface ExecRecord {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  standingMode: SandboxMode;
  approvalPolicy: AgentSession["approvalPolicy"];
  requestedMode: SandboxMode | null;
  effectiveMode: SandboxMode;
  justification: string | null;
  workspaceRoot: string;
  status: ExecStatus;
  events: BufferedEvent[];
  seq: number;
  listeners: Set<Listener>;
  everSubscribed: boolean;
  approvalId: string | null;
  child: ChildProcess | null;
  runner: RunnerName | "none";
  enforcement: Enforcement;
  denialSignatures: string[];
  runnerFailureSignatures: string[];
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  timeoutTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  pending: { stdout: Buffer[]; stderr: Buffer[] };
  history: { stdout: Buffer[]; stderr: Buffer[] };
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  killReason: "timeout" | "output-limit" | "cancelled" | null;
  denialEmitted: boolean;
  stderrTail: string;
  spillPaths: string[];
  spills: { stdout: WriteStream | null; stderr: WriteStream | null };
  spillBytes: number;
  runInBackground: boolean;
  promoteOnTimeout: boolean;
  promoted: boolean;
}

export interface ExecServiceOptions {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  /** Bytes buffered in memory before switching a stream to spill-only. */
  outputLimitBytes: number;
  /** Maximum bytes written to spill files before the process is stopped. */
  spillLimitBytes: number;
  flushIntervalMs: number;
  approvalTimeoutMs: number;
  denialTtlMs: number;
  spillDir: string;
  /**
   * Extra files/directories granted read-write in workspace-write mode,
   * e.g. GPU device nodes. Empty by default.
   */
  extraReadWritePaths?: readonly string[];
}

export interface ExecServiceDeps {
  sessions: SessionStore;
  approvals: ApprovalService;
  audit: AuditLog;
  sandbox: SandboxManager;
  options: ExecServiceOptions;
}

export interface JobOutput {
  execId: string;
  command: string;
  status: ExecStatus;
  text: string;
  nextSeq: number;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
  spillPaths: string[];
  promoted: boolean;
}

export interface JobSummary {
  execId: string;
  command: string;
  status: ExecStatus;
  running: boolean;
  startedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  runInBackground: boolean;
  promoted: boolean;
  truncated: boolean;
}

const TERMINAL: ReadonlySet<ExecStatus> = new Set(["exited", "error", "cancelled"]);

export class ExecService {
  private readonly records = new Map<string, ExecRecord>();
  private readonly deps: ExecServiceDeps;

  constructor(deps: ExecServiceDeps) {
    this.deps = deps;
  }

  async create(session: AgentSession, input: ExecInput): Promise<ExecRecord> {
    const snapshot: AgentSession = { ...session };
    const cwd = await this.resolveCwd(snapshot, input.cwd);
    const runInBackground = input.runInBackground === true;
    // Background jobs have no wall-clock deadline; the caller stops them.
    const timeoutMs = runInBackground
      ? 0
      : Math.min(
          input.timeoutMs ?? this.deps.options.defaultTimeoutMs,
          this.deps.options.maxTimeoutMs,
        );

    const requestedMode = input.sandboxPermissions ?? null;
    const justification = input.justification?.trim() ?? null;
    if (requestedMode !== null) {
      if (!isStrictlyWider(requestedMode, snapshot.mode)) {
        throw new AppError(
          "INVALID_ESCALATION",
          `sandboxPermissions must be strictly wider than the session mode (${snapshot.mode})`,
          400,
        );
      }
      if (!justification) {
        throw new AppError(
          "INVALID_ESCALATION",
          "a non-empty justification is required to request escalation",
          400,
        );
      }
      if (snapshot.approvalPolicy === "never") {
        throw new AppError(
          "APPROVAL_UNAVAILABLE",
          "the session's approval policy is never; escalation cannot be requested",
          403,
        );
      }

      const denial = snapshot.lastDenial;
      const fresh =
        denial !== null &&
        Date.now() - Date.parse(denial.at) <= this.deps.options.denialTtlMs;
      if (!fresh || denial.command !== input.command) {
        throw new AppError(
          "INVALID_ESCALATION",
          "escalation is only available as a one-shot retry after a sandbox denial of the same command",
          400,
        );
      }
      // Consume the denial now: a rejected/dismissed approval must not be
      // retried from the same denial.
      await this.deps.sessions.clearDenial(session.id);
    }

    const record: ExecRecord = {
      id: `e_${randomUUID()}`,
      sessionId: session.id,
      command: input.command,
      cwd,
      timeoutMs,
      standingMode: snapshot.mode,
      approvalPolicy: snapshot.approvalPolicy,
      requestedMode,
      effectiveMode: snapshot.mode,
      justification,
      workspaceRoot: snapshot.workspaceRoot,
      status: "queued",
      events: [],
      seq: 0,
      listeners: new Set(),
      everSubscribed: false,
      approvalId: null,
      child: null,
      runner: "none",
      enforcement: "full",
      denialSignatures: [],
      runnerFailureSignatures: [],
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      exitSignal: null,
      timeoutTimer: null,
      flushTimer: null,
      pending: { stdout: [], stderr: [] },
      history: { stdout: [], stderr: [] },
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      killReason: null,
      denialEmitted: false,
      stderrTail: "",
      spillPaths: [],
      spills: { stdout: null, stderr: null },
      spillBytes: 0,
      runInBackground,
      promoteOnTimeout: input.promoteOnTimeout !== false,
      promoted: false,
    };

    this.pruneSessionRecords(session.id);
    this.records.set(record.id, record);
    this.emit(record, {
      type: "exec.queued",
      execId: record.id,
      command: record.command,
      cwd: record.cwd,
      mode: record.standingMode,
    });

    setImmediate(() => {
      void this.start(record).catch((error: unknown) => {
        console.error("[exec] unexpected start failure", error);
        this.emit(record, {
          type: "exec.error",
          code: "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        });
        this.finishWithoutProcess(record, "error");
      });
    });

    return record;
  }

  getRecord(id: string): ExecRecord | undefined {
    return this.records.get(id);
  }

  isTerminal(record: ExecRecord): boolean {
    return TERMINAL.has(record.status);
  }

  snapshotEvents(record: ExecRecord): readonly BufferedEvent[] {
    return record.events;
  }

  subscribe(record: ExecRecord, listener: Listener): () => void {
    record.everSubscribed = true;
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
      if (
        record.listeners.size === 0 &&
        record.everSubscribed &&
        record.status === "awaiting-approval"
      ) {
        // Plan 4.3: a closed page/disconnected SSE stream cancels pending
        // approvals; the command is never executed.
        this.deps.approvals.cancelForExec(record.id, "disconnected");
      }
    };
  }

  decideApproval(execId: string, decision: "allow_once" | "deny"): boolean {
    const record = this.getRecord(execId);
    if (!record) throw new AppError("EXEC_NOT_FOUND", `unknown execution: ${execId}`, 404);
    if (record.status !== "awaiting-approval" || !record.approvalId) {
      throw new AppError(
        "APPROVAL_NOT_PENDING",
        "this execution is not awaiting approval",
        409,
      );
    }
    return this.deps.approvals.decide(record.approvalId, decision);
  }

  cancel(execId: string): boolean {
    const record = this.getRecord(execId);
    if (!record) throw new AppError("EXEC_NOT_FOUND", `unknown execution: ${execId}`, 404);
    if (record.finishedAt !== null) return false;

    record.killReason = "cancelled";

    if (record.status === "queued" || record.status === "awaiting-approval") {
      record.status = "cancelled";
      this.deps.approvals.cancelForExec(record.id, "cancelled");
      return true;
    }

    if (record.status === "running") {
      this.emit(record, {
        type: "exec.error",
        code: "CANCELLED",
        message: "Execution cancelled by user",
      });
      this.kill(record);
      return true;
    }

    return false;
  }

  /** Writes to a background job's stdin; returns false when stdin is closed. */
  writeStdin(execId: string, data: string): boolean {
    const record = this.getRecord(execId);
    if (!record) throw new AppError("EXEC_NOT_FOUND", `unknown execution: ${execId}`, 404);
    if (record.finishedAt !== null || record.status !== "running") {
      throw new AppError(
        "EXEC_NOT_RUNNING",
        `execution ${execId} is not running (status: ${record.status})`,
        409,
      );
    }
    const stdin = record.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(data);
    return true;
  }

  /**
   * Returns buffered output for a job. With `fromSeq`, only events after that
   * sequence are returned; otherwise the tail of the whole transcript.
   */
  jobOutput(
    sessionId: string,
    execId: string,
    options: { fromSeq?: number; maxChars?: number } = {},
  ): JobOutput {
    const record = this.getRecord(execId);
    if (!record) throw new AppError("EXEC_NOT_FOUND", `unknown execution: ${execId}`, 404);
    if (record.sessionId !== sessionId) {
      throw new AppError("EXEC_NOT_FOUND", `unknown execution: ${execId}`, 404);
    }

    const maxChars = Math.max(1_000, options.maxChars ?? 20_000);
    let text = "";
    for (const buffered of record.events) {
      if (options.fromSeq !== undefined && Number(buffered.id) <= options.fromSeq) {
        continue;
      }
      const event = buffered.event;
      if (event.type === "stdout" || event.type === "stderr") {
        text += event.data;
      } else if (event.type === "exec.denied") {
        text += `\n[sandbox denied] ${event.message}\n`;
      } else if (event.type === "exec.error") {
        text += `\n[exec ${event.code}] ${event.message}\n`;
      }
    }

    const truncated = text.length > maxChars;
    if (truncated) {
      const head = Math.min(500, maxChars);
      text = `${text.slice(0, head)}\n[... ${text.length - maxChars} characters omitted ...]\n${text.slice(-(maxChars - head))}`;
    }

    return {
      execId: record.id,
      command: record.command,
      status: record.status,
      text: text.length > 0 ? text : "(no output yet)",
      nextSeq: record.seq,
      running: record.finishedAt === null,
      exitCode: record.exitCode,
      signal: record.exitSignal,
      durationMs:
        record.startedAt === null
          ? 0
          : (record.finishedAt ?? Date.now()) - record.startedAt,
      truncated: record.truncated || truncated,
      spillPaths: record.spillPaths,
      promoted: record.promoted,
    };
  }

  /** Summaries of this session's executions, newest first. */
  listJobs(sessionId: string): JobSummary[] {
    return [...this.records.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 50)
      .map((record) => ({
        execId: record.id,
        command: record.command,
        status: record.status,
        running: record.finishedAt === null,
        startedAt:
          record.startedAt === null
            ? null
            : new Date(record.startedAt).toISOString(),
        durationMs:
          record.startedAt === null
            ? 0
            : (record.finishedAt ?? Date.now()) - record.startedAt,
        exitCode: record.exitCode,
        runInBackground: record.runInBackground,
        promoted: record.promoted,
        truncated: record.truncated,
      }));
  }

  /** Keeps the newest terminal records per session so memory is bounded. */
  private pruneSessionRecords(sessionId: string): void {
    const records = [...this.records.values()].filter(
      (record) => record.sessionId === sessionId && record.finishedAt !== null,
    );
    if (records.length < 50) return;
    records.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const record of records.slice(0, records.length - 49)) {
      this.records.delete(record.id);
    }
  }

  /**
   * Cancel anything still running for a session and remove its per-session
   * tmp directory. Called when the session itself is deleted.
   */
  async deleteSession(sessionId: string): Promise<void> {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && record.finishedAt === null) {
        this.cancel(record.id);
      }
    }
    await rm(`/tmp/codefly/${sessionId}`, { recursive: true, force: true });
  }

  async shutdown(): Promise<void> {
    this.deps.approvals.cancelAll("cancelled");
    for (const record of this.records.values()) {
      if (record.status === "running") this.kill(record);
    }
  }

  // ---------------------------------------------------------------- start

  private async start(record: ExecRecord): Promise<void> {
    if (record.status === "cancelled") {
      this.finishWithoutProcess(record, "cancelled");
      return;
    }

    if (record.requestedMode !== null) {
      record.status = "awaiting-approval";
      const result = await this.deps.approvals.ask(
        {
          kind: "exec",
          toolName: "bash",
          sessionId: record.sessionId,
          execId: record.id,
          currentMode: record.standingMode,
          requestedMode: record.requestedMode,
          command: record.command,
          justification: record.justification ?? "",
        },
        {
          policy: record.approvalPolicy,
          timeoutMs: this.deps.options.approvalTimeoutMs,
          onAsked: (request) => {
            record.approvalId = request.id;
            this.emit(record, {
              type: "approval.required",
              approvalId: request.id,
              execId: record.id,
              kind: "exec",
              command: record.command,
              currentMode: record.standingMode,
              requestedMode: record.requestedMode ?? record.standingMode,
              justification: record.justification ?? "",
              expiresAt: request.expiresAt,
            });
          },
        },
      );

      this.emit(record, {
        type: "approval.decided",
        approvalId: record.approvalId ?? "",
        outcome: result.outcome,
        reason: result.reason,
      });

      if (this.wasCancelled(record)) {
        this.finishWithoutProcess(record, "cancelled");
        return;
      }

      if (result.outcome !== "allowed-once") {
        this.emit(record, {
          type: "exec.error",
          code: approvalFailureCode(result.reason),
          message: approvalFailureMessage(result.reason),
        });
        this.finishWithoutProcess(record, "error");
        return;
      }

      record.effectiveMode = record.requestedMode;
    }

    if (this.wasCancelled(record)) {
      this.finishWithoutProcess(record, "cancelled");
      return;
    }

    let argv = ["bash", "-c", record.command];
    if (record.effectiveMode !== "danger-full-access") {
      try {
        const confined = this.deps.sandbox.wrap(argv, {
          mode: record.effectiveMode,
          workspaceRoot: record.workspaceRoot,
          readWritePaths:
            record.effectiveMode === "workspace-write"
              ? this.deps.options.extraReadWritePaths
              : undefined,
        });
        const selected = this.deps.sandbox.getRunner();
        argv = confined.argv;
        record.runner = selected?.runner.name ?? "none";
        record.enforcement = confined.enforcement;
        record.denialSignatures = confined.denialSignatures;
        record.runnerFailureSignatures = confined.runnerFailureSignatures;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "sandbox runner is unavailable";
        this.emit(record, {
          type: "exec.error",
          code: "SANDBOX_UNAVAILABLE",
          message,
        });
        void this.deps.audit.append({
          type: "sandbox.unavailable",
          sessionId: record.sessionId,
          execId: record.id,
          mode: record.effectiveMode,
          message,
        });
        this.finishWithoutProcess(record, "error");
        return;
      }
    }

    await this.ensureTmpDir(record.sessionId);
    if (this.wasCancelled(record) || record.finishedAt !== null) {
      this.finishWithoutProcess(record, "cancelled");
      return;
    }

    record.status = "running";
    record.startedAt = Date.now();

    this.emit(record, {
      type: "exec.started",
      execId: record.id,
      mode: record.effectiveMode,
      runner: record.runner,
      enforcement: record.enforcement,
    });
    void this.deps.audit.append({
      type: "exec.started",
      sessionId: record.sessionId,
      execId: record.id,
      command: record.command,
      cwd: record.cwd,
      mode: record.effectiveMode,
      runner: record.runner,
      enforcement: record.enforcement,
    });

    let child: ChildProcess;
    try {
      child = spawn(argv[0] ?? "bash", argv.slice(1), {
        cwd: record.cwd,
        env: sandboxEnv(record.sessionId),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(record, {
        type: "exec.error",
        code: "RUNNER_FAILURE",
        message: `failed to start command: ${message}`,
      });
      this.finishWithoutProcess(record, "error");
      return;
    }

    record.child = child;
    // Foreground commands must not block on an open stdin. Background jobs
    // keep it open for write_stdin.
    if (!record.runInBackground) child.stdin?.end();
    child.stdout?.on("data", (chunk: Buffer) => this.onData(record, "stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.onData(record, "stderr", chunk));
    child.on("error", (error) => {
      if (record.finishedAt !== null) return;
      this.emit(record, {
        type: "exec.error",
        code: "RUNNER_FAILURE",
        message: `failed to start command: ${error.message}`,
      });
      this.finishWithoutProcess(record, "error");
    });
    child.on("close", (code, signal) => {
      void this.onClose(record, code, signal);
    });

    record.flushTimer = setInterval(
      () => this.flush(record),
      this.deps.options.flushIntervalMs,
    );
    record.flushTimer.unref?.();

    if (record.timeoutMs > 0) {
      record.timeoutTimer = setTimeout(() => {
        if (record.finishedAt !== null || record.status !== "running") return;
        if (record.promoteOnTimeout) {
          // The command is still making progress; keep it alive and let the
          // model collect the rest through job_output instead of killing it.
          record.promoted = true;
          this.emit(record, {
            type: "exec.promoted",
            execId: record.id,
            timeoutMs: record.timeoutMs,
            spillPaths: record.spillPaths,
          });
          void this.deps.audit.append({
            type: "exec.started",
            sessionId: record.sessionId,
            execId: record.id,
            command: record.command,
            mode: record.effectiveMode,
            promotedAfterMs: record.timeoutMs,
          });
          return;
        }
        record.killReason ??= "timeout";
        this.emit(record, {
          type: "exec.error",
          code: "TIMEOUT",
          message: `Command timed out after ${record.timeoutMs} ms`,
        });
        this.kill(record);
      }, record.timeoutMs);
      record.timeoutTimer.unref?.();
    }
  }

  // ---------------------------------------------------------------- output

  private onData(
    record: ExecRecord,
    stream: "stdout" | "stderr",
    chunk: Buffer,
  ): void {
    if (record.finishedAt !== null) return;

    record.history[stream].push(chunk);
    if (stream === "stdout") record.stdoutBytes += chunk.byteLength;
    else record.stderrBytes += chunk.byteLength;

    if (
      !record.truncated &&
      (record.stdoutBytes > this.deps.options.outputLimitBytes ||
        record.stderrBytes > this.deps.options.outputLimitBytes)
    ) {
      this.beginTruncation(record);
      return;
    }

    if (record.truncated) {
      this.appendSpill(record, stream, chunk);
      return;
    }

    record.pending[stream].push(chunk);
  }

  /** Appends to the spill stream; stops the process only past the hard cap. */
  private appendSpill(
    record: ExecRecord,
    stream: "stdout" | "stderr",
    chunk: Buffer,
  ): void {
    const spill = record.spills[stream];
    if (!spill) return;
    spill.write(chunk);
    record.spillBytes += chunk.byteLength;
    if (
      record.spillBytes > this.deps.options.spillLimitBytes &&
      record.killReason === null
    ) {
      record.killReason = "output-limit";
      this.emit(record, {
        type: "exec.error",
        code: "OUTPUT_LIMIT",
        message:
          `Output exceeded the spill limit (${this.deps.options.spillLimitBytes} bytes); ` +
          `the process was stopped. Full output: ${record.spillPaths.join(", ")}`,
      });
      this.kill(record);
    }
  }

  private flush(record: ExecRecord): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const chunks = record.pending[stream];
      if (chunks.length === 0) continue;
      record.pending[stream] = [];
      const text = stripAnsi(Buffer.concat(chunks).toString("utf8"));
      if (!text) continue;

      this.emit(record, { type: stream, data: text });

      if (stream === "stderr") {
        record.stderrTail = `${record.stderrTail}${text}`.slice(-16_384);
        this.maybeEmitDenial(record);
      }
    }
  }

  private maybeEmitDenial(record: ExecRecord): void {
    if (record.denialEmitted) return;
    if (
      record.runnerFailureSignatures.some((signature) =>
        record.stderrTail.includes(signature),
      )
    ) {
      return;
    }

    const line = findDenial(
      record.stderrTail,
      record.denialSignatures,
      record.runnerFailureSignatures,
    );
    if (!line) return;

    record.denialEmitted = true;
    const message = [
      `[sandbox: command denied under ${record.effectiveMode} mode]`,
      line,
      "[sandbox: escalation available — retry this exact command once with sandbox_permissions + justification; the approval prompt asks the user]",
    ].join("\n");

    this.emit(record, {
      type: "exec.denied",
      mode: record.effectiveMode,
      message,
      command: record.command,
      canEscalateTo:
        record.approvalPolicy === "never"
          ? []
          : escalationTargets(record.effectiveMode),
    });
    void this.deps.sessions.recordDenial(
      record.sessionId,
      record.command,
      record.effectiveMode,
    );
  }

  private beginTruncation(record: ExecRecord): void {
    record.truncated = true;
    record.pending = { stdout: [], stderr: [] };

    for (const stream of ["stdout", "stderr"] as const) {
      const spillPath = path.join(
        this.deps.options.spillDir,
        `${record.id}.${stream}.log`,
      );
      const spill = createWriteStream(spillPath, { flags: "w" });
      spill.on("error", (error) => {
        console.error(`[exec] spill write failed for ${spillPath}`, error);
      });
      record.spills[stream] = spill;
      record.spillPaths.push(spillPath);
      for (const buffered of record.history[stream]) {
        spill.write(buffered);
        record.spillBytes += buffered.byteLength;
      }
      record.history[stream] = [];
    }
  }

  // ---------------------------------------------------------------- close

  private async onClose(
    record: ExecRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (record.finishedAt !== null) return;

    if (record.timeoutTimer) {
      clearTimeout(record.timeoutTimer);
      record.timeoutTimer = null;
    }
    if (record.flushTimer) {
      clearInterval(record.flushTimer);
      record.flushTimer = null;
    }

    this.flush(record);
    this.maybeEmitDenial(record);
    await this.closeSpills(record);

    const runnerFailure =
      !record.denialEmitted &&
      isRunnerFailure(code, record.stderrTail, record.runnerFailureSignatures);
    if (runnerFailure) {
      this.emit(record, {
        type: "exec.error",
        code: "RUNNER_FAILURE",
        message:
          "sandbox runner failed before executing the command: " +
          record.stderrTail.trim().slice(0, 2000),
      });
    }

    record.finishedAt = Date.now();
    record.exitCode = code;
    record.exitSignal = signal;
    const durationMs =
      record.startedAt === null ? 0 : record.finishedAt - record.startedAt;
    record.status = runnerFailure
      ? "error"
      : record.killReason === "cancelled"
        ? "cancelled"
        : record.killReason !== null
          ? "error"
          : "exited";

    this.emit(record, {
      type: "exec.exit",
      code,
      signal,
      durationMs,
      truncated: record.truncated,
      cancelled: record.killReason === "cancelled",
      timedOut: record.killReason === "timeout",
      spillPaths: record.spillPaths,
    });

    void this.deps.audit.append({
      type: "exec.exit",
      sessionId: record.sessionId,
      execId: record.id,
      command: record.command,
      mode: record.effectiveMode,
      runner: record.runner,
      code,
      signal,
      durationMs,
      truncated: record.truncated,
      cancelled: record.killReason === "cancelled",
      timedOut: record.killReason === "timeout",
      runnerFailure,
    });
  }

  private finishWithoutProcess(
    record: ExecRecord,
    status: "error" | "cancelled",
  ): void {
    if (record.finishedAt !== null) return;
    if (record.timeoutTimer) {
      clearTimeout(record.timeoutTimer);
      record.timeoutTimer = null;
    }
    if (record.flushTimer) {
      clearInterval(record.flushTimer);
      record.flushTimer = null;
    }

    record.finishedAt = Date.now();
    record.exitCode = null;
    record.exitSignal = null;
    record.status = status;
    const durationMs =
      record.startedAt === null ? 0 : record.finishedAt - record.startedAt;

    this.emit(record, {
      type: "exec.exit",
      code: null,
      signal: null,
      durationMs,
      truncated: record.truncated,
      cancelled: status === "cancelled",
      timedOut: record.killReason === "timeout",
      spillPaths: record.spillPaths,
    });

    void this.deps.audit.append({
      type: "exec.exit",
      sessionId: record.sessionId,
      execId: record.id,
      command: record.command,
      mode: record.effectiveMode,
      runner: record.runner,
      code: null,
      signal: null,
      durationMs,
      truncated: record.truncated,
      cancelled: status === "cancelled",
      timedOut: record.killReason === "timeout",
      note: "command was not executed",
    });
  }

  private async closeSpills(record: ExecRecord): Promise<void> {
    const spills = [record.spills.stdout, record.spills.stderr].filter(
      (spill): spill is WriteStream => spill !== null,
    );
    record.spills = { stdout: null, stderr: null };
    await Promise.all(
      spills.map(
        (spill) =>
          new Promise<void>((resolve) => {
            const done = (): void => resolve();
            spill.once("finish", done);
            spill.once("error", done);
            spill.end();
            const guard = setTimeout(done, 2000);
            guard.unref?.();
          }),
      ),
    );
  }

  private emit(record: ExecRecord, event: ExecEvent): void {
    record.seq += 1;
    const id = String(record.seq);
    record.events.push({ id, event });
    for (const listener of record.listeners) {
      try {
        listener(event, id);
      } catch (error) {
        console.error("[exec] listener failed", error);
      }
    }
  }

  private wasCancelled(record: ExecRecord): boolean {
    return record.status === "cancelled" || record.killReason === "cancelled";
  }

  private kill(record: ExecRecord): void {
    const child = record.child;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process already exited.
      }
    }
  }

  private async resolveCwd(session: AgentSession, input: string | undefined): Promise<string> {
    const target =
      input === undefined || input === ""
        ? session.workspaceRoot
        : path.isAbsolute(input)
          ? input
          : path.resolve(session.workspaceRoot, input);

    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if (isNotFound(error)) {
        throw new AppError("INVALID_CWD", `cwd does not exist: ${input ?? target}`, 400);
      }
      throw new AppError("INVALID_CWD", `cwd is not accessible: ${target}`, 400);
    }

    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new AppError("INVALID_CWD", `cwd is not a directory: ${resolved}`, 400);
    }
    if (!isUnder(resolved, session.workspaceRoot)) {
      throw new AppError(
        "INVALID_CWD",
        `cwd must stay inside the workspace (${session.workspaceRoot}): ${resolved}`,
        400,
      );
    }

    return resolved;
  }

  private async ensureTmpDir(sessionId: string): Promise<void> {
    const root = `/tmp/codefly/${sessionId}`;
    try {
      await mkdir(path.join(root, "cache"), { recursive: true });
      await mkdir(path.join(root, "pip"), { recursive: true });
      await mkdir(path.join(root, "npm"), { recursive: true });
    } catch (error) {
      console.warn(`[exec] could not create TMPDIR ${root}`, error);
    }
  }
}

function approvalFailureCode(reason: string): string {
  if (reason === "timeout") return "APPROVAL_TIMEOUT";
  if (reason === "disconnected" || reason === "policy") return "APPROVAL_UNAVAILABLE";
  return "APPROVAL_REJECTED";
}

function approvalFailureMessage(reason: string): string {
  switch (reason) {
    case "timeout":
      return "Approval timed out; the command was not executed.";
    case "disconnected":
      return "Approval was cancelled because the client disconnected; the command was not executed.";
    case "policy":
      return "The approval policy is never; the requested escalation was rejected without asking.";
    case "cancelled":
      return "Approval was cancelled; the command was not executed.";
    default:
      return "Approval was rejected; the command was not executed.";
  }
}

function sandboxEnv(sessionId: string): NodeJS.ProcessEnv {
  const tmp = `/tmp/codefly/${sessionId}`;
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    TMPDIR: tmp,
    XDG_CACHE_HOME: `${tmp}/cache`,
    PIP_CACHE_DIR: `${tmp}/pip`,
    PIP_REQUIRE_VIRTUALENV: "1",
    npm_config_cache: `${tmp}/npm`,
  };
}
