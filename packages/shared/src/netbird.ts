import { z } from 'zod';
import { hostnameSchema, netbirdNameSchema, portSchema } from './api.js';

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

export const netbirdServerSchema = z.object({ name: netbirdNameSchema.nullable() });

/** An empty name puts the panel on the domain itself. */
export const netbirdPanelSchema = z.object({
  name: z.union([netbirdNameSchema, z.literal('')]),
  port: portSchema,
});

/** What a NetBird service is for: the server itself, Bedrock players via Geyser, voice chat, the panel. */
export type NetbirdPurpose = 'main' | 'geyser' | 'voice' | 'panel';

export interface NetbirdStatus {
  readonly configured: boolean;
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
}

/** NetBird state of one server, shown on its pages. */
export interface NetbirdServerInfo {
  readonly name: string;
  readonly services: readonly NetbirdServiceInfo[];
  /** Why the last sync with NetBird failed (an error code with its details); null when all is in place. */
  readonly error: {
    readonly code: string;
    readonly params: Readonly<Record<string, string | number>>;
  } | null;
}
