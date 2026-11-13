import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROPERTY_FIELDS, type Edition } from '@mornihosting/shared';
import { BYTES_PER_MB, PERCENT } from '../lib/units.js';
import type {
  CommandChannel,
  ContainerEvent,
  ContainerSpec,
  ContainerState,
  DockerDriver,
  LogListener,
} from './driver.js';
import {
  bootGame,
  gameCommand,
  gameJoin,
  gameLeave,
  isFakeGame,
  prepareGameFiles,
  type FakeGameHost,
} from './fake-games.js';

/**
 * A pretend Docker that runs no containers. It writes the files a real Minecraft server
 * would create and plays back realistic console output, so the panel can be developed,
 * tested and demonstrated without Docker.
 */

export interface FakeDriverOptions {
  /** Delay between two simulated console lines. */
  readonly stepMs: number;
  /** Let pretend players join and leave on their own (demo mode). */
  readonly simulatePlayers: boolean;
}

interface FakeContainer {
  readonly id: string;
  readonly spec: ContainerSpec;
  readonly history: string[];
  readonly listeners: Set<LogListener>;
  readonly timers: Set<NodeJS.Timeout>;
  readonly players: Set<string>;
}

interface FakeStatus {
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

const STOPPED: FakeStatus = {
  running: false,
  exitCode: null,
  oomKilled: false,
  startedAt: null,
  finishedAt: null,
};

const HISTORY_LIMIT = 2000;
const EXIT_OK = 0;
const EXIT_CRASH = 1;
const EXIT_KILLED = 137;
const MIN_MODDED_MEMORY_MB = 4096;
const BASE_CPU = 6;
const CPU_PER_PLAYER = 4;
/** Simulated traffic per stats call: a little background chatter plus some per player. */
const RX_BASE_BYTES = 2_000;
const RX_PER_PLAYER_BYTES = 9_000;
const TX_PER_PLAYER_BYTES = 60_000;
const CPU_JITTER = 6;
const MEMORY_SHARE = 0.55;
const MEMORY_JITTER = 0.08;
const HALF = 0.5;
const MAX_PLAYERS_DEFAULT = 20;
const PLAYER_TICK_MIN_STEPS = 40;
const PLAYER_TICK_RANDOM_STEPS = 80;
const JOIN_CHANCE = 0.6;
const STARTUP_SECONDS = 3.512;
const SPAWN_FIRST = 18;
const SPAWN_SECOND = 52;
const SPAWN_THIRD = 87;
const SPAWN_PROGRESS = [SPAWN_FIRST, SPAWN_SECOND, SPAWN_THIRD];
const CLOCK_LENGTH = 8;
const TIMESTAMP_MS_LENGTH = 23;
const JSON_INDENT = 2;
const OP_LEVEL = 4;
const FAKE_HOST_MEMORY_GB = 24;
const FAKE_HOST_CPUS = 4;
const BYTES_PER_GB = BYTES_PER_MB * 1024; // eslint-disable-line ts-patterns/no-magic-numbers

const PLAYER_POOL = [
  'Morni',
  'Lena_Baut',
  'KaiKocht',
  'Juna',
  'Pixelpaul',
  'Tobi_04',
  'Mia.Builds',
  'Papa_M',
  'Ella',
  'Finn2015',
];

function stamp(): string {
  return new Date().toTimeString().slice(0, CLOCK_LENGTH);
}

function javaLine(text: string, thread = 'Server thread', level = 'INFO'): string {
  return `[${stamp()}] [${thread}/${level}]: ${text}`;
}

function bedrockLine(text: string): string {
  return `[${new Date().toISOString().replace('T', ' ').slice(0, TIMESTAMP_MS_LENGTH)} INFO] ${text}`;
}

function readJson<TValue>(file: string, fallback: TValue): TValue {
  try {
    // Files are written by this driver in the same shape.
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TValue;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, JSON_INDENT));
}

function writeIfMissing(file: string, content: string): void {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function editionOf(spec: ContainerSpec): Edition {
  return spec.labels['mornihosting.edition'] === 'bedrock' ? 'bedrock' : 'java';
}

function prepareFiles(spec: ContainerSpec): void {
  const dir = spec.dataDir;
  const edition = editionOf(spec);
  fs.mkdirSync(dir, { recursive: true });
  const props = PROPERTY_FIELDS.filter((f) => f.editions.includes(edition))
    .filter((f, i, all) => all.findIndex((g) => g.key === f.key) === i)
    .map((f) => `${f.key}=${f.key === 'motd' ? (spec.env['MOTD'] ?? f.defaultValue) : f.defaultValue}`);
  const port = edition === 'bedrock' ? 'server-port=19132' : 'server-port=25565';
  writeIfMissing(
    path.join(dir, 'server.properties'),
    `#Minecraft server properties\n${[...props, port].join('\n')}\n`,
  );
  if (edition === 'java') {
    writeIfMissing(path.join(dir, 'eula.txt'), 'eula=true\n');
    ['ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json'].forEach((f) =>
      writeIfMissing(path.join(dir, f), '[]\n'),
    );
    writeIfMissing(path.join(dir, 'world', 'level.dat'), 'fake level data');
    writeIfMissing(path.join(dir, 'world', 'region', 'r.0.0.mca'), 'fake region');
    writeIfMissing(path.join(dir, 'world_nether', 'level.dat'), 'fake level data');
    writeIfMissing(path.join(dir, 'world_the_end', 'level.dat'), 'fake level data');
    const contentDir = spec.labels['mornihosting.contentDir'];
    if (contentDir) fs.mkdirSync(path.join(dir, contentDir), { recursive: true });
  } else {
    writeIfMissing(path.join(dir, 'allowlist.json'), '[]\n');
    writeIfMissing(path.join(dir, 'permissions.json'), '[]\n');
    writeIfMissing(path.join(dir, 'worlds', 'Bedrock level', 'level.dat'), 'fake level data');
  }
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
}

function memoryMbOf(spec: ContainerSpec): number {
  const raw = spec.env['MAX_MEMORY'] ?? spec.env['MEMORY'] ?? '';
  const value = Number.parseInt(raw, 10);
  return raw.toUpperCase().endsWith('G') ? value * 1024 : value; // eslint-disable-line ts-patterns/no-magic-numbers
}

// "list": matches "list" and "list uuids"; rejects "playerlist".
// https://regex101.com/?flavor=javascript&regex=%5Elist%28%20uuids%29%3F%24&flags=gm&testString=list%0Alist%20uuids%0Aplayerlist
const CMD_LIST = /^list( uuids)?$/;
// "tps": matches only "tps".
// https://regex101.com/?flavor=javascript&regex=%5Etps%24&flags=gm&testString=tps%0Atpsx
const CMD_TPS = /^tps$/;
// "tick query": matches "tick query"; rejects "tick freeze".
// https://regex101.com/?flavor=javascript&regex=%5Etick%20query%24&flags=gm&testString=tick%20query%0Atick%20freeze
const CMD_TICK_QUERY = /^tick query$/;
// "say <text>": captures the text. "say Hallo" → "Hallo"; rejects "sayHallo".
// https://regex101.com/?flavor=javascript&regex=%5Esay%20%28.%2B%29%24&flags=gm&testString=say%20Hallo%0AsayHallo
const CMD_SAY = /^say (.+)$/;
// "op <name>": captures the player. "op Juna" → "Juna"; rejects "op".
// https://regex101.com/?flavor=javascript&regex=%5Eop%20%28%5CS%2B%29%24&flags=gm&testString=op%20Juna%0Aop
const CMD_OP = /^op (\S+)$/;
// "deop <name>": captures the player. "deop Juna" → "Juna"; rejects "deop".
// https://regex101.com/?flavor=javascript&regex=%5Edeop%20%28%5CS%2B%29%24&flags=gm&testString=deop%20Juna%0Adeop
const CMD_DEOP = /^deop (\S+)$/;
// "whitelist add|remove <name>": captures action and player. "whitelist add Juna" → ("add", "Juna"); rejects "whitelist list".
// https://regex101.com/?flavor=javascript&regex=%5Ewhitelist%20%28add%7Cremove%29%20%28%5CS%2B%29%24&flags=gm&testString=whitelist%20add%20Juna%0Awhitelist%20list
const CMD_WHITELIST_EDIT = /^whitelist (add|remove) (\S+)$/;
// "whitelist on|off|reload": matches "whitelist on"; rejects "whitelist maybe".
// https://regex101.com/?flavor=javascript&regex=%5Ewhitelist%20%28on%7Coff%7Creload%29%24&flags=gm&testString=whitelist%20on%0Awhitelist%20maybe
const CMD_WHITELIST_TOGGLE = /^whitelist (on|off|reload)$/;
// "kick <name> [reason]": captures player and optional reason. "kick Juna bitte" → ("Juna", "bitte").
// https://regex101.com/?flavor=javascript&regex=%5Ekick%20%28%5CS%2B%29%28%3F%3A%20%28.%2B%29%29%3F%24&flags=gm&testString=kick%20Juna%20bitte%0Akick%20Juna%0Akick
const CMD_KICK = /^kick (\S+)(?: (.+))?$/;
// "ban <name> [reason]": captures player and optional reason. "ban Juna griefing" → ("Juna", "griefing").
// https://regex101.com/?flavor=javascript&regex=%5Eban%20%28%5CS%2B%29%28%3F%3A%20%28.%2B%29%29%3F%24&flags=gm&testString=ban%20Juna%20griefing%0Aban%20Juna%0Aban
const CMD_BAN = /^ban (\S+)(?: (.+))?$/;
// "pardon <name>": captures the player. "pardon Juna" → "Juna"; rejects "pardon".
// https://regex101.com/?flavor=javascript&regex=%5Epardon%20%28%5CS%2B%29%24&flags=gm&testString=pardon%20Juna%0Apardon
const CMD_PARDON = /^pardon (\S+)$/;
// "save-all", "save-off", "save-on" with optional "flush": matches "save-all flush"; rejects "save".
// https://regex101.com/?flavor=javascript&regex=%5Esave-%28all%7Coff%7Con%29%28%20flush%29%3F%24&flags=gm&testString=save-all%20flush%0Asave-off%0Asave
const CMD_SAVE = /^save-(all|off|on)( flush)?$/;
// "stop": matches only "stop".
// https://regex101.com/?flavor=javascript&regex=%5Estop%24&flags=gm&testString=stop%0Astopp
const CMD_STOP = /^stop$/;

export function createFakeDriver(options: FakeDriverOptions): DockerDriver {
  const containers = new Map<string, FakeContainer>();
  const statuses = new Map<string, FakeStatus>();
  const statusOf = (id: string): FakeStatus => statuses.get(id) ?? STOPPED;
  const isRunning = (id: string): boolean => statusOf(id).running;
  const cpuById = new Map<string, number>();
  const trafficById = new Map<string, { rx: number; tx: number }>();
  const eventListeners = new Set<(e: ContainerEvent) => void>();
  const images = new Set<string>();

  const emitEvent = (containerId: string, action: ContainerEvent['action']): void =>
    eventListeners.forEach((l) => l({ containerId, action }));

  const log = (c: FakeContainer, line: string): void => {
    c.history.push(line);
    if (c.history.length > HISTORY_LIMIT) c.history.splice(0, c.history.length - HISTORY_LIMIT);
    fs.appendFile(path.join(c.spec.dataDir, 'logs', 'latest.log'), `${line}\n`, () => undefined);
    c.listeners.forEach((l) => l(line));
  };

  const later = (c: FakeContainer, steps: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      c.timers.delete(timer);
      if (isRunning(c.id)) fn();
    }, steps * options.stepMs);
    c.timers.add(timer);
  };

  const clearTimers = (c: FakeContainer): void => {
    c.timers.forEach((t) => clearTimeout(t));
    c.timers.clear();
  };

  const exit = (c: FakeContainer, code: number, oom = false): void => {
    clearTimers(c);
    statuses.set(c.id, {
      ...statusOf(c.id),
      running: false,
      exitCode: code,
      oomKilled: oom,
      finishedAt: new Date().toISOString(),
    });
    c.players.clear();
    emitEvent(c.id, 'die');
  };

  const line = (c: FakeContainer, text: string, level = 'INFO'): void =>
    log(c, editionOf(c.spec) === 'bedrock' ? bedrockLine(text) : javaLine(text, 'Server thread', level));

  const playerFile = (c: FakeContainer, file: string): string => path.join(c.spec.dataDir, file);

  const gameHost = (c: FakeContainer): FakeGameHost => ({
    log: (text) => log(c, text),
    later: (steps, fn) => later(c, steps, fn),
    exit: (code) => exit(c, code),
    players: c.players,
  });

  const join = (c: FakeContainer, name: string): void => {
    const game = isFakeGame(c.spec);
    if (game) {
      gameJoin(gameHost(c), game, name);
      return;
    }
    c.players.add(name);
    if (editionOf(c.spec) === 'bedrock') {
      log(c, bedrockLine(`Player connected: ${name}, xuid: 25350${Math.floor(Math.random() * PERCENT)}`));
      return;
    }
    line(
      c,
      `${name}[/172.18.0.1:${Math.floor(Math.random() * PERCENT)}] logged in with entity id 312 at ([world]12.5, 64.0, -8.5)`,
    );
    line(c, `${name} joined the game`);
  };

  const leave = (c: FakeContainer, name: string): void => {
    const game = isFakeGame(c.spec);
    if (game) {
      gameLeave(gameHost(c), game, name);
      return;
    }
    c.players.delete(name);
    if (editionOf(c.spec) === 'bedrock') log(c, bedrockLine(`Player disconnected: ${name}, xuid: 2535`));
    else {
      line(c, `${name} lost connection: Disconnected`);
      line(c, `${name} left the game`);
    }
  };

  const schedulePlayers = (c: FakeContainer): void => {
    if (!options.simulatePlayers) return;
    later(c, PLAYER_TICK_MIN_STEPS + Math.random() * PLAYER_TICK_RANDOM_STEPS, () => {
      const offline = PLAYER_POOL.filter((p) => !c.players.has(p));
      const shouldJoin = (Math.random() < JOIN_CHANCE && offline.length) || !c.players.size;
      if (shouldJoin && offline.length)
        join(c, offline[Math.floor(Math.random() * offline.length)] ?? 'Steve');
      else if (c.players.size) leave(c, [...c.players][Math.floor(Math.random() * c.players.size)] ?? '');
      schedulePlayers(c);
    });
  };

  const bootJava = (c: FakeContainer): void => {
    const software = c.spec.env['TYPE'] ?? 'VANILLA';
    const version = c.spec.env['VERSION'] ?? 'LATEST';
    const modded = ['FORGE', 'NEOFORGE'].includes(software);
    const steps: readonly (() => void)[] = [
      () => log(c, `[init] Running as uid=1000 gid=1000 with /data as 'drwxr-xr-x 1000:1000 /data'`),
      () => log(c, `[init] Resolving type given ${software}`),
      () => log(c, `[mc-image-helper] Downloading ${software.toLowerCase()} server for ${version}`),
      () => log(c, `[init] Starting the Minecraft server...`),
      () => line(c, `Starting minecraft server version ${version}`),
      () => line(c, 'Loading properties'),
      () => line(c, 'Default game type: SURVIVAL'),
      () => line(c, `Starting Minecraft server on *:25565`),
      () => line(c, 'Preparing level "world"'),
      () => {
        if (modded && memoryMbOf(c.spec) < MIN_MODDED_MEMORY_MB) {
          log(c, javaLine('Encountered an unexpected exception', 'Server thread', 'ERROR'));
          log(c, 'java.lang.OutOfMemoryError: Java heap space');
          log(c, '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537)');
          exit(c, EXIT_CRASH, true);
          return;
        }
        SPAWN_PROGRESS.forEach((p) => line(c, `Preparing spawn area: ${p}%`));
      },
      () => line(c, `Done (${STARTUP_SECONDS}s)! For help, type "help"`),
      () => {
        line(c, 'Starting remote control listener');
        line(c, 'Thread RCON Listener started');
        schedulePlayers(c);
      },
    ];
    steps.forEach((step, i) => later(c, i + 1, step));
  };

  const bootBedrock = (c: FakeContainer): void => {
    const version = c.spec.env['VERSION'] ?? 'LATEST';
    const steps: readonly (() => void)[] = [
      () => log(c, `Downloading Bedrock server version ${version} ...`),
      () => log(c, bedrockLine('Starting Server')),
      () => log(c, bedrockLine(`Version: ${version}`)),
      () => log(c, bedrockLine('Level Name: Bedrock level')),
      () => log(c, bedrockLine('IPv4 supported, port: 19132: Used for gameplay and LAN discovery')),
      () => {
        log(c, bedrockLine('Server started.'));
        schedulePlayers(c);
      },
    ];
    steps.forEach((step, i) => later(c, i + 1, step));
  };

  const listUpdate = <TEntry extends { name: string }>(
    c: FakeContainer,
    file: string,
    name: string,
    add: boolean,
    entry: (name: string) => TEntry,
  ): void => {
    const list = readJson<TEntry[]>(playerFile(c, file), []);
    const rest = list.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
    writeJson(playerFile(c, file), add ? [...rest, entry(name)] : rest);
  };

  const commandHandlers: readonly (readonly [RegExp, (c: FakeContainer, m: RegExpMatchArray) => string])[] = [
    [
      CMD_LIST,
      (c) =>
        `There are ${c.players.size} of a max of ${MAX_PLAYERS_DEFAULT} players online: ${[...c.players].join(', ')}`,
    ],
    [CMD_TPS, () => '§6TPS from last 1m, 5m, 15m: §a20.0, §a20.0, §a19.98'],
    [
      CMD_TICK_QUERY,
      () =>
        'The game is running normally\nTarget tick rate: 20.0 per second.\nAverage time per tick: 12.4ms (Target: 50.0ms)',
    ],
    [CMD_SAY, (c, m) => (line(c, `[Server] ${m[1] ?? ''}`), '')],
    [
      CMD_OP,
      (c, m) => {
        const name = m[1] ?? '';
        listUpdate(c, 'ops.json', name, true, (n) => ({
          uuid: randomUUID(),
          name: n,
          level: OP_LEVEL,
          bypassesPlayerLimit: false,
        }));
        return `Made ${name} a server operator`;
      },
    ],
    [
      CMD_DEOP,
      (c, m) => {
        const name = m[1] ?? '';
        listUpdate(c, 'ops.json', name, false, (n) => ({ name: n }));
        return `Made ${name} no longer a server operator`;
      },
    ],
    [
      CMD_WHITELIST_EDIT,
      (c, m) => {
        const name = m[2] ?? '';
        const add = m[1] === 'add';
        listUpdate(c, 'whitelist.json', name, add, (n) => ({ uuid: randomUUID(), name: n }));
        return add ? `Added ${name} to the whitelist` : `Removed ${name} from the whitelist`;
      },
    ],
    [CMD_WHITELIST_TOGGLE, (_c, m) => `Whitelist ${m[1] === 'on' ? 'is now turned on' : 'updated'}`],
    [
      CMD_KICK,
      (c, m) => {
        const name = m[1] ?? '';
        if (!c.players.has(name)) return 'No player was found';
        leave(c, name);
        return `Kicked ${name}: ${m[2] ?? 'Kicked by an operator'}`;
      },
    ],
    [
      CMD_BAN,
      (c, m) => {
        const name = m[1] ?? '';
        const reason = m[2] ?? 'Banned by an operator.';
        listUpdate(c, 'banned-players.json', name, true, (n) => ({
          uuid: randomUUID(),
          name: n,
          created: new Date().toISOString(),
          source: 'Server',
          expires: 'forever',
          reason,
        }));
        if (c.players.has(name)) leave(c, name);
        return `Banned ${name}: ${reason}`;
      },
    ],
    [
      CMD_PARDON,
      (c, m) => {
        listUpdate(c, 'banned-players.json', m[1] ?? '', false, (n) => ({ name: n }));
        return `Unbanned ${m[1] ?? ''}`;
      },
    ],
    [
      CMD_SAVE,
      (c, m) => {
        const text =
          {
            all: 'Saved the game',
            off: 'Automatic saving is now disabled',
            on: 'Automatic saving is now enabled',
          }[m[1] ?? 'all'] ?? '';
        line(c, text);
        return text;
      },
    ],
    [
      CMD_STOP,
      (c) => {
        line(c, 'Stopping the server');
        line(c, 'Stopping server');
        line(c, 'Saving players');
        line(c, 'Saving worlds');
        later(c, 1, () => exit(c, EXIT_OK));
        return 'Stopping the server';
      },
    ],
  ];

  const runCommand = (c: FakeContainer, command: string): string => {
    const game = isFakeGame(c.spec);
    if (game) return gameCommand(gameHost(c), game, command);
    const trimmed = command.trim().replace(/^\//, ''); // eslint-disable-line ts-patterns/require-regex-example -- strips one leading "/": "/list" → "list"
    const handler = commandHandlers
      .map(([pattern, fn]) => [trimmed.match(pattern), fn] as const)
      .find(([match]) => match !== null);
    if (!handler || !handler[0]) return 'Unknown or incomplete command, see below for error';
    return handler[1](c, handler[0]);
  };

  const get = (id: string): FakeContainer => {
    const c = containers.get(id);
    if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 }); // eslint-disable-line ts-patterns/no-magic-numbers
    return c;
  };

  return {
    kind: 'fake',
    ping: async () => undefined,
    ensureImage: async (image, onProgress) => {
      if (images.has(image)) return;
      onProgress?.(0, 'Pulling fs layer');
      onProgress?.(PERCENT, 'Download complete');
      images.add(image);
    },
    ensureNetwork: async () => undefined,
    createContainer: async (spec) => {
      const id = randomUUID().replaceAll('-', '');
      containers.set(id, {
        id,
        spec,
        history: [],
        listeners: new Set(),
        timers: new Set(),
        players: new Set(),
      });
      return id;
    },
    removeContainer: async (id) => {
      const c = containers.get(id);
      const wasRunning = isRunning(id);
      if (c) clearTimers(c);
      containers.delete(id);
      statuses.delete(id);
      // Like Docker's forced remove: a running container dies first (and is gone right after).
      if (wasRunning) emitEvent(id, 'die');
      emitEvent(id, 'destroy');
    },
    start: async (id) => {
      const c = get(id);
      if (isRunning(id)) return;
      // Helper containers with their own command (the HTTPS gateway) just run.
      if (c.spec.command) {
        statuses.set(id, { ...STOPPED, running: true, startedAt: new Date().toISOString() });
        emitEvent(id, 'start');
        return;
      }
      const game = isFakeGame(c.spec);
      if (game) prepareGameFiles(c.spec, game);
      else prepareFiles(c.spec);
      fs.writeFileSync(path.join(c.spec.dataDir, 'logs', 'latest.log'), '');
      statuses.set(id, { ...STOPPED, running: true, startedAt: new Date().toISOString() });
      emitEvent(id, 'start');
      if (game) bootGame(gameHost(c), c.spec, game, () => schedulePlayers(c));
      else if (editionOf(c.spec) === 'bedrock') bootBedrock(c);
      else bootJava(c);
    },
    stop: async (id) => {
      const c = get(id);
      if (!isRunning(id)) return;
      line(c, 'Stopping server');
      exit(c, EXIT_OK);
    },
    kill: async (id) => {
      const c = get(id);
      if (isRunning(id)) exit(c, EXIT_KILLED);
    },
    inspect: async (id): Promise<ContainerState | null> => {
      if (!containers.has(id)) return null;
      const s = statusOf(id);
      return {
        running: s.running,
        status: s.running ? 'running' : 'exited',
        exitCode: s.running ? null : s.exitCode,
        oomKilled: s.oomKilled,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        ip: null,
      };
    },
    followLogs: async (id, tail, onLine) => {
      const c = get(id);
      (tail === 'all' ? c.history : c.history.slice(-tail)).forEach(onLine);
      c.listeners.add(onLine);
      return () => c.listeners.delete(onLine);
    },
    stats: async (id) => {
      const c = containers.get(id);
      if (!c || !isRunning(id)) return null;
      const target = BASE_CPU + c.players.size * CPU_PER_PLAYER;
      const previous = cpuById.get(id) ?? target;
      const cpu = Math.max(1, (previous + target) * HALF + (Math.random() - HALF) * CPU_JITTER);
      cpuById.set(id, cpu);
      const before = trafficById.get(id) ?? { rx: 0, tx: 0 };
      const traffic = {
        rx: before.rx + RX_BASE_BYTES + c.players.size * RX_PER_PLAYER_BYTES * Math.random(),
        tx: before.tx + RX_BASE_BYTES + c.players.size * TX_PER_PLAYER_BYTES * Math.random(),
      };
      trafficById.set(id, traffic);
      return {
        rxBytes: Math.round(traffic.rx),
        txBytes: Math.round(traffic.tx),
        cpuPercent: cpu,
        memoryBytes: c.spec.memoryLimitBytes * (MEMORY_SHARE + (Math.random() - HALF) * MEMORY_JITTER),
        memoryLimitBytes: c.spec.memoryLimitBytes,
      };
    },
    sendCommand: async (id: string, command: string, _channel: CommandChannel) => {
      const c = get(id);
      if (!isRunning(id)) throw new Error('container not running');
      return runCommand(c, command);
    },
    onContainerEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    hostInfo: async () => ({
      name: `${os.hostname()} (Demo)`,
      cpus: FAKE_HOST_CPUS,
      memoryBytes: FAKE_HOST_MEMORY_GB * BYTES_PER_GB,
    }),
    resolveHostDataDir: async () => '/fake',
    close: () => containers.forEach(clearTimers),
  };
}

export const FAKE_STEP_MS_DEFAULT = 400;
export const FAKE_STEP_MS_FAST = 5;
