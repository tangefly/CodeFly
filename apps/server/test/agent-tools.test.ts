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

  it("reads line ranges with line numbers", async () => {
    await writeFile(
      path.join(workspace, "lines.txt"),
      "one\ntwo\nthree\nfour\nfive\n",
      "utf8",
    );

    const slice = await executor.execute(
      "read_file",
      JSON.stringify({ path: "lines.txt", offset: 2, limit: 2 }),
      context(),
    );
    expect(slice.status).toBe("complete");
    expect(slice.content).toContain("2\ttwo");
    expect(slice.content).toContain("3\tthree");
    expect(slice.content).not.toContain("1\tone");
    expect(slice.content).not.toContain("4\tfour");
    expect(slice.meta).toMatchObject({
      startLine: 2,
      endLine: 3,
      totalLines: 5,
      truncated: false,
    });

    const beyond = await executor.execute(
      "read_file",
      JSON.stringify({ path: "lines.txt", offset: 99 }),
      context(),
    );
    expect(beyond.status).toBe("error");
    expect(beyond.content).toContain("beyond the end");
  });

  it("applies multiple edits atomically", async () => {
    await writeFile(
      path.join(workspace, "multi.txt"),
      "alpha beta gamma beta\n",
      "utf8",
    );

    const edited = await executor.execute(
      "edit_file",
      JSON.stringify({
        path: "multi.txt",
        edits: [
          { old_string: "alpha", new_string: "A" },
          { old_string: "beta", new_string: "B", replace_all: true },
        ],
      }),
      context(),
    );
    expect(edited.status).toBe("complete");
    expect(edited.meta).toMatchObject({ edits: 2, replacements: 3 });
    expect(await readFile(path.join(workspace, "multi.txt"), "utf8")).toBe(
      "A B gamma B\n",
    );

    const failed = await executor.execute(
      "edit_file",
      JSON.stringify({
        path: "multi.txt",
        edits: [
          { old_string: "A", new_string: "Z" },
          { old_string: "does-not-exist", new_string: "x" },
        ],
      }),
      context(),
    );
    expect(failed.status).toBe("error");
    expect(failed.content).toContain("edit 2/2");
    expect(failed.content).toContain("No changes were written");
    expect(await readFile(path.join(workspace, "multi.txt"), "utf8")).toBe(
      "A B gamma B\n",
    );
  });

  it("greps contents, honors glob filters, and skips ignored dirs", async () => {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules/pkg"), { recursive: true });
    await writeFile(
      path.join(workspace, "src/a.ts"),
      "const needle = 1;\n",
      "utf8",
    );
    await writeFile(path.join(workspace, "src/b.js"), "// needle\n", "utf8");
    await writeFile(
      path.join(workspace, "node_modules/pkg/c.ts"),
      "needle\n",
      "utf8",
    );

    const found = await executor.execute(
      "grep",
      JSON.stringify({ pattern: "needle" }),
      context(),
    );
    expect(found.status).toBe("complete");
    expect(found.content).toContain("src/a.ts:1:");
    expect(found.content).toContain("src/b.js:1:");
    expect(found.content).not.toContain("node_modules");
    expect(found.meta).toMatchObject({ kind: "grep", matches: 2 });

    const filtered = await executor.execute(
      "grep",
      JSON.stringify({ pattern: "needle", glob: "**/*.ts" }),
      context(),
    );
    expect(filtered.status).toBe("complete");
    expect(filtered.content).toContain("src/a.ts:1:");
    expect(filtered.content).not.toContain("src/b.js");
    expect(filtered.meta).toMatchObject({ matches: 1 });

    const literal = await executor.execute(
      "grep",
      JSON.stringify({ pattern: "needle = 1", fixed_strings: true }),
      context(),
    );
    expect(literal.status).toBe("complete");
    expect(literal.content).toContain("src/a.ts:1:");
  });

  it("finds files with glob patterns", async () => {
    await mkdir(path.join(workspace, "src/nested"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(workspace, "src/a.ts"), "a\n", "utf8");
    await writeFile(path.join(workspace, "src/b.js"), "b\n", "utf8");
    await writeFile(path.join(workspace, "src/nested/c.ts"), "c\n", "utf8");
    await writeFile(path.join(workspace, "node_modules/pkg/d.ts"), "d\n", "utf8");

    const found = await executor.execute(
      "glob",
      JSON.stringify({ pattern: "**/*.{ts,js}" }),
      context(),
    );
    expect(found.status).toBe("complete");
    expect(found.content).toContain("src/a.ts");
    expect(found.content).toContain("src/b.js");
    expect(found.content).toContain("src/nested/c.ts");
    expect(found.content).not.toContain("node_modules");
    expect(found.meta).toMatchObject({ kind: "glob", matches: 3 });

    const shallow = await executor.execute(
      "glob",
      JSON.stringify({ pattern: "*.ts" }),
      context(),
    );
    expect(shallow.content).toContain("src/a.ts");
    expect(shallow.content).toContain("src/nested/c.ts");
    expect(shallow.content).not.toContain("src/b.js");
  });
});
