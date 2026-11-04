import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  SearchConfigStore,
  normalizeSearchBaseUrl,
  searchEndpointUrl,
} from "../src/search/config-store.js";
import { testSearchConnection } from "../src/search/test.js";

describe("SearchConfigStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-search-config-"));
    file = path.join(dir, "search.json");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("starts unconfigured and never exposes the key", async () => {
    const store = new SearchConfigStore(file);
    await store.init();

    const empty = store.getPublic();
    expect(empty.configured).toBe(false);
    expect(empty.baseUrl).toBe("");
    expect(empty.endpoint).toBeNull();
    expect(empty.hasApiKey).toBe(false);
    expect(empty.apiKeyHint).toBeNull();
    expect(empty.timeoutMs).toBe(DEFAULT_SEARCH_TIMEOUT_MS);
    expect(store.getEndpoint()).toBeNull();

    const saved = await store.update({
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "sk-search-12345678",
      timeoutMs: 90_000,
    });

    expect(saved.configured).toBe(true);
    expect(saved.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(saved.endpoint).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    expect(saved.hasApiKey).toBe(true);
    expect(saved.apiKeyHint).toBe("••••5678");
    expect("apiKey" in saved).toBe(false);
    expect(JSON.stringify(saved)).not.toContain("sk-search");
    expect(store.getEndpoint()).toEqual({
      url: "https://api.deepseek.com/v1/tools/search",
      apiKey: "sk-search-12345678",
      timeoutMs: 90_000,
    });

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("sk-search-12345678");
  });

  it("derives the endpoint from origins, /v1 bases, and full URLs", () => {
    expect(searchEndpointUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    expect(searchEndpointUrl("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    expect(searchEndpointUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    expect(
      searchEndpointUrl("https://api.deepseek.com/v1/tools/search/"),
    ).toBe("https://api.deepseek.com/v1/tools/search");
    expect(searchEndpointUrl("https://gateway.example.com/proxy/v1")).toBe(
      "https://gateway.example.com/proxy/v1/tools/search",
    );
  });

  it("keeps the saved key when only the base URL changes", async () => {
    const store = new SearchConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "search-key",
    });

    const updated = await store.update({
      baseUrl: "https://search.example.com/v1",
    });
    expect(updated.baseUrl).toBe("https://search.example.com/v1");
    expect(updated.hasApiKey).toBe(true);
    expect(store.getEndpoint()?.apiKey).toBe("search-key");
  });

  it("clears the key and disables search without leaving stale secrets", async () => {
    const store = new SearchConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "search-key",
    });

    const clearedKey = await store.update({
      baseUrl: "https://api.deepseek.com/v1",
      clearApiKey: true,
    });
    expect(clearedKey.hasApiKey).toBe(false);
    expect(clearedKey.configured).toBe(true);

    const disabled = await store.update({ baseUrl: "" });
    expect(disabled.configured).toBe(false);
    expect(disabled.endpoint).toBeNull();
    expect(disabled.hasApiKey).toBe(false);
    expect(store.getEndpoint()).toBeNull();
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      apiKey?: string;
    };
    expect(raw.apiKey).toBe("");
  });

  it("rejects non-http and credential-bearing URLs", async () => {
    const store = new SearchConfigStore(file);
    await store.init();

    await expect(
      store.update({ baseUrl: "file:///etc/passwd" }),
    ).rejects.toMatchObject({ code: "SEARCH_INVALID_CONFIG" });
    await expect(
      store.update({ baseUrl: "https://user:pass@example.com/v1" }),
    ).rejects.toMatchObject({ code: "SEARCH_INVALID_CONFIG" });
    await expect(
      store.update({ baseUrl: "https://example.com/v1?key=secret" }),
    ).rejects.toMatchObject({ code: "SEARCH_INVALID_CONFIG" });
    await expect(store.update({ baseUrl: "not a url" })).rejects.toMatchObject({
      code: "SEARCH_INVALID_CONFIG",
    });

    expect(normalizeSearchBaseUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  it("ignores a corrupt search.json and keeps defaults", async () => {
    await writeFile(file, "{not json", "utf8");
    const store = new SearchConfigStore(file);
    await store.init();
    expect(store.isConfigured()).toBe(false);
    expect(store.getPublic().endpoint).toBeNull();
  });
});

describe("testSearchConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a tiny query and reports the result count", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(
          JSON.stringify({
            results: [
              { title: "CodeFly", url: "https://example.com", summary: "ok" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const result = await testSearchConnection({
      url: "https://api.deepseek.com/v1/tools/search",
      apiKey: "search-key",
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.resultCount).toBe(1);
    expect(result.message).toContain("1 条结果");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer search-key");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      query: "CodeFly",
      count: 1,
    });
  });

  it("omits Authorization when no key is configured", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }),
    );

    const result = await testSearchConnection({
      url: "http://127.0.0.1:9999/v1/tools/search",
      apiKey: "",
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(headers.Authorization).toBeUndefined();
  });

  it("redacts the key from upstream errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "invalid key search-key" },
            }),
            { status: 401 },
          ),
      ),
    );

    const result = await testSearchConnection({
      url: "https://api.deepseek.com/v1/tools/search",
      apiKey: "search-key",
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 401");
    expect(result.message).toContain("[redacted]");
    expect(result.message).not.toContain("search-key");
  });

  it("rejects an unexpected response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );

    const result = await testSearchConnection({
      url: "https://api.deepseek.com/v1/tools/search",
      apiKey: "search-key",
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("results");
  });
});
