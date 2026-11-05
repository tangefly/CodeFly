import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "@codefly/protocol";
import { canonicalizeForWrite, isUnder } from "../src/fs/canonicalize.js";
import { assertWritable } from "../src/fs/fence.js";
import { escalationTargets, isStrictlyWider } from "../src/policy/modes.js";

function makeSession(workspaceRoot: string, mode: AgentSession["mode"]): AgentSession {
  return {
    id: `s_${mode}`,
    kind: "agent",
    title: mode,
    workspaceRoot,
    mode,
    approvalPolicy: mode === "danger-full-access" ? "never" : "ask",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDenial: null,
  };
}

describe("modes", () => {
  it("orders the three modes strictly", () => {
    expect(isStrictlyWider("workspace-write", "read-only")).toBe(true);
    expect(isStrictlyWider("danger-full-access", "workspace-write")).toBe(true);
    expect(isStrictlyWider("read-only", "workspace-write")).toBe(false);
    expect(isStrictlyWider("workspace-write", "workspace-write")).toBe(false);
  });

  it("lists escalation targets widest last", () => {
    expect(escalationTargets("read-only")).toEqual([
      "workspace-write",
      "danger-full-access",
    ]);
    expect(escalationTargets("workspace-write")).toEqual(["danger-full-access"]);
    expect(escalationTargets("danger-full-access")).toEqual([]);
  });
});

describe("canonicalize + containment", () => {
  let base: string;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "codefly-policy-"));
    workspace = path.join(base, "workspace");
    outside = await mkdtemp(path.join(os.homedir(), ".codefly-outside-"));
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("distinguishes containment from prefix lookalikes", () => {
    expect(isUnder("/a/b", "/a")).toBe(true);
    expect(isUnder("/a", "/a")).toBe(true);
    expect(isUnder("/ab", "/a")).toBe(false);
    expect(isUnder("/a/../b", "/a")).toBe(false);
  });

  it("resolves the deepest existing ancestor for a new file", async () => {
    const resolved = await canonicalizeForWrite(path.join(workspace, "a/b/c.txt"));
    expect(resolved).toBe(path.join(workspace, "a/b/c.txt"));
  });

  it("resolves a symlink ancestor to its real target", async () => {
    const link = path.join(workspace, "escape");
    await symlink(outside, link);
    const resolved = await canonicalizeForWrite(path.join(link, "pwn.txt"));
    expect(resolved).toBe(path.join(outside, "pwn.txt"));
  });
});

describe("file write fence", () => {
  let base: string;
  let workspace: string;
  let dataDir: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "codefly-fence-"));
    workspace = path.join(base, "workspace");
    dataDir = path.join(base, "data");
    await mkdir(workspace, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    outside = await mkdtemp(path.join(os.homedir(), ".codefly-fence-outside-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("read-only denies every write", async () => {
    const session = makeSession(workspace, "read-only");
    await expect(
      assertWritable(session, path.join(workspace, "x.txt"), dataDir),
    ).rejects.toMatchObject({ code: "SANDBOX_DENIED" });
  });

  it("workspace-write allows the workspace and /tmp", async () => {
    const session = makeSession(workspace, "workspace-write");
    await expect(
      assertWritable(session, path.join(workspace, "notes/x.txt"), dataDir),
    ).resolves.toEqual({ resolved: path.join(workspace, "notes/x.txt") });

    const tmpTarget = path.join(
      os.tmpdir(),
      `codefly-fence-tmp-${process.pid}.txt`,
    );
    await expect(assertWritable(session, tmpTarget, dataDir)).resolves.toEqual({
      resolved: tmpTarget,
    });
  });

  it("workspace-write denies paths outside workspace and /tmp", async () => {
    const session = makeSession(workspace, "workspace-write");
    await expect(
      assertWritable(session, path.join(outside, "x.txt"), dataDir),
    ).rejects.toMatchObject({ code: "SANDBOX_DENIED" });
  });

  it("workspace-write denies a symlink ancestor escape", async () => {
    const session = makeSession(workspace, "workspace-write");
    const link = path.join(workspace, "escape");
    await symlink(outside, link);
    await expect(
      assertWritable(session, path.join(link, "pwn.txt"), dataDir),
    ).rejects.toMatchObject({ code: "SANDBOX_DENIED" });
  });

  it("danger-full-access allows outside writes but protects .git", async () => {
    const session = makeSession(workspace, "danger-full-access");
    await expect(
      assertWritable(session, path.join(outside, "x.txt"), dataDir),
    ).resolves.toEqual({ resolved: path.join(outside, "x.txt") });

    await expect(
      assertWritable(session, path.join(workspace, ".git/config"), dataDir),
    ).rejects.toMatchObject({ code: "FS_PROTECTED" });
  });

  it("danger-full-access cannot reach .git through a symlink", async () => {
    const session = makeSession(workspace, "danger-full-access");
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    const link = path.join(workspace, "git-link");
    await symlink(path.join(workspace, ".git"), link);

    await expect(
      assertWritable(session, path.join(link, "config"), dataDir),
    ).rejects.toMatchObject({ code: "FS_PROTECTED" });
  });

  it("protects CodeFly's own data directory", async () => {
    const session = makeSession(workspace, "danger-full-access");
    await expect(
      assertWritable(session, path.join(dataDir, "sessions.json"), dataDir),
    ).rejects.toMatchObject({ code: "FS_PROTECTED" });
  });

  it("protects shell startup files", async () => {
    const session = makeSession(workspace, "danger-full-access");
    await expect(
      assertWritable(session, path.join(outside, ".bashrc"), dataDir),
    ).rejects.toMatchObject({ code: "FS_PROTECTED" });
  });
});
