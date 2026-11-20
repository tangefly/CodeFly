import path from "node:path";
import { AppError } from "../http/errors.js";
import { canonicalizeExisting, isUnder } from "./canonicalize.js";

/**
 * Credential files the model-facing read tools must not open. They may be
 * legitimately inspected through a shell by the user, but an agent should not
 * be able to vacuum them into its context (and possibly the provider) just
 * because it can read absolute paths.
 */
const SENSITIVE_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".pgpass",
]);

/** Relative path suffixes (under the user's home) that hold credentials. */
const SENSITIVE_HOME_SUFFIXES = [
  ".aws/credentials",
  ".aws/config",
  ".azure/accessTokens.json",
  ".config/gh/hosts.yml",
  ".config/gcloud/application_default_credentials.json",
  ".docker/config.json",
  ".kube/config",
];

/** /proc entries that expose the server process's environment or memory. */
const PROC_SENSITIVE =
  /^\/proc\/(?:self|thread-self|\d+)\/(?:environ|mem|maps|smaps|fd(?:\/|$)|task\/[^/]+\/(?:environ|mem|maps|smaps|fd(?:\/|$)))/;

function homeDir(): string {
  return process.env.HOME ?? "";
}

/** True when a resolved absolute path is off-limits to read tools. */
export function isReadDenied(target: string, dataDir: string): boolean {
  const resolved = path.resolve(target);
  if (isUnder(resolved, path.resolve(dataDir))) return true;
  if (PROC_SENSITIVE.test(resolved)) return true;

  if (SENSITIVE_BASENAMES.has(path.basename(resolved))) return true;

  const home = homeDir();
  if (home !== "") {
    for (const suffix of SENSITIVE_HOME_SUFFIXES) {
      if (isUnder(resolved, path.join(home, suffix))) return true;
    }
  }
  return false;
}

function deniedMessage(target: string): string {
  return [
    `[sandbox: read denied] ${target} is a protected path.`,
    "CodeFly's own data directory (API keys, session history) and credential files are never exposed to model-facing read tools.",
    "Ask the user to share the relevant content explicitly if a task truly needs it.",
  ].join("\n");
}

/**
 * Resolves symlinks before checking so an alias cannot reach a denied path.
 * Returns the canonical path the caller should read.
 */
export async function assertReadable(
  target: string,
  dataDir: string,
): Promise<string> {
  const [resolved, dataRoot] = await Promise.all([
    canonicalizeExisting(target),
    canonicalizeExisting(dataDir).catch(() => path.resolve(dataDir)),
  ]);
  if (isReadDenied(resolved, dataRoot)) {
    throw new AppError("FS_READ_DENIED", deniedMessage(resolved), 403);
  }
  return resolved;
}
