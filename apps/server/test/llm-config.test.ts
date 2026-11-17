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
      profiles?: Array<{ thinking?: boolean; reasoningEffort?: string }>;
    };
    expect(raw.profiles?.[0]?.thinking).toBe(false);
    expect(raw.profiles?.[0]?.reasoningEffort).toBe("max");
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
      profiles?: Array<{ model?: string }>;
    };
    expect(migrated.profiles?.[0]?.model).toBe("deepseek-v4-flash");

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

  it("migrates the legacy flat config into a saved profile", async () => {
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://api.example.com/v1",
        model: "legacy-model",
        apiKey: "legacy-key",
        temperature: 0.4,
        timeoutMs: 30_000,
        updatedAt: "2026-01-02T03:04:05.000Z",
      }),
      "utf8",
    );
    const store = new LlmConfigStore(file);
    await store.init();

    const settings = store.getPublic();
    expect(settings.configured).toBe(true);
    expect(settings.profiles).toHaveLength(1);
    expect(settings.activeProfileId).toBe(settings.profiles[0]!.id);
    expect(settings.profiles[0]).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "legacy-model",
      hasApiKey: true,
      active: true,
      temperature: 0.4,
      timeoutMs: 30_000,
    });

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      version?: number;
      activeId?: string;
      model?: string;
      profiles?: Array<{ id?: string; model?: string; apiKey?: string }>;
    };
    expect(raw.version).toBe(2);
    expect(raw.model).toBeUndefined();
    expect(raw.activeId).toBe(settings.activeProfileId);
    expect(raw.profiles?.[0]?.model).toBe("legacy-model");
    expect(raw.profiles?.[0]?.apiKey).toBe("legacy-key");
  });

  it("keeps previously configured models selectable", async () => {
    const store = new LlmConfigStore(file);
    await store.init();

    const first = await store.update({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
      apiKey: "sk-deepseek-key",
    });
    expect(first.profiles).toHaveLength(1);
    const firstId = first.activeProfileId;
    expect(firstId).not.toBeNull();

    // A second model on the same provider reuses the saved key.
    const second = await store.update({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
    });
    expect(second.profiles).toHaveLength(2);
    expect(second.model).toBe("deepseek-v4-flash");
    expect(second.hasApiKey).toBe(true);
    expect(second.activeProfileId).not.toBe(firstId);
    expect(second.profiles.find((profile) => profile.id === firstId)).toMatchObject({
      model: "deepseek-v4-pro",
      hasApiKey: true,
      active: false,
    });

    // Saving the first pair again switches back without losing the second.
    const back = await store.update({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
    });
    expect(back.activeProfileId).toBe(firstId);
    expect(back.profiles).toHaveLength(2);
    expect(back.profiles[0]?.id).toBe(firstId);
    expect(store.getInternal().apiKey).toBe("sk-deepseek-key");
    expect(JSON.stringify(back)).not.toContain("sk-deepseek-key");
  });

  it("keeps a separate API key per saved profile", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    const first = await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      apiKey: "key-alpha",
    });
    await store.update({
      baseUrl: "https://api.other.com/v1",
      model: "beta",
      apiKey: "key-beta",
    });
    expect(store.getInternal().apiKey).toBe("key-beta");

    const back = await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
    });
    expect(back.activeProfileId).toBe(first.activeProfileId);
    expect(store.getInternal().apiKey).toBe("key-alpha");
    expect(
      back.profiles.find((profile) => profile.model === "beta"),
    ).toMatchObject({ hasApiKey: true });
  });

  it("does not carry an API key to a different provider", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      apiKey: "key-alpha",
    });
    const other = await store.update({
      baseUrl: "https://api.other.com/v1",
      model: "beta",
    });
    expect(other.hasApiKey).toBe(false);
    expect(store.getInternal().apiKey).toBe("");
  });

  it("inherits the selected profile's key for a new model on its provider", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    const alpha = await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      apiKey: "key-alpha",
    });
    const alphaId = alpha.activeProfileId!;
    // Make another provider active, leaving alpha as a non-active profile.
    await store.update({
      baseUrl: "https://api.other.com/v1",
      model: "beta",
      apiKey: "key-beta",
    });

    const gamma = await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "gamma",
      profileId: alphaId,
    });
    expect(gamma.hasApiKey).toBe(true);
    expect(store.getInternal().apiKey).toBe("key-alpha");
    expect(gamma.profiles).toHaveLength(3);
    expect(store.getPublic().profiles.find((profile) => profile.model === "alpha")).toMatchObject({
      hasApiKey: true,
      active: false,
    });
  });

  it("clears the key of only the matched profile", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      apiKey: "key-alpha",
    });
    await store.update({
      baseUrl: "https://api.other.com/v1",
      model: "beta",
      apiKey: "key-beta",
    });
    await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      clearApiKey: true,
    });
    const settings = store.getPublic();
    expect(store.getInternal().apiKey).toBe("");
    expect(
      settings.profiles.find((profile) => profile.model === "alpha"),
    ).toMatchObject({ hasApiKey: false, apiKeyHint: null });
    expect(
      settings.profiles.find((profile) => profile.model === "beta"),
    ).toMatchObject({ hasApiKey: true });
  });

  it("reloads saved profiles and their order from disk", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      apiKey: "key-alpha",
    });
    const second = await store.update({
      baseUrl: "https://api.other.com/v1",
      model: "beta",
      apiKey: "key-beta",
    });

    const reloaded = new LlmConfigStore(file);
    await reloaded.init();
    const settings = reloaded.getPublic();
    expect(settings.profiles).toHaveLength(2);
    expect(settings.activeProfileId).toBe(second.activeProfileId);
    expect(settings.profiles.map((profile) => profile.model)).toEqual([
      "beta",
      "alpha",
    ]);
    expect(settings.profiles[0]?.active).toBe(true);

    // Switching back still finds the first profile's key after reload.
    await reloaded.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
    });
    expect(reloaded.getInternal().apiKey).toBe("key-alpha");
  });

  it("activates a saved profile without changing the others", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    const alpha = await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      apiKey: "key-alpha",
    });
    const alphaId = alpha.activeProfileId!;
    await store.update({
      baseUrl: "https://api.other.com/v1",
      model: "beta",
      apiKey: "key-beta",
    });

    const activated = await store.activateProfile(alphaId);
    expect(activated.activeProfileId).toBe(alphaId);
    expect(activated.model).toBe("alpha");
    expect(activated.hasApiKey).toBe(true);
    expect(store.getInternal().apiKey).toBe("key-alpha");
    expect(activated.profiles).toHaveLength(2);
    expect(activated.profiles[0]).toMatchObject({
      id: alphaId,
      active: true,
    });

    const reloaded = new LlmConfigStore(file);
    await reloaded.init();
    expect(reloaded.getInternal()).toMatchObject({
      model: "alpha",
      apiKey: "key-alpha",
    });
  });

  it("deletes profiles and falls back when the active one is removed", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    const alpha = await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      apiKey: "key-alpha",
    });
    const alphaId = alpha.activeProfileId!;
    const beta = await store.update({
      baseUrl: "https://api.other.com/v1",
      model: "beta",
      apiKey: "key-beta",
    });
    const betaId = beta.activeProfileId!;

    // Deleting a non-active profile keeps the active one.
    let settings = await store.deleteProfile(alphaId);
    expect(settings.profiles.map((profile) => profile.model)).toEqual(["beta"]);
    expect(settings.activeProfileId).toBe(betaId);
    expect(store.getInternal().apiKey).toBe("key-beta");

    // Deleting the active (last) profile clears the configuration.
    settings = await store.deleteProfile(betaId);
    expect(settings.profiles).toHaveLength(0);
    expect(settings.activeProfileId).toBeNull();
    expect(settings.configured).toBe(false);
    expect(store.getInternal()).toMatchObject({ baseUrl: "", model: "" });

    const reloaded = new LlmConfigStore(file);
    await reloaded.init();
    expect(reloaded.getPublic().configured).toBe(false);
    expect(reloaded.getPublic().profiles).toHaveLength(0);
  });

  it("falls back to the most recently updated profile when deleting the active one", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "alpha",
      apiKey: "key-alpha",
    });
    const beta = await store.update({
      baseUrl: "https://api.other.com/v1",
      model: "beta",
      apiKey: "key-beta",
    });
    const settings = await store.deleteProfile(beta.activeProfileId!);
    expect(settings.activeProfileId).not.toBeNull();
    expect(settings.model).toBe("alpha");
    expect(settings.hasApiKey).toBe(true);
  });

  it("rejects unknown profiles", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await expect(store.activateProfile("missing")).rejects.toMatchObject({
      code: "LLM_PROFILE_NOT_FOUND",
    });
    await expect(store.deleteProfile("missing")).rejects.toMatchObject({
      code: "LLM_PROFILE_NOT_FOUND",
    });
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

  it("accepts 0 as an unlimited inactivity timeout", async () => {
    const store = new LlmConfigStore(file);
    await store.init();
    await store.update({
      baseUrl: "https://api.example.com/v1",
      model: "unlimited",
      apiKey: "key",
      timeoutMs: 0,
    });

    expect(store.getInternal().timeoutMs).toBe(0);

    const reloaded = new LlmConfigStore(file);
    await reloaded.init();
    expect(reloaded.getInternal().timeoutMs).toBe(0);
  });
});
