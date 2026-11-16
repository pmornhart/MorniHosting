import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  clientPort,
  PORT_BEDROCK,
  ROUTER_PUBLIC_PORTS,
  SOFTWARE,
  toNetbirdName,
  type NetbirdBehindProxy,
  type NetbirdConfigInput,
  type NetbirdDiscovery,
  type NetbirdPurpose,
  type NetbirdServerInfo,
  type NetbirdServiceInfo,
  type NetbirdStatus,
  type RouterForwardProblem,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { netbirdServices, networkMembers, networks, servers as serverTable } from '../db/schema.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { createKeyedLock } from '../lib/locks.js';
import { GEYSER_PURPOSE, VOICE_PURPOSE, type ServerService, type TunnelAddress } from '../servers/service.js';
import type { ServerRow } from '../servers/spec.js';
import type { RouterKind } from '../gateway/router.js';
import { singleIpv4 } from '../lib/net-guard.js';
import {
  createNetbirdClient,
  type NetbirdClient,
  type NetbirdClientFactory,
  type NetbirdServiceRequest,
  type NetbirdServiceTarget,
} from './client.js';

/**
 * NetBird automation: with an API token, a domain and the machine MorniHosting runs on, the panel keeps
 * one reverse-proxy service per address in the admin's NetBird account. A server only needs a name;
 * "survival" becomes survival.<domain> (plus survival-bedrock and survival-voice when those are on).
 * NetBird Cloud assigns the outside ports; the panel stores them so every page shows the full address.
 * A self-hosted proxy that allows its own ports gets the server's port instead (survival.<domain>:25565),
 * so the admin opens one fixed range on the proxy once instead of a random port per server.
 *
 * One server can sit on the domain itself (players type only "moinmorni.net"). NetBird allows one service per name and the
 * website already has the domain, so its services keep their own names – but they ask for the ports games use when
 * none is typed (25565, 19132): NetBird's proxy forwards TCP and UDP by port, whatever name was typed. A port that
 * another service holds (e.g. another panel in the same NetBird account) is not taken away: the server gets the next
 * free one and its page says who has the wanted one; every few minutes the panel tries again.
 */

const SETTINGS_KEY = 'netbird';
const RESOURCES_KEY = 'netbird_resources';
/** How often a service may move on to another outside port, and how far it looks. */
const PORT_RETRIES = 5;
const PORT_SEARCH = 50;
/** A server that goes on the domain without a name gets one from its own name, numbered when taken. */
const NAME_ROOM = 36;
const NAME_TRIES = 50;
/** The first taken name gets "-2" ("reich-2"): the bare name counts as the first. */
const FIRST_NUMBER = 2;
// NetBird's refusal for a taken outside port, e.g. "tcp port 25565 is already in use by service abc on cluster
// netbird.example.org" → 25565; "domain already in use" does not match.
// https://regex101.com/?flavor=javascript&regex=port%20(%5Cd%2B)%20is%20already%20in%20use&flags=i&testString=tcp%20port%2025565%20is%20already%20in%20use%20by%20service%20abc%20on%20cluster%20netbird.example.org%0Adomain%20already%20in%20use
const PORT_IN_USE = /port (\d+) is already in use/i;
const portTaken = (err: unknown): number | null => {
  if (!(err instanceof AppError)) return null;
  const match = PORT_IN_USE.exec(String(err.params.message ?? ''));
  return match ? Number(match[1]) : null;
};

const PANEL_KEY = 'panel';
const NETWORK_LOCK = 'network';
const ROUTER_LOCK = 'router';
const isRouterPurpose = (purpose: string): boolean => purpose.startsWith('router-');
const SUFFIX: Readonly<Record<NetbirdPurpose, string>> = {
  main: '',
  geyser: '-bedrock',
  // Its own name so NetBird does not see two services for one domain; players only use the "-bedrock" one, both
  // point at the same proxy address and the same port.
  'geyser-signal': '-bedrock-tcp',
  voice: '-voice',
  panel: '',
  'panel-www': '',
  'router-java': '',
  'router-bedrock': '',
};
/** The router's own NetBird names (players never type them: any name on the router's port reaches it). */
const ROUTER_NAMES: Readonly<Record<RouterKind, string>> = {
  java: 'mh-router-java',
  bedrock: 'mh-router-bedrock',
};
const ROUTER_PURPOSE: Readonly<Record<RouterKind, NetbirdPurpose>> = {
  java: 'router-java',
  bedrock: 'router-bedrock',
};
const ROUTER_KINDS: readonly RouterKind[] = ['java', 'bedrock'];
/** A panel on the domain itself gets this name in front too ("www.moinmorni.net"). */
const WWW_PREFIX = 'www.';

interface StoredConfig {
  readonly apiUrl: string;
  /** Sealed with the panel secret. */
  readonly token: string;
  readonly domain: string;
  readonly peerId: string;
  readonly peerName: string;
  /** The domain's proxy listens on the ports the panel asks for; unknown for setups saved before. */
  readonly customPorts?: boolean;
  /** NetBird network "MorniHosting" and its group, found or made once. */
  readonly networkId?: string;
  readonly groupId?: string;
  /** Set once all services point at network resources (older setups pointed at the machine itself). */
  readonly resourceMode?: boolean;
  /** The server on the domain itself (players type only the domain); null or missing = none. */
  readonly domainServerId?: string | null;
}

/** One network resource per server (key: server id) and one for the panel (key: "panel"). */
interface StoredResource {
  readonly id: string;
  readonly name: string;
  readonly address: string;
}

interface Wanted {
  readonly purpose: NetbirdPurpose;
  readonly domain: string;
  readonly mode: 'http' | 'tcp' | 'udp';
  readonly port: number;
  /** The outside port this service must get (the TCP half of Geyser uses the same one as the UDP half). */
  readonly listenPort?: number | null;
  /** Outside ports it must not take (the router's 25565 and 19132). */
  readonly avoid?: readonly number[];
  /** Must get the same outside number as this one: the other protocol of one port (Geyser, a proxy's voice chat). */
  readonly pair?: NetbirdPurpose;
  /** The outside port players expect without typing one (server on the domain); a note when it cannot be had. */
  readonly wish?: number;
}

/** A wanted outside port that another service holds. */
type PortNote = Pick<NetbirdServiceInfo, 'wanted' | 'heldBy'>;

type Mapping = typeof netbirdServices.$inferSelect;

/** Where NetBird sends an outside TCP port, or why that is not known (see `portTarget`). */
export type PortTarget =
  | { readonly found: true; readonly host: string; readonly port: number; readonly service: string }
  | {
      readonly found: false;
      readonly problem: Extract<
        RouterForwardProblem,
        'no_netbird' | 'no_service' | 'own_service' | 'service_off' | 'no_target' | 'no_address'
      >;
      readonly service: string | null;
    };

export interface NetbirdAutomation {
  readonly status: () => NetbirdStatus;
  readonly discover: (input: { apiUrl?: string; token?: string }) => Promise<NetbirdDiscovery>;
  readonly configure: (input: NetbirdConfigInput, actor: Actor) => Promise<NetbirdStatus>;
  readonly disconnect: (actor: Actor) => Promise<NetbirdStatus>;
  readonly setServerName: (
    serverId: string,
    name: string | null,
    actor: Actor,
  ) => Promise<NetbirdServerInfo | null>;
  readonly setupPanel: (input: { name: string; port: number }, actor: Actor) => Promise<NetbirdStatus>;
  /** Puts a server on the domain itself (null: none); a server without a name gets one from its own name. */
  readonly setDomainServer: (serverId: string | null, actor: Actor) => Promise<NetbirdStatus>;
  /**
   * Self-repair (at start and every few minutes): the panel's machine was connected again and got a new id in
   * NetBird → take it over and move everything to it; resources of deleted servers are removed.
   * Returns what was repaired (for the alert), or null when all was fine.
   */
  readonly heal: () => Promise<{
    readonly peerMoved: string | null;
    /** Leftovers that are really gone now. */
    readonly removed: readonly string[];
    /** Leftovers NetBird refused to delete, with its answer. */
    readonly stuck: readonly { readonly name: string; readonly reason: string }[];
  } | null>;
  /**
   * Where NetBird sends an outside TCP port of another product in the same account (e.g. MoinMorni's Java port 25567):
   * the IP address and port of the service's target – a machine's NetBird IP or a network resource's address. Never one
   * of this panel's own services (its router would only send players back to itself). For the address router.
   */
  readonly portTarget: (listenPort: number) => Promise<PortTarget>;
}

export function createNetbirdAutomation(
  ctx: AppContext,
  servers: ServerService,
  clientFactory: NetbirdClientFactory = createNetbirdClient,
): NetbirdAutomation {
  const lock = createKeyedLock();
  const brand = ctx.config.brand;
  /** Network, group and resources the panel makes are called "<brand> …". */
  const resourceName = (name: string): string => `${brand} ${name}`;
  const panelResource = resourceName('Panel');
  /** Last failed sync per server, as an error code for its pages. */
  const failures = new Map<string, NonNullable<NetbirdServerInfo['error']>>();
  /** Outside ports a server wanted but did not get (per server and purpose), for its page and to try again. */
  const portNotes = new Map<string, ReadonlyMap<NetbirdPurpose, PortNote>>();

  const config = (): StoredConfig | null => ctx.settings.getValue<StoredConfig>(SETTINGS_KEY) ?? null;
  const clientFor = (cfg: StoredConfig): NetbirdClient =>
    clientFactory(cfg.apiUrl, ctx.secrets.decrypt(cfg.token));
  const requireConfig = (): StoredConfig => {
    const cfg = config();
    if (!cfg) throw badRequest('netbird_not_configured');
    return cfg;
  };

  /** Router kinds this setup gets: only where the proxy takes fixed ports (self-hosted NetBird) and the port is on. */
  const routerKinds = (cfg: StoredConfig): RouterKind[] =>
    cfg.customPorts === true ? ROUTER_KINDS.filter((kind) => ctx.config.routerPorts[kind] > 0) : [];
  const routerMapping = (kind: RouterKind): Mapping | undefined =>
    mappings(null).find((m) => m.purpose === ROUTER_PURPOSE[kind]);
  /** Which router ports really are in NetBird (on 25565 / 19132). */
  const routerLive = (): { java: boolean; bedrock: boolean } => ({
    java: routerMapping('java')?.listenPort === ROUTER_PUBLIC_PORTS.java,
    bedrock: routerMapping('bedrock')?.listenPort === ROUTER_PUBLIC_PORTS.bedrock,
  });
  const panelMapping = (): Mapping | undefined => mappings(null).find((m) => m.purpose === 'panel');
  const wwwMapping = (): Mapping | undefined => mappings(null).find((m) => m.purpose === 'panel-www');

  const saveConfig = (patch: Partial<StoredConfig>): void => {
    const cfg = config();
    if (cfg) ctx.settings.setValue(SETTINGS_KEY, { ...cfg, ...patch });
  };
  const storedResources = (): Record<string, StoredResource> =>
    ctx.settings.getValue<Record<string, StoredResource>>(RESOURCES_KEY) ?? {};
  const saveResource = (key: string, resource: StoredResource | null): void => {
    const rest = Object.fromEntries(Object.entries(storedResources()).filter(([k]) => k !== key));
    ctx.settings.setValue(RESOURCES_KEY, resource ? { ...rest, [key]: resource } : rest);
  };
  /** The machine's address in the home network; without it services go straight to the machine (peer). */
  const lanAddress = (): string | null => ctx.settings.get().lanIp.trim() || null;

  /** The network "<brand>" with this machine as routing peer, and the group for its resources. */
  // One at a time: after an update all servers move at once and would otherwise each create the network.
  const ensureNetwork = (
    client: NetbirdClient,
    cfg: StoredConfig,
  ): Promise<{ networkId: string; groupId: string }> =>
    lock(NETWORK_LOCK, () => ensureNetworkNow(client, config() ?? cfg));
  const ensureNetworkNow = async (
    client: NetbirdClient,
    cfg: StoredConfig,
  ): Promise<{ networkId: string; groupId: string }> => {
    const networks = await client.networks();
    const network =
      networks.find((n) => n.id === cfg.networkId) ??
      networks.find((n) => n.name === brand) ??
      (await client.createNetwork(brand, `Game-Server von ${brand}`));
    const groups = await client.groups();
    const group =
      groups.find((g) => g.id === cfg.groupId) ??
      groups.find((g) => g.name === brand) ??
      (await client.createGroup(brand));
    const routers = await client.routers(network.id);
    if (!routers.some((r) => r.peer === cfg.peerId)) await client.createRouter(network.id, cfg.peerId);
    if (cfg.networkId !== network.id || cfg.groupId !== group.id)
      saveConfig({ networkId: network.id, groupId: group.id });
    return { networkId: network.id, groupId: group.id };
  };

  /** Creates or updates the network resource for one server (or the panel); null without a home address. */
  const ensureResource = async (
    client: NetbirdClient,
    cfg: StoredConfig,
    key: string,
    name: string,
  ): Promise<{ resource: StoredResource; changed: boolean } | null> => {
    const address = lanAddress();
    if (!address) return null;
    const known = storedResources()[key];
    // Always ask NetBird: a resource (or the whole network) deleted there must be created again,
    // otherwise services point at an id NetBird no longer knows ("resource target … not found").
    const { networkId, groupId } = await ensureNetwork(client, cfg);
    const present = await client.resources(networkId);
    const existing = present.find((r) => r.id === known?.id) ?? present.find((r) => r.name === name);
    if (known && existing?.id === known.id && known.address === address && known.name === name)
      return { resource: known, changed: false };
    const request = { name, address, groupId, description: `Angelegt von ${brand}` };
    const result = existing
      ? await client.updateResource(networkId, existing.id, request)
      : await client.createResource(networkId, request);
    const saved: StoredResource = { id: result.id, name, address };
    saveResource(key, saved);
    // A new or moved resource: the services must point at it, even if nothing else changed.
    return { resource: saved, changed: true };
  };
  const dropResource = async (client: NetbirdClient, cfg: StoredConfig, key: string): Promise<void> => {
    const known = storedResources()[key];
    if (!known) return;
    if (cfg.networkId) await client.deleteResource(cfg.networkId, known.id);
    saveResource(key, null);
  };

  const mappings = (serverId: string | null): Mapping[] =>
    ctx.db
      .select()
      .from(netbirdServices)
      .where(serverId === null ? isNull(netbirdServices.serverId) : eq(netbirdServices.serverId, serverId))
      .all();
  const serverRow = (serverId: string): ServerRow | undefined =>
    ctx.db.select().from(serverTable).where(eq(serverTable.id, serverId)).get();

  /** Is this the server on the domain itself? */
  const isDomainServer = (row: ServerRow, cfg: StoredConfig): boolean => cfg.domainServerId === row.id;

  const wanted = (row: ServerRow, cfg: StoredConfig): Wanted[] => {
    if (!row.netbirdName) return [];
    const host = (purpose: NetbirdPurpose): string => `${row.netbirdName}${SUFFIX[purpose]}.${cfg.domain}`;
    const hostPort = (purpose: string): number | undefined =>
      row.extraPorts.find((p) => p.purpose === purpose)?.port;
    const geyserPort = row.geyser ? hostPort(GEYSER_PURPOSE) : undefined;
    // A proxy's voice chat rides on the proxy's own port (UDP next to TCP); other servers have a port of their own.
    const proxyVoice = row.voiceChat && SOFTWARE[row.software].proxy;
    const ownVoicePort = proxyVoice ? row.port : hostPort(VOICE_PURPOSE);
    const voicePort = row.voiceChat ? ownVoicePort : undefined;
    const routed = routerKinds(cfg);
    // With the router, 25565/19132 (TCP) belong to it; a server's own address moves to another port.
    const avoid: number[] = routed.map((kind) => ROUTER_PUBLIC_PORTS[kind]);
    // On the domain itself: the ports games use without one typed – unless the router has them (it then sends the
    // domain to this server).
    const direct = isDomainServer(row, cfg) && cfg.customPorts === true;
    const wishFor = (port: number): number | undefined =>
      direct && !avoid.includes(port) ? port : undefined;
    const mainWish = wishFor(clientPort(row.software));
    const geyserWish = wishFor(PORT_BEDROCK);
    return [
      {
        purpose: 'main',
        domain: host('main'),
        mode: SOFTWARE[row.software].protocol,
        port: row.port,
        avoid,
        listenPort: mainWish,
        wish: mainWish,
      },
      ...(geyserPort
        ? ([
            // Its own outside port, never the router's 19132: the TCP half below needs the same number.
            {
              purpose: 'geyser',
              domain: host('geyser'),
              mode: 'udp',
              port: geyserPort,
              avoid,
              listenPort: geyserWish,
              wish: geyserWish,
            },
            // Always the server's own TCP signaling too: players can always join with this port, router or not.
            {
              purpose: 'geyser-signal',
              domain: host('geyser-signal'),
              mode: 'tcp',
              port: geyserPort,
              pair: 'geyser',
            },
          ] as const)
        : []),
      ...(voicePort
        ? [
            {
              purpose: 'voice',
              domain: host('voice'),
              mode: 'udp',
              port: voicePort,
              pair: proxyVoice ? 'main' : undefined,
            } as const,
          ]
        : []),
    ];
  };

  /** Our domain or a name under it. */
  const underDomain = (cfg: StoredConfig, domain: string): boolean =>
    domain === cfg.domain || domain.endsWith(`.${cfg.domain}`);
  const knownIds = (): Set<string> =>
    new Set(
      ctx.db
        .select({ id: netbirdServices.id })
        .from(netbirdServices)
        .all()
        .map((m) => m.id),
    );

  /**
   * Outside ports chosen before NetBird is asked (self-hosted proxy with fixed ports; NetBird Cloud hands them out
   * itself). Two halves of one port – Geyser's UDP game and TCP signaling, a proxy's TCP and its voice UDP – get the
   * first number from the wanted one on that is free for both protocols. A wished-for port (server on the domain) that
   * another service holds: the service keeps the port it has, so nothing is changed in vain.
   */
  const placePorts = async (
    client: NetbirdClient,
    cfg: StoredConfig,
    wants: readonly Wanted[],
    existing: readonly Mapping[],
  ): Promise<Wanted[]> => {
    const seconds = wants.filter((w) => w.pair && wants.some((o) => o.purpose === w.pair));
    const wishes = wants.some((w) => w.wish !== undefined);
    if (cfg.customPorts !== true || (seconds.length === 0 && !wishes)) return [...wants];
    const all = await client.services();
    const known = knownIds();
    const own = new Set(existing.map((m) => m.id));
    // Left-overs of the panel itself (its domain, not in its list) do not count: they go when the port is taken.
    const holds = (mode: string, port: number): boolean =>
      all.some(
        (svc) =>
          svc.listen_port === port &&
          svc.mode === mode &&
          !own.has(svc.id) &&
          (known.has(svc.id) || !underDomain(cfg, svc.domain)),
      );
    const paired: [NetbirdPurpose, number][] = seconds.flatMap((second) => {
      const first = wants.find((w) => w.purpose === second.pair);
      if (!first) return [];
      const start = first.listenPort ?? first.port;
      const avoid = new Set([...(first.avoid ?? []), ...(second.avoid ?? [])]);
      const port = Array.from({ length: PORT_SEARCH }, (_, i) => start + i).find(
        (p) => !avoid.has(p) && !holds(first.mode, p) && !holds(second.mode, p),
      );
      return port === undefined
        ? []
        : [
            [first.purpose, port],
            [second.purpose, port],
          ];
    });
    const chosen = new Map(paired);
    const kept: [NetbirdPurpose, number][] = wants.flatMap((w) => {
      const current = existing.find((m) => m.purpose === w.purpose)?.listenPort;
      const stays = w.wish !== undefined && !chosen.has(w.purpose) && holds(w.mode, w.wish);
      return stays && current && !holds(w.mode, current) ? [[w.purpose, current]] : [];
    });
    kept.forEach(([purpose, port]) => chosen.set(purpose, port));
    return wants.map((w) => {
      const port = chosen.get(w.purpose);
      return port === undefined ? w : { ...w, listenPort: port };
    });
  };

  /** Ports the server on the domain wanted but did not get, with who has them now. */
  const notePorts = async (
    client: NetbirdClient,
    serverId: string,
    wants: readonly Wanted[],
    done: readonly Mapping[],
  ): Promise<void> => {
    const missed = wants.filter(
      (w) => w.wish !== undefined && done.find((m) => m.purpose === w.purpose)?.listenPort !== w.wish,
    );
    if (missed.length === 0) {
      portNotes.delete(serverId);
      return;
    }
    const all = await client.services().catch(() => []);
    const mine = new Set(done.map((m) => m.id));
    // A pair moves together: the holder may have the port in the other half's protocol.
    const modesOf = (w: Wanted): string[] => [
      w.mode,
      ...wants.filter((o) => o.pair === w.purpose || o.purpose === w.pair).map((o) => o.mode),
    ];
    portNotes.set(
      serverId,
      new Map(
        missed.map((w) => [
          w.purpose,
          {
            wanted: w.wish ?? null,
            heldBy:
              all.find(
                (svc) => svc.listen_port === w.wish && modesOf(w).includes(svc.mode) && !mine.has(svc.id),
              )?.domain ?? null,
          },
        ]),
      ),
    );
  };

  const remember = (
    serverId: string | null,
    want: Wanted,
    id: string,
    listenPort: number | null,
  ): Mapping => {
    const values = {
      id,
      serverId,
      purpose: want.purpose,
      domain: want.domain,
      mode: want.mode,
      targetPort: want.port,
      listenPort,
    };
    ctx.db
      .insert(netbirdServices)
      .values(values)
      .onConflictDoUpdate({ target: netbirdServices.id, set: values })
      .run();
    return { ...values, createdAt: new Date().toISOString() };
  };
  const forget = (id: string): void => {
    ctx.db.delete(netbirdServices).where(eq(netbirdServices.id, id)).run();
  };

  /**
   * NetBird refuses an outside port that another service already has ("tcp port 25565 is already in use by service
   * … on cluster …"). Left-overs of the panel itself (its domain, but no longer in its list – e.g. after the machine
   * was removed and added to NetBird again) are deleted and the port is used after all; a port that belongs to
   * someone else makes the service keep the port it has (when that one is fine) or take the next free one.
   */
  const withFreeListenPort = async <TResult>(
    client: NetbirdClient,
    cfg: StoredConfig,
    wanted: number | null,
    want: Pick<Wanted, 'domain' | 'mode' | 'avoid'>,
    current: Mapping | undefined,
    attempt: (listenPort: number | null) => Promise<TResult>,
  ): Promise<TResult> => {
    const tryPort = async (listenPort: number | null, left: number): Promise<TResult> => {
      try {
        return await attempt(listenPort);
      } catch (err) {
        const taken = portTaken(err);
        if (taken === null || left <= 0) throw err;
        const all = await client.services();
        const known = knownIds();
        const leftover = all.find(
          (svc) =>
            svc.listen_port === taken &&
            svc.domain !== want.domain &&
            !known.has(svc.id) &&
            underDomain(cfg, svc.domain),
        );
        if (leftover) {
          ctx.log.info(
            { service: leftover.domain, port: taken },
            'removing a left-over NetBird service of the panel',
          );
          await client.deleteService(leftover.id);
          return tryPort(listenPort, left - 1);
        }
        // NetBird keeps one service per port and protocol; the service's own port does not count as taken.
        const used = new Set([
          ...all
            .filter((svc) => svc.mode === want.mode && svc.id !== current?.id)
            .map((svc) => svc.listen_port),
          ...(want.avoid ?? []),
        ]);
        const own = current?.listenPort ?? null;
        const next =
          own !== null && own !== taken && !used.has(own)
            ? own
            : Array.from({ length: PORT_SEARCH }, (_, i) => taken + 1 + i).find((p) => !used.has(p));
        if (next === undefined) throw err;
        return tryPort(next, left - 1);
      }
    };
    return tryPort(wanted, PORT_RETRIES);
  };

  /** Creates, changes or keeps one service so that it matches what the server needs. */
  const apply = async (
    client: NetbirdClient,
    cfg: StoredConfig,
    serverId: string | null,
    want: Wanted,
    existing: Mapping | undefined,
    force: boolean,
    resource: StoredResource | null,
  ): Promise<Mapping> => {
    const request = {
      domain: want.domain,
      mode: want.mode,
      peerId: cfg.peerId,
      resourceId: resource?.id ?? null,
      resourceAddress: resource?.address ?? null,
      port: want.port,
      passHostHeader: want.mode === 'http',
    };
    // Fixed ports: the same port outside as on the server. Otherwise NetBird's port stays once assigned.
    const asked = want.listenPort ?? (cfg.customPorts && want.mode !== 'http' ? want.port : null);
    const avoided = (port: number | null | undefined): boolean =>
      port !== null && port !== undefined && (want.avoid ?? []).includes(port);
    // A port the router needs: keep the service's current one if that is fine, else start looking one higher.
    const oneHigher = (asked ?? 0) + 1;
    const instead = avoided(existing?.listenPort) ? oneHigher : (existing?.listenPort ?? oneHigher);
    const fixedPort = avoided(asked) ? instead : asked;
    const same =
      existing?.domain === want.domain &&
      existing.targetPort === want.port &&
      (fixedPort === null || existing.listenPort === fixedPort);
    if (existing && existing.mode === want.mode && same && !force) return existing;
    // Deleted in NetBird (by hand there): made again below, on the outside port it had, so addresses stay.
    let gonePort: number | null = null;
    if (existing && existing.mode === want.mode) {
      const updated = await withFreeListenPort(
        client,
        cfg,
        fixedPort ?? existing.listenPort,
        want,
        existing,
        (listenPort) => client.updateService(existing.id, { ...request, listenPort }),
      );
      if (updated)
        return remember(serverId, want, existing.id, updated.listen_port ?? fixedPort ?? existing.listenPort);
      ctx.log.info({ service: want.domain }, 'NetBird service was deleted there, making it again');
      // NetBird Cloud hands out ports itself and refuses a chosen one.
      gonePort = cfg.customPorts ? existing.listenPort : null;
      forget(existing.id);
    } else if (existing) {
      await client.deleteService(existing.id);
      forget(existing.id);
    }
    const created = await withFreeListenPort(
      client,
      cfg,
      fixedPort ?? gonePort,
      want,
      undefined,
      (listenPort) => client.createService({ ...request, listenPort }),
    );
    return remember(serverId, want, created.id, created.listen_port ?? fixedPort ?? gonePort);
  };

  /** Setups saved before the panel knew about fixed ports learn it once from NetBird. */
  const withPortMode = async (cfg: StoredConfig | null): Promise<StoredConfig | null> => {
    if (!cfg || cfg.customPorts !== undefined) return cfg;
    const domains = await clientFor(cfg).domains();
    const known: StoredConfig = {
      ...cfg,
      customPorts: domains.find((d) => d.domain.toLowerCase() === cfg.domain)?.supports_custom_ports ?? false,
    };
    ctx.settings.setValue(SETTINGS_KEY, known);
    return known;
  };

  const addressOf = (row: ServerRow, cfg: StoredConfig, done: readonly Mapping[]): TunnelAddress => {
    const port = (purpose: NetbirdPurpose): number | null =>
      done.find((m) => m.purpose === purpose)?.listenPort ?? null;
    const main = done.find((m) => m.purpose === 'main');
    // Through the router Java players use the name alone (port 25565).
    const viaRouter = row.edition === 'java' && routerLive().java;
    return main
      ? {
          // The server on the domain: players type the domain itself, the port decides where they land.
          domain: isDomainServer(row, cfg) ? cfg.domain : main.domain,
          publicPort: viaRouter ? ROUTER_PUBLIC_PORTS.java : main.listenPort,
          geyserPublicPort: port('geyser'),
          voicePublicPort: port('voice'),
        }
      : {};
  };

  /** Brings NetBird in line with one server; a deleted server loses all its services. */
  const syncNow = async (serverId: string, force = false): Promise<void> => {
    const cfg = await withPortMode(config());
    const existing = mappings(serverId);
    if (!cfg) return;
    const row = serverRow(serverId);
    const client = clientFor(cfg);
    const wants = row ? await placePorts(client, cfg, wanted(row, cfg), existing) : [];
    const ensured =
      row?.netbirdName && wants.length
        ? await ensureResource(client, cfg, serverId, resourceName(row.netbirdName))
        : null;
    const resource = ensured?.resource ?? null;
    const stale = existing.filter((m) => !wants.some((w) => w.purpose === m.purpose));
    await Promise.all(
      stale.map(async (m) => {
        await client.deleteService(m.id);
        forget(m.id);
      }),
    );
    const done = await Promise.all(
      wants.map((w) =>
        apply(
          client,
          cfg,
          serverId,
          w,
          existing.find((m) => m.purpose === w.purpose),
          force || (ensured?.changed ?? false),
          resource,
        ),
      ),
    );
    if (!wants.length) await dropResource(client, cfg, serverId);
    await notePorts(client, serverId, wants, done);
    if (row) servers.setTunnelAddress(serverId, addressOf(row, cfg, done));
    failures.delete(serverId);
  };

  const sync = async (serverId: string, force = false): Promise<void> => {
    try {
      await lock(serverId, () => syncNow(serverId, force));
    } catch (err) {
      failures.set(
        serverId,
        err instanceof AppError
          ? { code: err.code, params: err.params }
          : { code: 'netbird_failed', params: {} },
      );
      throw err;
    }
  };
  const syncQuietly = async (serverId: string, force = false): Promise<void> => {
    try {
      await sync(serverId, force);
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'NetBird sync failed');
    }
  };

  const namedServers = (): ServerRow[] =>
    ctx.db
      .select()
      .from(serverTable)
      .all()
      .filter((r) => r.netbirdName !== null);

  /** Outside ports of all server addresses, e.g. for opening them on a self-hosted proxy. */
  const openPorts = (): NetbirdStatus['openPorts'] =>
    ctx.db
      .select()
      .from(netbirdServices)
      .all()
      .filter((m) => m.listenPort !== null && m.mode !== 'http')
      .map((m) => ({
        port: m.listenPort ?? 0,
        protocol: m.mode === 'udp' ? ('udp' as const) : ('tcp' as const),
        domain: m.domain,
      }))
      .sort((a, b) => a.port - b.port);

  /**
   * The router's two services (TCP 25565 → the panel's Java router, TCP 19132 → its Bedrock router). Run after the
   * servers: they move their own addresses off these ports first.
   */
  const syncRouterNow = async (force: boolean): Promise<void> => {
    const cfg = config();
    if (!cfg) return;
    const client = clientFor(cfg);
    const kinds = routerKinds(cfg);
    const resource = kinds.length
      ? ((await ensureResource(client, cfg, PANEL_KEY, panelResource))?.resource ?? null)
      : null;
    await Promise.all(
      ROUTER_KINDS.map(async (kind) => {
        const existing = routerMapping(kind);
        if (!kinds.includes(kind)) {
          if (existing) {
            await client.deleteService(existing.id);
            forget(existing.id);
          }
          return;
        }
        const want: Wanted = {
          purpose: ROUTER_PURPOSE[kind],
          domain: `${ROUTER_NAMES[kind]}.${cfg.domain}`,
          mode: 'tcp',
          port: ctx.config.routerPorts[kind],
          listenPort: ROUTER_PUBLIC_PORTS[kind],
        };
        const done = await apply(client, cfg, null, want, existing, force, resource);
        // Someone else holds the port: a router on another port helps nobody.
        if (done.listenPort !== ROUTER_PUBLIC_PORTS[kind]) {
          ctx.log.warn({ kind, port: ROUTER_PUBLIC_PORTS[kind] }, 'router port taken in NetBird');
          await client.deleteService(done.id);
          forget(done.id);
        }
      }),
    );
    // Addresses follow: through the router Java players use the name alone.
    namedServers().forEach((r) => {
      const done = mappings(r.id);
      if (done.length) servers.setTunnelAddress(r.id, addressOf(r, cfg, done));
    });
  };
  const syncRouter = async (force = false): Promise<void> => {
    try {
      await lock(ROUTER_LOCK, () => syncRouterNow(force));
    } catch (err) {
      ctx.log.warn({ err }, 'NetBird router sync failed');
    }
  };

  /** A name for a server that has none yet: from its own name, with a number when another server has it. */
  const freeName = (row: ServerRow): string => {
    // Room for "-2" … behind it within the 40 characters of a name.
    const base = toNetbirdName(toNetbirdName(row.name).slice(0, NAME_ROOM));
    const taken = new Set(namedServers().map((r) => r.netbirdName));
    const candidates = [base, ...Array.from({ length: NAME_TRIES }, (_, i) => `${base}-${i + FIRST_NUMBER}`)];
    return candidates.find((n) => !taken.has(n)) ?? row.id;
  };

  /**
   * Servers behind a network's proxy (lobby, game modes): no ports of their own outside and no direct logins, so
   * players who reach them on the domain would not get in. Their proxy goes on the domain instead.
   */
  const behindProxy = (): NetbirdBehindProxy[] =>
    ctx.db
      .select({ serverId: networkMembers.serverId, proxyId: networks.proxyServerId })
      .from(networkMembers)
      .innerJoin(networks, eq(networkMembers.networkId, networks.id))
      .all()
      .flatMap(({ serverId, proxyId }) => {
        const row = serverRow(serverId);
        const proxy = serverRow(proxyId);
        return row && proxy ? [{ id: row.id, name: row.name, proxyId: proxy.id, proxyName: proxy.name }] : [];
      });

  const domainServerOf = (cfg: StoredConfig | null): NetbirdStatus['domainServer'] => {
    const row = cfg?.domainServerId ? serverRow(cfg.domainServerId) : undefined;
    return row ? { id: row.id, name: row.name } : null;
  };

  /**
   * www.<domain> next to a panel (or website) on the domain itself: the same target with "Pass Host Header" – the panel
   * answers it with a redirect to the domain. It follows the panel's address and goes when that leaves the domain.
   */
  const syncWww = async (
    client: NetbirdClient,
    cfg: StoredConfig,
    panel: Wanted,
    request: NetbirdServiceRequest,
  ): Promise<void> => {
    const current = wwwMapping();
    if (panel.domain !== cfg.domain) {
      if (current) {
        await client.deleteService(current.id);
        forget(current.id);
      }
      return;
    }
    const want: Wanted = {
      purpose: 'panel-www',
      domain: `${WWW_PREFIX}${cfg.domain}`,
      mode: 'http',
      port: panel.port,
    };
    const named = (await client.services()).find((svc) => svc.domain === want.domain);
    // A server called "www" has the name already: it keeps it.
    if (named && named.id !== current?.id && knownIds().has(named.id)) {
      ctx.log.warn({ domain: want.domain }, 'www name belongs to a server, the panel gets no www address');
      return;
    }
    const body = { ...request, domain: want.domain };
    // Kept, taken over (made by hand in NetBird) or made new (also when it was deleted there).
    const existing = named?.id ?? current?.id;
    const updated = existing ? await client.updateService(existing, body) : null;
    const result = updated ?? (await client.createService(body));
    if (current && current.id !== result.id) forget(current.id);
    remember(null, want, result.id, null);
  };

  const status = (): NetbirdStatus => {
    const cfg = config();
    return {
      configured: cfg !== null,
      brand,
      machineHint: ctx.config.machineHint,
      apiUrl: cfg?.apiUrl ?? ctx.config.netbirdApi,
      domain: cfg?.domain ?? null,
      peerId: cfg?.peerId ?? null,
      peerName: cfg?.peerName ?? null,
      panelAddress: panelMapping()?.domain ?? null,
      panelWww: wwwMapping()?.domain ?? null,
      customPorts: cfg?.customPorts ?? false,
      openPorts: openPorts(),
      router: routerLive(),
      domainServer: domainServerOf(cfg),
      behindProxy: behindProxy(),
    };
  };

  /** The stored token only ever goes to the stored API address; a new address needs the token typed again. */
  const tokenFor = (input: { apiUrl?: string; token?: string }): string => {
    const cfg = config();
    const sameApi = !input.apiUrl || input.apiUrl === cfg?.apiUrl;
    const token = input.token ?? (cfg && sameApi ? ctx.secrets.decrypt(cfg.token) : null);
    if (!token) throw badRequest('netbird_token_missing');
    return token;
  };
  const clientFromInput = (input: { apiUrl?: string; token?: string }): NetbirdClient =>
    clientFactory(input.apiUrl ?? config()?.apiUrl ?? ctx.config.netbirdApi, tokenFor(input));

  // A server gets its address before the answer to "create" goes out, later changes follow on their own.
  // Not awaited: the new server is there at once; its NetBird address follows a few seconds later (live update).
  servers.onCreated((id) => {
    if (serverRow(id)?.netbirdName) void syncQuietly(id);
    return Promise.resolve();
  });
  servers.onPortsChanged((id) => {
    if (serverRow(id)?.netbirdName || mappings(id).length) void syncQuietly(id);
  });
  ctx.events.on('server.deleted', ({ serverId }) => {
    if (config()?.domainServerId === serverId) saveConfig({ domainServerId: null });
    portNotes.delete(serverId);
    if (mappings(serverId).length) void syncQuietly(serverId);
  });
  const describe = (row: ServerRow): NetbirdServerInfo | null =>
    row.netbirdName && config()
      ? {
          name: row.netbirdName,
          onDomain: config()?.domainServerId === row.id,
          services: mappings(row.id).map((m) => ({
            purpose: m.purpose,
            domain: m.domain,
            port: m.listenPort,
            wanted: portNotes.get(row.id)?.get(m.purpose)?.wanted ?? null,
            heldBy: portNotes.get(row.id)?.get(m.purpose)?.heldBy ?? null,
          })),
          routed: {
            java: row.edition === 'java' && routerLive().java,
            bedrock: row.edition === 'java' && row.geyser && routerLive().bedrock,
          },
          error: failures.get(row.id) ?? null,
        }
      : null;
  servers.describeNetbird(describe);
  // After an update, addresses made under older rules (e.g. a random port on a self-hosted proxy) follow.
  // Setups from before network resources move over once: every service then points at its resource.
  const moveToResources = config()?.resourceMode !== true && lanAddress() !== null;
  if (config())
    void (async () => {
      await Promise.allSettled(namedServers().map((r) => syncQuietly(r.id, moveToResources)));
      if (moveToResources) saveConfig({ resourceMode: true });
      await syncRouter(moveToResources);
    })();

  /**
   * Resources of servers that no longer exist. NetBird refuses to delete a resource while a service still points
   * at it (a service left over from the same server), so those services go first. Only what is really gone counts
   * as removed.
   */
  const removeLeftovers = async (
    client: NetbirdClient,
    networkId: string,
  ): Promise<{ readonly name: string; readonly reason: string | null }[]> => {
    const wanted = new Set([panelResource, ...namedServers().map((r) => resourceName(r.netbirdName ?? ''))]);
    const stale = (await client.resources(networkId)).filter(
      (r) => r.name.startsWith(resourceName('')) && !wanted.has(r.name),
    );
    if (stale.length === 0) return [];
    const services = await client.services().catch(() => []);
    const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
    return Promise.all(
      stale.map(async (resource) => {
        const users = services.filter((s) => (s.targets ?? []).some((t) => t.target_id === resource.id));
        try {
          await Promise.all(users.map((s) => client.deleteService(s.id)));
          await client.deleteResource(networkId, resource.id);
          return { name: resource.name, reason: null };
        } catch (err) {
          ctx.log.warn({ err, resource: resource.name }, 'NetBird leftover could not be removed');
          return { name: resource.name, reason: reasonOf(err) };
        }
      }),
    );
  };

  /** The IP address behind a service target: a machine's NetBird IP, else the address of its network resource. */
  const targetAddress = async (
    client: NetbirdClient,
    target: NetbirdServiceTarget,
  ): Promise<string | null> => {
    if (target.target_type === 'peer')
      return singleIpv4((await client.peers()).find((p) => p.id === target.target_id)?.ip);
    const lists = await Promise.all((await client.networks()).map((n) => client.resources(n.id)));
    const resource = lists.flat().find((r) => r.id === target.target_id);
    return singleIpv4(resource?.address) ?? singleIpv4(target.host);
  };

  const portTarget: NetbirdAutomation['portTarget'] = async (listenPort) => {
    const cfg = config();
    if (!cfg) return { found: false, problem: 'no_netbird', service: null };
    const client = clientFor(cfg);
    const service = (await client.services()).find((s) => s.listen_port === listenPort && s.mode === 'tcp');
    const missing = (problem: Extract<PortTarget, { found: false }>['problem']): PortTarget => ({
      found: false,
      problem,
      service: service?.domain ?? null,
    });
    if (!service) return missing('no_service');
    if (knownIds().has(service.id)) return missing('own_service');
    if (!service.enabled) return missing('service_off');
    const target = (service.targets ?? []).find((t) => t.enabled && t.port);
    if (!target?.port) return missing('no_target');
    const host = await targetAddress(client, target);
    return host ? { found: true, host, port: target.port, service: service.domain } : missing('no_address');
  };

  const heal: NetbirdAutomation['heal'] = async () => {
    const cfg = config();
    if (!cfg) return null;
    const client = clientFor(cfg);
    const peers = await client.peers();
    const peerMoved = await (async (): Promise<string | null> => {
      if (peers.some((p) => p.id === cfg.peerId)) return null;
      const same =
        peers.find((p) => p.name === cfg.peerName) ??
        peers.find((p) => `${p.name} ${p.hostname}`.toLowerCase().includes(ctx.config.machineHint));
      if (!same) return null;
      saveConfig({ peerId: same.id, peerName: same.name });
      ctx.log.warn({ from: cfg.peerId, to: same.id }, 'NetBird machine has a new id, moved over');
      const moved = config() ?? cfg;
      if (lanAddress()) await ensureNetwork(client, moved);
      await Promise.allSettled(namedServers().map((r) => syncQuietly(r.id, true)));
      await syncRouter(true);
      return same.name;
    })();
    const current = config() ?? cfg;
    // The server on the domain waits for a port another service had: maybe it is free now.
    const waiting = current.domainServerId;
    if (waiting && portNotes.get(waiting)?.size) await syncQuietly(waiting);
    const outcomes = current.networkId ? await removeLeftovers(client, current.networkId) : [];
    const removed = outcomes.filter((o) => o.reason === null).map((o) => o.name);
    const stuck = outcomes.flatMap((o) => (o.reason === null ? [] : [{ name: o.name, reason: o.reason }]));
    return peerMoved || outcomes.length ? { peerMoved, removed, stuck } : null;
  };

  return {
    status,
    heal,
    portTarget,
    discover: async (input) => {
      const client = clientFromInput(input);
      const [domains, peers] = await Promise.all([client.domains(), client.peers()]);
      const looksLikePanel = peers.find((p) =>
        `${p.name} ${p.hostname}`.toLowerCase().includes(ctx.config.machineHint),
      );
      return {
        domains: domains.map((d) => ({
          domain: d.domain,
          validated: d.validated,
          custom: d.type === 'custom',
        })),
        peers: peers.map((p) => ({ id: p.id, name: p.name, ip: p.ip, connected: p.connected })),
        suggestedPeerId: looksLikePanel?.id ?? null,
      };
    },
    configure: async (input, actor) => {
      const client = clientFromInput(input);
      const token = tokenFor(input);
      const [domains, peers] = await Promise.all([client.domains(), client.peers()]);
      const domain = input.domain.toLowerCase();
      const chosen = domains.find((d) => d.domain.toLowerCase() === domain);
      if (!chosen) throw badRequest('netbird_domain_unknown', { domain });
      const peer = peers.find((p) => p.id === input.peerId);
      if (!peer) throw badRequest('netbird_peer_unknown');
      const previous = config();
      ctx.settings.setValue(SETTINGS_KEY, {
        apiUrl: input.apiUrl,
        token: ctx.secrets.encrypt(token),
        domain,
        peerId: peer.id,
        peerName: peer.name,
        customPorts: chosen.supports_custom_ports,
        ...(previous?.networkId ? { networkId: previous.networkId } : {}),
        ...(previous?.groupId ? { groupId: previous.groupId } : {}),
        ...(previous?.domainServerId ? { domainServerId: previous.domainServerId } : {}),
        resourceMode: lanAddress() !== null,
      } satisfies StoredConfig);
      ctx.audit.record(actor, 'netbird.configure', null, { domain, machine: peer.name });
      // The chosen machine routes to the resources (also after switching to another machine).
      const saved = config();
      if (saved && lanAddress()) await ensureNetwork(clientFor(saved), saved);
      const moved =
        previous?.domain !== domain ||
        previous.peerId !== peer.id ||
        previous.customPorts !== chosen.supports_custom_ports ||
        previous.resourceMode !== (lanAddress() !== null);
      await Promise.allSettled(namedServers().map((r) => syncQuietly(r.id, moved)));
      await syncRouter(moved);
      return status();
    },
    disconnect: async (actor) => {
      const cfg = config();
      const owned = ctx.db.select().from(netbirdServices).all();
      // The panel's own service stays in NetBird: removing it could lock the admin out of the panel. Its www name goes.
      const serverServices = owned.filter(
        (m) => m.serverId !== null || isRouterPurpose(m.purpose) || m.purpose === 'panel-www',
      );
      if (cfg) await Promise.allSettled(serverServices.map((m) => clientFor(cfg).deleteService(m.id)));
      const serverResources = Object.keys(storedResources()).filter((key) => key !== PANEL_KEY);
      if (cfg) await Promise.allSettled(serverResources.map((key) => dropResource(clientFor(cfg), cfg, key)));
      ctx.db.delete(netbirdServices).run();
      namedServers().forEach((r) =>
        servers.setTunnelAddress(r.id, {
          netbirdName: null,
          domain: null,
          publicPort: null,
          geyserPublicPort: null,
          voicePublicPort: null,
        }),
      );
      failures.clear();
      portNotes.clear();
      ctx.settings.deleteValue(SETTINGS_KEY);
      ctx.audit.record(actor, 'netbird.disconnect');
      return status();
    },
    setServerName: async (serverId, name, actor) => {
      const row = servers.row(serverId);
      if (name !== null) requireConfig();
      const taken =
        name !== null &&
        ctx.db
          .select()
          .from(serverTable)
          .where(and(eq(serverTable.netbirdName, name), ne(serverTable.id, serverId)))
          .get();
      if (taken) throw conflict('netbird_name_taken', { name });
      const cleared: TunnelAddress = {
        domain: null,
        publicPort: null,
        geyserPublicPort: null,
        voicePublicPort: null,
      };
      servers.setTunnelAddress(serverId, {
        netbirdName: name,
        ...(name === null && row.netbirdName ? cleared : {}),
      });
      if (name === null && config()?.domainServerId === serverId) saveConfig({ domainServerId: null });
      ctx.audit.record(actor, 'netbird.server', serverId, { name });
      await sync(serverId);
      return describe(servers.row(serverId));
    },
    setupPanel: async (input, actor) => {
      const cfg = requireConfig();
      const client = clientFor(cfg);
      const want: Wanted = {
        purpose: 'panel',
        // An empty name puts the panel on the domain itself (mornihosting.de).
        domain: input.name ? `${input.name}${SUFFIX.panel}.${cfg.domain}` : cfg.domain,
        mode: 'http',
        port: input.port,
      };
      const resource = (await ensureResource(client, cfg, PANEL_KEY, panelResource))?.resource;
      const request = {
        domain: want.domain,
        mode: want.mode,
        peerId: cfg.peerId,
        resourceId: resource?.id ?? null,
        resourceAddress: resource?.address ?? null,
        port: want.port,
        passHostHeader: true,
      };
      const ours = panelMapping();
      // A service for this address made by hand in NetBird is taken over, with "Pass Host Header" on.
      const byHand = (await client.services()).find((s) => s.domain === want.domain);
      const done = await lock(PANEL_KEY, async () => {
        const updated = byHand ? await client.updateService(byHand.id, request) : null;
        const result = updated ?? (await client.createService(request));
        return remember(null, want, result.id, null);
      });
      if (ours && ours.id !== done.id) {
        await client.deleteService(ours.id);
        forget(ours.id);
      }
      // On the domain itself www.<domain> leads there too; elsewhere it goes. Never in the way of the panel itself.
      await lock(PANEL_KEY, () => syncWww(client, cfg, want, request)).catch((err: unknown) =>
        ctx.log.warn({ err }, 'NetBird www address could not be set up'),
      );
      ctx.settings.update({ panelDomain: want.domain });
      ctx.events.emit('panel.host', { host: want.domain });
      ctx.audit.record(actor, 'netbird.panel', null, { domain: want.domain });
      return status();
    },
    setDomainServer: async (serverId, actor) => {
      const cfg = requireConfig();
      const row = serverId ? serverRow(serverId) : undefined;
      if (serverId && !row) throw notFound();
      // Behind a proxy nobody gets in from outside (no ports, no direct logins): the proxy is the way in.
      const hidden = behindProxy().find((b) => b.id === row?.id);
      if (hidden)
        throw badRequest('netbird_domain_server_behind_proxy', {
          server: hidden.name,
          proxy: hidden.proxyName,
        });
      if (row && !row.netbirdName) servers.setTunnelAddress(row.id, { netbirdName: freeName(row) });
      const before = cfg.domainServerId ?? null;
      saveConfig({ domainServerId: serverId });
      ctx.audit.record(actor, 'netbird.domain_server', serverId, { before });
      // The one before lets go of the domain's ports first, so the new one can take them.
      if (before && before !== serverId && serverRow(before)) await syncQuietly(before, true);
      if (serverId) await sync(serverId, true);
      return status();
    },
  };
}
