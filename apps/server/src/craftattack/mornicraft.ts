import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CRAFT_ATTACK_COMMANDS,
  MAX_RANKS,
  MORNICRAFT_DEFAULTS,
  RANK_PERMISSION_NODES,
  RANK_PERMISSIONS,
  RANK_SOURCES,
  type MorniCraftRank,
  type MorniCraftSettings,
} from '@mornihosting/shared';

/**
 * The panel's own MorniCraft plugin (Java, plugins/mornicraft in the repo): it comes with the panel image and is
 * copied into every MorniCraft server, kept up to date before each start. Its config.yml is written by the panel
 * from the dashboard settings; on a running server "/mornicraft reload" applies it at once.
 *
 * The plugins it replaces (EssentialsX, EssentialsX Spawn, SpawnElytra) are switched off (".jar.disabled"); homes
 * of EssentialsX are taken over by the plugin itself.
 */

const PLUGIN_FILE = 'MorniCraft.jar';
const CONFIG_DIR = 'MorniCraft';
/** Where the panel image keeps the plugin (Dockerfile); MH_MORNICRAFT_JAR overrides it. */
const IMAGE_JAR = '/app/plugins/MorniCraft.jar';
/** Files of plugins MorniCraft replaces: switched off once it is there. */
// Matches "EssentialsX-2.21.2.jar", "EssentialsXSpawn-2.21.2.jar", "SpawnElytra-1.4.jar"; not "EssentialsXChat-…".
// https://regex101.com/?flavor=javascript&regex=%5E(EssentialsX(Spawn)%3F%5B-_%20%5D%3F%5B%5Cd.%5D*%7CSpawnElytra.*)%5C.jar%24&flags=i&testString=EssentialsX-2.21.2.jar%0AEssentialsXSpawn-2.21.2.jar%0ASpawnElytra-1.4.jar%0AEssentialsXChat-2.21.2.jar
const REPLACED = /^(EssentialsX(Spawn)?[-_ ]?[\d.]*|SpawnElytra.*)\.jar$/i;

const here = path.dirname(fileURLToPath(import.meta.url));

/** The plugin file the panel brings along, or null (a build without it). */
export function morniCraftJar(): string | null {
  const candidates = [
    process.env['MH_MORNICRAFT_JAR'],
    IMAGE_JAR,
    // Development: built with "mvn package" in the repo.
    path.resolve(here, '../../../../plugins/mornicraft/target', PLUGIN_FILE),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const hashOf = (file: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Copies the plugin into the server when it is missing or older; true when it changed. */
export function installMorniCraft(serverDir: string): boolean {
  const jar = morniCraftJar();
  if (!jar) return false;
  const target = path.join(serverDir, 'plugins', PLUGIN_FILE);
  if (fs.existsSync(target) && hashOf(target) === hashOf(jar)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(jar, target);
  return true;
}

/** Switches off EssentialsX, EssentialsX Spawn and SpawnElytra (only when MorniCraft is there); their names. */
export function retireReplacedPlugins(serverDir: string): string[] {
  const dir = path.join(serverDir, 'plugins');
  if (!fs.existsSync(path.join(dir, PLUGIN_FILE)) || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => REPLACED.test(name))
    .map((name) => {
      fs.renameSync(path.join(dir, name), path.join(dir, `${name}.disabled`));
      return name;
    });
}

// Rank ids: "owner", "mod-2", "vip_plus". https://regex101.com/?flavor=javascript&regex=%5E%5Ba-z0-9_-%5D%7B1%2C24%7D%24&testString=owner%0Amod-2
const RANK_ID = /^[a-z0-9_-]{1,24}$/;
// "#ff5555". https://regex101.com/?flavor=javascript&regex=%5E%23%5B0-9a-fA-F%5D%7B6%7D%24&testString=%23ff5555
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// Java names (Morni_23), Bedrock names behind Floodgate (.Morni). https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_.*-%5D%7B1%2C32%7D%24&testString=Morni_23%0A.Morni
const PLAYER_NAME = /^[A-Za-z0-9_.*-]{1,32}$/;
const MAX_SYMBOL = 4;
const MAX_RANK_NAME = 20;
const MAX_RANK_PLAYERS = 200;

const rankSchema = z.object({
  id: z.string().regex(RANK_ID),
  name: z.string().trim().min(1).max(MAX_RANK_NAME),
  symbol: z
    .string()
    .trim()
    .refine((v) => Array.from(v).length <= MAX_SYMBOL),
  color: z.string().regex(HEX_COLOR),
  permissions: z.array(z.enum(RANK_PERMISSIONS)).max(RANK_PERMISSIONS.length),
  players: z.array(z.string().trim().regex(PLAYER_NAME)).max(MAX_RANK_PLAYERS),
  isDefault: z.boolean(),
  fromPanel: z.enum(RANK_SOURCES),
});

const ranksSchema = z
  .array(rankSchema)
  .max(MAX_RANKS)
  .refine((ranks) => new Set(ranks.map((r) => r.id)).size === ranks.length, 'rank ids must be unique')
  .refine((ranks) => ranks.filter((r) => r.isDefault).length <= 1, 'only one default rank');

export const morniCraftSettingsSchema = z.object({
  teleportDelay: z.number().int().min(0).max(30),
  maxHomes: z.number().int().min(1).max(50),
  spawnProtection: z.boolean(),
  spawnRadius: z.number().int().min(10).max(200),
  sleepAtSpawn: z.boolean(),
  pvpAtSpawn: z.boolean(),
  elytra: z.boolean(),
  elytraRadius: z.number().int().min(10).max(200),
  elytraBoost: z.boolean(),
  tpa: z.boolean(),
  back: z.boolean(),
  welcome: z.boolean(),
  sidebar: z.boolean(),
  showLink: z.boolean(),
  tnt: z.boolean(),
  creeperDamage: z.boolean(),
  fireSpread: z.boolean(),
  endermanGrief: z.boolean(),
  rules: z.array(z.string().trim().min(1).max(120)).max(15),
  ranks: ranksSchema,
  badges: z.boolean(),
  graves: z.boolean(),
  gravePrivateMinutes: z.number().int().min(0).max(120),
  tabStats: z.boolean(),
  combatSeconds: z.number().int().min(0).max(60),
});

/** Stored settings, completed with the defaults (older or partial entries). */
export function withDefaults(stored: Partial<MorniCraftSettings> | undefined): MorniCraftSettings {
  return { ...MORNICRAFT_DEFAULTS, ...(stored ?? {}) };
}

export interface ConfigContext {
  readonly language: 'de' | 'en';
  readonly serverName: string;
  readonly timezone: string;
  /** The personal command page with "{name}" for the player, or empty. */
  readonly link: string;
  /** Round spots outside the spawn circle that are protected too (x/z from the world spawn, radius). */
  readonly zones?: readonly { readonly x: number; readonly z: number; readonly r: number }[];
  /** The server's own names (panel domain, its address …): streamer mode turns them into "•••". */
  readonly hide?: readonly string[];
  /** The badges' resource pack (where to load it, its SHA-1, the character per rank id), when it can be offered. */
  readonly pack?: {
    readonly url: string;
    readonly sha1: string;
    readonly chars: Readonly<Record<string, string>>;
  };
  /** Players the panel gives a rank by itself: owners and moderators of the server with a linked account. */
  readonly members?: Readonly<Record<'owner' | 'moderator', readonly LinkedPlayer[]>>;
}

export interface LinkedPlayer {
  readonly uuid: string;
  readonly name: string;
}

/** Ranks with a symbol get a badge – and the rank for everyone else (it shows the little player). */
export const hasBadge = (r: MorniCraftRank): boolean => Boolean(r.symbol) || r.isDefault;

/** A rank as the plugin reads it: the permission nodes spelled out, players from the panel added (by UUID). */
function rankConfig(r: MorniCraftRank, c: ConfigContext) {
  const auto = r.fromPanel === 'none' ? [] : (c.members?.[r.fromPanel] ?? []);
  const named = r.players.filter((n) => !auto.some((a) => a.name.toLowerCase() === n.toLowerCase()));
  return {
    id: r.id,
    name: r.name,
    symbol: r.symbol,
    color: r.color,
    default: r.isDefault,
    // The character that shows the rank's badge to players with the resource pack.
    badge: (hasBadge(r) && c.pack?.chars[r.id]) || '',
    permissions: [...new Set(r.permissions.flatMap((p) => RANK_PERMISSION_NODES[p]))],
    players: [...auto.map((a) => ({ uuid: a.uuid, name: a.name })), ...named.map((name) => ({ name }))],
  };
}

/**
 * The plugin's config.yml. YAML is a superset of JSON, so the panel writes JSON (no quoting surprises with names,
 * rules or links) behind a comment line.
 */
export function morniCraftConfig(s: MorniCraftSettings, c: ConfigContext): string {
  const groups = CRAFT_ATTACK_COMMANDS.map((g) => ({
    title: g.title[c.language],
    commands: g.commands.map((cmd) => ({
      use: cmd.use[c.language],
      text: cmd.text[c.language],
      op: cmd.opOnly === true,
    })),
  }));
  const config = {
    language: c.language,
    'server-name': c.serverName,
    timezone: c.timezone,
    link: s.showLink ? c.link : '',
    'teleport-delay': s.teleportDelay,
    'max-homes': s.maxHomes,
    'spawn-protection': s.spawnProtection,
    'spawn-radius': s.spawnRadius,
    'sleep-at-spawn': s.sleepAtSpawn,
    'pvp-at-spawn': s.pvpAtSpawn,
    elytra: s.elytra,
    'elytra-radius': s.elytraRadius,
    'elytra-boost': s.elytraBoost,
    tpa: s.tpa,
    back: s.back,
    welcome: s.welcome,
    sidebar: s.sidebar,
    // The panel brings new plugin versions itself.
    'update-check': false,
    tnt: s.tnt,
    'creeper-damage': s.creeperDamage,
    'fire-spread': s.fireSpread,
    'enderman-grief': s.endermanGrief,
    rules: s.rules,
    groups,
    ranks: s.ranks.map((r) => rankConfig(r, c)),
    zones: c.zones ?? [],
    pack: c.pack ? { url: c.pack.url, sha1: c.pack.sha1 } : { url: '', sha1: '' },
    graves: s.graves,
    'grave-private-minutes': s.gravePrivateMinutes,
    'tab-stats': s.tabStats,
    'combat-seconds': s.combatSeconds,
    streamer: { hide: c.hide ?? [] },
  };
  return `# MorniCraft – written by MorniHosting (Dashboard → server → MorniCraft). Changes here are overwritten.\n${JSON.stringify(config, null, 2)}\n`;
}

export function writeMorniCraftConfig(serverDir: string, s: MorniCraftSettings, c: ConfigContext): void {
  const dir = path.join(serverDir, 'plugins', CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yml'), morniCraftConfig(s, c));
}

// A home's name in a player file (MorniCraft or EssentialsX): two spaces, the name, a colon ("  base:").
// https://regex101.com/?flavor=javascript&regex=%5E%20%7B2%7D(%5B%5E%5Cs%3A%5D%5B%5E%3A%5D*)%3A%5Cs*%24&testString=%20%20base%3A
const HOME_LINE = /^ {2}([^\s:][^:]*):\s*$/;
const TOP_LEVEL = /^\S/; // eslint-disable-line ts-patterns/require-regex-example -- "logoutlocation:" yes, "  base:" no

function homesIn(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === 'homes:');
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => TOP_LEVEL.test(line));
  return (end < 0 ? rest : rest.slice(0, end))
    .map((line) => line.match(HOME_LINE)?.[1])
    .filter((home): home is string => Boolean(home));
}

/** The names of a player's homes: MorniCraft's file, else (not taken over yet) EssentialsX's. */
export function homesOf(serverDir: string, uuid: string): string[] {
  const id = path.basename(uuid);
  const own = path.join(serverDir, 'plugins', CONFIG_DIR, 'players', `${id}.yml`);
  if (fs.existsSync(own)) return homesIn(own);
  return homesIn(path.join(serverDir, 'plugins', 'Essentials', 'userdata', `${id}.yml`));
}

/** The personal command page for /info: "{name}" is filled in by the plugin. */
export const personalLink = (domain: string, slug: string): string =>
  `https://${domain}/befehle/${slug}/{name}`;
