import { PORT_BEDROCK, type ContentSource, type GeyserCheck, type SoftwareId } from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { MarketService } from '../market/service.js';
import type { ServerService } from '../servers/service.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { netbirdServices } from '../db/schema.js';
import { bedrockPing } from '../lib/bedrock-ping.js';
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

export interface GeyserResult {
  readonly enabled: boolean;
  readonly port: number | null;
  readonly restartRequired: boolean;
}

export interface GeyserService {
  readonly set: (serverId: string, enabled: boolean, actor: Actor) => Promise<GeyserResult>;
  readonly check: (serverId: string) => Promise<GeyserCheck>;
}

/** Geyser needs a moment after the Java server is up before it answers Bedrock pings. */
const AFTER_START_CHECK_MS = 20_000;
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
    const port = existing?.port ?? servers.freePort(PORT_BEDROCK, 'udp', serverId);
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

  const check: GeyserService['check'] = async (serverId) => {
    const row = servers.row(serverId);
    const running = servers.isRunning(serverId);
    const pong = running && row.geyser ? await bedrockPing(containerName(serverId), PORT_BEDROCK) : null;
    const target = row.geyser ? await outsideTarget(serverId) : null;
    const outsideOk = await (async (): Promise<boolean | null> => {
      if (!target || !running) return null;
      try {
        const data = bedrockStatusSchema.parse(
          await fetchJson(BEDROCK_STATUS + encodeURIComponent(`${target.host}:${target.port}`)),
        );
        return data.online;
      } catch {
        return null;
      }
    })();
    return {
      running,
      inside: { ok: pong !== null, version: pong?.version ?? null, motd: pong?.motd ?? null },
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
      void bedrockPing(containerName(serverId), PORT_BEDROCK).then((pong) => {
        if (pong)
          servers.note(
            serverId,
            `✓ Geyser ist bereit – Bedrock-Spieler können rein (Bedrock ${pong.version}).`,
          );
        else
          servers.note(
            serverId,
            '✗ Geyser antwortet nicht. Netzwerk → „Bedrock-Verbindung prüfen“ zeigt, woran es liegt.',
          );
      });
    }, AFTER_START_CHECK_MS);
  });

  return {
    check,
    set: (serverId, enabled, actor) =>
      serial(serverId, async () => (enabled ? enable(serverId, actor) : disable(serverId, actor))),
  };
}
