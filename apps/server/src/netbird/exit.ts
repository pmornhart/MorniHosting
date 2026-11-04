import { isNotNull } from 'drizzle-orm';
import { netbirdExitSchema, type NetbirdExitInput, type NetbirdExitStatus } from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { netbirdServices, servers as serverTable } from '../db/schema.js';
import { AppError, badRequest } from '../lib/errors.js';
import { systemResolver, type Resolver } from '../lib/net-guard.js';
import { freshPublicIp } from '../servers/connectivity.js';
import { createNetbirdClient, type NetbirdClientFactory, type NetbirdPeer } from './client.js';

/**
 * "Hausanschluss verstecken": all internet traffic of the panel's machine leaves through another NetBird
 * machine (exit node, normally the NetBird server). NetBird calls that a route for 0.0.0.0/0 with this machine
 * as routing peer, given to a group that holds only the panel's machine. The home IP is remembered (sealed) once,
 * before switching, so the panel can warn when it shows up again — it is never shown or sent anywhere.
 */

const NETBIRD_KEY = 'netbird';
const EXIT_KEY = 'netbird_exit';
const EXIT_NAME = 'MorniHosting Ausgang';
/** The panel's container is called "mornihosting" (Proxmox script, install.sh); its NetBird peer carries the name. */
const PANEL_MACHINE_HINT = 'mornihosting';

interface NetbirdConfig {
  readonly apiUrl: string;
  readonly token: string;
  readonly domain: string;
  readonly peerId: string;
}

interface StoredExit {
  readonly exitPeerId: string;
  readonly routeId: string;
  readonly groupId: string;
  /** The home connection's IP before switching, sealed; null when it could not be found out. */
  readonly homeIpSealed: string | null;
}

export interface NetbirdExit {
  readonly status: () => Promise<NetbirdExitStatus>;
  readonly set: (input: NetbirdExitInput, actor: Actor) => Promise<NetbirdExitStatus>;
  /** Removes route and group again (when NetBird is disconnected). */
  readonly remove: () => Promise<void>;
  /** Sets group and route up again as stored (e.g. the panel's machine got a new id); no-op when off. */
  readonly repair: () => Promise<void>;
}

const failureOf = (err: unknown): NetbirdExitStatus['error'] =>
  err instanceof AppError ? { code: err.code, params: err.params } : { code: 'netbird_failed', params: {} };

export function createNetbirdExit(
  ctx: AppContext,
  clientFactory: NetbirdClientFactory = createNetbirdClient,
  resolve: Resolver = systemResolver,
  currentIp: () => Promise<string | null> = freshPublicIp,
): NetbirdExit {
  const netbird = (): NetbirdConfig | null => ctx.settings.getValue<NetbirdConfig>(NETBIRD_KEY) ?? null;
  const stored = (): StoredExit | null => ctx.settings.getValue<StoredExit>(EXIT_KEY) ?? null;
  const clientOf = (cfg: NetbirdConfig) => clientFactory(cfg.apiUrl, ctx.secrets.decrypt(cfg.token));
  const state: { checkedAt: string | null } = { checkedAt: null };

  /** Every address the panel publishes: the domain itself, the panel and each server. */
  const publishedNames = (cfg: NetbirdConfig): string[] => {
    const services = ctx.db
      .select()
      .from(netbirdServices)
      .all()
      .map((m) => m.domain);
    const servers = ctx.db
      .select()
      .from(serverTable)
      .where(isNotNull(serverTable.netbirdName))
      .all()
      .map((r) => `${r.netbirdName}.${cfg.domain}`);
    return [...new Set([cfg.domain, ...services, ...servers])];
  };

  const leaksOf = async (cfg: NetbirdConfig, homeIp: string | null): Promise<string[]> => {
    if (!homeIp) return [];
    const names = publishedNames(cfg);
    const nothing: readonly string[] = [];
    const answers = await Promise.all(names.map((name) => resolve(name).catch(() => nothing)));
    return names.filter((_, i) => answers[i]?.includes(homeIp));
  };

  const candidatesOf = (peers: readonly NetbirdPeer[], cfg: NetbirdConfig) =>
    peers
      .filter((p) => p.id !== cfg.peerId)
      .map((p) => ({ id: p.id, name: p.name, connected: p.connected, publicIp: p.connection_ip }));

  const status = async (): Promise<NetbirdExitStatus> => {
    const cfg = netbird();
    const exit = stored();
    const dnsAutomation = ctx.settings.getValue('dns') !== undefined;
    const empty: NetbirdExitStatus = {
      enabled: false,
      exitPeerId: null,
      exitPeerName: null,
      exitIp: null,
      hidden: null,
      leaks: [],
      dnsAutomation,
      candidates: [],
      checkedAt: null,
      error: null,
    };
    if (!cfg) return empty;
    try {
      const peers = await clientOf(cfg).peers();
      const candidates = candidatesOf(peers, cfg);
      if (!exit) return { ...empty, candidates };
      const exitPeer = peers.find((p) => p.id === exit.exitPeerId);
      const homeIp = exit.homeIpSealed ? ctx.secrets.decrypt(exit.homeIpSealed) : null;
      const [ip, leaks] = await Promise.all([currentIp(), leaksOf(cfg, homeIp)]);
      const exitIp = exitPeer?.connection_ip || null;
      const hiddenByExit = exitIp && ip ? ip === exitIp : null;
      const hiddenByHome = homeIp && ip ? ip !== homeIp : null;
      state.checkedAt = new Date().toISOString();
      return {
        ...empty,
        enabled: true,
        exitPeerId: exit.exitPeerId,
        exitPeerName: exitPeer?.name ?? null,
        exitIp,
        hidden: hiddenByExit ?? hiddenByHome,
        leaks,
        candidates,
        checkedAt: state.checkedAt,
      };
    } catch (err) {
      return {
        ...empty,
        enabled: exit !== null,
        exitPeerId: exit?.exitPeerId ?? null,
        error: failureOf(err),
      };
    }
  };

  const remove = async (): Promise<void> => {
    const cfg = netbird();
    const exit = stored();
    if (cfg && exit) {
      const client = clientOf(cfg);
      await client.deleteRoute(exit.routeId);
      await client.deleteGroup(exit.groupId);
    }
    ctx.settings.deleteValue(EXIT_KEY);
  };

  const enable = async (exitPeerId: string): Promise<void> => {
    const cfg = netbird();
    if (!cfg) throw badRequest('netbird_not_configured');
    if (!exitPeerId) throw badRequest('netbird_exit_peer_missing');
    if (exitPeerId === cfg.peerId) throw badRequest('netbird_exit_same_machine');
    const client = clientOf(cfg);
    const peers = await client.peers();
    const exitPeer = peers.find((p) => p.id === exitPeerId);
    if (!exitPeer) throw badRequest('netbird_exit_peer_unknown');
    const previous = stored();
    // Remember the home IP once, before traffic moves (later it would already be the exit's IP).
    const now = previous ? null : await currentIp();
    const homeIp = now && now !== exitPeer.connection_ip ? now : null;
    const groups = await client.groups();
    const existingGroup =
      groups.find((g) => g.id === previous?.groupId) ?? groups.find((g) => g.name === EXIT_NAME);
    // Only the machine the panel runs on goes out through the exit: the MorniHosting container, found by its name –
    // also when the machine chosen for the addresses is another one (e.g. the Proxmox host routing into the LAN).
    // The host itself must never be in this group, or it loses its internet whenever the exit is down.
    const panelPeer =
      peers.find(
        (p) => p.id !== exitPeerId && `${p.name} ${p.hostname}`.toLowerCase().includes(PANEL_MACHINE_HINT),
      )?.id ?? cfg.peerId;
    const group = existingGroup
      ? await client.updateGroup(existingGroup.id, EXIT_NAME, [panelPeer])
      : await client.createGroup(EXIT_NAME, [panelPeer]);
    const request = { name: EXIT_NAME, peerId: exitPeerId, groupId: group.id };
    const routes = await client.routes();
    const existingRoute =
      routes.find((r) => r.id === previous?.routeId) ?? routes.find((r) => r.network_id === EXIT_NAME);
    const route = existingRoute
      ? await client.updateRoute(existingRoute.id, request)
      : await client.createRoute(request);
    ctx.settings.setValue(EXIT_KEY, {
      exitPeerId,
      routeId: route.id,
      groupId: group.id,
      homeIpSealed: previous?.homeIpSealed ?? (homeIp ? ctx.secrets.encrypt(homeIp) : null),
    } satisfies StoredExit);
  };

  return {
    status,
    set: async (rawInput, actor) => {
      const input = netbirdExitSchema.parse(rawInput);
      if (input.enabled) await enable(input.exitPeerId);
      else await remove();
      ctx.audit.record(actor, input.enabled ? 'netbird.exit_on' : 'netbird.exit_off', null, {
        exitPeerId: input.exitPeerId,
      });
      return status();
    },
    remove,
    repair: async () => {
      const exit = stored();
      if (exit) await enable(exit.exitPeerId);
    },
  };
}
