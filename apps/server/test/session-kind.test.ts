import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/session/store.js";

describe("SessionStore session kinds", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-session-kind-"));
    file = path.join(dir, "sessions.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a chat session without a workspace", async () => {
    const store = new SessionStore(file);
    await store.init();

    const session = await store.create(
      undefined,
      undefined,
      "workspace-write",
      "chat",
    );

    expect(session.kind).toBe("chat");
    expect(session.workspaceRoot).toBeNull();
    expect(session.title).toBe("新对话");
    expect(session.titleSource).toBe("default");
    expect(store.getChatOrThrow(session.id).id).toBe(session.id);
    expect(() => store.getAgentOrThrow(session.id)).toThrowError(
      /对话会话/,
    );

    const reloaded = new SessionStore(file);
    await reloaded.init();
    const persisted = reloaded.getOrThrow(session.id);
    expect(persisted.kind).toBe("chat");
    expect(persisted.workspaceRoot).toBeNull();
  });

  it("requires a workspace for agent sessions", async () => {
    const store = new SessionStore(file);
    await store.init();

    await expect(
      store.create(undefined, "no workspace", "workspace-write"),
    ).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
  });

  it("treats legacy workspace sessions as agent sessions", async () => {
    const now = new Date().toISOString();
    await writeFile(
      file,
      JSON.stringify({
        sessions: [
          {
            id: "s_legacy",
            title: "proj",
            workspaceRoot: "/tmp",
            mode: "workspace-write",
            approvalPolicy: "ask",
            createdAt: now,
            updatedAt: now,
            lastDenial: null,
          },
        ],
      }),
      "utf8",
    );

    const store = new SessionStore(file);
    await store.init();

    const session = store.getAgentOrThrow("s_legacy");
    expect(session.kind).toBe("agent");
    expect(session.workspaceRoot).toBe("/tmp");
    expect(session.titleSource).toBe("user");
  });
});
