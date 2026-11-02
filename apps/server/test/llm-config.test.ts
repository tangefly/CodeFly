import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SYSTEM_PROMPT,
  LlmConfigStore,
} from "../src/llm/config-store.js";

describe("LlmConfigStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-llm-config-"));
    file = path.join(dir, "llm.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts unconfigured and never exposes the key publicly", async () => {
    const store = new LlmConfigStore(file);
    await store.init();

    const empty = store.getPublic();
    expect(empty.configured).toBe(false);
    expect(empty.hasApiKey).toBe(false);
    expect(empty.apiKeyHint).toBeNull();
    expect(empty.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(empty.thinking).toBe(true);
    expect(empty.reasoningEffort).toBe("high");

    const saved = await store.update({
      baseUrl: "https://api.example.com/v1/",
      model: "test-model",
      apiKey: "sk-secret-12345678",
      temperature: 0.2,
      maxTokens: 1024,
    });

    expect(saved.configured).toBe(true);
    expect(saved.baseUrl).toBe("https://api.example.com/v1");
    expect(saved.hasApiKey).toBe(true);
    expect(saved.apiKeyHint).toBe("••••5678");
    expect("apiKey" in saved).toBe(false);
    expect(JSON.stringify(saved)).not.toContain("sk-secret");
    expect(store.getInternal().apiKey).toBe("sk-secret-12345678");

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("sk-secret-12345678");
  });

  it("keeps the key when updating other fields", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3",
      apiKey: "local-key",
    });

    const updated = await store.update({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.1",
    });
    expect(updated.model).toBe("llama3.1");
    expect(updated.hasApiKey).toBe(true);
    expect(store.getInternal().apiKey).toBe("local-key");
  });

  it("supports local providers without a key", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    const saved = await store.update({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5",
    });
    expect(saved.configured).toBe(true);
    expect(saved.hasApiKey).toBe(false);
    expect(store.isConfigured()).toBe(true);
  });

  it("clears a saved key explicitly", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      apiKey: "key",
    });
    const cleared = await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      clearApiKey: true,
    });
    expect(cleared.hasApiKey).toBe(false);
    expect(store.getInternal().apiKey).toBe("");
  });

  it("rejects non-http and credential-bearing URLs", async () => {
    const store = new LlmConfigStore(file);
    await store.init();

    await expect(
      store.update({ baseUrl: "file:///etc/passwd", model: "m" }),
    ).rejects.toMatchObject({ code: "LLM_INVALID_CONFIG" });
    await expect(
      store.update({ baseUrl: "https://user:pass@example.com/v1", model: "m" }),
    ).rejects.toMatchObject({ code: "LLM_INVALID_CONFIG" });
    await expect(
      store.update({ baseUrl: "not a url", model: "m" }),
    ).rejects.toMatchObject({ code: "LLM_INVALID_CONFIG" });
    await expect(
      store.update({
        baseUrl: "https://example.com/v1?api-key=secret",
        model: "m",
      }),
    ).rejects.toMatchObject({ code: "LLM_INVALID_CONFIG" });
  });

  it("persists the thinking toggle and effort", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    const saved = await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      thinking: false,
      reasoningEffort: "max",
    });
    expect(saved).toMatchObject({ thinking: false, reasoningEffort: "max" });

    const reloaded = new LlmConfigStore(file);
    await reloaded.init();
    expect(reloaded.getInternal()).toMatchObject({
      thinking: false,
      reasoningEffort: "max",
    });
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      thinking?: boolean;
      reasoningEffort?: string;
    };
    expect(raw.thinking).toBe(false);
    expect(raw.reasoningEffort).toBe("max");
  });

  it("migrates retired DeepSeek model aliases", async () => {
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: "k",
      }),
      "utf8",
    );
    const store = new LlmConfigStore(file);
    await store.init();
    expect(store.getInternal().model).toBe("deepseek-v4-flash");
    const migrated = JSON.parse(await readFile(file, "utf8")) as {
      model?: string;
    };
    expect(migrated.model).toBe("deepseek-v4-flash");

    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-reasoner",
        apiKey: "k",
      }),
      "utf8",
    );
    const reasoningStore = new LlmConfigStore(file);
    await reasoningStore.init();
    expect(reasoningStore.getInternal().model).toBe("deepseek-v4-pro");
  });

  it("reloads persisted settings", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "persisted",
      apiKey: "persisted-key",
      systemPrompt: "custom prompt",
      timeoutMs: 5000,
    });

    const reloaded = new LlmConfigStore(file);
    await reloaded.init();
    const config = reloaded.getInternal();
    expect(config.baseUrl).toBe("https://api.example.com/v1");
    expect(config.model).toBe("persisted");
    expect(config.apiKey).toBe("persisted-key");
    expect(config.systemPrompt).toBe("custom prompt");
    expect(config.timeoutMs).toBe(5000);
  });
});
