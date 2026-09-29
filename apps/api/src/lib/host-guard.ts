import net from "node:net";
import dns from "node:dns/promises";

type LookupAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const lookupAll: LookupAll = (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

const blockedV4 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}

// Only globally routable unicast is accepted. Additional special-purpose
// ranges inside 2000::/3 are denied explicitly (transition/documentation).
const globallyRoutableV6 = new net.BlockList();
globallyRoutableV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new net.BlockList();
for (const [network, prefix] of [
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

/** Return true unless the literal is a globally routable IPv4/IPv6 address. */
export function isBlockedIp(ip: string): boolean {
  const normalized = ip.trim().replace(/^\[|\]$/g, "");
  const type = net.isIP(normalized);
  if (type === 4) return blockedV4.check(normalized, "ipv4");
  if (type === 6) {
    return !globallyRoutableV6.check(normalized, "ipv6")
      || blockedV6.check(normalized, "ipv6");
  }
  return true;
}

/**
 * Validate and resolve an external SQL host.
 *
 * The returned value is always a numeric address. Callers must connect to this
 * exact value, not to the original hostname, so a second DNS lookup cannot
 * rebind the connection to a private address.
 */
export async function assertHostAllowed(
  host: string,
  resolve: LookupAll = lookupAll,
): Promise<string> {
  const allowPrivate = process.env.ALLOW_PRIVATE_SQL_HOST === "1";
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) throw new Error("host is empty");

  if (
    !allowPrivate
    && (normalized === "localhost"
      || normalized.endsWith(".localhost")
      || normalized.endsWith(".internal")
      || normalized.endsWith(".local"))
  ) {
    throw new Error("private/local SQL hosts are not allowed");
  }

  if (net.isIP(normalized)) {
    if (!allowPrivate && isBlockedIp(normalized)) {
      throw new Error("private, reserved, or non-routable SQL hosts are not allowed");
    }
    return normalized;
  }

  let addresses: string[];
  try {
    const records = await resolve(normalized);
    addresses = records.map((record) => record.address);
  } catch (error: any) {
    throw new Error(`unable to resolve SQL host: ${error?.message ?? "DNS lookup failed"}`);
  }
  if (!addresses.length) throw new Error("SQL host resolved to no addresses");
  if (addresses.some((address) => net.isIP(address) === 0)) {
    throw new Error("SQL host resolved to an invalid address");
  }
  if (!allowPrivate && addresses.some(isBlockedIp)) {
    throw new Error("SQL host resolves to a private, reserved, or non-routable address");
  }

  return addresses[0];
}
