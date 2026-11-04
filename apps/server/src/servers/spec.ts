import path from 'node:path';
import {
  PORT_RCON,
  SOFTWARE,
  gameImage,
  gameOf,
  javaTagFor,
  type GameInfo,
  type SoftwareId,
} from '@mornihosting/shared';
import type { Config } from '../config.js';
import type { servers } from '../db/schema.js';
import type { CommandChannel, ContainerSpec } from '../docker/driver.js';
import { badRequest } from '../lib/errors.js';
import { BYTES_PER_MB } from '../lib/units.js';

export type ServerRow = typeof servers.$inferSelect;

/** Linux user the itzg images run Minecraft as; the panel container uses the same id. */
const RUN_UID = '1000';
/** The JVM needs room beyond its heap (metaspace, threads, native buffers). */
const JAVA_OVERHEAD_FACTOR = 1.25;
const JAVA_OVERHEAD_MB = 512;

const ITZG_TYPE: Partial<Readonly<Record<SoftwareId, string>>> = {
  vanilla: 'VANILLA',
  paper: 'PAPER',
  purpur: 'PURPUR',
  fabric: 'FABRIC',
  forge: 'FORGE',
  neoforge: 'NEOFORGE',
  velocity: 'VELOCITY',
  bedrock: 'BEDROCK',
  custom: 'CUSTOM',
};

export function containerName(serverId: string): string {
  return `mh-${serverId}`;
}

export function serverDir(config: Config, serverId: string): string {
  return path.join(config.dataDir, 'servers', serverId);
}

export function imageFor(config: Config, row: Pick<ServerRow, 'software' | 'version' | 'javaTag'>): string {
  const game = gameOf(row.software);
  if (game) return gameImage(game, row.version);
  if (row.software === 'bedrock') return `${config.images.bedrock}:latest`;
  if (row.software === 'velocity') return `${config.images.proxy}:latest`;
  return `${config.images.java}:${row.javaTag ?? javaTagFor(row.software, row.version)}`;
}

/** Heap Java starts with; it grows up to the server's RAM when players and chunks need it. */
const INIT_MEMORY_MB = 1024;

function javaEnv(row: ServerRow, timezone: string): Record<string, string> {
  const base: Record<string, string> = {
    EULA: 'TRUE',
    TYPE: ITZG_TYPE[row.software] ?? 'CUSTOM',
    VERSION: row.version,
    // The set RAM is the ceiling; Java starts small and takes more only when the server needs it. With the same
    // start and maximum (and Aikar's AlwaysPreTouch) it would grab the whole amount at once, even when empty.
    INIT_MEMORY: `${Math.min(INIT_MEMORY_MB, row.memoryMb)}M`,
    MAX_MEMORY: `${row.memoryMb}M`,
    ENABLE_RCON: 'true',
    RCON_PASSWORD: row.rconPassword,
    RCON_PORT: String(PORT_RCON),
    CREATE_CONSOLE_IN_PIPE: 'true',
    ENABLE_AUTOPAUSE: 'false',
    // Smooth play: Aikar's garbage-collector settings (the standard for Minecraft servers, no lag spikes from
    // memory clean-up) and chunk saving that does not stop the game while it writes.
    USE_AIKAR_FLAGS: 'true',
    SYNC_CHUNK_WRITES: 'false',
    // The panel writes the folder as the same user already: walking a big world to fix owners only costs time.
    SKIP_CHOWN_DATA: 'true',
    TZ: timezone,
    UID: RUN_UID,
    GID: RUN_UID,
  };
  if (row.software === 'velocity') {
    return {
      TYPE: 'VELOCITY',
      VELOCITY_VERSION: row.version,
      MEMORY: `${row.memoryMb}M`,
      SKIP_CHOWN_DATA: 'true',
      TZ: timezone,
      UID: RUN_UID,
      GID: RUN_UID,
    };
  }
  return base;
}

function bedrockEnv(row: ServerRow, timezone: string): Record<string, string> {
  return { EULA: 'TRUE', VERSION: row.version, TZ: timezone, UID: RUN_UID, GID: RUN_UID };
}

function memoryLimitBytes(row: Pick<ServerRow, 'software' | 'memoryMb'>): number {
  const game = gameOf(row.software);
  const mb =
    row.software === 'bedrock' || (game && !game.jvm)
      ? row.memoryMb
      : Math.ceil(row.memoryMb * JAVA_OVERHEAD_FACTOR) + JAVA_OVERHEAD_MB;
  return mb * BYTES_PER_MB;
}

export function buildContainerSpec(config: Config, row: ServerRow, timezone: string): ContainerSpec {
  const game = gameOf(row.software);
  if (game) return buildGameSpec(config, row, game, timezone);
  const info = SOFTWARE[row.software];
  const env = row.edition === 'bedrock' ? bedrockEnv(row, timezone) : javaEnv(row, timezone);
  return {
    name: containerName(row.id),
    image: row.image,
    env: { ...env, ...row.extraEnv },
    ports: [
      { containerPort: info.defaultPort, hostPort: row.port, protocol: info.protocol },
      ...withSignalingPorts(row.extraPorts).map((p) => ({
        containerPort: p.containerPort ?? p.port,
        hostPort: p.port,
        protocol: p.protocol,
      })),
    ],
    memoryLimitBytes: memoryLimitBytes(row),
    ...(row.cpuLimit ? { cpus: row.cpuLimit } : {}),
    dataDir: serverDir(config, row.id),
    labels: {
      'mornihosting.server': row.id,
      'mornihosting.edition': row.edition,
      'mornihosting.contentDir': info.contentDir ?? '',
    },
  };
}

/**
 * Container of another game: the catalog's fixed variables, the person's settings, RCON over the panel's
 * network (never published), and every port players need. Ports the image reads from a variable listen on
 * the host port inside the container too, so the game announces the port players really use.
 */
function buildGameSpec(config: Config, row: ServerRow, game: GameInfo, timezone: string): ContainerSpec {
  const ports = gamePorts(row, game);
  const portEnv = Object.fromEntries(
    game.ports.flatMap((p) => {
      const bound = ports.find((b) => b.key === p.key);
      return p.env && bound ? [[p.env, String(bound.hostPort)]] : [];
    }),
  );
  const rconPort = rconPortOf(row, game);
  const rconEnv = {
    ...(game.rconEnv?.port && rconPort ? { [game.rconEnv.port]: String(rconPort) } : {}),
    ...(game.rconEnv?.password ? { [game.rconEnv.password]: row.rconPassword } : {}),
  };
  const args = [
    ...(game.rconArg ? [game.rconArg, row.rconPassword] : []),
    ...game.fields.flatMap((f) => {
      const value = row.gameSettings[f.key] || f.fallback;
      return f.arg && value ? [f.arg, value] : [];
    }),
  ];
  const argsEnv = game.argsEnv && args.length ? { [game.argsEnv]: args.join(' ') } : {};
  const memoryEnv = game.memoryEnv ? { [game.memoryEnv]: `${row.memoryMb}M` } : {};
  return {
    name: containerName(row.id),
    image: row.image,
    env: {
      ...game.env,
      TZ: timezone,
      ...gameFieldEnv(row, game),
      ...rconEnv,
      ...argsEnv,
      ...memoryEnv,
      ...portEnv,
      ...row.extraEnv,
    },
    ports: ports.map(({ containerPort, hostPort, protocol }) => ({ containerPort, hostPort, protocol })),
    memoryLimitBytes: memoryLimitBytes(row),
    ...(row.cpuLimit ? { cpus: row.cpuLimit } : {}),
    dataDir: serverDir(config, row.id),
    mounts: game.mounts,
    labels: {
      'mornihosting.server': row.id,
      'mornihosting.edition': row.edition,
      'mornihosting.contentDir': '',
    },
  };
}

/** Prefix of extra ports that belong to a game (see GamePort.key). */
export const GAME_PORT_PURPOSE = 'game-';

interface BoundGamePort {
  readonly key: string;
  readonly containerPort: number;
  readonly hostPort: number;
  readonly protocol: 'tcp' | 'udp';
}

/** Host and container port of every port a game needs; extra ports come from the server's stored list. */
export function gamePorts(row: Pick<ServerRow, 'port' | 'extraPorts'>, game: GameInfo): BoundGamePort[] {
  return game.ports.map((p, index) => {
    const stored = row.extraPorts.find((e) => e.purpose === `${GAME_PORT_PURPOSE}${p.key}`)?.port;
    const hostPort = index === 0 || p.sameAsMain ? row.port : (stored ?? p.defaultPort);
    return {
      key: p.key,
      hostPort,
      containerPort: p.env || p.sameAsMain || p.configKey ? hostPort : p.defaultPort,
      protocol: p.protocol,
    };
  });
}

/** Turns the stored settings into variables; empty values fall back to the catalog's default or are left out. */
function gameFieldEnv(row: ServerRow, game: GameInfo): Record<string, string> {
  return Object.fromEntries(
    game.fields.flatMap((f) => {
      const value = row.gameSettings[f.key] || f.fallback;
      return value === undefined || !f.env ? [] : [[f.env, value]];
    }),
  );
}

export function commandChannelFor(row: ServerRow): CommandChannel {
  const game = gameOf(row.software);
  if (game) return gameChannel(row, game);
  if (row.software === 'bedrock') return { kind: 'exec', argv: ['send-command'] };
  if (row.software === 'velocity') return { kind: 'stdin' };
  return { kind: 'rcon', host: containerName(row.id), port: PORT_RCON, password: row.rconPassword };
}

/** Source games answer RCON on their game port (TCP), which follows the server's port. */
function rconPortOf(row: Pick<ServerRow, 'port'>, game: GameInfo): number | null {
  if (game.rconPort === 'main') return row.port;
  return game.rconPort ?? null;
}

function gameChannel(row: ServerRow, game: GameInfo): CommandChannel {
  const port = rconPortOf(row, game);
  if (game.console === 'rcon' && port)
    return { kind: 'rcon', host: containerName(row.id), port, password: row.rconPassword };
  if (game.console === 'stdin') return { kind: 'stdin' };
  return { kind: 'none' };
}

/** Minecraft-only features (players files, worlds, properties, plugins) refuse other games. */
export function assertMinecraft(row: Pick<ServerRow, 'software'>): void {
  if (gameOf(row.software)) throw badRequest('minecraft_only');
}

/** What players type into Minecraft: domain or IP, plus the port unless it is the default. */
export function displayAddress(host: string, port: number, defaultPort: number): string {
  return port === defaultPort ? host : `${host}:${port}`;
}

type ExtraPort = (typeof servers.$inferSelect)['extraPorts'][number];

/**
 * Since Bedrock 26.60 Geyser speaks NetherNet: players find the server over TCP ("signaling") and then play over
 * UDP, both on the same port. So the Geyser port is opened for TCP as well; older entries only stored UDP.
 */
export function withSignalingPorts(ports: readonly ExtraPort[]): ExtraPort[] {
  return ports.flatMap((p) =>
    p.purpose === 'geyser' && p.protocol === 'udp' ? [p, { ...p, protocol: 'tcp' as const }] : [p],
  );
}
