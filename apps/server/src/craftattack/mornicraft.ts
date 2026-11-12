import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CRAFT_ATTACK_COMMANDS, MORNICRAFT_DEFAULTS, type MorniCraftSettings } from '@mornihosting/shared';

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
