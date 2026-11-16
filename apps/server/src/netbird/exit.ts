import { isNotNull } from 'drizzle-orm';
import { netbirdExitSchema, type NetbirdExitInput, type NetbirdExitStatus } from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { netbirdServices, servers as serverTable } from '../db/schema.js';
import { AppError, badRequest } from '../lib/errors.js';
import { systemResolver, type Resolver } from '../lib/net-guard.js';
import { freshPublicIp } from '../servers/connectivity.js';
import {
  createNetbirdClient,
  EVERYTHING_V4,
  type NetbirdClient,
  type NetbirdClientFactory,
  type NetbirdPeer,
  type NetbirdRoute,
} from './client.js';

/**
 * "Hausanschluss verstecken": all internet traffic of the panel's machine leaves through another NetBird
 * machine (exit node, normally the NetBird server). NetBird calls that a route for 0.0.0.0/0 with this machine
 * as routing peer, given to a group that holds only the panel's machine. The home IP is remembered (sealed) once,
 * before switching, so the panel can warn when it shows up again — it is never shown or sent anywhere.
 *
 * Two panels in one NetBird account (MorniHosting and an app that runs it as its motor, each with its own MH_BRAND)
 * can leave through the same exit machine: each has its own group "<brand> Ausgang" and its own route. NetBird takes
 * several routes for 0.0.0.0/0 over one machine (its check only looks at machine groups). Should a NetBird refuse that
 * ("… already has this route"), the panel puts its group into the route that is already there and later takes only its
 * own group out again. Groups of others in a route always stay.
 */

const NETBIRD_KEY = 'netbird';
const EXIT_KEY = 'netbird_exit';
const EXIT_SUFFIX = 'Ausgang';
// NetBird's answer when an exit machine may carry only one route for a network: "failed to add route with prefix
// 0.0.0.0/0 - peer d3k5 already has this route" matches; "group with ID abc not found" does not.
// https://regex101.com/?flavor=javascript&regex=already%20has%20this%20route&flags=i&testString=failed%20to%20add%20route%20with%20prefix%200.0.0.0%2F0%20-%20peer%20d3k5%20already%20has%20this%20route%0Agroup%20with%20ID%20abc%20not%20found
const ALREADY_ROUTED = /already has this route/i;

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
  /** The route belongs to another panel on the same exit machine (its name); only this panel's group is in it. */
  readonly sharedWith?: string | null;
}

export interface NetbirdExit {
  readonly status: () => Promise<NetbirdExitStatus>;
  readonly set: (input: NetbirdExitInput, actor: Actor) => Promise<NetbirdExitStatus>;
  /** Removes route and group again (when NetBird is disconnected); a route others use stays for them. */
  readonly remove: () => Promise<void>;
  /** Sets group and route up again as stored (e.g. the panel's machine got a new id); no-op when off. */
  readonly repair: () => Promise<void>;
}

const failureOf = (err: unknown): NetbirdExitStatus['error'] =>
  err instanceof AppError ? { code: err.code, params: err.params } : { code: 'netbird_failed', params: {} };
const alreadyRouted = (err: unknown): boolean =>
  err instanceof AppError && ALREADY_ROUTED.test(String(err.params.message ?? ''));

export function createNetbirdExit(
  ctx: AppContext,
  clientFactory: NetbirdClientFactory = createNetbirdClient,
  resolve: Resolver = systemResolver,
  currentIp: () => Promise<string | null> = freshPublicIp,
): NetbirdExit {
  const exitName = `${ctx.config.brand} ${EXIT_SUFFIX}`;
  const description = `Angelegt von ${ctx.config.brand}: Internet über diesen Rechner`;
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

  /**
   * Only the machine the panel runs on goes out through the exit: found by its name (the brand as machine name,
   * "mornihosting" or "moinmorni") – also when the machine chosen for the addresses is another one (e.g. the Proxmox
   * host routing into the LAN). The host itself must never be in this group, or it loses its internet whenever the
   * exit is down.
   */
  const panelPeerOf = (peers: readonly NetbirdPeer[], cfg: NetbirdConfig, exitPeerId: string): string =>
    peers.find(
      (p) => p.id !== exitPeerId && `${p.name} ${p.hostname}`.toLowerCase().includes(ctx.config.machineHint),
    )?.id ?? cfg.peerId;

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
      sharedWith: null,
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
        sharedWith: exit.sharedWith ?? null,
        checkedAt: state.checkedAt,
      };
    } catch (err) {
      return {
        ...empty,
        enabled: exit !== null,
        exitPeerId: exit?.exitPeerId ?? null,
        sharedWith: exit?.sharedWith ?? null,
        error: failureOf(err),
      };
    }
  };

  const remove = async (): Promise<void> => {
    const cfg = netbird();
    const exit = stored();
    if (cfg && exit) {
      const client = clientOf(cfg);
      const route = (await client.routes()).find((r) => r.id === exit.routeId);
      const rest = (route?.groups ?? []).filter((g) => g !== exit.groupId);
      // Only this panel's group goes: a route another panel still uses stays for it.
      if (route && rest.length) await client.setRouteGroups(route, rest);
      else if (route) await client.deleteRoute(route.id);
      await client.deleteGroup(exit.groupId);
    }
    ctx.settings.deleteValue(EXIT_KEY);
  };

  /** Where the panel's group goes: its own route, or (NetBird allows one per exit machine) the one already there. */
  const placeRoute = async (
    client: NetbirdClient,
    exitPeerId: string,
    groupId: string,
    previous: StoredExit | null,
    others: (route: NetbirdRoute) => string[],
  ): Promise<{ readonly route: NetbirdRoute; readonly sharedWith: string | null }> => {
    const routes = await client.routes();
    const request = { name: exitName, peerId: exitPeerId, groupId, description };
    const sharing = previous?.sharedWith ? routes.find((r) => r.id === previous.routeId) : undefined;
    if (sharing?.peer === exitPeerId)
      return {
        route: await client.setRouteGroups(sharing, [...others(sharing), groupId]),
        sharedWith: sharing.network_id,
      };
    // Another exit machine now: out of the route shared so far.
    if (sharing) await client.setRouteGroups(sharing, others(sharing));
    const own =
      (previous?.sharedWith ? undefined : routes.find((r) => r.id === previous?.routeId)) ??
      routes.find((r) => r.network_id === exitName);
    if (own) {
      const theirs = others(own);
      if (own.peer === exitPeerId || theirs.length === 0)
        return {
          route: await client.updateRoute(own.id, { ...request, extraGroups: theirs }),
          sharedWith: null,
        };
      // Others leave through this route over the old exit machine: it stays theirs, this panel makes a new one.
      await client.setRouteGroups(own, theirs);
    }
    try {
      return { route: await client.createRoute(request), sharedWith: null };
    } catch (err) {
      const shared = routes.find(
        (r) => r.network === EVERYTHING_V4 && r.peer === exitPeerId && r.id !== own?.id,
      );
      if (!alreadyRouted(err) || !shared) throw err;
      ctx.log.info({ route: shared.network_id }, 'NetBird allows one exit route per machine: sharing it');
      return {
        route: await client.setRouteGroups(shared, [...others(shared), groupId]),
        sharedWith: shared.network_id,
      };
    }
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
      groups.find((g) => g.id === previous?.groupId) ?? groups.find((g) => g.name === exitName);
    const members = [panelPeerOf(peers, cfg, exitPeerId)];
    const group = existingGroup
      ? await client.updateGroup(existingGroup.id, exitName, members)
      : await client.createGroup(exitName, members);
    const known = new Set([...groups.map((g) => g.id), group.id]);
    const ours = new Set([group.id, previous?.groupId]);
    /** Groups of others in a route (e.g. another panel's): they stay, as long as NetBird still knows them. */
    const others = (route: NetbirdRoute): string[] =>
      (route.groups ?? []).filter((g) => !ours.has(g) && known.has(g));
    const placed = await placeRoute(client, exitPeerId, group.id, previous, others);
    ctx.settings.setValue(EXIT_KEY, {
      exitPeerId,
      routeId: placed.route.id,
      groupId: group.id,
      homeIpSealed: previous?.homeIpSealed ?? (homeIp ? ctx.secrets.encrypt(homeIp) : null),
      sharedWith: placed.sharedWith,
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
