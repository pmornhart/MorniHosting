import {
  PORT_BEDROCK,
  type ViaStatus,
  ROUTER_PUBLIC_PORTS,
  type ContentSource,
  type GeyserCheck,
  type SoftwareId,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { MarketService } from '../market/service.js';
import type { ServerService } from '../servers/service.js';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { netbirdServices } from '../db/schema.js';
import { bedrockPing, signalingAnswers } from '../lib/bedrock-ping.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isHomeNetworkAddress } from '../lib/net-guard.js';
import { fetchJson } from '../lib/http-client.js';
import { connectionInfo } from '../servers/connectivity.js';
import { containerName } from '../servers/spec.js';
import { serial } from '../lib/serial.js';

/**
 * Lets Bedrock players (phones, consoles, Windows) join a Java server: installs Geyser and Floodgate
 * and opens a UDP port. Inside the container Geyser always listens on 19132; the host port may differ.
 */

interface Plugin {
  readonly source: ContentSource;
  readonly id: string;
}

/** Each plugin with the places to get it, tried in order (a marketplace can be down for a moment). */
interface GeyserPlugins {
  readonly geyser: readonly Plugin[];
  readonly floodgate: readonly Plugin[];
}

const GEYSER: readonly Plugin[] = [
  { source: 'modrinth', id: 'wKkoqHrH' },
  { source: 'hangar', id: 'Geyser' },
];
const PAPER: GeyserPlugins = {
  geyser: GEYSER,
  floodgate: [
    { source: 'geysermc', id: 'floodgate:spigot' },
    { source: 'hangar', id: 'Floodgate' },
  ],
};
const MODDED: GeyserPlugins = {
  geyser: [{ source: 'modrinth', id: 'wKkoqHrH' }],
  floodgate: [{ source: 'modrinth', id: 'bWrNNfkb' }],
};
const ATTEMPTS = 3;
const RETRY_WAIT_MS = 1500;
const PLUGINS: Partial<Readonly<Record<SoftwareId, GeyserPlugins>>> = {
  paper: PAPER,
  purpur: PAPER,
  custom: PAPER,
  velocity: {
    geyser: GEYSER,
    floodgate: [
      { source: 'geysermc', id: 'floodgate:velocity' },
      { source: 'hangar', id: 'Floodgate' },
    ],
  },
  fabric: MODDED,
  neoforge: MODDED,
};
const PURPOSE = 'geyser';
/**
 * Crossplay also means Java players on newer (ViaVersion) or older (ViaBackwards) game versions get in, so
 * nobody has to wait for the server to update. On Fabric the same comes as ViaFabric.
 */
const VIA_PLUGINS: readonly Plugin[] = [
  { source: 'modrinth', id: 'P1OZGk5p' },
  { source: 'modrinth', id: 'NpvuJQoq' },
];
const VIA: Partial<Readonly<Record<SoftwareId, readonly Plugin[]>>> = {
  paper: VIA_PLUGINS,
  purpur: VIA_PLUGINS,
  custom: VIA_PLUGINS,
  velocity: VIA_PLUGINS,
  fabric: [{ source: 'modrinth', id: 'YlKdE5VK' }],
};
// Geyser and Floodgate jars, also when switched off: "Geyser-Spigot.jar" and "floodgate-spigot.jar.disabled" match.
// https://regex101.com/?regex=geyser%7Cfloodgate&flags=i&testString=Geyser-Spigot.jar%0Afloodgate-spigot.jar.disabled%0AViaVersion.jar
const GEYSER_FILE = /geyser|floodgate/i;
// ViaVersion jars, also switched off: "ViaVersion-5.5.1.jar", "ViaBackwards.jar.disabled", "viafabric.jar"; not "Geyser".
// https://regex101.com/?flavor=javascript&regex=%5Evia(version%7Cbackwards%7Cfabric)&flags=i&testString=ViaVersion-5.5.1.jar%0AViaBackwards.jar.disabled%0Aviafabric.jar%0AGeyser-Spigot.jar
const VIA_FILE = /^via(version|backwards|fabric)/i;

export interface GeyserResult {
  readonly enabled: boolean;
  readonly port: number | null;
  readonly restartRequired: boolean;
}

export interface GeyserService {
  readonly set: (serverId: string, enabled: boolean, actor: Actor) => Promise<GeyserResult>;
  readonly check: (serverId: string) => Promise<GeyserCheck>;
  /** Loads Geyser, Floodgate and ViaVersion into the download cache at the same time (before `set`). */
  readonly prefetch: (serverId: string) => Promise<void>;
  /** "All versions" on its own (also without Geyser): ViaVersion + ViaBackwards, or ViaFabric. */
  readonly via: (serverId: string) => ViaStatus;
  readonly setVia: (serverId: string, enabled: boolean, actor: Actor) => Promise<ViaStatus>;
  readonly prefetchVia: (serverId: string) => Promise<void>;
}

/** Geyser needs a moment after the Java server is up before it answers Bedrock pings. */
const AFTER_START_CHECK_MS = 20_000;
const IPV4 = 4;
const LOOPBACK_PREFIX = '127.';
const BEDROCK_STATUS = 'https://api.mcsrvstat.us/bedrock/3/';
const bedrockStatusSchema = z.object({ online: z.boolean() }).loose();

export function createGeyserService(
  ctx: AppContext,
  servers: ServerService,
  market: MarketService,
): GeyserService {
  const pluginsFor = (serverId: string): GeyserPlugins => {
    const row = servers.row(serverId);
    if (row.edition !== 'java') throw badRequest('geyser_java_only');
    const plugins = PLUGINS[row.software];
    if (!plugins) throw badRequest('geyser_unsupported');
    return plugins;
  };

  const installOrEnable = async (serverId: string, plugin: Plugin, actor: Actor): Promise<void> => {
    try {
      await market.installFrom(serverId, plugin.source, plugin.id, actor);
    } catch (err) {
      // Already there (also from another marketplace) is fine: we only need it switched on.
      if (!(err instanceof AppError && err.code === 'content_already_installed')) throw err;
    }
  };

  /** Tries each source, each a few times on network trouble; throws only when none worked. */
  const installFirst = async (serverId: string, choices: readonly Plugin[], actor: Actor): Promise<void> => {
    const attempts = choices.flatMap((plugin) => Array.from({ length: ATTEMPTS }, (_, n) => ({ plugin, n })));
    const failure = await attempts.reduce<Promise<unknown>>(async (previous, { plugin, n }) => {
      const last = await previous;
      if (last === null) return null;
      if (n > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS * n));
      try {
        await installOrEnable(serverId, plugin, actor);
        return null;
      } catch (err) {
        ctx.log.warn(
          { err, serverId, plugin: plugin.id, attempt: n + 1 },
          'plugin download failed, trying again',
        );
        return err;
      }
    }, Promise.resolve(undefined));
    if (failure !== null) throw failure;
  };

  const enable = async (serverId: string, actor: Actor): Promise<GeyserResult> => {
    const plugins = pluginsFor(serverId);
    market
      .list(serverId)
      .filter((e) => GEYSER_FILE.test(e.fileName) && !e.enabled)
      .forEach((e) => market.setEnabled(serverId, e.fileName, true, actor));
    await installFirst(serverId, plugins.geyser, actor);
    // Without Floodgate Geyser still works (Bedrock players then log in with a Java account): not a reason to stop.
    await installFirst(serverId, plugins.floodgate, actor).catch(() =>
      servers.note(
        serverId,
        'Floodgate ließ sich gerade nicht laden – Geyser läuft trotzdem. Später Geyser aus- und wieder einschalten.',
      ),
    );
    // ViaVersion is a bonus: if Modrinth has no fitting build yet, Geyser still works.
    await (VIA[servers.row(serverId).software] ?? []).reduce(async (previous, plugin) => {
      await previous;
      try {
        await installFirst(serverId, [plugin], actor);
      } catch (err) {
        ctx.log.warn({ err, serverId, plugin: plugin.id }, 'ViaVersion could not be installed');
        servers.note(serverId, 'ViaVersion ließ sich gerade nicht installieren – Geyser läuft trotzdem.');
      }
    }, Promise.resolve());
    const row = servers.row(serverId);
    const existing = row.extraPorts.find((p) => p.purpose === PURPOSE);
    // NetherNet needs the port on UDP and TCP, so look for a number that is free on both.
    const freeOnBoth = (start: number): number => {
      const udp = servers.freePort(start, 'udp', serverId);
      return servers.freePort(udp, 'tcp', serverId) === udp ? udp : freeOnBoth(udp + 1);
    };
    const port = existing?.port ?? freeOnBoth(PORT_BEDROCK);
    if (!existing) {
      servers.setExtraPorts(serverId, [
        ...row.extraPorts,
        { port, containerPort: PORT_BEDROCK, protocol: 'udp', purpose: PURPOSE },
      ]);
    }
    servers.setGeyser(serverId, true);
    ctx.audit.record(actor, 'geyser.enable', serverId, { port });
    return { enabled: true, port, restartRequired: servers.isRunning(serverId) };
  };

  const disable = (serverId: string, actor: Actor): GeyserResult => {
    market
      .list(serverId)
      .filter((e) => GEYSER_FILE.test(e.fileName) && e.enabled)
      .forEach((e) => market.setEnabled(serverId, e.fileName, false, actor));
    const row = servers.row(serverId);
    servers.setExtraPorts(
      serverId,
      row.extraPorts.filter((p) => p.purpose !== PURPOSE),
    );
    servers.setGeyser(serverId, false);
    ctx.audit.record(actor, 'geyser.disable', serverId);
    return { enabled: false, port: null, restartRequired: servers.isRunning(serverId) };
  };

  /** Where Bedrock players connect: the NetBird name for Geyser, else the server's domain or public IP. */
  const outsideTarget = async (serverId: string): Promise<{ host: string; port: number } | null> => {
    const row = servers.row(serverId);
    const viaNetbird = ctx.db
      .select()
      .from(netbirdServices)
      .where(and(eq(netbirdServices.serverId, serverId), eq(netbirdServices.purpose, PURPOSE)))
      .get();
    if (viaNetbird) return { host: viaNetbird.domain, port: viaNetbird.listenPort ?? viaNetbird.targetPort };
    const info = await connectionInfo(row, ctx.settings);
    const host = info.domain ?? info.publicIp;
    const port = row.geyserPublicPort ?? row.extraPorts.find((p) => p.purpose === PURPOSE)?.port ?? null;
    return host && port ? { host, port } : null;
  };

  /** The server's name when the router takes Bedrock players by it (NetBird service on TCP 19132). */
  const routedName = (serverId: string): string | null => {
    const router = ctx.db
      .select()
      .from(netbirdServices)
      .where(and(isNull(netbirdServices.serverId), eq(netbirdServices.purpose, 'router-bedrock')))
      .get();
    if (router?.listenPort !== ROUTER_PUBLIC_PORTS.bedrock) return null;
    const main = ctx.db
      .select()
      .from(netbirdServices)
      .where(and(eq(netbirdServices.serverId, serverId), eq(netbirdServices.purpose, 'main')))
      .get();
    return main?.domain ?? null;
  };

  /** NetherNet signaling (TCP) or the old RakNet ping (UDP): either answer means Geyser is up. */
  const answersInside = async (
    serverId: string,
  ): Promise<{ ok: boolean; pong: Awaited<ReturnType<typeof bedrockPing>> }> => {
    const [signaling, pong] = await Promise.all([
      signalingAnswers(containerName(serverId), PORT_BEDROCK),
      bedrockPing(containerName(serverId), PORT_BEDROCK),
    ]);
    return { ok: signaling || pong !== null, pong };
  };

  /**
   * NetherNet hands players the address to play on. Behind NetBird or a router Geyser cannot see it itself, so the
   * panel passes the public one (the name looked up to an IPv4 address) when the server starts.
   */
  servers.onStartEnv(async (serverId): Promise<Record<string, string>> => {
    const row = servers.row(serverId);
    if (!row.geyser || row.edition !== 'java') return {};
    const target = await outsideTarget(serverId);
    if (!target) return {};
    const ip = isIP(target.host) ? target.host : (await lookup(target.host, { family: IPV4 })).address;
    // Geyser refuses private or special addresses ("no player can reach it") and would not start signaling.
    if (isHomeNetworkAddress(ip) || ip.startsWith(LOOPBACK_PREFIX)) return {};
    return { JVM_OPTS: `-DgeyserAdvertiseAddresses=${ip}:${target.port}` };
  });

  const check: GeyserService['check'] = async (serverId) => {
    const row = servers.row(serverId);
    const running = servers.isRunning(serverId);
    const inside = running && row.geyser ? await answersInside(serverId) : null;
    const pong = inside?.pong ?? null;
    const target = row.geyser ? await outsideTarget(serverId) : null;
    const outsideOk = await (async (): Promise<boolean | null> => {
      if (!target || !running) return null;
      try {
        // NetherNet first (what current Bedrock uses), then the old RakNet way through mcsrvstat.
        // Through the address router players reach signaling by the server's name on 19132.
        const routed = routedName(serverId);
        if (routed && (await signalingAnswers(routed, ROUTER_PUBLIC_PORTS.bedrock))) return true;
        if (await signalingAnswers(target.host, target.port)) return true;
        const data = bedrockStatusSchema.parse(
          await fetchJson(BEDROCK_STATUS + encodeURIComponent(`${target.host}:${target.port}`)),
        );
        return data.online ? true : null;
      } catch {
        return null;
      }
    })();
    return {
      running,
      inside: { ok: inside?.ok ?? false, version: pong?.version ?? null, motd: pong?.motd ?? null },
      outside: target ? { ...target, ok: outsideOk } : null,
    };
  };

  // After each start: does Geyser really answer? If not, say so in the console right away.
  ctx.events.on('server.state', ({ serverId, state }) => {
    if (state !== 'running') return;
    const row = (() => {
      try {
        return servers.row(serverId);
      } catch {
        return null;
      }
    })();
    if (!row?.geyser) return;
    setTimeout(() => {
      if (!servers.isRunning(serverId)) return;
      void answersInside(serverId).then(({ ok }) => {
        if (ok) servers.note(serverId, '✓ Geyser ist bereit – Bedrock-Spieler können rein.');
        else
          servers.note(
            serverId,
            '✗ Geyser antwortet nicht. Netzwerk → „Bedrock-Verbindung prüfen“ zeigt, woran es liegt.',
          );
      });
    }, AFTER_START_CHECK_MS);
  });

  const prefetch: GeyserService['prefetch'] = async (serverId) => {
    const row = servers.row(serverId);
    const plugins = PLUGINS[row.software];
    if (row.edition !== 'java' || !plugins) return;
    const first = [plugins.geyser[0], plugins.floodgate[0], ...(VIA[row.software] ?? [])].filter(
      (p): p is Plugin => p !== undefined,
    );
    await Promise.all(first.map((p) => market.prefetch(serverId, p.source, p.id)));
  };

  const viaPlugins = (serverId: string): readonly Plugin[] => {
    const row = servers.row(serverId);
    const plugins = row.edition === 'java' ? VIA[row.software] : undefined;
    if (!plugins) throw badRequest('via_unsupported');
    return plugins;
  };
  const via: GeyserService['via'] = (serverId) => ({
    enabled: market.list(serverId).some((e) => VIA_FILE.test(e.fileName) && e.enabled),
    restartRequired: servers.isRunning(serverId),
  });
  const setViaNow = async (serverId: string, enabled: boolean, actor: Actor): Promise<ViaStatus> => {
    if (enabled) {
      // Each plugin from Modrinth (a few tries); the panel keeps them up to date afterwards (crossplay plugins).
      await viaPlugins(serverId).reduce(async (previous, plugin) => {
        await previous;
        await installFirst(serverId, [plugin], actor);
      }, Promise.resolve());
    } else {
      market
        .list(serverId)
        .filter((e) => VIA_FILE.test(e.fileName) && e.enabled)
        .forEach((e) => market.setEnabled(serverId, e.fileName, false, actor));
    }
    ctx.audit.record(actor, enabled ? 'via.enable' : 'via.disable', serverId);
    return via(serverId);
  };

  return {
    via,
    setVia: (serverId, enabled, actor) => serial(serverId, () => setViaNow(serverId, enabled, actor)),
    prefetchVia: async (serverId) => {
      await Promise.all(
        viaPlugins(serverId).map((plugin) =>
          market.prefetch(serverId, plugin.source, plugin.id).catch(() => undefined),
        ),
      );
    },
    check,
    prefetch,
    set: (serverId, enabled, actor) =>
      serial(serverId, async () => (enabled ? enable(serverId, actor) : disable(serverId, actor))),
  };
}
