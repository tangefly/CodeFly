import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentSession, ExecEvent } from "@codefly/protocol";
import { ApprovalService } from "../src/approval/service.js";
import { AuditLog } from "../src/audit/log.js";
import { ExecService } from "../src/exec/service.js";
import { SandboxManager } from "../src/sandbox/runner.js";
import { SessionStore } from "../src/session/store.js";

const sandbox = new SandboxManager();
const sandboxStatus = sandbox.status();

const base = await mkdtemp(path.join(os.tmpdir(), "codefly-exec-"));
const workspace = path.join(base, "workspace");
const dataDir = path.join(base, "data");
const spillDir = path.join(dataDir, "spills");
await mkdir(workspace, { recursive: true });
await mkdir(spillDir, { recursive: true });

const audit = new AuditLog(path.join(dataDir, "audit.jsonl"));
await audit.init();
const sessions = new SessionStore(path.join(dataDir, "sessions.json"));
await sessions.init();
const approvals = new ApprovalService(audit);
const exec = new ExecService({
  sessions,
  approvals,
  audit,
  sandbox,
  options: {
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
    flushIntervalMs: 10,
    approvalTimeoutMs: 1200,
    denialTtlMs: 60_000,
    spillDir,
  },
});

// Same service, but with an explicit extra device grant, to prove that the
// allowlist reaches the real Landlock runner.
const execWithDevices = new ExecService({
  sessions,
  approvals,
  audit,
  sandbox,
  options: {
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
    flushIntervalMs: 10,
    approvalTimeoutMs: 1200,
    denialTtlMs: 60_000,
    spillDir,
    extraReadWritePaths: ["/dev/zero"],
  },
});

const createdSessionIds = new Set<string>();
const outsideFiles = new Set<string>();

function outsideFile(label: string): string {
  const file = path.join(
    os.homedir(),
    `.codefly-exec-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  outsideFiles.add(file);
  return file;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function newSession(mode: AgentSession["mode"]): Promise<AgentSession> {
  const created = await sessions.create(workspace, `test-${mode}`, "workspace-write");
  createdSessionIds.add(created.id);
  if (mode !== "workspace-write") {
    await sessions.updatePermissions(
      created.id,
      mode,
      mode === "danger-full-access" ? "never" : "ask",
    );
  }
  return sessions.getAgentOrThrow(created.id);
}

interface Collector {
  events: ExecEvent[];
  waitFor(
    predicate: (event: ExecEvent) => boolean,
    timeoutMs?: number,
  ): Promise<ExecEvent>;
  unsubscribe(): void;
}

function collect(record: ReturnType<ExecService["getRecord"]>): Collector {
  if (!record) throw new Error("missing exec record");
  const events: ExecEvent[] = exec.snapshotEvents(record).map((buffered) => buffered.event);
  const listeners = new Set<() => void>();

  const unsubscribe = exec.subscribe(record, (event) => {
    events.push(event);
    for (const listener of [...listeners]) listener();
  });

  return {
    events,
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise<ExecEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error("timed out waiting for exec event"));
        }, timeoutMs);

        const check = (): void => {
          const found = events.find(predicate);
          if (!found) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(found);
        };

        listeners.add(check);
      });
    },
    unsubscribe,
  };
}

async function run(
  session: AgentSession,
  input: Parameters<ExecService["create"]>[1],
): Promise<Collector> {
  const record = await exec.create(session, input);
  const collector = collect(record);
  await collector.waitFor((event) => event.type === "exec.exit");
  return collector;
}

async function waitForDenial(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sessions.getOrThrow(sessionId).lastDenial) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("denial was not recorded");
}

describe.skipIf(!sandboxStatus.available)("ExecService (real Landlock)", () => {
  it("runs a command and streams stdout", async () => {
    const session = await newSession("workspace-write");
    const collector = await run(session, { command: "echo hello && pwd" });

    const stdout = collector.events
      .filter((event) => event.type === "stdout")
      .map((event) => (event as { data: string }).data)
      .join("");
    expect(stdout).toContain("hello");
    expect(stdout).toContain(workspace);

    const started = collector.events.find((event) => event.type === "exec.started");
    expect(started).toMatchObject({ runner: "landlock", enforcement: "full" });
    expect(collector.events.at(-1)).toMatchObject({ type: "exec.exit", code: 0 });
    collector.unsubscribe();
  }, 20_000);

  it("allows workspace writes and denies outside writes", async () => {
    const session = await newSession("workspace-write");
    const marker = path.join(workspace, `marker-${Date.now()}.txt`);
    const ok = await run(session, { command: `touch ${shellQuote(marker)} && echo done` });
    expect(ok.events.at(-1)).toMatchObject({ type: "exec.exit", code: 0 });
    expect(existsSync(marker)).toBe(true);

    const forbidden = outsideFile("denied");
    const denied = await run(session, { command: `touch ${shellQuote(forbidden)}` });
    expect(denied.events.some((event) => event.type === "exec.denied")).toBe(true);
    expect(denied.events.at(-1)).toMatchObject({ type: "exec.exit", code: 1 });
    expect(existsSync(forbidden)).toBe(false);
    collectorDenial(denied);
  }, 20_000);

  it("read-only denies writes but allows /dev/null", async () => {
    const session = await newSession("read-only");
    const blocked = await run(session, {
      command: `touch ${shellQuote(path.join(workspace, "ro.txt"))}`,
    });
    expect(blocked.events.some((event) => event.type === "exec.denied")).toBe(true);
    expect(existsSync(path.join(workspace, "ro.txt"))).toBe(false);
    collectorDenial(blocked);

    const allowed = await run(session, { command: "echo ok >/dev/null && echo allowed" });
    expect(allowed.events.at(-1)).toMatchObject({ type: "exec.exit", code: 0 });
  }, 20_000);

  it("grants explicit read-write access to configured device paths", async () => {
    const session = await newSession("workspace-write");
    const command = "exec 3<>/dev/zero";

    // Without the grant, O_RDWR on the device node is denied.
    const denied = await run(session, { command });
    expect(denied.events.some((event) => event.type === "exec.denied")).toBe(true);
    expect(denied.events.at(-1)).toMatchObject({ type: "exec.exit", code: 1 });
    collectorDenial(denied);
    denied.unsubscribe();

    // With /dev/zero in extraReadWritePaths, the same command succeeds.
    const record = await execWithDevices.create(session, { command });
    const collector = collect(record);
    await collector.waitFor((event) => event.type === "exec.exit");
    expect(collector.events.some((event) => event.type === "exec.denied")).toBe(false);
    expect(collector.events.at(-1)).toMatchObject({ type: "exec.exit", code: 0 });
    collector.unsubscribe();
  }, 20_000);

  it("escalates once after a denial with approval", async () => {
    const session = await newSession("workspace-write");
    const target = outsideFile("escalated");
    const command = `touch ${shellQuote(target)}`;

    await run(session, { command });
    await waitForDenial(session.id);

    const fresh = sessions.getAgentOrThrow(session.id);
    const record = await exec.create(fresh, {
      command,
      sandboxPermissions: "danger-full-access",
      justification: "integration test",
    });
    const collector = collect(record);

    const approval = await collector.waitFor(
      (event) => event.type === "approval.required",
    );
    expect(approval).toMatchObject({
      currentMode: "workspace-write",
      requestedMode: "danger-full-access",
    });
    expect(exec.decideApproval(record.id, "allow_once")).toBe(true);

    await collector.waitFor((event) => event.type === "exec.exit");
    expect(existsSync(target)).toBe(true);
    expect(collector.events.some((event) => event.type === "exec.denied")).toBe(false);

    // A second escalation requires a fresh denial.
    await expect(
      exec.create(sessions.getAgentOrThrow(session.id), {
        command,
        sandboxPermissions: "danger-full-access",
        justification: "again",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ESCALATION" });
    collector.unsubscribe();
  }, 25_000);

  it("rejects escalation on deny without executing", async () => {
    const session = await newSession("workspace-write");
    const target = outsideFile("rejected");
    const command = `touch ${shellQuote(target)}`;

    await run(session, { command });
    await waitForDenial(session.id);

    const record = await exec.create(sessions.getAgentOrThrow(session.id), {
      command,
      sandboxPermissions: "danger-full-access",
      justification: "should be rejected",
    });
    const collector = collect(record);
    await collector.waitFor((event) => event.type === "approval.required");
    expect(exec.decideApproval(record.id, "deny")).toBe(true);

    await collector.waitFor((event) => event.type === "exec.exit");
    expect(
      collector.events.some(
        (event) => event.type === "exec.error" && event.code === "APPROVAL_REJECTED",
      ),
    ).toBe(true);
    expect(existsSync(target)).toBe(false);
    collector.unsubscribe();
  }, 25_000);

  it("times out approval and does not execute", async () => {
    const session = await newSession("workspace-write");
    const target = outsideFile("timeout");
    const command = `touch ${shellQuote(target)}`;

    await run(session, { command });
    await waitForDenial(session.id);

    const record = await exec.create(sessions.getAgentOrThrow(session.id), {
      command,
      sandboxPermissions: "danger-full-access",
      justification: "will time out",
    });
    const collector = collect(record);
    await collector.waitFor((event) => event.type === "exec.exit", 8000);

    expect(
      collector.events.some(
        (event) => event.type === "exec.error" && event.code === "APPROVAL_TIMEOUT",
      ),
    ).toBe(true);
    expect(existsSync(target)).toBe(false);
    collector.unsubscribe();
  }, 25_000);

  it("kills a command on timeout", async () => {
    const session = await newSession("workspace-write");
    const collector = await run(session, { command: "sleep 5", timeoutMs: 1000 });
    expect(
      collector.events.some(
        (event) => event.type === "exec.error" && event.code === "TIMEOUT",
      ),
    ).toBe(true);
    expect(collector.events.at(-1)).toMatchObject({
      type: "exec.exit",
      timedOut: true,
    });
    collector.unsubscribe();
  }, 20_000);

  it("cancels a running process group", async () => {
    const session = await newSession("workspace-write");
    const record = await exec.create(session, { command: "sleep 5" });
    const collector = collect(record);
    await collector.waitFor((event) => event.type === "exec.started");
    expect(exec.cancel(record.id)).toBe(true);
    const exit = await collector.waitFor((event) => event.type === "exec.exit");
    expect(exit).toMatchObject({ type: "exec.exit", cancelled: true });
    collector.unsubscribe();
  }, 20_000);

  it("truncates output, kills the process, and writes spills", async () => {
    const session = await newSession("workspace-write");
    const collector = await run(session, {
      command: "head -c 300000 /dev/zero | tr '\\0' a",
    });

    const exit = collector.events.at(-1);
    expect(exit).toMatchObject({ type: "exec.exit", truncated: true });
    expect(
      collector.events.some(
        (event) => event.type === "exec.error" && event.code === "OUTPUT_LIMIT",
      ),
    ).toBe(true);

    const spillPaths = (exit as { spillPaths: string[] }).spillPaths;
    expect(spillPaths.length).toBeGreaterThan(0);
    const info = await stat(spillPaths[0] ?? "");
    expect(info.size).toBeGreaterThan(64 * 1024);
    collector.unsubscribe();
  }, 25_000);

  it("rejects a cwd outside the workspace", async () => {
    const session = await newSession("workspace-write");
    await expect(
      exec.create(session, { command: "pwd", cwd: "/etc" }),
    ).rejects.toMatchObject({ code: "INVALID_CWD" });
    await expect(
      exec.create(session, { command: "pwd", cwd: "../.." }),
    ).rejects.toMatchObject({ code: "INVALID_CWD" });
  }, 20_000);
});

function collectorDenial(collector: Collector): void {
  const denied = collector.events.find((event) => event.type === "exec.denied");
  expect(denied).toBeDefined();
}

afterAll(async () => {
  await execWithDevices.shutdown();
  await exec.shutdown();
  for (const sessionId of createdSessionIds) {
    await rm(path.join("/tmp/codefly", sessionId), { recursive: true, force: true });
  }
  for (const file of outsideFiles) {
    await rm(file, { force: true });
  }
  await rm(base, { recursive: true, force: true });
});
