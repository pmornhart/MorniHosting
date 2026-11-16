import { z } from 'zod';
import { hostnameSchema, netbirdNameSchema, portSchema } from './api.js';
import { PORT_BEDROCK, PORT_JAVA } from './software.js';

/**
 * NetBird automation: the panel creates reverse-proxy services in the admin's NetBird account, so a
 * server only needs a short name to be reachable as <name>.<domain>.
 */

export const NETBIRD_DEFAULT_API = 'https://api.netbird.io';
const TOKEN_MAX = 200;
const ID_MAX = 100;
const URL_MAX = 2048;

// The NetBird API must be reached over HTTPS: "https" matches; "http" is rejected.
// https://regex101.com/?flavor=javascript&regex=%5Ehttps%24&flags=gm&testString=https%0Ahttp
const HTTPS_ONLY = /^https$/;

export const netbirdApiUrlSchema = z.url({ protocol: HTTPS_ONLY }).max(URL_MAX);

/** Look up domains and machines with a token (or the stored one) before saving anything. */
export const netbirdDiscoverSchema = z.object({
  apiUrl: netbirdApiUrlSchema.optional(),
  token: z.string().trim().min(1).max(TOKEN_MAX).optional(),
});

export const netbirdConfigSchema = z.object({
  apiUrl: netbirdApiUrlSchema,
  /** Left out to keep the stored token. */
  token: z.string().trim().min(1).max(TOKEN_MAX).optional(),
  domain: hostnameSchema,
  peerId: z.string().trim().min(1).max(ID_MAX),
});
export type NetbirdConfigInput = z.infer<typeof netbirdConfigSchema>;

const NAME_FROM_TEXT_MAX = 40;
const FALLBACK_NAME = 'minecraft';
const UMLAUTS: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
// German umlauts and ß, written out before the rest is cleaned: "Bärenhöhle" → "baerenhoehle".
// https://regex101.com/?flavor=javascript&regex=%5B%C3%A4%C3%B6%C3%BC%C3%9F%5D&flags=g&testString=b%C3%A4renh%C3%B6hle%20stra%C3%9Fe
const UMLAUT = /[äöüß]/g;
// Everything that is not a letter or digit becomes a dash: "survival mit freunden!" → "survival-mit-freunden-".
// https://regex101.com/?flavor=javascript&regex=%5B%5Ea-z0-9%5D%2B&flags=g&testString=survival%20mit%20freunden!
const NOT_NAME = /[^a-z0-9]+/g;
// Dashes at the start or end: "-survival-" loses both, "sur-vival" keeps its dash.
// https://regex101.com/?flavor=javascript&regex=%5E-%2B%7C-%2B%24&flags=g&testString=-survival-%0Asur-vival
const EDGE_DASHES = /^-+|-+$/g;

/** A server name as an address part: "Survival mit Freunden!" → "survival-mit-freunden". */
export function toNetbirdName(text: string, fallback = FALLBACK_NAME): string {
  const name = text
    .toLowerCase()
    .replace(UMLAUT, (c) => UMLAUTS[c] ?? '')
    .replace(NOT_NAME, '-')
    .slice(0, NAME_FROM_TEXT_MAX)
    .replace(EDGE_DASHES, '');
  return name || fallback;
}

/**
 * The brand as a technical name for machines, files and services: "MorniHosting" → "mornihosting",
 * "MoinMorni" → "moinmorni".
 */
export function brandSlug(brand: string): string {
  return brand.toLowerCase().replace(NOT_NAME, '');
}

export const netbirdServerSchema = z.object({ name: netbirdNameSchema.nullable() });

/**
 * The server players reach on the domain itself ("moinmorni.net" instead of "spiel.moinmorni.net"); null = none.
 * Its NetBird services keep their own names (NetBird allows one service per name, the website already has the domain),
 * but ask for the ports games use when none is typed – NetBird forwards TCP and UDP by port, whatever name was typed.
 */
export const netbirdDomainServerSchema = z.object({
  serverId: z.string().trim().min(1).max(ID_MAX).nullable(),
});

/**
 * "Weitere Domains über diesen Verteiler": another product on the same NetBird server (e.g. MoinMorni on
 * moinmorni.net) cannot have the ports games use without one typed – the address router holds them. Its domain is
 * entered here with the outside ports it has in NetBird (e.g. 25567 and 19134, as its page shows them); players who type
 * that domain are then sent where NetBird sends those ports.
 */
export const ROUTER_FORWARDS_MAX = 20;
export const routerForwardSchema = z
  .object({
    domain: hostnameSchema.toLowerCase(),
    /** Outside TCP port of the other product's Java (or proxy) service in NetBird; null = no Java. */
    javaPort: portSchema.nullable(),
    /** Outside port of its Bedrock service (TCP half, signaling); null = no Bedrock. */
    bedrockPort: portSchema.nullable(),
  })
  .refine((f) => f.javaPort !== null || f.bedrockPort !== null, { message: 'port_missing' });
export type RouterForward = z.infer<typeof routerForwardSchema>;
export const routerForwardsSchema = z.object({
  forwards: z.array(routerForwardSchema).max(ROUTER_FORWARDS_MAX),
});

/**
 * Why the router cannot send players of a forwarded domain on: NetBird not connected, no TCP service on that port,
 * the port belongs to this panel itself, the service is switched off or has no target, the target is no IP address,
 * not in the home network or NetBird (the router is no open relay), in one of the panel's own internal networks,
 * or NetBird could not be asked.
 */
export type RouterForwardProblem =
  | 'no_netbird'
  | 'no_service'
  | 'own_service'
  | 'service_off'
  | 'no_target'
  | 'no_address'
  | 'not_private'
  | 'own_network'
  | 'netbird_error';

export interface RouterForwardCheck {
  /** Where NetBird sends the port, e.g. "10.20.30.40:25565"; null when it is not known. */
  readonly target: string | null;
  /** The NetBird service on that port, e.g. "moinmorni-proxy.moinmorni.net". */
  readonly service: string | null;
  /** null: players get through. */
  readonly problem: RouterForwardProblem | null;
  /** NetBird's error when it could not be asked. */
  readonly error: {
    readonly code: string;
    readonly params: Readonly<Record<string, string | number>>;
  } | null;
}

export interface RouterForwardView extends RouterForward {
  readonly java: RouterForwardCheck | null;
  readonly bedrock: RouterForwardCheck | null;
  /** A server of this panel answers to the same name first (its name is the domain's first part): players land there. */
  readonly shadowedBy: string | null;
}

export interface RouterForwardsStatus {
  /** The router holds 25565 / 19132 in NetBird: only then do other domains get through it. */
  readonly router: { readonly java: boolean; readonly bedrock: boolean };
  readonly forwards: readonly RouterForwardView[];
}

/** An empty name puts the panel on the domain itself. */
export const netbirdPanelSchema = z.object({
  name: z.union([netbirdNameSchema, z.literal('')]),
  port: portSchema,
});

/** What a NetBird service is for: the server itself, Bedrock players via Geyser, voice chat, the panel. */
/** "geyser-signal": the TCP half of Geyser's port (NetherNet finds the server over TCP, plays over UDP). */
/** "router-java"/"router-bedrock": the panel's address router on 25565/19132 (every server by name, no port). */
export type NetbirdPurpose =
  'main' | 'geyser' | 'geyser-signal' | 'voice' | 'panel' | 'router-java' | 'router-bedrock';

/** Outside ports of the address router: the ports Java and Bedrock use when no port is typed. */
export const ROUTER_PUBLIC_PORTS = { java: PORT_JAVA, bedrock: PORT_BEDROCK } as const;

export interface NetbirdStatus {
  readonly configured: boolean;
  /** Name in front of everything the panel makes in NetBird (network, group, resources, exit): "MorniHosting". */
  readonly brand: string;
  /** Machines whose name contains this are taken for the panel's own machine, e.g. "mornihosting". */
  readonly machineHint: string;
  readonly apiUrl: string;
  readonly domain: string | null;
  readonly peerId: string | null;
  readonly peerName: string | null;
  /** The panel's own address when the panel created its NetBird service, e.g. "panel.example.de". */
  readonly panelAddress: string | null;
  /** The proxy uses the servers' own ports outside (self-hosted NetBird); NetBird Cloud picks its own. */
  readonly customPorts: boolean;
  /** Outside ports of the server addresses: on a self-hosted proxy each must be let through. */
  readonly openPorts: readonly NetbirdOpenPort[];
  /** The address router is in place: Java on 25565, Bedrock on 19132, every server by its name alone. */
  readonly router: { readonly java: boolean; readonly bedrock: boolean };
  /** The server on the domain itself (see netbirdDomainServerSchema). */
  readonly domainServer: { readonly id: string; readonly name: string } | null;
  /**
   * Servers behind a network's proxy (lobby, game modes): no ports of their own outside and no direct logins, so they
   * cannot sit on the domain – their proxy can.
   */
  readonly behindProxy: readonly NetbirdBehindProxy[];
}

/** A server that players only reach through its network's proxy. */
export interface NetbirdBehindProxy {
  readonly id: string;
  readonly name: string;
  readonly proxyId: string;
  readonly proxyName: string;
}

export interface NetbirdOpenPort {
  readonly port: number;
  readonly protocol: 'tcp' | 'udp';
  readonly domain: string;
}

export interface NetbirdDomainOption {
  readonly domain: string;
  readonly validated: boolean;
  readonly custom: boolean;
}

export interface NetbirdPeerOption {
  readonly id: string;
  readonly name: string;
  readonly ip: string;
  readonly connected: boolean;
}

export interface NetbirdDiscovery {
  readonly domains: readonly NetbirdDomainOption[];
  readonly peers: readonly NetbirdPeerOption[];
  /** The machine that looks like this panel (its name contains "mornihosting"), if any. */
  readonly suggestedPeerId: string | null;
}

export interface NetbirdServiceInfo {
  readonly purpose: NetbirdPurpose;
  readonly domain: string;
  /** Port friends use from outside; NetBird Cloud assigns it. */
  readonly port: number | null;
  /** The outside port this service asked for but did not get, because another service has it; else null. */
  readonly wanted: number | null;
  /** NetBird name of the service that holds the wanted port (e.g. one of another panel in the same account). */
  readonly heldBy: string | null;
}

/** NetBird state of one server, shown on its pages. */
export interface NetbirdServerInfo {
  readonly name: string;
  /** Players reach this server on the domain itself (no name in front). */
  readonly onDomain: boolean;
  readonly services: readonly NetbirdServiceInfo[];
  /** Players join by the name alone (no port): Java through the router, Bedrock through the router (Geyser on). */
  readonly routed: { readonly java: boolean; readonly bedrock: boolean };
  /** Why the last sync with NetBird failed (an error code with its details); null when all is in place. */
  readonly error: {
    readonly code: string;
    readonly params: Readonly<Record<string, string | number>>;
  } | null;
}

/**
 * "Hausanschluss verstecken": the panel's machine sends all its internet traffic through another NetBird machine
 * (an exit node, e.g. the NetBird server), so the home connection's IP shows up nowhere.
 */
export const netbirdExitSchema = z.object({
  enabled: z.boolean(),
  /** The machine traffic leaves through; needed when switching on. */
  exitPeerId: z.string().trim().max(ID_MAX).default(''),
});
export type NetbirdExitInput = z.input<typeof netbirdExitSchema>;

export interface NetbirdExitCandidate {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  /** The internet IP NetBird sees this machine connect from. */
  readonly publicIp: string;
}

export interface NetbirdExitStatus {
  readonly enabled: boolean;
  readonly exitPeerId: string | null;
  readonly exitPeerName: string | null;
  /** Internet IP of the exit machine: what the world should see. */
  readonly exitIp: string | null;
  /** true: the panel's traffic leaves through the exit machine; false: still through the home connection. */
  readonly hidden: boolean | null;
  /** Addresses whose DNS still points at the home connection. */
  readonly leaks: readonly string[];
  /** The own-domain DNS automation would publish the home IP. */
  readonly dnsAutomation: boolean;
  readonly candidates: readonly NetbirdExitCandidate[];
  /**
   * Name of the route this panel shares with another panel on the same exit machine (NetBird allows only one route
   * for all internet traffic per exit machine there): the panel's group sits in that route. Null with an own route.
   */
  readonly sharedWith: string | null;
  readonly checkedAt: string | null;
  readonly error: {
    readonly code: string;
    readonly params: Readonly<Record<string, string | number>>;
  } | null;
}

/** "Bedrock-Verbindung prüfen": does Geyser answer inside, and from the internet? */
export interface GeyserCheck {
  readonly running: boolean;
  /** Answer from Geyser inside the server (container port 19132). */
  readonly inside: { readonly ok: boolean; readonly version: string | null; readonly motd: string | null };
  /** What Bedrock players type: address and port, checked from outside via mcsrvstat.us. */
  readonly outside: { readonly host: string; readonly port: number; readonly ok: boolean | null } | null;
}
