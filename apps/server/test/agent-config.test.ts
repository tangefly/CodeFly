import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_MAX_STEPS_LIMIT,
  AGENT_TOOL_NAMES,
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
    expect(settings.maxSteps).toBe(10);
    expect(settings.commandTimeoutMs).toBe(60_000);
    expect(settings.enabledTools).toEqual([...AGENT_TOOL_NAMES]);
    expect(settings.systemPrompt).toBe(DEFAULT_AGENT_PROMPT);
  });

  it("updates, clamps, filters, and persists settings", async () => {
    const store = new AgentConfigStore(file);
    await store.init();
    const updated = await store.update({
      maxSteps: AGENT_MAX_STEPS_LIMIT + 100,
      commandTimeoutMs: 1000,
      enabledTools: ["read_file", "write_file", "read_file"] as AgentToolName[],
      systemPrompt: "custom agent prompt",
    });

    expect(updated.maxSteps).toBe(AGENT_MAX_STEPS_LIMIT);
    expect(updated.commandTimeoutMs).toBe(1000);
    expect(updated.enabledTools).toEqual(["read_file", "write_file"]);
    expect(updated.systemPrompt).toBe("custom agent prompt");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = new AgentConfigStore(file);
    await reloaded.init();
    expect(reloaded.getPublic()).toMatchObject({
      maxSteps: AGENT_MAX_STEPS_LIMIT,
      commandTimeoutMs: 1000,
      enabledTools: ["read_file", "write_file"],
      systemPrompt: "custom agent prompt",
    });
  });

  it("allows disabling all tools", async () => {
    const store = new AgentConfigStore(file);
    await store.init();
    const updated = await store.update({ enabledTools: [] });
    expect(updated.enabledTools).toEqual([]);
  });
});
