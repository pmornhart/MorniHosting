import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { badRequest } from './errors.js';

/**
 * Keeps outgoing requests to user-supplied URLs (webhooks) away from the local network:
 * loopback, private ranges, link-local (cloud metadata), CGNAT, multicast and their IPv6 cousins.
 */

/* eslint-disable ts-patterns/no-magic-numbers -- network prefixes and their lengths */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
];
/** Home networks (routers hand these out); not CGNAT or VPNs such as NetBird (100.64.0.0/10). */
const HOME_V4: readonly (readonly [string, number])[] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];
const HOME_V6: readonly (readonly [string, number])[] = [
  ['fc00::', 7],
  ['fe80::', 10],
];
/* eslint-enable ts-patterns/no-magic-numbers */

const blockList = new net.BlockList();
BLOCKED_V4.forEach(([address, prefix]) => blockList.addSubnet(address, prefix, 'ipv4'));
BLOCKED_V6.forEach(([address, prefix]) => blockList.addSubnet(address, prefix, 'ipv6'));

const IPV4_MAPPED = '::ffff:';
// The brackets around an IPv6 literal in a URL host: in "[::1]" it matches "[" and "]".
// https://regex101.com/?regex=%5E%5C%5B%7C%5C%5D%24&flags=g&testString=%5B%3A%3A1%5D
const BRACKETS = /^\[|\]$/g;

export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith(IPV4_MAPPED) && net.isIPv4(lower.slice(IPV4_MAPPED.length))) {
    return blockList.check(lower.slice(IPV4_MAPPED.length), 'ipv4');
  }
  if (!net.isIP(lower)) return true;
  return blockList.check(lower, net.isIPv4(lower) ? 'ipv4' : 'ipv6');
}

const homeList = new net.BlockList();
HOME_V4.forEach(([address, prefix]) => homeList.addSubnet(address, prefix, 'ipv4'));
HOME_V6.forEach(([address, prefix]) => homeList.addSubnet(address, prefix, 'ipv6'));

/** True for a visitor from the same home network, e.g. "192.168.178.20" or "::ffff:10.0.0.5". */
export function isHomeNetworkAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const v4 = lower.startsWith(IPV4_MAPPED) ? lower.slice(IPV4_MAPPED.length) : lower;
  if (net.isIPv4(v4)) return homeList.check(v4, 'ipv4');
  return net.isIPv6(lower) && homeList.check(lower, 'ipv6');
}

/* eslint-disable ts-patterns/no-magic-numbers -- network prefixes and their lengths */
/** Where the address router may send players: the home network and NetBird machines (100.64.0.0/10), nothing else. */
const FORWARD_V4: readonly (readonly [string, number])[] = [...HOME_V4, ['100.64.0.0', 10]];
/* eslint-enable ts-patterns/no-magic-numbers */
const forwardList = new net.BlockList();
FORWARD_V4.forEach(([address, prefix]) => forwardList.addSubnet(address, prefix, 'ipv4'));
const CIDR_SEPARATOR = '/';
const SINGLE_HOST_V4 = '32';

/** The one IPv4 address in a NetBird address ("10.0.0.5" or "10.0.0.5/32"); null for subnets, names and IPv6. */
export function singleIpv4(address: string | null | undefined): string | null {
  const [ip, prefix] = (address ?? '').trim().split(CIDR_SEPARATOR);
  return ip && net.isIPv4(ip) && (prefix === undefined || prefix === SINGLE_HOST_V4) ? ip : null;
}

/** The panel's own networks (inside Docker: its internal networks, e.g. the one with the Docker API proxy). */
export function ownNetworks(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && a.cidr !== null)
    .map((a) => a.cidr ?? '');
}

/**
 * Why the address router must not send players to this address, or null when it may: only the home network and
 * NetBird machines – never the internet (no open relay) and never the panel's own internal networks (inside Docker
 * they hold the Docker API proxy, which nobody from outside may reach).
 */
export function forwardTargetProblem(
  address: string,
  own: readonly string[],
): 'not_private' | 'own_network' | null {
  if (!net.isIPv4(address) || !forwardList.check(address, 'ipv4')) return 'not_private';
  const inside = new net.BlockList();
  own.forEach((cidr) => {
    const [base, bits] = cidr.split(CIDR_SEPARATOR);
    if (base && net.isIPv4(base)) inside.addSubnet(base, Number(bits), 'ipv4');
  });
  return inside.check(address, 'ipv4') ? 'own_network' : null;
}

export type Resolver = (hostname: string) => Promise<readonly string[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Throws unless every address the host name resolves to is public. */
export async function assertPublicHost(hostname: string, resolve: Resolver = systemResolver): Promise<void> {
  const bare = hostname.replace(BRACKETS, '');
  const addresses = await (async () => {
    if (net.isIP(bare)) return [bare];
    try {
      return await resolve(bare);
    } catch {
      throw badRequest('webhook_unresolvable', { host: bare });
    }
  })();
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw badRequest('webhook_private_address', { host: bare });
}
