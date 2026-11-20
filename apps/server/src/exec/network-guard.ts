import { isIP } from "node:net";
import type { SandboxMode } from "@codefly/protocol";
import { AppError } from "../http/errors.js";
import {
  BLOCKED_HOSTNAMES,
  bareHost,
  isBlockedAddress,
} from "../net/address.js";

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>]+/gi;
const NETWORK_COMMANDS =
  /\b(curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|rsync|ftp)\b/i;
const SENSITIVE_HOST_TOKEN =
  /(^|[\s:/"'(@])(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|169\.254\.169\.254|\[::1\]|::1)(?=$|[\s:/"')])/i;
const PRIVATE_IPV4_TOKEN =
  /(^|[\s:/"'(@])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})(?=$|[\s:/"')])/;

function isBlockedHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (BLOCKED_HOSTNAMES.test(host)) return true;
  if (isIP(host) !== 0) return isBlockedAddress(host);
  return false;
}

function denied(target: string): AppError {
  return new AppError(
    "NETWORK_DENIED",
    [
      `[sandbox: network access denied] ${target} targets a private, loopback or link-local address.`,
      "Model commands may not reach local services, LAN hosts or cloud metadata endpoints.",
      "Use web_fetch for public HTTP(S) URLs. If this target is genuinely required, ask the user to switch the session to danger-full-access.",
    ].join("\n"),
    403,
  );
}

/**
 * Best-effort guard for shell commands. It catches literal URLs and
 * curl/wget-style targets aimed at private addresses; it is not a network
 * sandbox, so it deliberately only runs for workspace-write/read-only modes.
 * danger-full-access is the explicit escape hatch.
 */
export function assertCommandNetworkAllowed(
  command: string,
  mode: SandboxMode,
): void {
  if (mode === "danger-full-access") return;

  for (const raw of command.match(URL_PATTERN) ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (isBlockedHost(url.hostname)) throw denied(raw);
  }

  if (
    NETWORK_COMMANDS.test(command) &&
    (SENSITIVE_HOST_TOKEN.test(command) || PRIVATE_IPV4_TOKEN.test(command))
  ) {
    throw denied(command.trim().slice(0, 300));
  }
}
