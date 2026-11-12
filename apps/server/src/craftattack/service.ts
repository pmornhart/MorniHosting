import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CRAFT_ATTACK_PLUGINS,
  CRAFT_ATTACK_PREGEN_RADIUS,
  CRAFT_ATTACK_PROPERTIES,
  CRAFT_ATTACK_SOFTWARE,
  type CraftAttackPlayerCommands,
  type PublicStats,
  type PublicStatsSetting,
  type SoftwareId,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { fetchJson } from '../lib/http-client.js';
import type { MarketService } from '../market/service.js';
import type { PlayerDetailService } from '../players/detail.js';
import { readPropertiesFile, writePropertiesFile } from '../servers/properties-file.js';
import type { ServerService } from '../servers/service.js';
import { versionsFor } from '../servers/versions.js';
import { SPAWN_PACK_DIR, SPAWN_Y, spawnElytraConfig, writeSpawnPack } from './spawn.js';
import { homesOf, openPlayerCommands, personalLink, writeHelpFiles } from './help.js';
import { deathsOf, playerNumbers } from './stats.js';

/**
 * The Craft Attack package and the public statistics page.
 *
 * Package (ordered as an add-on): EssentialsX + EssentialsX Spawn (/spawn, /home, /tpa …), Chunky and SpawnElytra
 * (the start elytra) from Modrinth, settings for a whitelisted friends' survival world, a datapack that builds the
 * floating spawn island on the first
 * start, the world around it generated in advance, and the statistics page switched on.
 */

const SETTINGS_KEY = 'public_stats';
const MODRINTH_PROJECT = 'https://api.modrinth.com/v2/project/';
const MOTD_SUFFIX = ' §7· §aCraft Attack';
// A server's address name as the page path: "Craft Attack!" → "craft-attack".
// https://regex101.com/?flavor=javascript&regex=%5B%5Ea-z0-9%5D%2B&flags=g&testString=craft%20attack!
const NOT_SLUG = /[^a-z0-9]+/g;
// Leading or trailing dashes of a slug: "-craft-attack-" → "craft-attack".
// https://regex101.com/?flavor=javascript&regex=%5E-%2B%7C-%2B%24&flags=g&testString=-craft-attack-
const EDGE_DASHES = /^-+|-+$/g;
const SLUG_MAX = 40;
/** Where the spawn island goes on a new world: the nearest deep ocean, else any ocean. */
const OCEAN_BIOMES = ['minecraft:deep_ocean', '#minecraft:is_ocean'] as const;
/** How far beyond the ocean's nearest edge the island is placed. */
const OCEAN_INSET = 96;
/** Half the area the build needs loaded round the island (island, decks, islets, balloon). */
const BUILD_REACH = 64;
const LOAD_WAIT_MS = 60_000;
const LOAD_POLL_MS = 1000;
// "/locate" answer: "The nearest minecraft:deep_ocean is at [1088, 64, 1088] (1538 blocks away)" → 1088, 1088
// (older versions write "~" instead of the height).
// https://regex101.com/?flavor=javascript&regex=%5C%5B(-%3F%5Cd%2B)%2C%20(%3F%3A~%7C-%3F%5Cd%2B)%2C%20(-%3F%5Cd%2B)%5C%5D&testString=The%20nearest%20minecraft%3Adeep_ocean%20is%20at%20%5B1088%2C%2064%2C%201088%5D%20(1538%20blocks%20away)%0A%5B-1200%2C%20~%2C%20340%5D
const LOCATED = /\[(-?\d+), (?:~|-?\d+), (-?\d+)\]/;
// Scoreboard answer when the island was built: "#built has 1 [mh_craftattack]"; "Can't get value" does not match.
// https://regex101.com/?flavor=javascript&regex=has%201%20%5C%5B&testString=%23built%20has%201%20%5Bmh_craftattack%5D%0ACan't%20get%20value%20of%20%23built
const BUILT = /has 1 \[/;
// "execute if loaded" answer: "Test passed" matches, "Test failed" does not.
// https://regex101.com/?flavor=javascript&regex=passed&testString=Test%20passed%0ATest%20failed
const PASSED = /passed/;

const FLOODGATE_PREFIX = '.';
const FLOODGATE_UUID = '00000000-0000-0000-';
const nameListSchema = z.array(z.object({ name: z.string() }).loose());

/** Lower-case names in ops.json / whitelist.json (empty if missing or broken). */
function namesIn(file: string): Set<string> {
  try {
    const parsed = nameListSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return new Set(parsed.success ? parsed.data.map((e) => e.name.toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls until the check says yes or the time is up. */
async function waitUntil(check: () => Promise<boolean>, maxMs: number): Promise<void> {
  if (maxMs <= 0 || (await check())) return;
  await sleep(LOAD_POLL_MS);
  await waitUntil(check, maxMs - LOAD_POLL_MS);
}
/** The SpawnElytra plugin's data folder (its name in plugin.yml). */
const ELYTRA_FOLDER = 'SpawnElytra';
const ELYTRA_ANYWHERE = 'ignoreYInSpawnRadius: true';
const ELYTRA_AT_SPAWN = 'ignoreYInSpawnRadius: false';

export const publicStatsInputSchema = z.object({
  enabled: z.boolean(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(SLUG_MAX)
    .regex(/^[a-z0-9-]*$/) // eslint-disable-line ts-patterns/require-regex-example -- "craft-attack" ok, "Craft Attack!" not
    .optional(),
});

const projectSchema = z.object({ game_versions: z.array(z.string()) }).loose();

export interface CraftAttackService {
  /** The newest version (not newer than the wanted one, if it fits) that all required plugins support. */
  readonly fitVersion: (software: SoftwareId, wanted: string) => Promise<string>;
  readonly setUp: (serverId: string, actor: Actor) => Promise<void>;
  /** Generates the world around the spawn (the server must run). */
  readonly pregenerate: (serverId: string) => Promise<void>;
  readonly publicSetting: (serverId: string) => PublicStatsSetting;
  readonly setPublic: (serverId: string, input: z.infer<typeof publicStatsInputSchema>) => PublicStatsSetting;
  readonly publicStats: (slug: string) => PublicStats;
  /** The personal command page: what this player may use on the server with this slug. */
  readonly playerCommands: (slug: string, name: string) => CraftAttackPlayerCommands;
  /** A Craft Attack server: its world carries the spawn datapack. */
  readonly isCraftAttack: (serverId: string) => boolean;
}

export function createCraftAttackService(
  ctx: AppContext,
  deps: {
    readonly servers: ServerService;
    readonly market: MarketService;
    readonly players: PlayerDetailService;
  },
): CraftAttackService {
  const { servers, market, players } = deps;
  const stored = (): Record<string, PublicStatsSetting> =>
    ctx.settings.getValue<Record<string, PublicStatsSetting>>(SETTINGS_KEY) ?? {};

  const slugFrom = (text: string): string =>
    text.toLowerCase().replace(NOT_SLUG, '-').replace(EDGE_DASHES, '').slice(0, SLUG_MAX);
  const defaultSlug = (serverId: string): string => {
    const row = servers.row(serverId);
    return slugFrom(row.netbirdName ?? row.name) || serverId;
  };

  const publicSetting: CraftAttackService['publicSetting'] = (serverId) =>
    stored()[serverId] ?? { enabled: false, slug: defaultSlug(serverId) };

  const setPublic: CraftAttackService['setPublic'] = (serverId, input) => {
    const row = servers.row(serverId);
    if (row.edition !== 'java') throw badRequest('public_stats_java_only');
    const slug = slugFrom(input.slug || publicSetting(serverId).slug) || serverId;
    const taken = Object.entries(stored()).some(([id, s]) => id !== serverId && s.slug === slug);
    if (taken) throw badRequest('public_stats_slug_taken', { slug });
    const next = { enabled: input.enabled, slug };
    ctx.settings.setValue(SETTINGS_KEY, { ...stored(), [serverId]: next });
    return next;
  };

  /** The page address for /info (only with a panel domain); older servers get their slug stored here. */
  const linkFor = (serverId: string): string | undefined => {
    const domain = ctx.settings.get().panelDomain;
    if (!domain) return undefined;
    const slug = stored()[serverId]?.slug ?? safeSlug(serverId);
    return slug ? personalLink(domain, slug) : undefined;
  };
  const safeSlug = (serverId: string): string | undefined => {
    try {
      return setPublic(serverId, { enabled: false }).slug;
    } catch {
      return undefined;
    }
  };

  const locale = (): 'de' | 'en' => (ctx.settings.get().defaultLocale === 'en' ? 'en' : 'de');

  const fitVersion: CraftAttackService['fitVersion'] = async (software, wanted) => {
    try {
      return await fitVersionNow(software, wanted);
    } catch (err) {
      // Modrinth not reachable: keep the chosen version; the plugin install then says what does not fit.
      ctx.log.warn({ err }, 'craft attack version check failed');
      return wanted;
    }
  };
  const fitVersionNow = async (software: SoftwareId, wanted: string): Promise<string> => {
    const supported = await Promise.all(
      CRAFT_ATTACK_PLUGINS.filter((p) => p.required).map(async (p) => {
        const parsed = projectSchema.safeParse(await fetchJson(`${MODRINTH_PROJECT}${p.id}`));
        return new Set(parsed.success ? parsed.data.game_versions : []);
      }),
    );
    const fits = (version: string): boolean => supported.every((s) => s.has(version));
    if (fits(wanted)) return wanted;
    const options = await versionsFor(software);
    return options.find((v) => v.stable && fits(v.id))?.id ?? wanted;
  };

  const setUp: CraftAttackService['setUp'] = async (serverId, actor) => {
    const row = servers.row(serverId);
    if (!CRAFT_ATTACK_SOFTWARE.includes(row.software)) throw badRequest('craft_attack_software');
    // One after another: the per-server plugin lock would make them wait anyway.
    await CRAFT_ATTACK_PLUGINS.reduce(async (previous, plugin) => {
      await previous;
      try {
        await market.installFrom(serverId, 'modrinth', plugin.id, actor);
      } catch (err) {
        if (plugin.required) throw err;
        servers.note(serverId, `${plugin.name} ließ sich nicht installieren – geht auch ohne.`);
      }
    }, Promise.resolve());
    const dir = servers.dir(serverId);
    writePropertiesFile(dir, { ...CRAFT_ATTACK_PROPERTIES, motd: `§f${row.name}${MOTD_SUFFIX}` });
    const level = readPropertiesFile(dir).values['level-name'] || 'world';
    writeSpawnPack(path.join(dir, path.basename(level)));
    // The start elytra's settings, before the plugin first starts (it keeps an existing file and fills in the rest).
    const elytraConfig = path.join(dir, 'plugins', ELYTRA_FOLDER, 'config.yml');
    if (!fs.existsSync(elytraConfig)) {
      fs.mkdirSync(path.dirname(elytraConfig), { recursive: true });
      fs.writeFileSync(elytraConfig, spawnElytraConfig(path.basename(level)));
    }
    setPublic(serverId, { enabled: true });
    writeHelpFiles(dir, locale(), linkFor(serverId));
  };

  /**
   * Builds the spawn island over an ocean (on a new world): Minecraft's own /locate finds the nearest deep ocean
   * (else any ocean), the island goes a bit further out from its edge, the chunks there are loaded, then the
   * datapack builds everything at that spot. Older worlds (already built) are left alone (null).
   */
  const buildSpawn = async (serverId: string): Promise<{ x: number; z: number } | null> => {
    const ask = (command: string): Promise<string> => servers.quietCommand(serverId, command).catch(() => '');
    if (BUILT.test(await ask('scoreboard players get #built mh_craftattack'))) return null;
    const located = await OCEAN_BIOMES.reduce<Promise<RegExpMatchArray | null>>(
      async (previous, biome) => (await previous) ?? (await ask(`locate biome ${biome}`)).match(LOCATED),
      Promise.resolve(null),
    );
    const found = { x: Number(located?.[1] ?? 0), z: Number(located?.[2] ?? 0) };
    // /locate gives the ocean's nearest point – its edge. Go further out, away from the world's middle.
    const away = Math.hypot(found.x, found.z);
    const spot =
      away > OCEAN_INSET
        ? {
            x: Math.round(found.x + (found.x / away) * OCEAN_INSET),
            z: Math.round(found.z + (found.z / away) * OCEAN_INSET),
          }
        : found;
    const box = `${spot.x - BUILD_REACH} ${spot.z - BUILD_REACH} ${spot.x + BUILD_REACH} ${spot.z + BUILD_REACH}`;
    await ask(`forceload add ${box}`);
    const corners = [-BUILD_REACH, BUILD_REACH].flatMap((dx) =>
      [-BUILD_REACH, BUILD_REACH].map((dz) => `${spot.x + dx} ${SPAWN_Y} ${spot.z + dz}`),
    );
    const loaded = async (): Promise<boolean> =>
      (await Promise.all(corners.map((c) => ask(`execute if loaded ${c}`)))).every((r) => PASSED.test(r));
    await waitUntil(loaded, LOAD_WAIT_MS);
    await ask(`execute positioned ${spot.x} ${SPAWN_Y} ${spot.z} run function craftattack:build`);
    await ask(`forceload remove ${box}`);
    servers.note(
      serverId,
      located
        ? `Spawn-Insel über dem Meer gebaut (x ${spot.x}, z ${spot.z}).`
        : `Kein Meer in der Nähe gefunden – Spawn-Insel bei x ${spot.x}, z ${spot.z} gebaut.`,
    );
    return spot;
  };

  const pregenerate: CraftAttackService['pregenerate'] = async (serverId) => {
    const spot = await buildSpawn(serverId);
    if (spot) await servers.command(serverId, `chunky center ${spot.x} ${spot.z}`, null);
    // EssentialsX wrote its config on this first start: let players use /home, /tpa … and reload it.
    if (openPlayerCommands(servers.dir(serverId))) await servers.command(serverId, 'essentials reload', null);
    await servers.command(serverId, `chunky radius ${CRAFT_ATTACK_PREGEN_RADIUS}`, null);
    await servers.command(serverId, 'chunky start', null);
    servers.note(
      serverId,
      `Die Welt wird im Hintergrund bis ${CRAFT_ATTACK_PREGEN_RADIUS} Blöcke um den Spawn vorgeneriert – spielen geht schon.`,
    );
  };

  const publicStats: CraftAttackService['publicStats'] = (slug) => {
    const entry = Object.entries(stored()).find(([, s]) => s.enabled && s.slug === slug.toLowerCase());
    if (!entry) throw notFound('public_stats_unknown');
    const [serverId] = entry;
    const row = servers.row(serverId);
    const dir = servers.dir(serverId);
    const level = readPropertiesFile(dir).values['level-name'] || 'world';
    const worldDir = path.join(dir, path.basename(level));
    const live = servers.live(serverId);
    const known = (() => {
      try {
        return players.known(serverId);
      } catch {
        return [];
      }
    })();
    const list = known
      .map((p) => ({
        name: p.name,
        uuid: p.uuid,
        online: p.online,
        lastSeen: p.savedAt,
        ...playerNumbers(worldDir, p.uuid),
      }))
      .sort((a, b) => b.playTimeSeconds - a.playTimeSeconds);
    return {
      name: row.name,
      locale: ctx.settings.get().defaultLocale === 'en' ? 'en' : 'de',
      motd: readPropertiesFile(dir).values['motd']?.replace(/§[0-9a-fk-or]/gi, '') ?? null, // eslint-disable-line ts-patterns/require-regex-example -- colour codes: "§aHallo" → "Hallo"
      address: servers.summary(serverId).address || null,
      running: live.state === 'running',
      playersOnline: live.playersOnline,
      playersMax: live.playersMax,
      players: list,
      deaths: deathsOf(
        dir,
        known.map((p) => p.name),
        ctx.settings.get().timezone,
      ),
      updatedAt: new Date().toISOString(),
    };
  };

  const playerCommands: CraftAttackService['playerCommands'] = (slug, name) => {
    const entry = Object.entries(stored()).find(
      ([id, s]) => s.slug === slug.toLowerCase() && isCraftAttack(id),
    );
    if (!entry) throw notFound('craft_attack_unknown');
    const [serverId] = entry;
    const dir = servers.dir(serverId);
    const lower = name.toLowerCase();
    const player = (() => {
      try {
        return players.known(serverId).find((p) => p.name.toLowerCase() === lower);
      } catch {
        return undefined;
      }
    })();
    const listed = (file: string): boolean => namesIn(path.join(dir, file)).has(lower);
    const op = player?.op ?? listed('ops.json');
    const whitelisted = player?.whitelisted ?? listed('whitelist.json');
    const whitelistOn = readPropertiesFile(dir).values['white-list'] === 'true';
    return {
      server: servers.row(serverId).name,
      locale: locale(),
      name: player?.name ?? name,
      uuid: player?.uuid ?? null,
      known: Boolean(player),
      online: player?.online ?? false,
      op,
      locked: whitelistOn && !whitelisted && !op,
      // Floodgate marks Bedrock players with a leading dot and a UUID starting with zeros.
      bedrock: name.startsWith(FLOODGATE_PREFIX) || Boolean(player?.uuid.startsWith(FLOODGATE_UUID)),
      homes: player ? homesOf(dir, player.uuid) : [],
    };
  };

  /** Older setups let the start elytra work in the whole column under the island, down to the ground. */
  const startElytraOnlyAtSpawn = (dir: string): void => {
    const file = path.join(dir, 'plugins', ELYTRA_FOLDER, 'config.yml');
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(ELYTRA_ANYWHERE))
      fs.writeFileSync(file, text.replace(ELYTRA_ANYWHERE, ELYTRA_AT_SPAWN));
  };

  const worldOf = (serverId: string): string => {
    const dir = servers.dir(serverId);
    const level = readPropertiesFile(dir).values['level-name'] || 'world';
    return path.join(dir, path.basename(level));
  };
  const isCraftAttack: CraftAttackService['isCraftAttack'] = (serverId) => {
    try {
      return fs.existsSync(path.join(worldOf(serverId), 'datapacks', SPAWN_PACK_DIR));
    } catch {
      return false;
    }
  };

  // Craft Attack servers get the newest datapack before each start (it repairs older islands once and never builds
  // anything twice), the in-game help (/info, /motd, /rules) and the rights for players to use the commands.
  servers.onBeforeStart((serverId) => {
    try {
      if (!isCraftAttack(serverId)) return;
      writeSpawnPack(worldOf(serverId));
      writeHelpFiles(servers.dir(serverId), locale(), linkFor(serverId));
      openPlayerCommands(servers.dir(serverId));
      startElytraOnlyAtSpawn(servers.dir(serverId));
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'craft attack datapack update failed');
    }
  });

  return {
    fitVersion,
    setUp,
    pregenerate,
    publicSetting,
    setPublic,
    publicStats,
    playerCommands,
    isCraftAttack,
  };
}
