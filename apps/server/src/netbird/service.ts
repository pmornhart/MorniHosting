import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  ROUTER_PUBLIC_PORTS,
  SOFTWARE,
  type NetbirdConfigInput,
  type NetbirdDiscovery,
  type NetbirdPurpose,
  type NetbirdServerInfo,
  type NetbirdStatus,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { netbirdServices, servers as serverTable } from '../db/schema.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { createKeyedLock } from '../lib/locks.js';
import { GEYSER_PURPOSE, VOICE_PURPOSE, type ServerService, type TunnelAddress } from '../servers/service.js';
import type { ServerRow } from '../servers/spec.js';
import type { RouterKind } from '../gateway/router.js';
import { createNetbirdClient, type NetbirdClient, type NetbirdClientFactory } from './client.js';

/**
 * NetBird automation: with an API token, a domain and the machine MorniHosting runs on, the panel keeps
 * one reverse-proxy service per address in the admin's NetBird account. A server only needs a name;
 * "survival" becomes survival.<domain> (plus survival-bedrock and survival-voice when those are on).
 * NetBird Cloud assigns the outside ports; the panel stores them so every page shows the full address.
 * A self-hosted proxy that allows its own ports gets the server's port instead (survival.<domain>:25565),
 * so the admin opens one fixed range on the proxy once instead of a random port per server.
 */

const SETTINGS_KEY = 'netbird';
const RESOURCES_KEY = 'netbird_resources';
/** How often a service may move on to another outside port, and how far it looks. */
const PORT_RETRIES = 5;
const PORT_SEARCH = 50;
// NetBird's refusal for a taken outside port, e.g. "tcp port 25565 is already in use by service abc on cluster
// netbird.example.org" → 25565; "domain already in use" does not match.
// https://regex101.com/?flavor=javascript&regex=port%20(%5Cd%2B)%20is%20already%20in%20use&flags=i&testString=tcp%20port%2025565%20is%20already%20in%20use%20by%20service%20abc%20on%20cluster%20netbird.example.org%0Adomain%20already%20in%20use
const PORT_IN_USE = /port (\d+) is already in use/i;
const portTaken = (err: unknown): number | null => {
  if (!(err instanceof AppError)) return null;
  const match = PORT_IN_USE.exec(String(err.params.message ?? ''));
  return match ? Number(match[1]) : null;
};

/** Name of the NetBird network, its group and the resources the panel makes. */
const NETWORK_NAME = 'MorniHosting';
const PANEL_KEY = 'panel';
const NETWORK_LOCK = 'network';
const ROUTER_LOCK = 'router';
const isRouterPurpose = (purpose: string): boolean => purpose.startsWith('router-');
/** Machines whose name contains this are offered first: the Proxmox script calls its container so. */
const MACHINE_HINT = 'mornihosting';
const SUFFIX: Readonly<Record<NetbirdPurpose, string>> = {
  main: '',
  geyser: '-bedrock',
  // Its own name so NetBird does not see two services for one domain; players only use the "-bedrock" one, both
  // point at the same proxy address and the same port.
  'geyser-signal': '-bedrock-tcp',
  voice: '-voice',
  panel: '',
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
}

type Mapping = typeof netbirdServices.$inferSelect;

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
}

export function createNetbirdAutomation(
  ctx: AppContext,
  servers: ServerService,
  clientFactory: NetbirdClientFactory = createNetbirdClient,
): NetbirdAutomation {
  const lock = createKeyedLock();
  /** Last failed sync per server, as an error code for its pages. */
  const failures = new Map<string, NonNullable<NetbirdServerInfo['error']>>();

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

  /** The network "MorniHosting" with this machine as routing peer, and the group for its resources. */
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
      networks.find((n) => n.name === NETWORK_NAME) ??
      (await client.createNetwork(NETWORK_NAME, 'Game-Server von MorniHosting'));
    const groups = await client.groups();
    const group =
      groups.find((g) => g.id === cfg.groupId) ??
      groups.find((g) => g.name === NETWORK_NAME) ??
      (await client.createGroup(NETWORK_NAME));
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
    const request = { name, address, groupId };
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

  const wanted = (row: ServerRow, cfg: StoredConfig): Wanted[] => {
    if (!row.netbirdName) return [];
    const host = (purpose: NetbirdPurpose): string => `${row.netbirdName}${SUFFIX[purpose]}.${cfg.domain}`;
    const hostPort = (purpose: string): number | undefined =>
      row.extraPorts.find((p) => p.purpose === purpose)?.port;
    const geyserPort = row.geyser ? hostPort(GEYSER_PURPOSE) : undefined;
    const voicePort = row.voiceChat ? hostPort(VOICE_PURPOSE) : undefined;
    const routed = routerKinds(cfg);
    // With the router, 25565/19132 (TCP) belong to it; a server's own address moves to another port.
    const avoid = routed.map((kind) => ROUTER_PUBLIC_PORTS[kind]);
    return [
      { purpose: 'main', domain: host('main'), mode: SOFTWARE[row.software].protocol, port: row.port, avoid },
      ...(geyserPort
        ? ([
            // Its own outside port, never the router's 19132: the TCP half below needs the same number.
            { purpose: 'geyser', domain: host('geyser'), mode: 'udp', port: geyserPort, avoid },
            // Always the server's own TCP signaling too: players can always join with this port, router or not.
            { purpose: 'geyser-signal', domain: host('geyser-signal'), mode: 'tcp', port: geyserPort },
          ] as const)
        : []),
      ...(voicePort
        ? [{ purpose: 'voice', domain: host('voice'), mode: 'udp', port: voicePort } as const]
        : []),
    ];
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
   * someone else makes the service take the next free one.
   */
  const withFreeListenPort = async <TResult>(
    client: NetbirdClient,
    cfg: StoredConfig,
    wanted: number | null,
    domain: string,
    attempt: (listenPort: number | null) => Promise<TResult>,
  ): Promise<TResult> => {
    const tryPort = async (listenPort: number | null, left: number): Promise<TResult> => {
      try {
        return await attempt(listenPort);
      } catch (err) {
        const taken = portTaken(err);
        if (taken === null || left <= 0) throw err;
        const all = await client.services();
        const known = new Set(
          ctx.db
            .select({ id: netbirdServices.id })
            .from(netbirdServices)
            .all()
            .map((m) => m.id),
        );
        const leftover = all.find(
          (svc) =>
            svc.listen_port === taken &&
            svc.domain !== domain &&
            !known.has(svc.id) &&
            (svc.domain === cfg.domain || svc.domain.endsWith(`.${cfg.domain}`)),
        );
        if (leftover) {
          ctx.log.info(
            { service: leftover.domain, port: taken },
            'removing a left-over NetBird service of the panel',
          );
          await client.deleteService(leftover.id);
          return tryPort(listenPort, left - 1);
        }
        const used = new Set(all.map((svc) => svc.listen_port));
        const next = Array.from({ length: PORT_SEARCH }, (_, i) => taken + 1 + i).find((p) => !used.has(p));
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
    const fixedPort = avoided(asked)
      ? avoided(existing?.listenPort)
        ? (asked ?? 0) + 1
        : (existing?.listenPort ?? (asked ?? 0) + 1)
      : asked;
    const same =
      existing?.domain === want.domain &&
      existing.targetPort === want.port &&
      (fixedPort === null || existing.listenPort === fixedPort);
    if (existing && existing.mode === want.mode && same && !force) return existing;
    if (existing && existing.mode === want.mode) {
      const updated = await withFreeListenPort(
        client,
        cfg,
        fixedPort ?? existing.listenPort,
        want.domain,
        (listenPort) => client.updateService(existing.id, { ...request, listenPort }),
      );
      return remember(serverId, want, existing.id, updated.listen_port ?? fixedPort ?? existing.listenPort);
    }
    if (existing) {
      await client.deleteService(existing.id);
      forget(existing.id);
    }
    const created = await withFreeListenPort(client, cfg, fixedPort, want.domain, (listenPort) =>
      client.createService({ ...request, listenPort }),
    );
    // Some NetBird setups pick their own port on creating; the wanted one (Geyser's TCP half follows its UDP half)
    // is then set right away instead of at the next sync.
    if (want.listenPort && created.listen_port && created.listen_port !== want.listenPort) {
      const moved = await client.updateService(created.id, { ...request, listenPort: want.listenPort });
      return remember(serverId, want, created.id, moved.listen_port ?? want.listenPort);
    }
    return remember(serverId, want, created.id, created.listen_port ?? fixedPort);
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

  const addressOf = (row: ServerRow, done: readonly Mapping[]): TunnelAddress => {
    const port = (purpose: NetbirdPurpose): number | null =>
      done.find((m) => m.purpose === purpose)?.listenPort ?? null;
    const main = done.find((m) => m.purpose === 'main');
    // Through the router Java players use the name alone (port 25565).
    const viaRouter = row.edition === 'java' && routerLive().java;
    return main
      ? {
          domain: main.domain,
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
    const wants = row ? wanted(row, cfg) : [];
    const client = clientFor(cfg);
    const ensured =
      row?.netbirdName && wants.length
        ? await ensureResource(client, cfg, serverId, `${NETWORK_NAME} ${row.netbirdName}`)
        : null;
    const resource = ensured?.resource ?? null;
    const stale = existing.filter((m) => !wants.some((w) => w.purpose === m.purpose));
    await Promise.all(
      stale.map(async (m) => {
        await client.deleteService(m.id);
        forget(m.id);
      }),
    );
    const applyOne = (w: Wanted): Promise<Mapping> =>
      apply(
        client,
        cfg,
        serverId,
        w,
        existing.find((m) => m.purpose === w.purpose),
        force || (ensured?.changed ?? false),
        resource,
      );
    const first = await Promise.all(wants.filter((w) => w.purpose !== 'geyser-signal').map(applyOne));
    // The TCP half of Geyser follows the UDP half, so both answer on the same outside port.
    const udpListen = first.find((m) => m.purpose === 'geyser')?.listenPort ?? null;
    const second = await Promise.all(
      wants
        .filter((w) => w.purpose === 'geyser-signal')
        .map((w) => applyOne({ ...w, listenPort: udpListen ?? w.listenPort ?? null })),
    );
    const done = [...first, ...second];
    if (!wants.length) await dropResource(client, cfg, serverId);
    if (row) servers.setTunnelAddress(serverId, addressOf(row, done));
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
      ? ((await ensureResource(client, cfg, PANEL_KEY, `${NETWORK_NAME} Panel`))?.resource ?? null)
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
      if (done.length) servers.setTunnelAddress(r.id, addressOf(r, done));
    });
  };
  const syncRouter = async (force = false): Promise<void> => {
    try {
      await lock(ROUTER_LOCK, () => syncRouterNow(force));
    } catch (err) {
      ctx.log.warn({ err }, 'NetBird router sync failed');
    }
  };

  const status = (): NetbirdStatus => {
    const cfg = config();
    return {
      configured: cfg !== null,
      apiUrl: cfg?.apiUrl ?? ctx.config.netbirdApi,
      domain: cfg?.domain ?? null,
      peerId: cfg?.peerId ?? null,
      peerName: cfg?.peerName ?? null,
      panelAddress: panelMapping()?.domain ?? null,
      customPorts: cfg?.customPorts ?? false,
      openPorts: openPorts(),
      router: routerLive(),
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
    if (mappings(serverId).length) void syncQuietly(serverId);
  });
  const describe = (row: ServerRow): NetbirdServerInfo | null =>
    row.netbirdName && config()
      ? {
          name: row.netbirdName,
          services: mappings(row.id).map((m) => ({
            purpose: m.purpose,
            domain: m.domain,
            port: m.listenPort,
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
    const wanted = new Set([
      `${NETWORK_NAME} Panel`,
      ...namedServers().map((r) => `${NETWORK_NAME} ${r.netbirdName ?? ''}`),
    ]);
    const stale = (await client.resources(networkId)).filter(
      (r) => r.name.startsWith(`${NETWORK_NAME} `) && !wanted.has(r.name),
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

  const heal: NetbirdAutomation['heal'] = async () => {
    const cfg = config();
    if (!cfg) return null;
    const client = clientFor(cfg);
    const peers = await client.peers();
    const peerMoved = await (async (): Promise<string | null> => {
      if (peers.some((p) => p.id === cfg.peerId)) return null;
      const same =
        peers.find((p) => p.name === cfg.peerName) ??
        peers.find((p) => `${p.name} ${p.hostname}`.toLowerCase().includes(MACHINE_HINT));
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
    const outcomes = current.networkId ? await removeLeftovers(client, current.networkId) : [];
    const removed = outcomes.filter((o) => o.reason === null).map((o) => o.name);
    const stuck = outcomes.flatMap((o) => (o.reason === null ? [] : [{ name: o.name, reason: o.reason }]));
    return peerMoved || outcomes.length ? { peerMoved, removed, stuck } : null;
  };

  return {
    status,
    heal,
    discover: async (input) => {
      const client = clientFromInput(input);
      const [domains, peers] = await Promise.all([client.domains(), client.peers()]);
      const looksLikePanel = peers.find((p) =>
        `${p.name} ${p.hostname}`.toLowerCase().includes(MACHINE_HINT),
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
      // The panel's own service stays in NetBird: removing it could lock the admin out of the panel.
      const serverServices = owned.filter((m) => m.serverId !== null || isRouterPurpose(m.purpose));
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
      const resource = (await ensureResource(client, cfg, PANEL_KEY, `${NETWORK_NAME} Panel`))?.resource;
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
        const result = byHand
          ? await client.updateService(byHand.id, request)
          : await client.createService(request);
        return remember(null, want, result.id, null);
      });
      if (ours && ours.id !== done.id) {
        await client.deleteService(ours.id);
        forget(ours.id);
      }
      ctx.settings.update({ panelDomain: want.domain });
      ctx.audit.record(actor, 'netbird.panel', null, { domain: want.domain });
      return status();
    },
  };
}
