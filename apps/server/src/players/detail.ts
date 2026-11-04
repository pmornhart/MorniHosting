import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { z } from 'zod';
import {
  gameOf,
  type ItemStack,
  type KnownPlayer,
  type PlayerAdjust,
  type PlayerChatLine,
  type PlayerDetail,
  type PlayerGamemode,
  type PlayerTravel,
  type StatCount,
} from '@mornihosting/shared';
import { conflict, notFound } from '../lib/errors.js';
import { readPropertiesFile } from '../servers/properties-file.js';
import { readList } from '../servers/players.js';
import type { ServerService } from '../servers/service.js';
import { isCompound, list, num, readNbt, str, type NbtCompound, type NbtValue } from './nbt.js';

/**
 * Player details for Java servers, read straight from the server folder so they also work while the player
 * (or the whole server) is offline: playerdata/<uuid>.dat (inventory, health, position …), stats/<uuid>.json
 * (play time, deaths, kills …) and the log files (chat and commands).
 */

const CHAT_LIMIT = 50;
const LOG_FILES_MAX = 60;
const LOG_BYTES_MAX = 32 * 1024 * 1024;
const TICKS_PER_SECOND = 20;
const CM_PER_BLOCK = 100;
const TOP_STATS = 12;
const MAX_HEALTH = 20;
/** After "save-all" the server needs a moment to write the files. */
const SAVE_WAIT_MS = 1500;
const ARMOR_SLOTS = { feet: 100, legs: 101, chest: 102, head: 103, offhand: -106 } as const;
const GAMEMODES: readonly PlayerGamemode[] = ['survival', 'creative', 'adventure', 'spectator'];

// Java account names, safe to put into console commands. Matches "Lena_Baut"; rejects "Finn 2015", "a;b".
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_%5D%7B1%2C16%7D%24&testString=Lena_Baut%0AFinn%202015%0Aa%3Bb
const JAVA_NAME = /^[A-Za-z0-9_]{1,16}$/;
// Dashed uuid. Matches "548b0931-31bf-4476-9a32-01e2e690a62e"; rejects "548b093131bf…" and "../x".
// https://regex101.com/?flavor=javascript&regex=%5E%5B0-9a-f%5D%7B8%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B12%7D%24&flags=i&testString=548b0931-31bf-4476-9a32-01e2e690a62e%0A..%2Fx
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Player data file names. Matches "548b0931-31bf-4476-9a32-01e2e690a62e.dat"; rejects "x.dat_old".
// https://regex101.com/?flavor=javascript&regex=%5E(%5B0-9a-f-%5D%7B36%7D)%5C.dat%24&flags=i&testString=548b0931-31bf-4476-9a32-01e2e690a62e.dat%0Ax.dat_old
const DAT_FILE = /^([0-9a-f-]{36})\.dat$/i;
// Chat line in vanilla ("[12:00:01] [Server thread/INFO]: <Lena> hi") and Paper ("[12:00:01 INFO]: <Lena> hi"),
// also with "[Not Secure] ". Captures time, the name part and the message; rejects "Lena joined the game".
// https://regex101.com/?flavor=javascript&regex=%5E%5C%5B(%5Cd%7B2%7D%3A%5Cd%7B2%7D%3A%5Cd%7B2%7D)%5B%5E%5C%5D%5D*%5C%5D(%3F%3A%20%5C%5B%5B%5E%5C%5D%5D*%5C%5D)%3F%3A%20(%3F%3A%5C%5BNot%20Secure%5C%5D%20)%3F%3C(%5B%5E%3E%5D%2B)%3E%20(.*)%24&flags=gm&testString=%5B12%3A00%3A01%5D%20%5BServer%20thread%2FINFO%5D%3A%20%3CLena%3E%20hi%0A%5B12%3A00%3A01%20INFO%5D%3A%20%5BNot%20Secure%5D%20%3CLena%3E%20hi%0A%5B12%3A00%3A01%20INFO%5D%3A%20Lena%20joined%20the%20game
const CHAT_LINE = /^\[(\d{2}:\d{2}:\d{2})[^\]]*\](?: \[[^\]]*\])?: (?:\[Not Secure\] )?<([^>]+)> (.*)$/;
// Command line (Paper/Spigot log every player command). "[12:00:01 INFO]: Lena issued server command: /home" →
// time, "Lena", "/home"; rejects chat lines.
// https://regex101.com/?flavor=javascript&regex=%5E%5C%5B(%5Cd%7B2%7D%3A%5Cd%7B2%7D%3A%5Cd%7B2%7D)%5B%5E%5C%5D%5D*%5C%5D(%3F%3A%20%5C%5B%5B%5E%5C%5D%5D*%5C%5D)%3F%3A%20(%5CS%2B)%20issued%20server%20command%3A%20(.*)%24&flags=gm&testString=%5B12%3A00%3A01%20INFO%5D%3A%20Lena%20issued%20server%20command%3A%20%2Fhome%0A%5B12%3A00%3A01%20INFO%5D%3A%20%3CLena%3E%20hi
const COMMAND_LINE = /^\[(\d{2}:\d{2}:\d{2})[^\]]*\](?: \[[^\]]*\])?: (\S+) issued server command: (.*)$/;
// Rotated log names. Matches "2026-11-03-2.log.gz" (date, number); rejects "latest.log".
// https://regex101.com/?flavor=javascript&regex=%5E(%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7D)-(%5Cd%2B)%5C.log(%3F%3A%5C.gz)%3F%24&testString=2026-11-03-2.log.gz%0Alatest.log
const ROTATED_LOG = /^(\d{4}-\d{2}-\d{2})-(\d+)\.log(?:\.gz)?$/;
// Colour codes inside names: "§c[Admin] §fLena" → "[Admin] Lena".
// https://regex101.com/?flavor=javascript&regex=%C2%A7%5B0-9a-fk-orx%5D&flags=gi&testString=%C2%A7c%5BAdmin%5D%20%C2%A7fLena
const COLOUR = /§[0-9a-fk-orx]/gi;

const usercacheSchema = z.array(z.object({ name: z.string(), uuid: z.string() }).loose());
const statsSchema = z.object({ stats: z.record(z.string(), z.record(z.string(), z.number())) }).loose();

export interface PlayerDetailService {
  readonly known: (serverId: string) => KnownPlayer[];
  readonly detail: (serverId: string, uuid: string, fresh: boolean) => Promise<PlayerDetail>;
  readonly adjust: (serverId: string, uuid: string, change: PlayerAdjust) => Promise<void>;
}

const stripNamespace = (id: string): string =>
  id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id;

/** A text component (JSON or plain, depending on the version) as plain text. */
function plainText(value: NbtValue | undefined): string | null {
  if (typeof value === 'string') {
    try {
      return plainText(JSON.parse(value) as NbtValue);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((v) => plainText(v as NbtValue) ?? '').join('') || null;
  if (isCompound(value)) {
    const own = str(value['text']) ?? str(value['translate']) ?? '';
    const extra = list(value['extra'])
      .map((v) => plainText(v) ?? '')
      .join('');
    return `${own}${extra}` || null;
  }
  return null;
}

function toItem(raw: NbtValue): ItemStack | null {
  if (!isCompound(raw)) return null;
  const id = str(raw['id']);
  if (!id) return null;
  const components = isCompound(raw['components']) ? raw['components'] : null;
  const legacyTag = isCompound(raw['tag']) ? raw['tag'] : null;
  const legacyDisplay = legacyTag && isCompound(legacyTag['display']) ? legacyTag['display'] : null;
  return {
    id,
    count: num(raw['count']) ?? num(raw['Count']) ?? 1,
    customName: plainText(components?.['minecraft:custom_name'] ?? legacyDisplay?.['Name']),
    slot: num(raw['Slot']) ?? 0,
  };
}

function armorOf(data: NbtCompound, inventory: readonly ItemStack[]): PlayerDetail['armor'] {
  // Since 1.21.5 armor and off hand live in "equipment"; before that in special inventory slots.
  const equipment = isCompound(data['equipment']) ? data['equipment'] : null;
  const fromEquipment = (key: string): ItemStack | null => (equipment ? toItem(equipment[key] ?? 0) : null);
  const fromSlot = (slot: number): ItemStack | null => inventory.find((i) => i.slot === slot) ?? null;
  return {
    head: fromEquipment('head') ?? fromSlot(ARMOR_SLOTS.head),
    chest: fromEquipment('chest') ?? fromSlot(ARMOR_SLOTS.chest),
    legs: fromEquipment('legs') ?? fromSlot(ARMOR_SLOTS.legs),
    feet: fromEquipment('feet') ?? fromSlot(ARMOR_SLOTS.feet),
    offhand: fromEquipment('offhand') ?? fromSlot(ARMOR_SLOTS.offhand),
  };
}

function worldName(dimension: NbtValue | undefined): string | null {
  const legacy: Readonly<Record<number, string>> = { [-1]: 'the_nether', 0: 'overworld', 1: 'the_end' };
  if (typeof dimension === 'number') return legacy[dimension] ?? null;
  return typeof dimension === 'string' ? stripNamespace(dimension) : null;
}

const topCounts = (group: Readonly<Record<string, number>> | undefined): StatCount[] =>
  Object.entries(group ?? {})
    .map(([id, count]) => ({ id, count }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_STATS);

export function travelOf(custom: Readonly<Record<string, number>>): PlayerTravel {
  const blocks = (...keys: string[]): number =>
    Math.round(keys.reduce((sum, k) => sum + (custom[`minecraft:${k}`] ?? 0), 0) / CM_PER_BLOCK);
  const walk = blocks('walk_one_cm', 'walk_on_water_one_cm', 'walk_under_water_one_cm', 'climb_one_cm');
  const sprint = blocks('sprint_one_cm');
  const crouch = blocks('crouch_one_cm');
  const swim = blocks('swim_one_cm');
  const ride = blocks(
    'horse_one_cm',
    'boat_one_cm',
    'minecart_one_cm',
    'pig_one_cm',
    'strider_one_cm',
    'happy_ghast_one_cm',
  );
  const fly = blocks('fly_one_cm', 'aviate_one_cm');
  return { walk, sprint, crouch, swim, ride, fly, total: walk + sprint + crouch + swim + ride + fly };
}

/** Log files newest first: latest.log, then the rotated ones by date and number. */
export function logFiles(logDir: string): { file: string; date: string }[] {
  const names = (() => {
    try {
      return fs.readdirSync(logDir);
    } catch {
      return [];
    }
  })();
  const rotated = names
    .map((name) => ({ name, match: ROTATED_LOG.exec(name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
    .sort(
      (a, b) =>
        (b.match[1] ?? '').localeCompare(a.match[1] ?? '') ||
        Number(b.match[2] ?? 0) - Number(a.match[2] ?? 0),
    )
    .map((e) => ({ file: path.join(logDir, e.name), date: e.match[1] ?? '' }));
  const latest = path.join(logDir, 'latest.log');
  const latestDate = (() => {
    try {
      return fs.statSync(latest).mtime.toISOString().slice(0, 10);
    } catch {
      return null;
    }
  })();
  return [...(latestDate ? [{ file: latest, date: latestDate }] : []), ...rotated].slice(0, LOG_FILES_MAX);
}

export function readLog(file: string): string {
  try {
    const data = fs.readFileSync(file);
    const text = file.endsWith('.gz') ? zlib.gunzipSync(data, { maxOutputLength: LOG_BYTES_MAX }) : data;
    return text.toString('utf8');
  } catch {
    return '';
  }
}

/** The player's last chat messages and commands, newest first. */
export function chatOf(serverDir: string, name: string): PlayerChatLine[] {
  const lower = name.toLowerCase();
  const isPlayer = (who: string): boolean =>
    who.replace(COLOUR, '').trim().split(' ').at(-1)?.toLowerCase() === lower;
  const lineOf = (line: string, date: string): PlayerChatLine | null => {
    const chat = CHAT_LINE.exec(line);
    if (chat && isPlayer(chat[2] ?? ''))
      return { at: `${date}T${chat[1]}Z`, kind: 'chat', text: (chat[3] ?? '').replace(COLOUR, '') };
    const command = COMMAND_LINE.exec(line);
    if (command && (command[2] ?? '').toLowerCase() === lower)
      return { at: `${date}T${command[1]}Z`, kind: 'command', text: command[3] ?? '' };
    return null;
  };
  return logFiles(path.join(serverDir, 'logs')).reduce<PlayerChatLine[]>((found, { file, date }) => {
    if (found.length >= CHAT_LIMIT) return found;
    const lines = readLog(file)
      .split('\n')
      .map((l) => lineOf(l.trimEnd(), date))
      .filter((l): l is PlayerChatLine => l !== null)
      .reverse();
    return [...found, ...lines].slice(0, CHAT_LIMIT);
  }, []);
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

export function createPlayerDetailService(servers: ServerService): PlayerDetailService {
  const javaOnly = (serverId: string): void => {
    const row = servers.row(serverId);
    if (row.edition !== 'java' || gameOf(row.software)) throw conflict('player_details_java_only');
  };
  const worldDir = (serverId: string): string => {
    const dir = servers.dir(serverId);
    const level = readPropertiesFile(dir).values['level-name'] || 'world';
    return path.join(dir, path.basename(level));
  };

  const known: PlayerDetailService['known'] = (serverId) => {
    javaOnly(serverId);
    const dir = servers.dir(serverId);
    const playerdata = path.join(worldDir(serverId), 'playerdata');
    const cache = usercacheSchema.safeParse(readJson(path.join(dir, 'usercache.json')));
    const names = new Map((cache.success ? cache.data : []).map((e) => [e.uuid.toLowerCase(), e.name]));
    const savedAt = (uuid: string): string | null => {
      try {
        return fs.statSync(path.join(playerdata, `${uuid}.dat`)).mtime.toISOString();
      } catch {
        return null;
      }
    };
    const withData = (() => {
      try {
        return fs.readdirSync(playerdata);
      } catch {
        return [];
      }
    })()
      .map((f) => DAT_FILE.exec(f)?.[1]?.toLowerCase())
      .filter((u): u is string => Boolean(u));
    const online = new Set(servers.live(serverId).players.map((p) => p.toLowerCase()));
    const inList = (file: string) => {
      const entries = readList(path.join(dir, file));
      return (uuid: string, name: string): boolean =>
        entries.some((e) => e.uuid?.toLowerCase() === uuid || e.name.toLowerCase() === name.toLowerCase());
    };
    const op = inList('ops.json');
    const banned = inList('banned-players.json');
    const whitelisted = inList('whitelist.json');
    const uuids = [...new Set([...withData, ...names.keys()])].filter((u) => names.has(u));
    return uuids
      .map((uuid) => {
        const name = names.get(uuid) ?? uuid;
        return {
          name,
          uuid,
          online: online.has(name.toLowerCase()),
          op: op(uuid, name),
          banned: banned(uuid, name),
          whitelisted: whitelisted(uuid, name),
          savedAt: savedAt(uuid),
        };
      })
      .sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          (b.savedAt ?? '').localeCompare(a.savedAt ?? '') ||
          a.name.localeCompare(b.name),
      );
  };

  const find = (serverId: string, uuid: string): KnownPlayer => {
    if (!UUID_PATTERN.test(uuid)) throw notFound('player_unknown');
    const player = known(serverId).find((p) => p.uuid === uuid.toLowerCase());
    if (!player) throw notFound('player_unknown');
    return player;
  };

  const detail: PlayerDetailService['detail'] = async (serverId, uuid, fresh) => {
    javaOnly(serverId);
    const before = find(serverId, uuid);
    if (fresh && before.online && servers.isRunning(serverId)) {
      await servers.command(serverId, 'save-all', null).catch(() => '');
      await new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MS));
    }
    const player = find(serverId, uuid);
    const world = worldDir(serverId);
    const data = (() => {
      try {
        return readNbt(fs.readFileSync(path.join(world, 'playerdata', `${player.uuid}.dat`)));
      } catch {
        return null;
      }
    })();
    const parsedStats = statsSchema.safeParse(readJson(path.join(world, 'stats', `${player.uuid}.json`)));
    const stats = parsedStats.success ? parsedStats.data.stats : {};
    const custom = stats['minecraft:custom'] ?? {};
    const stat = (key: string): number => custom[`minecraft:${key}`] ?? 0;
    const seconds = (key: string): number | null =>
      `minecraft:${key}` in custom ? Math.round(stat(key) / TICKS_PER_SECOND) : null;
    const inventory = list(data?.['Inventory'])
      .map(toItem)
      .filter((i): i is ItemStack => i !== null);
    const pos = list(data?.['Pos']).map((v) => num(v) ?? 0);
    const deaths = stat('deaths');
    const xpProgress = num(data?.['XpP']);
    return {
      ...player,
      health: num(data?.['Health']),
      maxHealth: MAX_HEALTH,
      food: num(data?.['foodLevel']),
      level: num(data?.['XpLevel']),
      levelProgress: xpProgress === null ? null : Math.min(1, Math.max(0, xpProgress)),
      gamemode: GAMEMODES[num(data?.['playerGameType']) ?? -1] ?? null,
      world: worldName(data?.['Dimension']),
      position: pos.length === 3 ? { x: pos[0] ?? 0, y: pos[1] ?? 0, z: pos[2] ?? 0 } : null,
      playTimeSeconds: Math.round((stat('play_time') || stat('play_one_minute')) / TICKS_PER_SECOND),
      sinceRestSeconds: seconds('time_since_rest'),
      sinceDeathSeconds: deaths > 0 ? seconds('time_since_death') : null,
      deaths,
      playerKills: stat('player_kills'),
      mobKills: stat('mob_kills'),
      pickedUp: topCounts(stats['minecraft:picked_up']),
      used: topCounts(stats['minecraft:used']),
      killed: topCounts(stats['minecraft:killed']),
      travel: travelOf(custom),
      inventory: inventory.filter((i) => i.slot >= 0 && i.slot < ARMOR_SLOTS.feet),
      armor: data
        ? armorOf(data, inventory)
        : { head: null, chest: null, legs: null, feet: null, offhand: null },
      enderChest: list(data?.['EnderItems'])
        .map(toItem)
        .filter((i): i is ItemStack => i !== null),
      chat: chatOf(servers.dir(serverId), player.name),
      hasData: data !== null,
      refreshedAt: new Date().toISOString(),
    };
  };

  const adjust: PlayerDetailService['adjust'] = async (serverId, uuid, change) => {
    javaOnly(serverId);
    const player = find(serverId, uuid);
    if (!player.online || !servers.isRunning(serverId)) throw conflict('player_not_online');
    if (!JAVA_NAME.test(player.name)) throw conflict('player_not_online');
    const p = player.name;
    const up = 'direction' in change && change.direction === 'up';
    const commands: Readonly<Record<PlayerAdjust['kind'], () => string[]>> = {
      health: () => [up ? `effect give ${p} minecraft:instant_health 1 0 true` : `damage ${p} 2`],
      food: () => [
        up ? `effect give ${p} minecraft:saturation 1 1 true` : `effect give ${p} minecraft:hunger 3 79 true`,
      ],
      level: () => [`xp add ${p} ${up ? 1 : -1} levels`],
      gamemode: () => (change.kind === 'gamemode' ? [`gamemode ${change.gamemode} ${p}`] : []),
      teleport: () => (change.kind === 'teleport' ? [`tp ${p} ${change.x} ${change.y} ${change.z}`] : []),
    };
    await Promise.all(
      [...commands[change.kind](), 'save-all'].map((c) => servers.command(serverId, c, null)),
    );
  };

  return { known, detail, adjust };
}
