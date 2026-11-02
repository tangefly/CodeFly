import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Session } from "@codefly/protocol";
import type { AuditLog } from "../src/audit/log.js";
import type { ExecService } from "../src/exec/service.js";
import { AgentToolExecutor, type ToolExecutionContext } from "../src/agent/tools.js";

describe("AgentToolExecutor file tools", () => {
  let base: string;
  let workspace: string;
  let dataDir: string;
  let session: Session;
  let audits: AuditEvent[];
  let executor: AgentToolExecutor;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "codefly-agent-tools-"));
    workspace = path.join(base, "workspace");
    dataDir = path.join(base, "data");
    await mkdir(workspace, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    session = {
      id: "s_tools",
      title: "tools",
      workspaceRoot: workspace,
      mode: "workspace-write",
      approvalPolicy: "ask",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastDenial: null,
    };
    audits = [];
    executor = new AgentToolExecutor();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
    const audit = {
      append: async (event: AuditEvent) => {
        audits.push({ ...event, ts: new Date().toISOString() });
      },
      recent: async () => [],
    } as unknown as AuditLog;
    return {
      session,
      dataDir,
      maxReadBytes: 2 * 1024 * 1024,
      maxWriteBytes: 5 * 1024 * 1024,
      commandTimeoutMs: 60_000,
      exec: {} as ExecService,
      audit,
      signal: new AbortController().signal,
      emit: () => undefined,
      toolCallId: "call_test",
      ...overrides,
    };
  }

  it("writes, reads, edits, and lists files", async () => {
    const wrote = await executor.execute(
      "write_file",
      JSON.stringify({ path: "notes/hello.txt", content: "hello codefly\n" }),
      context(),
    );
    expect(wrote.status).toBe("complete");
    expect(wrote.meta?.kind).toBe("write");
    expect(await readFile(path.join(workspace, "notes/hello.txt"), "utf8")).toBe(
      "hello codefly\n",
    );
    expect(audits.some((event) => event.type === "fs.write")).toBe(true);

    const read = await executor.execute(
      "read_file",
      JSON.stringify({ path: "notes/hello.txt" }),
      context(),
    );
    expect(read).toMatchObject({ status: "complete" });
    expect(read.content).toContain("hello codefly");

    const edited = await executor.execute(
      "edit_file",
      JSON.stringify({
        path: "notes/hello.txt",
        old_string: "codefly",
        new_string: "agent",
      }),
      context(),
    );
    expect(edited.status).toBe("complete");
    expect(edited.meta?.replacements).toBe(1);
    expect(await readFile(path.join(workspace, "notes/hello.txt"), "utf8")).toBe(
      "hello agent\n",
    );

    const listed = await executor.execute(
      "list_files",
      JSON.stringify({ path: "notes" }),
      context(),
    );
    expect(listed.status).toBe("complete");
    expect(listed.content).toContain("file hello.txt");
  });

  it("denies relative path escapes and protected paths", async () => {
    const escape = await executor.execute(
      "write_file",
      JSON.stringify({ path: "../escape.txt", content: "x" }),
      context(),
    );
    expect(escape.status).toBe("error");
    expect(escape.content).toContain("File tools cannot request one-shot escalation");

    const protectedWrite = await executor.execute(
      "write_file",
      JSON.stringify({ path: ".git/config", content: "x" }),
      context(),
    );
    expect(protectedWrite.status).toBe("error");
    expect(protectedWrite.content).toContain("FS_PROTECTED");
  });

  it("reads absolute paths but refuses binary files", async () => {
    const outside = path.join(os.tmpdir(), `codefly-tool-read-${process.pid}.txt`);
    const binary = path.join(os.tmpdir(), `codefly-tool-bin-${process.pid}.bin`);
    await writeFile(outside, "outside content\n", "utf8");
    await writeFile(binary, Buffer.from([0, 1, 2, 3]));

    const read = await executor.execute(
      "read_file",
      JSON.stringify({ path: outside }),
      context(),
    );
    expect(read.status).toBe("complete");
    expect(read.content).toContain("outside content");

    const readBinary = await executor.execute(
      "read_file",
      JSON.stringify({ path: binary }),
      context(),
    );
    expect(readBinary.status).toBe("error");
    expect(readBinary.content).toContain("binary");

    await rm(outside, { force: true });
    await rm(binary, { force: true });
  });

  it("rejects invalid arguments and oversized writes", async () => {
    const invalid = await executor.execute("write_file", "{not json", context());
    expect(invalid.status).toBe("error");
    expect(invalid.content).toContain("valid JSON");

    const tooLarge = await executor.execute(
      "write_file",
      JSON.stringify({ path: "big.txt", content: "x".repeat(100) }),
      context({ maxWriteBytes: 10 }),
    );
    expect(tooLarge.status).toBe("error");
    expect(tooLarge.content).toContain("write limit");
    await expect(stat(path.join(workspace, "big.txt"))).rejects.toThrow();
  });

  it("reports missing files and non-unique edits", async () => {
    const missing = await executor.execute(
      "read_file",
      JSON.stringify({ path: "missing.txt" }),
      context(),
    );
    expect(missing.status).toBe("error");
    expect(missing.content).toContain("does not exist");

    await writeFile(path.join(workspace, "dup.txt"), "x x", "utf8");
    const duplicate = await executor.execute(
      "edit_file",
      JSON.stringify({ path: "dup.txt", old_string: "x", new_string: "y" }),
      context(),
    );
    expect(duplicate.status).toBe("error");
    expect(duplicate.content).toContain("replace_all");
  });
});
