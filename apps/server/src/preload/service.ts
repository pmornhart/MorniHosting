import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  CREATABLE_SOFTWARE,
  SOFTWARE,
  createServerSchema,
  gameOf,
  type Edition,
  type PreloadItem,
  type ServerState,
  type SoftwareId,
} from '@mornihosting/shared';
import { SYSTEM_ACTOR } from '../audit/service.js';
import type { UserRow } from '../auth/context.js';
import type { AppContext } from '../context.js';
import { servers as serverTable, users } from '../db/schema.js';
import { badRequest, conflict, errorMessage } from '../lib/errors.js';
import { MS_PER_HOUR, nowIso } from '../lib/units.js';
import { INSTALLED_MARK } from '../servers/game-seed.js';
import type { ServerService } from '../servers/service.js';
import { imageFor } from '../servers/spec.js';
import { versionsFor } from '../servers/versions.js';

/**
 * "Spiele vorladen" in the admin area: downloads a game before anyone orders a server of it. A hidden template
 * server (never listed, no address, no mails) starts once – that pulls the image and downloads the server program
 * or the game files – and stops again. New servers of the same game then copy from it (see game-seed.ts).
 * Games whose image already holds everything (or that need files or a login first) only get their image pulled.
 */

/** These need nothing but the image: the game comes inside it, or it needs uploads / a login first. */
const IMAGE_ONLY: ReadonlySet<SoftwareId> = new Set(['bedrock', 'factorio', 'ets2', 'hytale', 'custom']);
const SETTINGS_KEY = 'preload';
/** How often preloaded games are checked for updates. */
const UPDATE_CHECK_MS = MS_PER_HOUR;
const MINECRAFT_TEMPLATE_MB = 2048;
const MB_PER_GB = 1024;
/** Template servers listen far away from the ports players use. */
const TEMPLATE_PORT = 45000;
const FIRST_START_LIMIT_HOURS = 6;
const FIRST_START_LIMIT_MS = FIRST_START_LIMIT_HOURS * MS_PER_HOUR;
/** After a crash the panel may restart once by itself (steamcmd); give it this long to show "starting". */
const RETRY_GRACE_MS = 15_000;
// Terminal colours in log lines: "\u001b[33m[MorniHosting]\u001b[0m Start" → "[MorniHosting] Start".
// https://regex101.com/?flavor=javascript&regex=%5Cx1b%5C%5B%5B0-9%3B%5D*m&flags=g&testString=%1B%5B33m%5BMorniHosting%5D%1B%5B0m%20Start
const ANSI_COLOUR = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex -- the point is to strip them
/** Rough download sizes for Minecraft software, in GB (server program + libraries). */
const MINECRAFT_SIZE_GB = 0.3;

/** First that applies wins: loading, then failed, then ready. */
const STATES: readonly (readonly [
  (job: {
    readonly running: boolean;
    readonly queued: boolean;
    readonly failed: boolean;
    readonly ready: boolean;
  }) => boolean,
  PreloadItem['state'],
])[] = [
  [(j) => j.running, 'loading'],
  [(j) => j.queued, 'queued'],
  [(j) => j.failed, 'failed'],
  [(j) => j.ready, 'ready'],
];

type Done = Readonly<Record<string, { readonly doneAt: string; readonly version: string | null }>>;

export interface PreloadService {
  readonly list: () => PreloadItem[];
  readonly start: (software: SoftwareId, admin: UserRow) => void;
  /** Queues every game that is not downloaded yet; they load one after another. */
  readonly startAll: (admin: UserRow) => void;
  readonly remove: (software: SoftwareId) => Promise<void>;
}

const editionOf = (software: SoftwareId): Edition =>
  (Object.entries(CREATABLE_SOFTWARE).find(([, list]) => list.includes(software))?.[0] ?? 'java') as Edition;

export function createPreloadService(ctx: AppContext, servers: ServerService): PreloadService {
  const jobs = new Map<
    SoftwareId,
    { readonly error: string | null; readonly running: boolean; readonly queued?: boolean }
  >();
  /** Downloads run one after another, so the line and the disk are not flooded. */
  let chain: Promise<void> = Promise.resolve();
  const done = (): Done => ctx.settings.getValue<Done>(SETTINGS_KEY) ?? {};
  const markDone = (software: SoftwareId, version: string | null): void =>
    ctx.settings.setValue(SETTINGS_KEY, { ...done(), [software]: { doneAt: nowIso(), version } });

  const candidates = (): SoftwareId[] =>
    [...new Set(Object.values(CREATABLE_SOFTWARE).flat())].filter((id) => id !== 'custom');

  const templateOf = (software: SoftwareId) =>
    ctx.db
      .select()
      .from(serverTable)
      .where(and(eq(serverTable.software, software), eq(serverTable.template, true)))
      .get();

  const modeOf = (software: SoftwareId): PreloadItem['mode'] =>
    IMAGE_ONLY.has(software) ? 'image' : 'template';

  const sizeOf = (software: SoftwareId): number | null => {
    const game = gameOf(software);
    if (game) return game.downloadGb;
    return MINECRAFT_SIZE_GB;
  };

  const list: PreloadService['list'] = () =>
    candidates().map((software) => {
      const job = jobs.get(software);
      const template = templateOf(software);
      const live = template ? servers.live(template.id) : null;
      const installed = template ? fs.existsSync(path.join(servers.dir(template.id), INSTALLED_MARK)) : false;
      const stored = done()[software];
      const ready = modeOf(software) === 'image' ? stored !== undefined : installed;
      const state =
        STATES.find(([applies]) =>
          applies({
            running: job?.running === true,
            queued: job?.queued === true,
            failed: Boolean(job?.error),
            ready,
          }),
        )?.[1] ?? 'none';
      return {
        software,
        version: template?.version ?? stored?.version ?? null,
        mode: modeOf(software),
        state,
        progress: job?.running ? (live?.progress ?? null) : null,
        download: job?.running ? (live?.download ?? null) : null,
        sizeGb: sizeOf(software),
        error: job?.error ?? null,
        doneAt: ready ? (stored?.doneAt ?? template?.updatedAt ?? null) : null,
        checkedAt: lastCheck,
      };
    });

  const versionToUse = async (software: SoftwareId): Promise<string> => {
    const game = gameOf(software);
    if (game) return (game.versions.find((v) => v.stable) ?? game.versions[0])?.id ?? 'latest';
    const options = await versionsFor(software);
    const pick = options.find((v) => v.stable) ?? options[0];
    if (!pick) throw badRequest('versions_unavailable');
    return pick.id;
  };

  /** Resolves when the template's first start is really over: running, or crashed without the panel retrying. */
  const firstStart = (id: string): Promise<'running' | 'failed'> =>
    new Promise((resolve) => {
      const settle = (result: 'running' | 'failed'): void => {
        clearTimeout(limit);
        off();
        resolve(result);
      };
      const limit = setTimeout(() => settle('failed'), FIRST_START_LIMIT_MS);
      const off = ctx.events.on(
        'server.state',
        ({ serverId, state }: { serverId: string; state: ServerState }) => {
          if (serverId !== id) return;
          if (state === 'running') settle('running');
          if (state === 'crashed' || state === 'stopped')
            setTimeout(() => {
              if (servers.live(id).state !== 'starting' && servers.live(id).state !== 'running')
                settle('failed');
            }, RETRY_GRACE_MS);
        },
      );
    });

  const run = async (software: SoftwareId, admin: UserRow): Promise<void> => {
    const version = await versionToUse(software);
    const edition = editionOf(software);
    if (modeOf(software) === 'image') {
      await ctx.docker.ensureImage(imageFor(ctx.config, { software, version, javaTag: null }));
      markDone(software, version);
      return;
    }
    // One template per game: an older version makes room for the new one.
    const old = templateOf(software);
    if (old && old.version !== version) await servers.remove(old.id, true, SYSTEM_ACTOR);
    const existing = old && old.version === version ? old : undefined;
    const game = gameOf(software);
    const memoryMb = game ? (game.packagesGb[0] ?? 1) * MB_PER_GB : MINECRAFT_TEMPLATE_MB;
    const id =
      existing?.id ??
      (
        await servers.create(
          createServerSchema.parse({
            name: `Vorlage ${SOFTWARE[software].label}`,
            edition,
            software,
            version,
            memoryMb,
            port: TEMPLATE_PORT,
            eula: true,
            autoStart: false,
            startNow: false,
          }),
          SYSTEM_ACTOR,
          admin,
          { template: true },
        )
      ).id;
    const over = firstStart(id);
    await servers.start(id, SYSTEM_ACTOR);
    const result = await over;
    await servers.stopAndWait(id, SYSTEM_ACTOR);
    if (result !== 'running')
      throw new Error(
        (servers.logs(id).slice(-1)[0] ?? 'Der erste Start hat nicht geklappt.').replace(ANSI_COLOUR, ''),
      );
    markDone(software, version);
    ctx.log.info({ software, version }, 'game preloaded');
  };

  const enqueue = (software: SoftwareId, admin: UserRow): void => {
    const job = jobs.get(software);
    if (job?.running || job?.queued) return;
    jobs.set(software, { running: false, queued: true, error: null });
    chain = chain.then(async () => {
      jobs.set(software, { running: true, error: null });
      try {
        await run(software, admin);
        jobs.set(software, { running: false, error: null });
      } catch (err) {
        ctx.log.warn({ err, software }, 'preload failed');
        jobs.set(software, { running: false, error: errorMessage(err) });
      }
    });
  };

  const firstAdmin = (): UserRow | undefined =>
    ctx.db.select().from(users).where(eq(users.isAdmin, true)).get();

  /**
   * Every hour: what is preloaded stays current. Minecraft loads again when a newer version is out, Steam games
   * start their template once (steamcmd fetches only what changed), images are checked for a newer one.
   */
  let lastCheck: string | null = null;
  const keepCurrent = async (): Promise<void> => {
    lastCheck = nowIso();
    const admin = firstAdmin();
    if (!admin) return;
    const stored = done();
    await Promise.all(
      candidates()
        .filter((software) => stored[software] !== undefined || templateOf(software) !== undefined)
        .map(async (software) => {
          try {
            const newest = await versionToUse(software);
            const steamGame = gameOf(software)?.steamAppId !== undefined;
            const changed = newest !== (templateOf(software)?.version ?? stored[software]?.version ?? null);
            if (changed || steamGame || modeOf(software) === 'image') enqueue(software, admin);
          } catch (err) {
            ctx.log.debug({ err, software }, 'preload update check failed');
          }
        }),
    );
  };
  const timer = setInterval(() => void keepCurrent(), UPDATE_CHECK_MS);
  timer.unref();

  return {
    list,
    start: (software, admin) => {
      if (!candidates().includes(software)) throw badRequest('preload_unknown');
      if (jobs.get(software)?.running) throw conflict('preload_running');
      enqueue(software, admin);
    },
    startAll: (admin) => {
      list()
        .filter((item) => item.state === 'none' || item.state === 'failed')
        .forEach((item) => enqueue(item.software, admin));
    },
    remove: async (software) => {
      const job = jobs.get(software);
      if (job?.running || job?.queued) throw conflict('preload_running');
      const template = templateOf(software);
      if (template) await servers.remove(template.id, true, SYSTEM_ACTOR);
      const { [software]: _gone, ...rest } = done();
      ctx.settings.setValue(SETTINGS_KEY, rest);
      jobs.delete(software);
    },
  };
}
