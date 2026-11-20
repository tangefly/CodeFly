import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleEmailConfigStore } from "../src/schedule/email.js";

describe("ScheduleEmailConfigStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "codefly-schedule-email-"));
    file = path.join(dir, "email.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts unconfigured and refuses to build a transport", async () => {
    const store = new ScheduleEmailConfigStore(file);
    await store.init();
    expect(store.isConfigured()).toBe(false);
    expect(store.getPublic()).toMatchObject({
      configured: false,
      to: "",
      hasPassword: false,
    });
    expect(() => store.getInternal()).toThrowError(/尚未配置/);
  });

  it("persists SMTP settings without exposing the password", async () => {
    const store = new ScheduleEmailConfigStore(file);
    await store.init();
    const settings = await store.update({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "me@example.com",
      password: "super-secret",
      from: "me@example.com",
      to: "me@example.com",
    });
    expect(settings).toMatchObject({
      configured: true,
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "me@example.com",
      from: "me@example.com",
      to: "me@example.com",
      hasPassword: true,
    });
    expect(settings.passwordHint).toBe("••••cret");
    expect(JSON.stringify(settings)).not.toContain("super-secret");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = new ScheduleEmailConfigStore(file);
    await reloaded.init();
    const internal = reloaded.getInternal();
    expect(internal.password).toBe("super-secret");
    expect(internal.to).toBe("me@example.com");
  });

  it("keeps the existing password when the field is omitted and clears it on request", async () => {
    const store = new ScheduleEmailConfigStore(file);
    await store.init();
    await store.update({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "me",
      password: "old-secret",
      from: "me@example.com",
      to: "me@example.com",
    });

    await store.update({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "me",
      from: "me@example.com",
      to: "me@example.com",
    });
    expect(store.getInternal().password).toBe("old-secret");

    await store.update({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "me",
      clearPassword: true,
      from: "me@example.com",
      to: "me@example.com",
    });
    expect(store.getInternal().password).toBe("");
    expect(store.getPublic().hasPassword).toBe(false);
  });

  it("resolves unsaved test overrides without changing the stored config", async () => {
    const store = new ScheduleEmailConfigStore(file);
    await store.init();
    await store.update({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "me",
      password: "stored",
      from: "me@example.com",
      to: "me@example.com",
    });
    const resolved = store.resolveForTest({
      host: "other.example.com",
      port: 2525,
      to: "other@example.com",
    });
    expect(resolved.host).toBe("other.example.com");
    expect(resolved.port).toBe(2525);
    expect(resolved.password).toBe("stored");
    expect(resolved.to).toBe("other@example.com");
    expect(store.getInternal().host).toBe("smtp.example.com");
  });
});
