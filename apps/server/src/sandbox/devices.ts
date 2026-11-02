import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** NVIDIA nodes without an index (indexed ones are discovered via readdir). */
const NVIDIA_FIXED = [
  "nvidiactl",
  "nvidia-modeset",
  "nvidia-uvm",
  "nvidia-uvm-tools",
];

const NVIDIA_INDEXED = /^nvidia\d+$/;
const DRI_RENDER = /^renderD\d+$/;

function isCharDevice(candidate: string): boolean {
  try {
    return statSync(candidate).isCharacterDevice();
  } catch {
    return false;
  }
}

function listCharDevices(
  dir: string,
  include: (name: string) => boolean,
): string[] {
  try {
    return readdirSync(dir)
      .filter(include)
      .map((name) => path.join(dir, name))
      .filter(isCharDevice);
  } catch {
    return [];
  }
}

/**
 * Device nodes that need read-write access for GPU work. Landlock grants are
 * per-path (no globs), so this list is materialized once at startup. Only
 * character devices are accepted; missing drivers simply yield fewer paths.
 * `/dev/shm` is included for CUDA IPC and multiprocessing.
 *
 * @param devRoot - device root, injectable for tests.
 */
export function gpuDevicePaths(devRoot = "/dev"): string[] {
  const found = new Set<string>();

  for (const name of NVIDIA_FIXED) {
    const candidate = path.join(devRoot, name);
    if (isCharDevice(candidate)) found.add(candidate);
  }

  for (const candidate of listCharDevices(devRoot, (name) =>
    NVIDIA_INDEXED.test(name),
  )) {
    found.add(candidate);
  }

  for (const candidate of listCharDevices(
    path.join(devRoot, "dri"),
    (name) => DRI_RENDER.test(name),
  )) {
    found.add(candidate);
  }

  // MIG capability nodes, when the driver exposes them.
  const capsDir = path.join(devRoot, "nvidia-caps");
  try {
    for (const name of readdirSync(capsDir)) {
      const candidate = path.join(capsDir, name);
      if (isCharDevice(candidate)) found.add(candidate);
    }
  } catch {
    // No MIG support.
  }

  const shm = path.join(devRoot, "shm");
  try {
    if (statSync(shm).isDirectory()) found.add(shm);
  } catch {
    // No /dev/shm.
  }

  return [...found].sort();
}

/**
 * Read-write grants needed for GPU work beyond the device nodes.
 *
 * The CUDA runtime names its threads by writing
 * `/proc/self/task/<tid>/comm`. Sandboxed commands are typically forked
 * children of the launcher, so `/proc/self` would only cover the shell and
 * not the actual workload; the rule must cover the whole `/proc` tree.
 */
export function gpuReadWritePaths(devRoot = "/dev"): string[] {
  return [...gpuDevicePaths(devRoot), "/proc"];
}
