import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gpuDevicePaths, gpuReadWritePaths } from "../src/sandbox/devices.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codefly-devices-"));
await mkdir(path.join(root, "dri"), { recursive: true });
await mkdir(path.join(root, "shm"), { recursive: true });
await mkdir(path.join(root, "nvidia-caps"), { recursive: true });

// symlinks to /dev/null keep isCharacterDevice() true without needing root.
for (const name of ["nvidiactl", "nvidia0", "nvidia-uvm", "nvidia-uvm-tools"]) {
  await symlink("/dev/null", path.join(root, name));
}
await symlink("/dev/null", path.join(root, "nvidia-caps", "cap1"));
await symlink("/dev/null", path.join(root, "dri", "renderD128"));
await symlink("/dev/null", path.join(root, "dri", "card1"));

// Indexed name that is not a device node; must not be granted.
await writeFile(path.join(root, "nvidia9"), "not a device");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gpuDevicePaths", () => {
  it("collects NVIDIA and render nodes but not unrelated entries", () => {
    const paths = gpuDevicePaths(root);

    expect(paths).toContain(path.join(root, "nvidiactl"));
    expect(paths).toContain(path.join(root, "nvidia0"));
    expect(paths).toContain(path.join(root, "nvidia-uvm"));
    expect(paths).toContain(path.join(root, "nvidia-uvm-tools"));
    expect(paths).toContain(path.join(root, "nvidia-caps", "cap1"));
    expect(paths).toContain(path.join(root, "dri", "renderD128"));
    expect(paths).toContain(path.join(root, "shm"));

    expect(paths).not.toContain(path.join(root, "dri", "card1"));
    expect(paths).not.toContain(path.join(root, "nvidia9"));
  });

  it("returns an empty list when the device root is missing", () => {
    expect(gpuDevicePaths(path.join(root, "missing"))).toEqual([]);
  });

  it("adds /proc for CUDA thread naming", () => {
    const paths = gpuReadWritePaths(root);
    expect(paths).toContain("/proc");
    expect(paths).toContain(path.join(root, "nvidia0"));
  });
});
