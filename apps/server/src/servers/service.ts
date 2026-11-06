import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, lt, ne } from 'drizzle-orm';
import {
  BUILTIN_ROLES,
  CREATABLE_SOFTWARE,
  gameOf,
  type SetupProgress,
  type GameInfo,
  PORT_VOICE_CHAT,
  SOFTWARE,
  SWITCHABLE_SOFTWARE,
  type CreateServerInput,
  type NetbirdServerInfo,
  type ServerDetail,
  type ServerLive,
  type ServerState,
  type ServerSummary,
  type UpdateServerInput,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { UserRow } from '../auth/context.js';
import type { AppContext } from '../context.js';
import { roles, serverAccess, servers, stats, users } from '../db/schema.js';
import { randomToken } from '../lib/crypto.js';
import { SYSTEM_ACTOR } from '../audit/service.js';
import { AppError, badRequest, conflict, errorMessage, forbidden, notFound } from '../lib/errors.js';
import { HTTP_CONFLICT } from '../lib/http-status.js';
import { BYTES_PER_MB, MS_PER_DAY, MS_PER_SECOND, nowIso, sleep } from '../lib/units.js';
import { folderBytes } from '../lib/folder-size.js';
import { createKeyedLock } from '../lib/locks.js';
import {
  decryptGameSettings,
  gameSettingsView,
  mergeGameSettings,
  parseGamePlayers,
  missingGameFiles,
  prepareGameFiles,
  validateGameSettings,
} from '../games/settings.js';
import { pluginPackages } from './plugin-packages.js';
import { hostMemoryMb, refreshHostMemory } from '../system/host.js';
import { analyseCrash } from './crash.js';
import { createDownloadMeter, type DownloadProgress } from './steam-progress.js';
import {
  INSTALLED_MARK,
  SHARED_GAME_FILES,
  markInstalled,
  needsRuntime,
  seedGameFiles,
  seedRuntime,
  seedSource,
} from './game-seed.js';
import { isPanelNoise, isStartFinished, parseListAnswer, parseTps, playerEventOf } from './log-parse.js';
import {
  GAME_PORT_PURPOSE,
  buildContainerSpec,
  commandChannelFor,
  displayAddress,
  gamePorts,
  imageFor,
  serverDir,
  withSignalingPorts,
  type ServerRow,
} from './spec.js';

export type TunnelAddress = Partial<
  Pick<ServerRow, 'domain' | 'publicPort' | 'geyserPublicPort' | 'voicePublicPort' | 'netbirdName'>
>;

export interface ServerService {
  readonly init: () => Promise<void>;
  readonly shutdown: () => void;
  readonly list: (user: UserRow) => ServerSummary[];
  readonly row: (id: string) => ServerRow;
  readonly rowWithSecrets: (id: string) => ServerRow;
  readonly summary: (id: string) => ServerSummary;
  readonly detail: (id: string, user: UserRow) => ServerDetail;
  readonly create: (
    input: CreateServerInput,
    actor: Actor,
    creator: UserRow,
    options?: { readonly template?: boolean },
  ) => Promise<ServerSummary>;
  readonly createFromImport: (
    input: Omit<CreateServerInput, 'eula' | 'startNow'> & { id: string },
    actor: Actor,
    creator: UserRow,
  ) => ServerSummary;
  readonly update: (id: string, patch: UpdateServerInput, actor: Actor) => ServerSummary;
  /** Settings of another game; take effect at the next start. */
  readonly setGameSettings: (id: string, input: Readonly<Record<string, string>>, actor: Actor) => void;
  readonly remove: (id: string, deleteFiles: boolean, actor: Actor) => Promise<void>;
  readonly start: (id: string, actor: Actor) => Promise<void>;
  readonly stop: (id: string, actor: Actor) => Promise<void>;
  readonly restart: (id: string, actor: Actor) => Promise<void>;
  readonly kill: (id: string, actor: Actor) => Promise<void>;
  /** Stops and waits until the process is gone (backups, restores, world resets need that). */
  readonly stopAndWait: (id: string, actor: Actor) => Promise<boolean>;
  readonly command: (id: string, command: string, actor: Actor | null) => Promise<string>;
  /** Runs a command without showing it in the console (status polling, player list). */
  readonly quietCommand: (id: string, command: string) => Promise<string>;
  readonly live: (id: string) => ServerLive;
  readonly logs: (id: string) => readonly string[];
  /** A line from the panel itself in the server's console ("[MorniHosting] …"). */
  readonly note: (id: string, text: string) => void;
  /** How far the setup after an order is (the server page shows a setup screen until it is null). */
  readonly setSetup: (id: string, progress: SetupProgress | null) => void;
  readonly dir: (id: string) => string;
  /** The next free port after the server's own one (for the crash helper when the port is taken). */
  readonly nextFreePort: (id: string) => number;
  readonly isRunning: (id: string) => boolean;
  readonly setExtraPorts: (id: string, ports: ServerRow['extraPorts']) => void;
  readonly setGeyser: (id: string, enabled: boolean) => void;
  readonly setVoiceChat: (id: string, enabled: boolean, voicePublicPort: number | null) => void;
  /** Runs right before a container starts; the listener must not throw. */
  readonly onBeforeStart: (prepare: (id: string) => void) => () => void;
  /** Extra environment for the container, worked out just before each start (e.g. Geyser's public address). */
  readonly onStartEnv: (provide: (id: string) => Promise<Readonly<Record<string, string>>>) => void;
  /** Awaited after a server was created, before the answer goes out (e.g. NetBird sets up its address). */
  readonly onCreated: (listener: (id: string) => Promise<void>) => void;
  /** Called after a server's host ports changed (server port, Geyser, voice chat). */
  readonly onPortsChanged: (listener: (id: string) => void) => () => void;
  /** Address fields a tunnel integration (NetBird) keeps up to date. */
  readonly setTunnelAddress: (id: string, patch: TunnelAddress) => void;
  /** Lets the NetBird integration describe a server on its pages. */
  readonly describeNetbird: (provider: (row: ServerRow) => NetbirdServerInfo | null) => void;
  /** voice_host for Simple Voice Chat: the public name with the outside UDP port, or just the port. */
  readonly voiceHost: (id: string) => string;
  /** The first port from `start` upwards that no other server uses. */
  readonly freePort: (start: number, protocol: 'tcp' | 'udp', exceptId: string) => number;
  readonly newId: () => string;
  /** The quota rules (quota/service.ts) plug in here; without them nothing is limited. */
  readonly useQuota: (guard: QuotaGuard) => void;
  /** Throws when a new server of this size would not fit the person's quota (e.g. for a server request). */
  readonly checkNewServer: (owner: UserRow, memoryMb: number) => void;
}

/** Limits per person, checked whenever a server of theirs is created or made bigger. */
export interface QuotaGuard {
  /** CPU and disk limits for a new server: what the admin set, or what is left of the owner's quota. */
  readonly limitsFor: (
    owner: UserRow,
    wanted: { cpuLimit: number | null; diskLimitMb: number | null; memoryMb: number },
  ) => { cpuLimit: number | null; diskLimitMb: number | null };
  /** Throws when the owner's servers would need more than their quota allows. */
  readonly check: (
    owner: UserRow,
    serverId: string | null,
    next: { memoryMb: number; cpuLimit: number | null; diskLimitMb: number | null },
  ) => void;
  /** The person a server counts against (its owner), or null for admins' servers. */
  readonly ownerOf: (serverId: string) => UserRow | null;
}

interface Runtime {
  state: ServerState;
  players: Set<string>;
  playersMax: number;
  logs: string[];
  stopLogs: (() => void) | null;
  cpu: number | null;
  memMb: number | null;
  tps: number | null;
  diskMb: number | null;
  netRx: number | null;
  netTx: number | null;
  startedAt: string | null;
  progress: number | null;
  download: DownloadProgress | null;
  setup: SetupProgress | null;
  meter: (line: string) => DownloadProgress | null;
  stopRequested: boolean;
  /** Log lines that arrive before this time are history; they must not fire webhooks again. */
  quietUntil: number;
  /** Another game's catalog entry (its log lines read differently), null for Minecraft. */
  game: GameInfo | null;
}

const LOG_BUFFER_LINES = 1000;
/** Under the data folder: deleted servers wait here while they are removed in the background. */
const DISCARD_DIR = '.deleting';
/** How many ports above the wanted one are tried when looking for a free one. */
const PORT_SEARCH_LIMIT = 100;
const ATTACH_TAIL_LINES = 300;
const STATS_INTERVAL_SECONDS = 10;
/** Always-on: how often down servers are looked for, and the waits between restart tries. */
const KEEP_ALIVE_EVERY_MS = 5_000;
const KEEP_ALIVE_WAITS_MS: readonly number[] = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];
/** Running this long in one go counts as healthy again: the next crash starts with short waits. */
const KEEP_ALIVE_RESET_MS = 600_000;
const SECONDS_PER_MINUTE = 60;
/** RAM kept free for the panel, Docker and the system when servers start. */
const HOST_RESERVE_MB = 768;
/** Below this much free disk no server starts (worlds and backups would fail to save). */
const MIN_FREE_DISK_MB = 1024;
/** Images the servers use are checked for a newer version this often (the driver pulls at most once a day). */
const IMAGE_REFRESH_EVERY_MS = MS_PER_DAY / 2;
/** Harmless command that every Source-engine console answers. */
const READY_PROBE_COMMAND = 'status';
const TPS_EVERY_TICKS = 3;
const LIST_EVERY_TICKS = 6;
const PERSIST_EVERY_TICKS = 6;
/** The folder size is measured once a minute (it walks every file). */
const DISK_EVERY_TICKS = 6;
const STATS_RETENTION_DAYS = 7;
const STOP_TIMEOUT_SECONDS = 60;
const DOCKER_STOP_GRACE_SECONDS = 30;
const STOP_UNCONFIRMED_SECONDS = 20;
const POLL_INTERVAL_MS = 500;
const REPLAY_QUIET_MS = 3000;
/** A container already running this long when the panel starts counts as up (no ready line needed). */
const RECONCILE_RUNNING_AFTER_MS = 180_000;
const CRASH_EXCERPT_LINES = 12;
const DIE_SETTLE_MS = 750;
/** Old statistics are pruned once an hour (360 ticks of 10 seconds). */
const PURGE_EVERY_TICKS = 360;
const ID_BYTES = 5;
const RCON_PASSWORD_BYTES = 18;
const DEFAULT_MAX_PLAYERS = 20;
const ECHO_PREFIX = '\u001b[36m> ';
/** Extra port entry of Simple Voice Chat (see voicechat/service.ts). */
export const VOICE_PURPOSE = 'voicechat';
export const GEYSER_PURPOSE = 'geyser';
const ANSI_RESET = '\u001b[0m';
const PANEL_PREFIX = '\u001b[33m[MorniHosting]\u001b[0m ';

const ACTIVE_STATES: readonly ServerState[] = ['starting', 'running'];

function emptyRuntime(): Runtime {
  return {
    state: 'stopped',
    players: new Set(),
    playersMax: DEFAULT_MAX_PLAYERS,
    logs: [],
    stopLogs: null,
    cpu: null,
    memMb: null,
    tps: null,
    diskMb: null,
    netRx: null,
    netTx: null,
    startedAt: null,
    progress: null,
    download: null,
    setup: null,
    meter: createDownloadMeter(),
    stopRequested: false,
    quietUntil: 0,
    game: null,
  };
}

/** Ready and join/leave lines: the game's own patterns, otherwise Minecraft's. */
function readyLine(game: GameInfo | null, line: string): boolean {
  return game ? game.logPatterns.ready.test(line) : isStartFinished(line);
}

function playerLine(game: GameInfo | null, line: string): { kind: 'join' | 'leave'; player: string } | null {
  if (!game) return playerEventOf(line);
  const joined = game.logPatterns.join ? line.match(game.logPatterns.join)?.[1] : undefined;
  if (joined) return { kind: 'join', player: joined };
  const left = game.logPatterns.leave ? line.match(game.logPatterns.leave)?.[1] : undefined;
  return left ? { kind: 'leave', player: left } : null;
}

export function createServerService(ctx: AppContext): ServerService {
  const { db, config, docker, events, settings, audit, secrets, log } = ctx;
  const runtimes = new Map<string, Runtime>();
  const timers: {
    stats: NodeJS.Timeout | null;
    images: NodeJS.Timeout | null;
    keepAlive: NodeJS.Timeout | null;
    tick: number;
  } = {
    stats: null,
    images: null,
    keepAlive: null,
    tick: 0,
  };

  /** Every image the servers use stays current in the background, so starting never waits for a download. */
  const refreshImages = (): void => {
    const images = new Set(
      db
        .select({ image: servers.image })
        .from(servers)
        .all()
        .map((r) => r.image),
    );
    images.forEach((image) => {
      void (async () => {
        try {
          await docker.ensureImage(image);
        } catch (err) {
          log.debug({ err, image }, 'image refresh failed');
        }
      })();
    });
  };
  const unsubscribers: (() => void)[] = [];

  const rt = (id: string): Runtime => {
    const existing = runtimes.get(id);
    if (existing) return existing;
    const fresh = emptyRuntime();
    runtimes.set(id, fresh);
    return fresh;
  };

  const row = (id: string): ServerRow => {
    const found = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!found) throw notFound('server_not_found');
    return found;
  };

  const rowWithSecrets = (id: string): ServerRow => {
    const r = row(id);
    return {
      ...r,
      rconPassword: secrets.decrypt(r.rconPassword),
      gameSettings: decryptGameSettings(r, secrets),
    };
  };

  const live = (id: string): ServerLive => {
    const r = rt(id);
    return {
      state: r.state,
      playersOnline: r.players.size,
      playersMax: r.playersMax,
      players: [...r.players].sort((a, b) => a.localeCompare(b)),
      cpuPercent: r.cpu,
      memoryMb: r.memMb,
      tps: r.tps,
      diskMb: r.diskMb,
      netRxBytes: r.netRx,
      netTxBytes: r.netTx,
      startedAt: r.startedAt,
      progress: r.progress,
      download: r.download
        ? {
            doneBytes: r.download.doneBytes,
            totalBytes: r.download.totalBytes,
            bytesPerSecond: r.download.bytesPerSecond,
          }
        : null,
      setup: r.setup,
    };
  };

  const publishLive = (id: string): void => events.emit('server.live', { serverId: id, live: live(id) });

  const setState = (id: string, state: ServerState): void => {
    const r = rt(id);
    const previous = r.state;
    if (previous === state) return;
    r.state = state;
    if (!ACTIVE_STATES.includes(state)) {
      r.players.clear();
      r.cpu = null;
      r.memMb = null;
      r.tps = null;
      r.progress = null;
    }
    if (state === 'running') {
      r.progress = null;
      r.download = null;
      // Its files are complete now: other servers of the same kind may copy them (games and Minecraft alike).
      markInstalled(serverDir(config, id));
    }
    events.emit('server.state', { serverId: id, state, previous });
    publishLive(id);
  };

  const appendLog = (id: string, line: string): void => {
    const r = rt(id);
    r.logs.push(line);
    if (r.logs.length > LOG_BUFFER_LINES) r.logs.splice(0, r.logs.length - LOG_BUFFER_LINES);
    events.emit('server.log', { serverId: id, line });
  };

  const panelLog = (id: string, text: string): void => appendLog(id, PANEL_PREFIX + text);

  const handleLine = (id: string, line: string): void => {
    if (isPanelNoise(line)) return;
    appendLog(id, line);
    const r = rt(id);
    if (r.state === 'starting' && readyLine(r.game, line)) setState(id, 'running');
    if (r.game && r.state === 'starting') {
      const download = r.meter(line);
      if (download) {
        r.download = download;
        r.progress = Math.floor(download.percent);
        publishLive(id);
      }
    }
    const player = playerLine(r.game, line);
    if (!player) return;
    const quiet = Date.now() < r.quietUntil;
    if (player.kind === 'join') r.players.add(player.player);
    else r.players.delete(player.player);
    if (!quiet)
      events.emit(player.kind === 'join' ? 'player.joined' : 'player.left', {
        serverId: id,
        player: player.player,
      });
    publishLive(id);
  };

  const detachLogs = (id: string): void => {
    const r = rt(id);
    r.stopLogs?.();
    r.stopLogs = null;
  };

  const attachLogs = async (id: string, containerId: string, tail: number | 'all'): Promise<void> => {
    detachLogs(id);
    rt(id).game = gameOf(row(id).software);
    const stop = await docker.followLogs(containerId, tail, (line) => handleLine(id, line));
    rt(id).stopLogs = stop;
  };

  const withLock = createKeyedLock();
  /** Features that keep files in sync with the panel (e.g. voice chat) refresh them here. */
  const beforeStart = new Set<(id: string) => void>();
  const startEnv = new Set<(id: string) => Promise<Readonly<Record<string, string>>>>();
  let quota: QuotaGuard | null = null;
  const portListeners = new Set<(id: string) => void>();
  const createdListeners = new Set<(id: string) => Promise<void>>();
  const portsChanged = (id: string): void => portListeners.forEach((listener) => listener(id));
  // NetBird or the own-domain DNS automation describe a server's address; whichever is set up answers.
  const addressDescribers = new Set<(row: ServerRow) => NetbirdServerInfo | null>();
  const describeAddress = (row: ServerRow): NetbirdServerInfo | null =>
    [...addressDescribers].map((d) => d(row)).find((info) => info !== null) ?? null;

  const addressOf = (r: ServerRow): string => {
    const s = settings.get();
    const name = r.domain || s.publicAddress;
    // A tunnel's own port only belongs to the public name; at home the server port is right.
    const port = name ? (r.publicPort ?? r.port) : r.port;
    return displayAddress(name || s.lanIp || 'localhost', port, SOFTWARE[r.software].defaultPort);
  };

  const voiceHostOf = (r: ServerRow): string => {
    const name = r.domain || settings.get().publicAddress;
    const hostPort = r.extraPorts.find((p) => p.purpose === VOICE_PURPOSE)?.port ?? PORT_VOICE_CHAT;
    const port = r.voicePublicPort ?? hostPort;
    return name ? `${name}:${port}` : String(port);
  };

  const gameOfRow = (r: ServerRow): GameInfo | null => gameOf(r.software);

  const summaryOf = (r: ServerRow): ServerSummary => ({
    id: r.id,
    name: r.name,
    edition: r.edition,
    software: r.software,
    version: r.version,
    memoryMb: r.memoryMb,
    cpuLimit: r.cpuLimit,
    diskLimitMb: r.diskLimitMb,
    port: r.port,
    address: addressOf(r),
    autoStart: r.autoStart,
    hasIcon: fs.existsSync(path.join(serverDir(config, r.id), 'server-icon.png')),
    live: live(r.id),
    crash: r.crash ?? null,
    createdAt: r.createdAt,
  });

  /** Ports a game uses with the main port's number but the other protocol (they are not stored). */
  const sameAsMainPorts = (o: ServerRow): { port: number; protocol: 'tcp' | 'udp' }[] =>
    (gameOf(o.software)?.ports ?? [])
      .filter((p) => p.sameAsMain)
      .map((p) => ({ port: o.port, protocol: p.protocol }));

  const assertPortFree = (port: number, protocol: 'tcp' | 'udp', exceptId: string | null): void => {
    const others = db
      .select()
      .from(servers)
      .where(exceptId ? ne(servers.id, exceptId) : undefined)
      .all();
    const taken = others.find(
      (o) =>
        (o.port === port && SOFTWARE[o.software].protocol === protocol) ||
        withSignalingPorts(o.extraPorts).some((p) => p.port === port && p.protocol === protocol) ||
        sameAsMainPorts(o).some((p) => p.port === port && p.protocol === protocol),
    );
    if (taken) throw conflict('port_taken', { port, server: taken.name });
  };

  const newId = (): string => randomBytes(ID_BYTES).toString('hex');

  /**
   * The first free main port from `start` on: free for the server's own protocol and, for games that use the same
   * number on the other protocol too, for that one as well. A taken port is never an error when creating — the
   * next free one is used.
   */
  const firstFreeMainPort = (start: number, protocol: 'tcp' | 'udp', game: GameInfo | null): number => {
    const sameAs = (game?.ports ?? []).filter((p) => p.sameAsMain).map((p) => p.protocol);
    const fits = (port: number): boolean =>
      portFree(port, protocol, null) && sameAs.every((other) => portFree(port, other, null));
    const found = Array.from({ length: PORT_SEARCH_LIMIT }, (_, i) => start + i).find(fits);
    if (found === undefined) throw conflict('port_taken', { port: start, server: '' });
    return found;
  };

  /** Extra ports of other games: one per catalog port besides the main one, each on a free host port. */
  const allocateGamePorts = (game: GameInfo, mainPort: number): ServerRow['extraPorts'] =>
    game.ports.slice(1).reduce<ServerRow['extraPorts']>((acc, p) => {
      if (p.sameAsMain) {
        assertPortFree(mainPort, p.protocol, null);
        return acc;
      }
      const isFree = (port: number): boolean =>
        port !== mainPort &&
        !acc.some((a) => a.port === port && a.protocol === p.protocol) &&
        portFree(port, p.protocol, null);
      const port = Array.from({ length: PORT_SEARCH_LIMIT }, (_, i) => p.defaultPort + i).find(isFree);
      if (port === undefined) throw conflict('port_taken', { port: p.defaultPort, server: '' });
      return [...acc, { port, protocol: p.protocol, purpose: `${GAME_PORT_PURPOSE}${p.key}` }];
    }, []);

  const portFree = (port: number, protocol: 'tcp' | 'udp', exceptId: string | null): boolean => {
    try {
      assertPortFree(port, protocol, exceptId);
      return true;
    } catch {
      return false;
    }
  };

  const grantOwner = (creator: UserRow, serverId: string): void => {
    if (creator.isAdmin) return;
    const owner = db.select().from(roles).where(eq(roles.builtIn, 'owner')).get();
    if (owner) db.insert(serverAccess).values({ userId: creator.id, serverId, roleId: owner.id }).run();
  };

  const startError = (id: string, err: unknown): void => {
    const message = errorMessage(err);
    // Docker reports a taken host port as "port is already allocated" or "address already in use".
    const portTaken =
      message.includes('port is already allocated') || message.includes('address already in use');
    const crash = {
      at: nowIso(),
      ruleId: portTaken ? 'port-in-use' : 'start-failed',
      params: { message },
      excerpt: rt(id).logs.slice(-CRASH_EXCERPT_LINES),
    };
    db.update(servers).set({ crash }).where(eq(servers.id, id)).run();
    panelLog(id, `Start fehlgeschlagen: ${message}`);
    setState(id, 'crashed');
    events.emit('server.crashed', { serverId: id, crash });
  };

  /** A second CS2/GMod server copies the game from the first one instead of downloading 60 GB again. */
  /** A new Minecraft server takes the finished server program of one with the same software and version. */
  const seedRuntimeFromSibling = async (id: string, row: ServerRow): Promise<void> => {
    if (gameOf(row.software) || row.software === 'bedrock') return;
    const target = serverDir(config, id);
    if (!needsRuntime(target)) return;
    const twin = db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(and(eq(servers.software, row.software), eq(servers.version, row.version)))
      .all()
      .find((s) => s.id !== id && fs.existsSync(path.join(serverDir(config, s.id), INSTALLED_MARK)));
    if (!twin) return;
    const started = Date.now();
    try {
      const bytes = await seedRuntime(serverDir(config, twin.id), target);
      const seconds = ((Date.now() - started) / MS_PER_SECOND).toFixed(1);
      panelLog(
        id,
        `⚡ Server-Programm von „${twin.name}“ übernommen (${Math.round(bytes / BYTES_PER_MB)} MB in ${seconds} s) – kein Download nötig.`,
      );
    } catch (err) {
      log.warn({ err, serverId: id }, 'server program not copied');
    }
  };

  const seedFromSibling = async (id: string, software: ServerRow['software']): Promise<void> => {
    if (!gameOf(software)) return;
    // Preloaded templates hold nothing but the game, so every game may copy from them; real servers only
    // for games whose folder holds nothing but game files.
    const shared = SHARED_GAME_FILES.has(software);
    const others = db
      .select({ id: servers.id, name: servers.name, template: servers.template })
      .from(servers)
      .where(eq(servers.software, software))
      .all()
      .filter((s) => s.id !== id && (shared || s.template))
      .sort((a, b) => Number(b.template) - Number(a.template));
    const source = seedSource(
      serverDir(config, id),
      others.map((s) => serverDir(config, s.id)),
    );
    if (!source) return;
    const from = others.find((s) => serverDir(config, s.id) === source);
    panelLog(id, `Kopiere die Spieldateien von „${from?.name ?? ''}“ – das spart den großen Download …`);
    const started = Date.now();
    try {
      const bytes = await seedGameFiles(source, serverDir(config, id));
      const BYTES_PER_GB = 1024 ** 3;
      const seconds = Math.round((Date.now() - started) / 1000);
      panelLog(
        id,
        `✓ ${(bytes / BYTES_PER_GB).toFixed(1)} GB in ${seconds} s kopiert. Steam lädt jetzt nur noch Neuerungen.`,
      );
    } catch (err) {
      panelLog(
        id,
        `Kopieren hat nicht geklappt (${errorMessage(err)}) – der Server lädt die Dateien von Steam.`,
      );
    }
  };

  const bootContainer = async (id: string): Promise<void> => {
    const r = rowWithSecrets(id);
    const runtime = rt(id);
    runtime.stopRequested = false;
    runtime.progress = 0;
    setState(id, 'starting');
    // Other games' "version" is an image choice ("stable", "steam"); the name says enough.
    const what = gameOf(r.software)
      ? SOFTWARE[r.software].label
      : `${SOFTWARE[r.software].label} ${r.version}`;
    panelLog(id, `Server wird gestartet (${what}) …`);
    beforeStart.forEach((prepare) => prepare(id));
    await docker.ensureNetwork(config.mcNetwork);
    await docker.ensureImage(r.image, (percent) => {
      const current = rt(id);
      if (percent !== null && percent !== current.progress) {
        current.progress = percent;
        publishLive(id);
      }
    });
    if (r.containerId) await docker.removeContainer(r.containerId);
    fs.mkdirSync(serverDir(config, id), { recursive: true });
    await seedFromSibling(id, r.software);
    await seedRuntimeFromSibling(id, r);
    const missing = missingGameFiles(serverDir(config, id), r.software);
    if (missing.length) throw new Error(`Es fehlen Dateien: ${missing.join(', ')}`);
    prepareGameFiles(serverDir(config, id), r);
    const built = buildContainerSpec(config, r, settings.get().timezone);
    const extra = await Promise.all(
      [...startEnv].map((provide) =>
        provide(id).catch((err: unknown) => {
          log.warn({ err, serverId: id }, 'start environment not added');
          return {};
        }),
      ),
    );
    const spec = { ...built, env: Object.assign({}, built.env, ...extra) as Record<string, string> };
    const containerId = await docker.createContainer(spec);
    db.update(servers)
      .set({ containerId, crash: null, desiredRunning: true, updatedAt: nowIso() })
      .where(eq(servers.id, id))
      .run();
    await docker.start(containerId);
    // Attach after starting: a container that never ran has no live log stream yet.
    await attachLogs(id, containerId, 'all');
    rt(id).startedAt = nowIso();
    rt(id).progress = null;
    publishLive(id);
  };

  const startInternal = async (id: string): Promise<void> => {
    if (rt(id).state === 'running') return;
    try {
      await bootContainer(id);
    } catch (err) {
      log.warn({ err, serverId: id }, 'server start failed');
      startError(id, err);
    }
  };

  const waitForExit = async (containerId: string, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    const poll = async (): Promise<boolean> => {
      const state = await docker.inspect(containerId);
      if (!state?.running) return true;
      if (Date.now() > deadline) return false;
      await sleep(POLL_INTERVAL_MS);
      return poll();
    };
    return poll();
  };

  const stopInternal = async (id: string): Promise<boolean> => {
    const r = rowWithSecrets(id);
    const runtime = rt(id);
    db.update(servers).set({ desiredRunning: false }).where(eq(servers.id, id)).run();
    if (!r.containerId || !ACTIVE_STATES.includes(runtime.state)) {
      setState(id, 'stopped');
      return true;
    }
    runtime.stopRequested = true;
    setState(id, 'stopping');
    panelLog(id, 'Server wird sauber heruntergefahren: Welt speichern, dann stoppen …');
    const channel = commandChannelFor(r);
    const game = gameOf(r.software);
    if (game) return stopGame(id, r, game);
    const began = Date.now();
    // "stop" saves the world itself; an extra "save-all" before only doubled the waiting.
    const delivered = await (async (): Promise<boolean> => {
      try {
        await docker.sendCommand(r.containerId ?? '', SOFTWARE[r.software].proxy ? 'end' : 'stop', channel);
        return true;
      } catch (err) {
        // Already gone counts as done; still running gets Docker's stop below (the image saves on SIGTERM too).
        log.info({ err, serverId: id }, 'stop command not confirmed');
        return (await docker.inspect(r.containerId ?? ''))?.running !== true;
      }
    })();
    // Unconfirmed often only means RCON closed while the server was already shutting down: give it a short while
    // to finish saving instead of cutting it off (a cut-off save broke the next start).
    const exited = await waitForExit(
      r.containerId,
      (delivered ? STOP_TIMEOUT_SECONDS : STOP_UNCONFIRMED_SECONDS) * MS_PER_SECOND,
    );
    if (!exited) await docker.stop(r.containerId, DOCKER_STOP_GRACE_SECONDS);
    panelLog(id, `Server ist aus (nach ${Math.round((Date.now() - began) / MS_PER_SECOND)} Sekunden).`);
    setState(id, 'stopped');
    return exited;
  };

  /** Other games: save and quit through the console if they have one, otherwise SIGTERM with time to save. */
  const stopGame = async (id: string, r: ServerRow, game: GameInfo): Promise<boolean> => {
    const containerId = r.containerId ?? '';
    const channel = commandChannelFor(r);
    try {
      if (game.saveCommand) await docker.sendCommand(containerId, game.saveCommand, channel);
      if (game.stopCommand) await docker.sendCommand(containerId, game.stopCommand, channel);
    } catch (err) {
      log.info({ err, serverId: id }, 'stop command not delivered, falling back to docker stop');
    }
    if (!game.stopCommand) await docker.stop(containerId, STOP_TIMEOUT_SECONDS);
    const exited = await waitForExit(containerId, STOP_TIMEOUT_SECONDS * MS_PER_SECOND);
    if (!exited) await docker.stop(containerId, DOCKER_STOP_GRACE_SECONDS);
    setState(id, 'stopped');
    return exited;
  };

  const onContainerDied = async (containerId: string): Promise<void> => {
    const r = db.select().from(servers).where(eq(servers.containerId, containerId)).get();
    if (!r) return;
    const runtime = rt(r.id);
    // The die event can overtake the last log lines; give the log stream a moment to drain.
    await sleep(DIE_SETTLE_MS);
    // During a restart the next container may already be running; this exit is old news then.
    const current = db
      .select({ containerId: servers.containerId })
      .from(servers)
      .where(eq(servers.id, r.id))
      .get();
    if (current?.containerId !== containerId) return;
    detachLogs(r.id);
    if (runtime.stopRequested || runtime.state === 'stopped') {
      setState(r.id, 'stopped');
      return;
    }
    const state = await docker.inspect(containerId);
    const packages = await pluginPackages(serverDir(config, r.id));
    const crash = analyseCrash({
      packages,
      lines: runtime.logs,
      oomKilled: state?.oomKilled ?? false,
      exitCode: state?.exitCode ?? null,
      memoryMb: r.memoryMb,
      javaTag: r.javaTag,
    });
    db.update(servers).set({ crash }).where(eq(servers.id, r.id)).run();
    panelLog(r.id, 'Der Server wurde unerwartet beendet. Der Absturz-Helfer zeigt dir die Ursache.');
    setState(r.id, 'crashed');
    events.emit('server.crashed', { serverId: r.id, crash });
  };

  /**
   * Crash protection for the whole machine: a server only starts when the RAM of all running servers still fits
   * into the machine (with room for the panel and Docker) and the disk has some space left. Otherwise the machine
   * would swap until everything hangs, or fill up until nothing can save anymore.
   */
  const guardHost = async (r: ServerRow): Promise<void> => {
    // The machine may have got more RAM meanwhile (pct set …): ask again instead of trusting an old number.
    await refreshHostMemory(docker);
    const hostMb = hostMemoryMb();
    const othersMb = db
      .select()
      .from(servers)
      .all()
      .filter((other) => other.id !== r.id && ACTIVE_STATES.includes(rt(other.id).state))
      .reduce((sum, other) => sum + other.memoryMb, 0);
    if (hostMb > 0 && othersMb + r.memoryMb + HOST_RESERVE_MB > hostMb)
      throw conflict('host_memory_full', {
        need: r.memoryMb,
        free: Math.max(0, hostMb - othersMb - HOST_RESERVE_MB),
        total: hostMb,
      });
    const freeMb = (() => {
      try {
        const s = fs.statfsSync(config.dataDir);
        return (s.bavail * s.bsize) / BYTES_PER_MB;
      } catch {
        return null;
      }
    })();
    if (freeMb !== null && freeMb < MIN_FREE_DISK_MB)
      throw conflict('host_disk_full', { free: Math.round(freeMb) });
  };

  const quietCommand = async (id: string, command: string): Promise<string> => {
    const r = rowWithSecrets(id);
    if (!r.containerId || !ACTIVE_STATES.includes(rt(id).state)) throw conflict('server_not_running');
    return docker.sendCommand(r.containerId, command, commandChannelFor(r));
  };

  const syncPlayers = async (id: string): Promise<void> => {
    const answer = parseListAnswer(await quietCommand(id, 'list'));
    if (!answer) return;
    const runtime = rt(id);
    runtime.players = new Set(answer.players);
    runtime.playersMax = answer.max;
  };

  const syncGamePlayers = async (id: string, game: GameInfo): Promise<void> => {
    const names = parseGamePlayers(game, await quietCommand(id, game.listCommand ?? ''));
    if (!names) return;
    const runtime = rt(id);
    runtime.players = new Set(names);
    runtime.playersMax = game.maxPlayers;
  };

  const probeReady = async (id: string, game: GameInfo | null): Promise<void> => {
    try {
      await quietCommand(id, game?.listCommand ?? READY_PROBE_COMMAND);
      if (rt(id).state === 'starting') setState(id, 'running');
    } catch {
      // Not listening yet: still downloading or loading.
    }
  };

  const sampleTps = async (id: string, r: ServerRow): Promise<void> => {
    const command = SOFTWARE[r.software].tpsCommand;
    if (!command) return;
    const tps = parseTps(await quietCommand(id, command));
    if (tps !== null) rt(id).tps = tps;
  };

  const sampleOne = async (r: ServerRow, tick: number): Promise<void> => {
    if (!r.containerId) return;
    const runtime = rt(r.id);
    const s = await docker.stats(r.containerId);
    if (s) {
      runtime.cpu = s.cpuPercent;
      runtime.memMb = s.memoryBytes / BYTES_PER_MB;
      runtime.netRx = s.rxBytes;
      runtime.netTx = s.txBytes;
    }
    const isRunningJava = runtime.state === 'running' && r.edition === 'java' && !SOFTWARE[r.software].proxy;
    if (isRunningJava && !(tick % TPS_EVERY_TICKS)) await sampleTps(r.id, r);
    if (isRunningJava && !(tick % LIST_EVERY_TICKS)) await syncPlayers(r.id);
    if (runtime.state === 'running' && runtime.game?.listCommand && !(tick % LIST_EVERY_TICKS))
      await syncGamePlayers(r.id, runtime.game);
    // Some games print their "ready" line late or not at all (Garry's Mod buffers its output):
    // once their remote console answers, they are up.
    // Minecraft Java too: after a panel restart the "Done" line may be long gone from the log, so the server would
    // stay on "starting" for ever although it runs. Its RCON only answers once the world is loaded.
    const answersRcon =
      runtime.game?.console === 'rcon' || (r.edition === 'java' && !SOFTWARE[r.software].proxy);
    if (runtime.state === 'starting' && answersRcon) await probeReady(r.id, runtime.game ?? null);
    if (!(tick % PERSIST_EVERY_TICKS)) {
      db.insert(stats)
        .values({
          serverId: r.id,
          at: Date.now(),
          cpu: runtime.cpu,
          memMb: runtime.memMb,
          players: runtime.players.size,
          tps: runtime.tps,
        })
        .run();
    }
    publishLive(r.id);
  };

  /**
   * Always-on: a server that should run (started and never stopped by a person, "start automatically" on) but is
   * down – crashed, failed to start, its container gone – starts again by itself. Waits grow after each try
   * (10 s … 30 min), so a server that cannot start does not hammer the machine; after it ran 10 minutes
   * in one go the count starts over.
   */
  const revive = new Map<string, { tries: number; nextAt: number }>();
  const keepAlive = async (): Promise<void> => {
    const now = Date.now();
    const rows = db.select().from(servers).all();
    rows.forEach((r) => {
      const state = rt(r.id).state;
      const since = rt(r.id).startedAt ? Date.parse(rt(r.id).startedAt ?? '') : 0;
      if (state === 'running' && since && now - since > KEEP_ALIVE_RESET_MS && revive.has(r.id)) {
        revive.delete(r.id);
        events.emit('server.revive', { serverId: r.id, tries: 0, reason: null });
      }
    });
    const down = rows.filter(
      (r) =>
        !r.template &&
        r.desiredRunning &&
        r.autoStart &&
        !rt(r.id).stopRequested &&
        (rt(r.id).state === 'crashed' || rt(r.id).state === 'stopped'),
    );
    await Promise.all(
      down.map(async (r) => {
        const plan = revive.get(r.id) ?? { tries: 0, nextAt: now + (KEEP_ALIVE_WAITS_MS[0] ?? 0) };
        if (!revive.has(r.id)) {
          revive.set(r.id, plan);
          panelLog(
            r.id,
            `Dauerbetrieb: Der Server ist aus, sollte aber laufen – er startet in ${Math.round((KEEP_ALIVE_WAITS_MS[0] ?? 0) / MS_PER_SECOND)} Sekunden von selbst neu.`,
          );
          return;
        }
        if (now < plan.nextAt) return;
        const tries = plan.tries + 1;
        const wait = KEEP_ALIVE_WAITS_MS[Math.min(tries, KEEP_ALIVE_WAITS_MS.length - 1)] ?? 0;
        revive.set(r.id, { tries, nextAt: now + wait });
        panelLog(r.id, `Dauerbetrieb: starte den Server neu (Versuch ${tries}) …`);
        try {
          await service.start(r.id, SYSTEM_ACTOR);
        } catch (err) {
          events.emit('server.revive', {
            serverId: r.id,
            tries,
            reason: errorMessage(err),
            ...(err instanceof AppError ? { code: err.code, params: err.params ?? {} } : {}),
          });
          panelLog(
            r.id,
            `Dauerbetrieb: Start ging nicht (${errorMessage(err)}). Nächster Versuch in ${Math.round(wait / MS_PER_SECOND / SECONDS_PER_MINUTE) || 1} Min.`,
          );
        }
      }),
    );
  };

  const sampleAll = async (): Promise<void> => {
    timers.tick += 1;
    const tick = timers.tick;
    const active = db
      .select()
      .from(servers)
      .all()
      .filter((r) => ACTIVE_STATES.includes(rt(r.id).state));
    await Promise.all(
      active.map(async (r) => {
        try {
          await sampleOne(r, tick);
        } catch (err) {
          log.debug({ err, serverId: r.id }, 'stats sample failed');
        }
      }),
    );
    if (tick % DISK_EVERY_TICKS === 1) {
      await Promise.all(
        db
          .select({ id: servers.id })
          .from(servers)
          .all()
          .map(async ({ id }) => {
            rt(id).diskMb = (await folderBytes(serverDir(config, id))) / BYTES_PER_MB;
          }),
      );
    }
    if (!(tick % PURGE_EVERY_TICKS)) {
      db.delete(stats)
        .where(lt(stats.at, Date.now() - STATS_RETENTION_DAYS * MS_PER_DAY))
        .run();
    }
  };

  const reconcile = async (r: ServerRow): Promise<void> => {
    const state = r.containerId ? await docker.inspect(r.containerId) : null;
    if (state?.running && r.containerId) {
      const runtime = rt(r.id);
      runtime.state = 'starting';
      runtime.startedAt = state.startedAt;
      runtime.quietUntil = Date.now() + REPLAY_QUIET_MS;
      await attachLogs(r.id, r.containerId, ATTACH_TAIL_LINES);
      // Kept running while the panel was away (update): it was up long before, so it counts as running now –
      // servers without a remote console would otherwise wait for a "ready" line that already went by.
      const upFor = Date.now() - Date.parse(state.startedAt ?? '');
      if (runtime.state === 'starting' && upFor > RECONCILE_RUNNING_AFTER_MS) setState(r.id, 'running');
      return;
    }
    if (r.desiredRunning && r.autoStart) await withLock(r.id, () => startInternal(r.id));
  };

  const ensureBuiltinRoles = (): void => {
    BUILTIN_ROLES.forEach((role) => {
      const existing = db.select().from(roles).where(eq(roles.builtIn, role.key)).get();
      if (!existing) {
        db.insert(roles)
          .values({ name: role.key, description: '', permissions: [...role.permissions], builtIn: role.key })
          .run();
      }
    });
  };

  /** Folders being deleted in the background; a restart finishes what was left. */
  const discardDir = path.join(config.dataDir, DISCARD_DIR);
  const deleteQuietly = (dir: string): void => {
    fs.promises
      .rm(dir, { recursive: true, force: true })
      .catch((err: unknown) => log.warn({ err, dir }, 'could not delete a removed folder'));
  };
  const discardLater = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    fs.mkdirSync(discardDir, { recursive: true });
    const aside = path.join(
      discardDir,
      `${path.basename(path.dirname(dir))}-${path.basename(dir)}-${Date.now()}`,
    );
    try {
      fs.renameSync(dir, aside);
      deleteQuietly(aside);
    } catch (err) {
      log.warn({ err, dir }, 'could not move a folder aside, deleting it in place');
      deleteQuietly(dir);
    }
  };
  if (fs.existsSync(discardDir))
    fs.readdirSync(discardDir).forEach((name) => deleteQuietly(path.join(discardDir, name)));

  const service: ServerService = {
    init: async () => {
      ensureBuiltinRoles();
      unsubscribers.push(
        docker.onContainerEvent((event) => {
          if (event.action !== 'die') return;
          void (async () => {
            try {
              await onContainerDied(event.containerId);
            } catch (err) {
              log.error({ err }, 'handling container exit failed');
            }
          })();
        }),
      );
      try {
        await docker.ensureNetwork(config.mcNetwork);
      } catch (err) {
        log.warn({ err }, 'docker not reachable at startup');
      }
      const all = db.select().from(servers).all();
      await Promise.all(
        all.map(async (r) => {
          try {
            await reconcile(r);
          } catch (err) {
            log.warn({ err, serverId: r.id }, 'could not reconcile server');
          }
        }),
      );
      timers.stats = setInterval(() => {
        void sampleAll();
      }, STATS_INTERVAL_SECONDS * MS_PER_SECOND);
      refreshImages();
      timers.images = setInterval(refreshImages, IMAGE_REFRESH_EVERY_MS);
      timers.keepAlive = setInterval(() => {
        void (async () => {
          try {
            await keepAlive();
          } catch (err) {
            log.warn({ err }, 'keep-alive check failed');
          }
        })();
      }, KEEP_ALIVE_EVERY_MS);
      timers.images.unref();
    },
    shutdown: () => {
      if (timers.stats) clearInterval(timers.stats);
      if (timers.images) clearInterval(timers.images);
      if (timers.keepAlive) clearInterval(timers.keepAlive);
      unsubscribers.forEach((u) => u());
      [...runtimes.keys()].forEach(detachLogs);
    },
    list: (user) => {
      const visible = ctx.access.visibleServerIds(user);
      return db
        .select()
        .from(servers)
        .all()
        .filter((r) => !r.template && (visible === 'all' || visible.has(r.id)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(summaryOf);
    },
    row,
    rowWithSecrets,
    summary: (id) => summaryOf(row(id)),
    detail: (id, user) => {
      const r = row(id);
      return {
        ...summaryOf(r),
        javaTag: r.javaTag,
        domain: r.domain,
        image: r.image,
        geyser: r.geyser,
        geyserPort: r.geyser ? (r.extraPorts.find((p) => p.purpose === GEYSER_PURPOSE)?.port ?? null) : null,
        geyserPublicPort: r.geyser ? r.geyserPublicPort : null,
        publicPort: r.publicPort,
        voiceChat: r.voiceChat,
        voicePort: r.voiceChat ? (r.extraPorts.find((p) => p.purpose === VOICE_PURPOSE)?.port ?? null) : null,
        voicePublicPort: r.voicePublicPort,
        voiceHost: r.voiceChat ? voiceHostOf(r) : null,
        netbird: describeAddress(r),
        permissions: ctx.access.permissionsFor(user, id),
        gameSettings: gameSettingsView(r),
        gamePorts: gameOfRow(r)
          ? gamePorts(r, gameOfRow(r) as GameInfo).map((p) => ({
              key: p.key,
              port: p.hostPort,
              protocol: p.protocol,
            }))
          : [],
      };
    },
    create: async (input, actor, creator, options) => {
      const template = options?.template === true;
      const info = SOFTWARE[input.software];
      if (!CREATABLE_SOFTWARE[input.edition].includes(input.software))
        throw badRequest('software_edition_mismatch');
      const game = gameOf(input.software);
      if (game) validateGameSettings(game, input.gameSettings ?? {});
      const port = firstFreeMainPort(input.port, info.protocol, game);
      const extraPorts = game ? allocateGamePorts(game, port) : [];
      const gameSettings = game ? mergeGameSettings(game, {}, input.gameSettings ?? {}, secrets) : {};
      // Only admins may publish a server through the admin's NetBird account.
      const netbirdName = creator.isAdmin ? (input.netbirdName ?? null) : null;
      if (netbirdName && db.select().from(servers).where(eq(servers.netbirdName, netbirdName)).get())
        throw conflict('netbird_name_taken', { name: netbirdName });
      const wanted = {
        cpuLimit: creator.isAdmin ? (input.cpuLimit ?? null) : null,
        diskLimitMb: creator.isAdmin ? (input.diskLimitMb ?? null) : null,
      };
      const limits =
        creator.isAdmin || !quota
          ? wanted
          : quota.limitsFor(creator, { ...wanted, memoryMb: input.memoryMb });
      if (!creator.isAdmin) quota?.check(creator, null, { memoryMb: input.memoryMb, ...limits });
      const id = newId();
      const base = {
        id,
        name: input.name,
        edition: input.edition,
        software: input.software,
        version: input.version,
        memoryMb: input.memoryMb,
        ...limits,
        port,
        javaTag: null,
        autoStart: input.autoStart,
      };
      db.insert(servers)
        .values({
          ...base,
          rconPassword: secrets.encrypt(randomToken(RCON_PASSWORD_BYTES)),
          image: imageFor(config, base),
          netbirdName: template ? null : netbirdName,
          extraPorts,
          gameSettings,
          template,
        })
        .run();
      fs.mkdirSync(serverDir(config, id), { recursive: true });
      grantOwner(creator, id);
      audit.record(actor, 'server.create', id, {
        name: input.name,
        software: input.software,
        version: input.version,
      });
      if (input.startNow) {
        rt(id).state = 'starting';
        void withLock(id, () => startInternal(id));
      }
      // A preload template is no real server: no address, no OP, no "server ordered" mail.
      if (!template) {
        await Promise.allSettled(Array.from(createdListeners, (listener) => listener(id)));
        events.emit('server.created', { serverId: id, userId: creator.id, coupon: input.coupon ?? null });
      }
      return summaryOf(row(id));
    },
    createFromImport: (input, actor, creator) => {
      const info = SOFTWARE[input.software];
      if (!creator.isAdmin)
        quota?.check(creator, null, { memoryMb: input.memoryMb, cpuLimit: null, diskLimitMb: null });
      assertPortFree(input.port, info.protocol, null);
      const base = { ...input, javaTag: null };
      db.insert(servers)
        .values({
          ...base,
          rconPassword: secrets.encrypt(randomToken(RCON_PASSWORD_BYTES)),
          image: imageFor(config, base),
        })
        .run();
      grantOwner(creator, input.id);
      audit.record(actor, 'server.import', input.id, { name: input.name, software: input.software });
      return summaryOf(row(input.id));
    },
    update: (id, patch, actor) => {
      const current = row(id);
      const software = patch.software ?? current.software;
      if (software !== current.software) {
        if (![current.software, software].every((s) => SWITCHABLE_SOFTWARE.includes(s)))
          throw badRequest('software_not_switchable');
        if (ACTIVE_STATES.includes(rt(id).state)) throw conflict('software_switch_running');
        // Geyser and Simple Voice Chat come as plugins or mods for the old software; they would not load.
        if (current.geyser || current.voiceChat) throw badRequest('software_switch_addons');
        if (!patch.version) throw badRequest('software_switch_version');
      }
      if (patch.port !== undefined && patch.port !== current.port) {
        assertPortFree(patch.port, SOFTWARE[current.software].protocol, id);
      }
      const limitsChanged = patch.cpuLimit !== undefined || patch.diskLimitMb !== undefined;
      const acting =
        actor.userId === null ? undefined : db.select().from(users).where(eq(users.id, actor.userId)).get();
      if (limitsChanged && !acting?.isAdmin) throw forbidden('admin_only');
      const cpuLimit = patch.cpuLimit === undefined ? current.cpuLimit : patch.cpuLimit;
      const diskLimitMb = patch.diskLimitMb === undefined ? current.diskLimitMb : patch.diskLimitMb;
      const memoryMb = patch.memoryMb ?? current.memoryMb;
      // Only the owner's own changes are held to the quota; an admin may give more.
      const owner = quota?.ownerOf(id);
      if (owner && !acting?.isAdmin) quota?.check(owner, id, { memoryMb, cpuLimit, diskLimitMb });
      const next = {
        name: patch.name ?? current.name,
        memoryMb,
        cpuLimit,
        diskLimitMb,
        port: patch.port ?? current.port,
        autoStart: patch.autoStart ?? current.autoStart,
        domain: patch.domain === undefined ? current.domain : patch.domain || null,
        publicPort: patch.publicPort === undefined ? current.publicPort : patch.publicPort,
        javaTag: patch.javaTag === undefined ? current.javaTag : patch.javaTag,
        version: patch.version ?? current.version,
        software,
      };
      if (software !== current.software) next.javaTag = null;
      const image = imageFor(config, {
        software,
        version: next.version,
        javaTag: next.javaTag,
      });
      db.update(servers)
        .set({ ...next, image, updatedAt: nowIso() })
        .where(eq(servers.id, id))
        .run();
      audit.record(
        actor,
        'server.update',
        id,
        Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      );
      if (next.port !== current.port) portsChanged(id);
      return summaryOf(row(id));
    },
    setGameSettings: (id, input, actor) => {
      const current = row(id);
      const game = gameOf(current.software);
      if (!game) throw badRequest('not_a_game');
      validateGameSettings(game, input);
      const gameSettings = mergeGameSettings(game, current.gameSettings, input, secrets);
      db.update(servers).set({ gameSettings, updatedAt: nowIso() }).where(eq(servers.id, id)).run();
      const secretKeys = new Set(game.fields.filter((f) => f.kind === 'secret').map((f) => f.key));
      // Secrets never go into the protocol, only that they changed.
      audit.record(
        actor,
        'server.update',
        id,
        Object.fromEntries(Object.entries(input).map(([k, v]) => [k, secretKeys.has(k) ? '***' : v])),
      );
    },
    remove: async (id, deleteFiles, actor) => {
      const r = row(id);
      await withLock(id, async () => {
        rt(id).stopRequested = true;
        if (r.containerId) {
          const state = await docker.inspect(r.containerId);
          if (state?.running) await docker.kill(r.containerId);
          await docker.removeContainer(r.containerId);
        }
      });
      detachLogs(id);
      db.delete(servers).where(eq(servers.id, id)).run();
      db.delete(stats).where(eq(stats.serverId, id)).run();
      const dirs = ['servers', 'backups', 'trash'].map((d) => path.join(config.dataDir, d, id));
      if (deleteFiles) {
        // Big servers (CS2: 60 GB) would block the panel while deleting: move aside at once, delete in the background.
        dirs.forEach((d) => discardLater(d));
      } else {
        const archive = path.join(config.dataDir, 'archive', `${r.name.replace(/[^\w.-]+/g, '_')}-${id}`); // eslint-disable-line ts-patterns/require-regex-example -- anything but word characters, dot and dash becomes "_": "Mein Server!" → "Mein_Server_"
        fs.mkdirSync(path.dirname(archive), { recursive: true });
        if (fs.existsSync(dirs[0] ?? '')) fs.renameSync(dirs[0] ?? '', archive);
      }
      runtimes.delete(id);
      audit.record(actor, 'server.delete', null, { serverId: id, name: r.name, deleteFiles });
      events.emit('server.deleted', { serverId: id });
    },
    start: async (id, actor) => {
      const r = row(id);
      const missing = missingGameFiles(serverDir(config, id), r.software);
      if (missing.length) throw badRequest('game_files_missing', { files: missing.join(', ') });
      if (ACTIVE_STATES.includes(rt(id).state)) throw conflict('server_already_running');
      const usedMb = rt(id).diskMb;
      if (r.diskLimitMb !== null && usedMb !== null && usedMb > r.diskLimitMb)
        throw conflict('disk_limit_reached', { used: Math.round(usedMb), limit: r.diskLimitMb });
      await guardHost(r);
      audit.record(actor, 'server.start', id);
      rt(id).state = 'starting';
      publishLive(id);
      void withLock(id, () => startInternal(id));
    },
    stop: async (id, actor) => {
      row(id);
      audit.record(actor, 'server.stop', id);
      void withLock(id, async () => {
        await stopInternal(id);
      });
    },
    stopAndWait: async (id, actor) => {
      row(id);
      audit.record(actor, 'server.stop', id);
      return withLock(id, () => stopInternal(id));
    },
    restart: async (id, actor) => {
      row(id);
      audit.record(actor, 'server.restart', id);
      void withLock(id, async () => {
        await stopInternal(id);
        await startInternal(id);
      });
    },
    kill: async (id, actor) => {
      const r = row(id);
      audit.record(actor, 'server.kill', id);
      await withLock(id, async () => {
        db.update(servers).set({ desiredRunning: false }).where(eq(servers.id, id)).run();
        rt(id).stopRequested = true;
        if (r.containerId) {
          const state = await docker.inspect(r.containerId);
          if (state?.running) await docker.kill(r.containerId);
        }
        panelLog(id, 'Server wurde sofort beendet.');
        setState(id, 'stopped');
      });
    },
    command: async (id, command, actor) => {
      if (!ACTIVE_STATES.includes(rt(id).state)) throw conflict('server_not_running');
      if (gameOf(row(id).software)?.console === 'none') throw badRequest('console_unavailable');
      appendLog(id, `${ECHO_PREFIX}${command}${ANSI_RESET}`);
      try {
        const answer = await quietCommand(id, command);
        answer
          .split('\n')
          .map((l) => l.trimEnd())
          .filter(Boolean)
          .forEach((l) => appendLog(id, l));
        if (actor) audit.record(actor, 'server.command', id, { command });
        return answer;
      } catch (err) {
        if (err instanceof AppError) throw err;
        panelLog(id, `Befehl konnte nicht gesendet werden: ${errorMessage(err)}`);
        throw new AppError(HTTP_CONFLICT, 'command_failed', { message: errorMessage(err) });
      }
    },
    quietCommand,
    live,
    logs: (id) => rt(id).logs,
    dir: (id) => serverDir(config, id),
    note: (id, text) => panelLog(id, text),
    setSetup: (id, progress) => {
      rt(id).setup = progress;
      publishLive(id);
    },
    nextFreePort: (id) => {
      const current = row(id);
      const protocol = SOFTWARE[current.software].protocol;
      const found = Array.from({ length: PORT_SEARCH_LIMIT }, (_, i) => current.port + 1 + i).find((port) =>
        portFree(port, protocol, id),
      );
      if (found === undefined) throw conflict('port_taken', { port: current.port, server: '' });
      return found;
    },
    isRunning: (id) => ACTIVE_STATES.includes(rt(id).state),
    setExtraPorts: (id, ports) => {
      db.update(servers).set({ extraPorts: ports }).where(eq(servers.id, id)).run();
      portsChanged(id);
    },
    freePort: (start, protocol, exceptId) => {
      const isFree = (port: number): boolean => {
        try {
          assertPortFree(port, protocol, exceptId);
          return true;
        } catch {
          return false;
        }
      };
      const found = Array.from({ length: PORT_SEARCH_LIMIT }, (_, i) => start + i).find(isFree);
      if (found === undefined) throw conflict('port_taken', { port: start, server: '' });
      return found;
    },
    setGeyser: (id, enabled) => {
      db.update(servers).set({ geyser: enabled }).where(eq(servers.id, id)).run();
      portsChanged(id);
    },
    setVoiceChat: (id, enabled, voicePublicPort) => {
      db.update(servers).set({ voiceChat: enabled, voicePublicPort }).where(eq(servers.id, id)).run();
      portsChanged(id);
    },
    voiceHost: (id) => voiceHostOf(row(id)),
    useQuota: (guard) => {
      quota = guard;
    },
    checkNewServer: (owner, memoryMb) => {
      if (owner.isAdmin || !quota) return;
      quota.check(owner, null, {
        memoryMb,
        ...quota.limitsFor(owner, { cpuLimit: null, diskLimitMb: null, memoryMb }),
      });
    },
    onStartEnv: (provide) => {
      startEnv.add(provide);
    },
    onBeforeStart: (prepare) => {
      beforeStart.add(prepare);
      return () => beforeStart.delete(prepare);
    },
    onCreated: (listener) => {
      createdListeners.add(listener);
    },
    onPortsChanged: (listener) => {
      portListeners.add(listener);
      return () => portListeners.delete(listener);
    },
    setTunnelAddress: (id, patch) => {
      const before = db.select().from(servers).where(eq(servers.id, id)).get();
      db.update(servers).set(patch).where(eq(servers.id, id)).run();
      const after = db.select().from(servers).where(eq(servers.id, id)).get();
      if (before && after && voiceHostOf(before) !== voiceHostOf(after))
        events.emit('server.address', { serverId: id });
    },
    describeNetbird: (provider) => {
      addressDescribers.add(provider);
    },
    newId,
  };
  return service;
}
