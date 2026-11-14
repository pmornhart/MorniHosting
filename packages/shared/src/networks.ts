import { z } from 'zod';
import type { ServerState } from './api.js';

/**
 * Networks ("Netzwerke"): one Velocity proxy in front, Paper/Purpur servers behind it. The panel wires them up
 * before every start – modern forwarding with a shared secret, the server list, the server players land on,
 * Floodgate's key for Bedrock players – and the servers behind the proxy get no ports to the outside: players
 * only ever come in through the proxy.
 */

const NAME_MAX = 40;
const MEMBER_NAME_MAX = 32;

/** Software that can stand behind a Velocity proxy (needs Paper's modern forwarding). */
export const NETWORK_MEMBER_SOFTWARE = ['paper', 'purpur'] as const;

// A server's name in the proxy (Velocity's [servers] key): lower case letters, digits, "-" and "_", starting
// with a letter or digit. Accepts "lobby", "duels-2", "mirni_smp"; rejects "Lobby", "-x", "zwei wörter".
// https://regex101.com/?flavor=javascript&regex=%5E%5Ba-z0-9%5D%5Ba-z0-9_-%5D*%24&testString=duels-2
const MEMBER_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export const networkMemberNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMBER_NAME_MAX)
  .regex(MEMBER_NAME, 'network_member_name');

export const networkCreateSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  /** An existing Velocity server as the proxy. */
  proxyServerId: z.string().min(1),
});
export type NetworkCreateInput = z.infer<typeof networkCreateSchema>;

export const networkUpdateSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX).optional(),
  /** Name of the member players land on first (and come back to when a server stops). */
  defaultMember: networkMemberNameSchema.nullable().optional(),
  /** Players sign in with Mojang/Microsoft at the proxy (off only for tests and LAN parties). */
  onlineMode: z.boolean().optional(),
});
export type NetworkUpdateInput = z.infer<typeof networkUpdateSchema>;

export const networkMemberSchema = z.object({
  serverId: z.string().min(1),
  name: networkMemberNameSchema,
});
export type NetworkMemberInput = z.infer<typeof networkMemberSchema>;

export interface NetworkMemberView {
  readonly serverId: string;
  /** Name in the proxy (e.g. "lobby"). */
  readonly name: string;
  readonly serverName: string;
  readonly software: string;
  readonly version: string;
  readonly state: ServerState;
  readonly players: number;
  readonly isDefault: boolean;
  /** Joined while running: the new settings apply after its next restart. */
  readonly restartRequired: boolean;
}

export interface NetworkView {
  readonly id: string;
  readonly name: string;
  readonly proxy: {
    readonly serverId: string;
    readonly serverName: string;
    readonly state: ServerState;
    readonly players: number;
    readonly address: string;
  };
  readonly members: readonly NetworkMemberView[];
  readonly defaultMember: string | null;
  readonly onlineMode: boolean;
  readonly createdAt: string;
}

/** What a server is in a network, for its own pages. */
export interface ServerNetworkInfo {
  readonly networkId: string;
  readonly networkName: string;
  readonly role: 'proxy' | 'member';
  /** Name in the proxy (members only). */
  readonly memberName: string | null;
}
