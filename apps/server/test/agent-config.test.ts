import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_MAX_STEPS_LIMIT,
  AGENT_TOOL_NAMES,
  DEFAULT_AGENT_MAX_STEPS,
  type AgentToolName,
} from "@codefly/protocol";
import {
  AgentConfigStore,
  DEFAULT_AGENT_PROMPT,
} from "../src/agent/config-store.js";

describe("AgentConfigStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-agent-config-"));
    file = path.join(dir, "agent.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts with safe defaults", async () => {
    const store = new AgentConfigStore(file);
    await store.init();
    const settings = store.getPublic();
    expect(settings.maxSteps).toBe(DEFAULT_AGENT_MAX_STEPS);
    expect(settings.maxSteps).toBe(500);
    expect(settings.commandTimeoutMs).toBe(60_000);
    expect(settings.enabledTools).toEqual([...AGENT_TOOL_NAMES]);
    expect(settings.personaPrefix).toBe("");
    expect(settings.personaSuffix).toBe("");
  });

  it("updates, clamps, filters, and persists settings", async () => {
    const store = new AgentConfigStore(file);
    await store.init();
    const updated = await store.update({
      maxSteps: AGENT_MAX_STEPS_LIMIT + 100,
      commandTimeoutMs: 1000,
      enabledTools: ["read_file", "write_file", "read_file"] as AgentToolName[],
      personaPrefix: "custom prefix",
      personaSuffix: "custom suffix",
    });

    expect(updated.maxSteps).toBe(AGENT_MAX_STEPS_LIMIT);
    expect(updated.commandTimeoutMs).toBe(1000);
    expect(updated.enabledTools).toEqual(["read_file", "write_file"]);
    expect(updated.personaPrefix).toBe("custom prefix");
    expect(updated.personaSuffix).toBe("custom suffix");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = new AgentConfigStore(file);
    await reloaded.init();
    expect(reloaded.getPublic()).toMatchObject({
      maxSteps: AGENT_MAX_STEPS_LIMIT,
      commandTimeoutMs: 1000,
      enabledTools: ["read_file", "write_file"],
      personaPrefix: "custom prefix",
      personaSuffix: "custom suffix",
    });
  });

  it("allows disabling all tools", async () => {
    const store = new AgentConfigStore(file);
    await store.init();
    const updated = await store.update({ enabledTools: [] });
    expect(updated.enabledTools).toEqual([]);
  });

  it("migrates a legacy customized systemPrompt to the persona prefix", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({ systemPrompt: "my tuned prompt" }),
      "utf8",
    );
    const store = new AgentConfigStore(file);
    await store.init();
    expect(store.getPublic().personaPrefix).toBe("my tuned prompt");
    expect(store.getPublic().personaSuffix).toBe("");
  });

  it("drops a legacy systemPrompt that is an untouched default copy", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({ systemPrompt: DEFAULT_AGENT_PROMPT }),
      "utf8",
    );
    const store = new AgentConfigStore(file);
    await store.init();
    expect(store.getPublic().personaPrefix).toBe("");
  });
});
