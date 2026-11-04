import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pathList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry));
}

const repoDataDir = fileURLToPath(new URL("../../../data", import.meta.url));

export const config = {
  host: process.env.CODEFLY_HOST ?? "127.0.0.1",
  port: num(process.env.CODEFLY_PORT, 8787),
  dataDir: process.env.CODEFLY_DATA_DIR
    ? path.resolve(process.env.CODEFLY_DATA_DIR)
    : repoDataDir,
  devWebUrl: process.env.CODEFLY_DEV_WEB_URL?.replace(/\/+$/, "") ?? null,
  token: process.env.CODEFLY_TOKEN?.trim() || crypto.randomBytes(24).toString("base64url"),
  version: "0.1.0",
  approvalTimeoutMs: num(process.env.CODEFLY_APPROVAL_TIMEOUT_MS, 120_000),
  sandbox: {
    // Default-on: workspace-write still fences filesystem writes, but GPU
    // devices and /dev/shm are granted so ordinary local development works
    // without extra environment variables. Set CODEFLY_ALLOW_GPU=0 to opt out.
    gpuAccess: process.env.CODEFLY_ALLOW_GPU !== "0",
    extraReadWritePaths: pathList(process.env.CODEFLY_SANDBOX_RW_PATHS),
  },
  exec: {
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 600_000,
    outputLimitBytes: 2 * 1024 * 1024,
    flushIntervalMs: 30,
    denialTtlMs: 10 * 60_000,
  },
  fs: {
    maxReadBytes: 2 * 1024 * 1024,
    maxWriteBytes: 5 * 1024 * 1024,
  },
  llm: {
    maxHistoryMessages: 500,
    contextBudgetChars: 120_000,
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 600_000,
    testMaxTokens: 32,
  },
} as const;

export const paths = {
  audit: path.join(config.dataDir, "audit.jsonl"),
  sessions: path.join(config.dataDir, "sessions.json"),
  settings: path.join(config.dataDir, "settings.json"),
  messages: path.join(config.dataDir, "messages.json"),
  llm: path.join(config.dataDir, "llm.json"),
  search: path.join(config.dataDir, "search.json"),
  agent: path.join(config.dataDir, "agent.json"),
  spills: path.join(config.dataDir, "spills"),
  webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)),
} as const;
