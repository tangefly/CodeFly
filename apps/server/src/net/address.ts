import { isIP } from "node:net";

/** True for IPv4 ranges that must not be reachable from model commands. */
export function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

/** True for IPv6 loopback, ULA, link-local, multicast and mapped private v4. */
export function isBlockedIpv6(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip === "::" || ip === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped !== null) return isBlockedIpv4(mapped[1]!);
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  return ip.startsWith("ff");
}

/** True when a literal address is loopback, private, link-local or multicast. */
export function isBlockedAddress(address: string): boolean {
  return isIP(address) === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

/** Hostnames that never resolve to a public service. */
export const BLOCKED_HOSTNAMES = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

/** Strips brackets from an IPv6 hostname. */
export function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}
