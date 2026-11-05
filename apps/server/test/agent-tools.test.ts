import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AuditEvent } from "@codefly/protocol";
import type { AuditLog } from "../src/audit/log.js";
import type { ExecService } from "../src/exec/service.js";
import {
  AgentToolExecutor,
  type ToolExecutionContext,
} from "../src/agent/tools.js";

describe("AgentToolExecutor tools", () => {
  let base: string;
  let workspace: string;
  let dataDir: string;
  let session: AgentSession;
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
      kind: "agent",
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
    vi.unstubAllGlobals();
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

  describe("web_search", () => {
    function searchExecutor(): AgentToolExecutor {
      return new AgentToolExecutor({
        searchEndpoint: () => ({
          url: "https://api.deepseek.com/v1/tools/search",
          apiKey: "secret-key",
          timeoutMs: 60_000,
        }),
      });
    }

    it("is only exposed when a search API is configured", () => {
      expect(executor.definitions(["web_search"])).toEqual([]);
      expect(
        searchExecutor()
          .definitions(["web_search"])
          .map((definition) => definition.function.name),
      ).toEqual(["web_search"]);
    });

    it("posts the query and formats ranked results", async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchMock = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(input), init: init ?? {} });
          return new Response(
            JSON.stringify({
              results: [
                {
                  rerank_score: 2.4,
                  title: "DeepSeek V4 released",
                  url: "https://example.com/v4",
                  snippet: "short snippet",
                  summary: "Long summary for the model.",
                  content: "Full page body text.",
                  site_name: "Example News",
                  site_icon: null,
                  date: "2026-06-01T00:00:00+00:00",
                  authority: 3,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await searchExecutor().execute(
        "web_search",
        JSON.stringify({
          query: "DeepSeek V4",
          count: 3,
          need_content: true,
          ori_question: "When was DeepSeek V4 released?",
        }),
        context(),
      );

      expect(result.status).toBe("complete");
      expect(result.content).toContain("DeepSeek V4 released");
      expect(result.content).toContain("https://example.com/v4");
      expect(result.content).toContain("score 2.40");
      expect(result.content).toContain("Long summary for the model.");
      expect(result.content).toContain("Full page body text.");
      expect(result.meta).toMatchObject({
        kind: "search",
        query: "DeepSeek V4",
        resultCount: 1,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/search");
      expect(calls[0]!.init.method).toBe("POST");
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret-key");
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        query: "DeepSeek V4",
        count: 3,
        need_content: true,
        ori_question: "When was DeepSeek V4 released?",
      });
    });

    it("reports unavailable providers and upstream errors", async () => {
      const unavailable = await executor.execute(
        "web_search",
        JSON.stringify({ query: "anything" }),
        context(),
      );
      expect(unavailable.status).toBe("error");
      expect(unavailable.content).toContain("unavailable");

      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: {
                  message: "'count' must be between 1 and 50",
                  type: "invalid_request_error",
                },
              }),
              { status: 400 },
            ),
        ),
      );

      const failed = await searchExecutor().execute(
        "web_search",
        JSON.stringify({ query: "anything" }),
        context(),
      );
      expect(failed.status).toBe("error");
      expect(failed.content).toContain("HTTP 400");
      expect(failed.content).toContain("must be between 1 and 50");
    });

    it("rejects invalid arguments", async () => {
      const invalid = await searchExecutor().execute(
        "web_search",
        JSON.stringify({ query: "", count: 51 }),
        context(),
      );
      expect(invalid.status).toBe("error");
      expect(invalid.content).toContain("Invalid tool arguments");
    });
  });

  describe("web_fetch", () => {
    const fetchExecutor = (): AgentToolExecutor =>
      new AgentToolExecutor({
        // Every public URL resolves to a documentation IP in tests.
        resolveHost: async () => ["93.184.216.34"],
      });

    it("fetches HTML, strips markup and reports the response", async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(input), init: init ?? {} });
          return new Response(
            "<!doctype html><html><head><title>Hello &amp; world</title>" +
              "<style>.x{color:red}</style></head><body>" +
              "<p>First paragraph</p><p>Second <b>bold</b> move</p>" +
              "<script>alert(1)</script></body></html>",
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }),
      );

      const result = await fetchExecutor().execute(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/doc" }),
        context(),
      );

      expect(result.status).toBe("complete");
      expect(result.content).toContain("Hello & world");
      expect(result.content).toContain("First paragraph");
      expect(result.content).toContain("Second bold move");
      expect(result.content).not.toContain("alert(1)");
      expect(result.content).not.toContain("<p>");
      expect(result.meta).toMatchObject({
        kind: "fetch",
        url: "https://example.com/doc",
        statusCode: 200,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.redirect).toBe("manual");
    });

    it("follows redirects and reports the final URL", async () => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          call += 1;
          if (call === 1) {
            return new Response(null, {
              status: 302,
              headers: { location: "https://example.com/final" },
            });
          }
          return new Response("plain text body", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }),
      );

      const result = await fetchExecutor().execute(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/start" }),
        context(),
      );

      expect(result.status).toBe("complete");
      expect(result.content).toContain("plain text body");
      expect(result.meta?.url).toBe("https://example.com/final");
      expect(call).toBe(2);
    });

    it("refuses loopback, private DNS results and non-http schemes", async () => {
      const executor = new AgentToolExecutor();

      const loopback = await executor.execute(
        "web_fetch",
        JSON.stringify({ url: "http://127.0.0.1:8080/admin" }),
        context(),
      );
      expect(loopback.status).toBe("error");
      expect(loopback.content).toContain("private address");

      const rebinding = new AgentToolExecutor({
        resolveHost: async () => ["10.0.0.5"],
      });
      const internal = await rebinding.execute(
        "web_fetch",
        JSON.stringify({ url: "https://intranet.example.com/" }),
        context(),
      );
      expect(internal.status).toBe("error");
      expect(internal.content).toContain("10.0.0.5");

      const scheme = await executor.execute(
        "web_fetch",
        JSON.stringify({ url: "file:///etc/passwd" }),
        context(),
      );
      expect(scheme.status).toBe("error");
      expect(scheme.content).toContain("only http(s)");
    });

    it("reports HTTP errors and refuses binary content", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("gone", { status: 404 })),
      );
      const missing = await fetchExecutor().execute(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/missing" }),
        context(),
      );
      expect(missing.status).toBe("error");
      expect(missing.content).toContain("HTTP 404");

      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(Buffer.from([0, 1, 2, 3]), {
              status: 200,
              headers: { "content-type": "application/pdf" },
            }),
        ),
      );
      const binary = await fetchExecutor().execute(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/file.pdf" }),
        context(),
      );
      expect(binary.status).toBe("error");
      expect(binary.content).toContain("Unsupported content type");
    });

    it("refuses binary bodies even without a content-type header", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(Buffer.from([0, 1, 2, 3, 4]), { status: 200 }),
        ),
      );
      const result = await fetchExecutor().execute(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/blob" }),
        context(),
      );
      expect(result.status).toBe("error");
      expect(result.content).toContain("looks binary");
    });

    it("truncates long pages at max_chars", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("x".repeat(5000), {
              status: 200,
              headers: { "content-type": "text/plain" },
            }),
        ),
      );
      const result = await fetchExecutor().execute(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/long", max_chars: 1000 }),
        context(),
      );
      expect(result.status).toBe("complete");
      expect(result.meta?.truncated).toBe(true);
      expect(result.content).toContain("truncated at 1000 characters");
      expect(result.content.length).toBeLessThan(5000);
    });
  });

  describe("read_image", () => {
    const PNG_1X1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );

    it("reads a PNG, reports dimensions and attaches a data URL", async () => {
      await writeFile(path.join(workspace, "shot.png"), PNG_1X1);
      const result = await executor.execute(
        "read_image",
        JSON.stringify({ path: "shot.png" }),
        context(),
      );

      expect(result.status).toBe("complete");
      expect(result.content).toContain("image/png");
      expect(result.content).toContain("1x1");
      expect(result.meta).toMatchObject({
        kind: "image",
        path: path.join(workspace, "shot.png"),
        mime: "image/png",
        width: 1,
        height: 1,
        bytes: PNG_1X1.length,
      });
      expect(String(result.meta?.imageDataUrl)).toMatch(
        /^data:image\/png;base64,/,
      );
    });

    it("rejects non-images, directories and missing files", async () => {
      await writeFile(path.join(workspace, "note.txt"), "hello");
      const text = await executor.execute(
        "read_image",
        JSON.stringify({ path: "note.txt" }),
        context(),
      );
      expect(text.status).toBe("error");
      expect(text.content).toContain("Not a supported image");

      await mkdir(path.join(workspace, "folder"), { recursive: true });
      const dir = await executor.execute(
        "read_image",
        JSON.stringify({ path: "folder" }),
        context(),
      );
      expect(dir.status).toBe("error");
      expect(dir.content).toContain("directory");

      const missing = await executor.execute(
        "read_image",
        JSON.stringify({ path: "nope.png" }),
        context(),
      );
      expect(missing.status).toBe("error");
      expect(missing.content).toContain("does not exist");
    });

    it("refuses images above the read limit", async () => {
      await writeFile(path.join(workspace, "big.png"), PNG_1X1);
      const result = await executor.execute(
        "read_image",
        JSON.stringify({ path: "big.png" }),
        context({ maxReadBytes: 10 }),
      );
      expect(result.status).toBe("error");
      expect(result.content).toContain("limit");
    });

    it("exposes both schemas in the tool catalog", () => {
      const names = executor
        .definitions(["web_fetch", "read_image"])
        .map((definition) => definition.function.name);
      expect(names).toEqual(["web_fetch", "read_image"]);
    });
  });
});
