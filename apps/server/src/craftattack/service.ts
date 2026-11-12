import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CRAFT_ATTACK_PLUGINS,
  CRAFT_ATTACK_PREGEN_RADIUS,
  CRAFT_ATTACK_PROPERTIES,
  CRAFT_ATTACK_SOFTWARE,
  type CraftAttackPlayerCommands,
  type MorniCraftSettings,
  type MorniCraftState,
  type PublicStats,
  type PublicStatsSetting,
  type SoftwareId,
} from '@mornihosting/shared';
import { SYSTEM_ACTOR, type Actor } from '../audit/service.js';
import type { GeyserService } from '../geyser/service.js';
import type { AppContext } from '../context.js';
import { and, eq, isNotNull } from 'drizzle-orm';
import { roles, serverAccess, servers as serverTable, users } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { fetchJson } from '../lib/http-client.js';
import type { MarketService } from '../market/service.js';
import type { PlayerDetailService } from '../players/detail.js';
import { readPropertiesFile, writePropertiesFile } from '../servers/properties-file.js';
import type { ServerService } from '../servers/service.js';
import { versionsFor } from '../servers/versions.js';
import { type IslandSpot, SPAWN_PACK_DIR, SPAWN_Y, SPAWN_ZONES, writeSpawnPack } from './spawn.js';
import {
  type ConfigContext,
  hasBadge,
  homesOf,
  installMorniCraft,
  type LinkedPlayer,
  morniCraftJar,
  personalLink,
  retireReplacedPlugins,
  withDefaults,
  writeMorniCraftConfig,
} from './mornicraft.js';
import { type BadgePack, badgePack } from './badges.js';
import { MORNICRAFT_ICON_VERSION, writeMorniCraftIcon } from './icon.js';
import { deathsOf, playerNumbers } from './stats.js';

/**
 * The MorniCraft package (in the code "craft attack") and its public pages.
 *
 * Package (ordered as an add-on): the panel's own MorniCraft plugin (see mornicraft.ts) and Chunky, settings for a
 * whitelisted friends' survival world, a datapack that builds the floating spawn island over the sea after the
 * first start, the world around it generated in advance, the statistics page switched on. Every client version
 * can join: the order adds ViaVersion.
 */

const SETTINGS_KEY = 'public_stats';
/** Where the panel built each server's spawn island (older islands: not stored, they stand at 0/0). */
const SPOTS_KEY = 'craftattack_spawn';
const MODRINTH_PROJECT = 'https://api.modrinth.com/v2/project/';
const MOTD_SUFFIX = ' §7· §aMorniCraft';
/** The dashboard settings of each MorniCraft server. */
const MORNICRAFT_KEY = 'mornicraft';
/** MorniCraft servers on which the panel switched on "all versions" once (switching it off later stays off). */
const VIA_DONE_KEY = 'mornicraft_via';
/** Which MorniCraft servers already got the server icon (server id → picture version). */
const ICON_DONE_KEY = 'mornicraft_icon';
/** Letters of the pack's checksum in its link: a changed pack gets a new address. */
const PACK_VERSION_LENGTH = 10;
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
/** Bring the plugin and its settings to all MorniCraft servers shortly after the panel started. */
const REFRESH_DELAY_MS = 5000;
/** How often a server waiting for a restart (new plugin version) is checked for players. */
const RESTART_CHECK_MS = 60_000;
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
  /** A MorniCraft server: its world carries the spawn datapack. */
  readonly isCraftAttack: (serverId: string) => boolean;
  /** The badges' resource pack of the server with this public slug (the zip file), or null. */
  readonly badgePack: (slug: string) => Buffer | null;
  readonly morniCraft: (serverId: string) => MorniCraftState;
  /** Saves the dashboard settings, writes the plugin's config and applies it at once on a running server. */
  readonly setMorniCraft: (serverId: string, settings: MorniCraftSettings) => Promise<MorniCraftState>;
}

export function createCraftAttackService(
  ctx: AppContext,
  deps: {
    readonly servers: ServerService;
    readonly market: MarketService;
    readonly players: PlayerDetailService;
    /** Switches on "all versions" (ViaVersion) once on MorniCraft servers set up before it came with the order. */
    readonly geyser?: GeyserService;
  },
): CraftAttackService {
  const { servers, market, players, geyser } = deps;
  const spots = (): Record<string, IslandSpot> =>
    ctx.settings.getValue<Record<string, IslandSpot>>(SPOTS_KEY) ?? {};
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
  const linkFor = (serverId: string): string => {
    const domain = ctx.settings.get().panelDomain;
    if (!domain) return '';
    const slug = stored()[serverId]?.slug ?? safeSlug(serverId);
    return slug ? personalLink(domain, slug) : '';
  };
  const mcStored = (): Record<string, Partial<MorniCraftSettings>> =>
    ctx.settings.getValue<Record<string, Partial<MorniCraftSettings>>>(MORNICRAFT_KEY) ?? {};
  const settingsOf = (serverId: string): MorniCraftSettings => withDefaults(mcStored()[serverId]);
  /** Linked Minecraft accounts of the server's owners (and panel admins) and moderators: they get their rank. */
  const panelMembers = (serverId: string): Record<'owner' | 'moderator', LinkedPlayer[]> => {
    const withRole = (role: 'owner' | 'moderator'): Set<number> =>
      new Set(
        ctx.db
          .select({ userId: serverAccess.userId })
          .from(serverAccess)
          .innerJoin(roles, eq(roles.id, serverAccess.roleId))
          .where(and(eq(serverAccess.serverId, serverId), eq(roles.builtIn, role)))
          .all()
          .map((r) => r.userId),
      );
    const owners = withRole('owner');
    const moderators = withRole('moderator');
    const linked = ctx.db
      .select()
      .from(users)
      .where(and(isNotNull(users.minecraftUuid), eq(users.disabled, false)))
      .all();
    const player = (u: (typeof linked)[number]): LinkedPlayer => ({
      uuid: u.minecraftUuid ?? '',
      name: u.minecraftName ?? '',
    });
    return {
      owner: linked.filter((u) => u.isAdmin || owners.has(u.id)).map(player),
      moderator: linked.filter((u) => !u.isAdmin && !owners.has(u.id) && moderators.has(u.id)).map(player),
    };
  };
  /** The badges' resource pack of a server, built from its ranks (kept until the ranks change). */
  const packs = new Map<string, { key: string; pack: BadgePack }>();
  const packOf = (serverId: string): BadgePack => {
    const ranks = settingsOf(serverId).ranks.filter(hasBadge);
    const key = JSON.stringify(ranks.map((r) => [r.id, r.name, r.symbol, r.color, r.isDefault]));
    const cached = packs.get(serverId);
    if (cached?.key === key) return cached.pack;
    const pack = badgePack(ranks);
    packs.set(serverId, { key, pack });
    return pack;
  };
  /** Where players load the pack from – only with a panel domain (the link has to work from everywhere). */
  const packUrl = (serverId: string): string | null => {
    const domain = ctx.settings.get().panelDomain;
    const slug = stored()[serverId]?.slug ?? safeSlug(serverId);
    if (!domain || !slug) return null;
    return `https://${domain}/api/public/packs/${slug}.zip?v=${packOf(serverId).sha1.slice(0, PACK_VERSION_LENGTH)}`;
  };
  const packConfig = (serverId: string): ConfigContext['pack'] => {
    const url = settingsOf(serverId).badges ? packUrl(serverId) : null;
    if (!url) return undefined;
    const { sha1, chars } = packOf(serverId);
    return { url, sha1, chars };
  };
  const writeConfig = (serverId: string): void =>
    writeMorniCraftConfig(servers.dir(serverId), settingsOf(serverId), {
      pack: packConfig(serverId),
      language: locale(),
      serverName: servers.row(serverId).name,
      timezone: ctx.settings.get().timezone,
      link: linkFor(serverId),
      members: panelMembers(serverId),
      // The small islands and balloons round the spawn belong to it: nobody takes them apart.
      zones: SPAWN_ZONES,
    });
  /** The MorniCraft picture for the server list: put in once per server (a picture uploaded later stays). */
  const iconOnce = (serverId: string, dir: string): void => {
    const done = ctx.settings.getValue<Record<string, number>>(ICON_DONE_KEY) ?? {};
    if ((done[serverId] ?? 0) >= MORNICRAFT_ICON_VERSION) return;
    writeMorniCraftIcon(dir);
    ctx.settings.setValue(ICON_DONE_KEY, { ...done, [serverId]: MORNICRAFT_ICON_VERSION });
  };
  /** The plugin, its config, and the old plugins it replaces switched off. */
  /** True when a new plugin version was put in (a running server loads it at its next start). */
  const equip = (serverId: string): boolean => {
    const dir = servers.dir(serverId);
    const newPlugin = installMorniCraft(dir);
    const retired = retireReplacedPlugins(dir);
    if (retired.length)
      servers.note(serverId, `Durch MorniCraft ersetzt und ausgeschaltet: ${retired.join(', ')}`);
    writeConfig(serverId);
    iconOnce(serverId, dir);
    return newPlugin;
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
    writeSpawnPack(path.join(dir, path.basename(level)), undefined, locale());
    setPublic(serverId, { enabled: true });
    equip(serverId);
    // New orders bring ViaVersion themselves: nothing to switch on later.
    ctx.settings.setValue(VIA_DONE_KEY, [...(ctx.settings.getValue<string[]>(VIA_DONE_KEY) ?? []), serverId]);
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
    // Later datapack versions repair this island where it really stands.
    ctx.settings.setValue(SPOTS_KEY, { ...spots(), [serverId]: spot });
    writeSpawnPack(worldOf(serverId), spot, locale());
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

  const morniCraft: CraftAttackService['morniCraft'] = (serverId) => {
    const active = isCraftAttack(serverId);
    return {
      active,
      slug: active ? publicSetting(serverId).slug : null,
      settings: settingsOf(serverId),
      pluginAvailable: morniCraftJar() !== null,
      badgePackUrl: active ? packUrl(serverId) : null,
      panelMembers: (() => {
        const m = panelMembers(serverId);
        return { owner: m.owner.map((p) => p.name), moderator: m.moderator.map((p) => p.name) };
      })(),
    };
  };

  const badgePackFile: CraftAttackService['badgePack'] = (slug) => {
    const wanted = slug.toLowerCase();
    const found = Object.entries(stored()).find(([id, st]) => st.slug === wanted && isCraftAttack(id));
    return found ? packOf(found[0]).zip : null;
  };

  const setMorniCraft: CraftAttackService['setMorniCraft'] = async (serverId, next) => {
    if (!isCraftAttack(serverId)) throw badRequest('mornicraft_inactive');
    ctx.settings.setValue(MORNICRAFT_KEY, { ...mcStored(), [serverId]: next });
    equip(serverId);
    if (servers.live(serverId).state === 'running') {
      await servers.command(serverId, 'mornicraft reload', null).catch(() => undefined);
    }
    return morniCraft(serverId);
  };

  // A new plugin version on a running server: restart it as soon as nobody plays, so every existing server is up
  // to date without anyone being thrown out.
  const restartWhenEmpty = new Set<string>();
  const waitToRestart = (serverId: string): void => {
    restartWhenEmpty.add(serverId);
    servers.note(
      serverId,
      'Neue MorniCraft-Version liegt bereit – der Server startet kurz neu, sobald niemand online ist.',
    );
  };
  setInterval(() => {
    [...restartWhenEmpty].forEach((serverId) => {
      try {
        const live = servers.live(serverId);
        if (live.state !== 'running') {
          // Stopped or starting anyway: the next start loads the new version.
          restartWhenEmpty.delete(serverId);
        } else if (live.playersOnline === 0) {
          restartWhenEmpty.delete(serverId);
          servers.note(serverId, 'Niemand online – Neustart für die neue MorniCraft-Version.');
          void servers.restart(serverId, SYSTEM_ACTOR).catch((err: unknown) => {
            ctx.log.warn({ err, serverId }, 'mornicraft: restart for the new version failed');
          });
        }
      } catch {
        restartWhenEmpty.delete(serverId);
      }
    });
  }, RESTART_CHECK_MS).unref();

  /** Every client version may join: older MorniCraft servers get ViaVersion once (an admin may switch it off). */
  const allVersionsOnce = async (serverId: string): Promise<void> => {
    const done = ctx.settings.getValue<string[]>(VIA_DONE_KEY) ?? [];
    if (!geyser || done.includes(serverId)) return;
    ctx.settings.setValue(VIA_DONE_KEY, [...done, serverId]);
    try {
      if (!geyser.via(serverId).enabled) {
        await geyser.setVia(serverId, true, SYSTEM_ACTOR);
        servers.note(
          serverId,
          'MorniCraft: alle Minecraft-Versionen eingeschaltet (ViaVersion) – gilt nach dem nächsten Neustart.',
        );
      }
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'mornicraft: switching on all versions failed');
    }
  };

  // MorniCraft servers get the newest datapack before each start (it repairs older islands once and never builds
  // anything twice), the newest plugin and its config.
  servers.onBeforeStart((serverId) => {
    try {
      if (!isCraftAttack(serverId)) return;
      writeSpawnPack(worldOf(serverId), spots()[serverId], locale());
      equip(serverId);
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'mornicraft update before start failed');
    }
  });

  // Someone got or lost a role on a server, or linked a Minecraft account: ranks follow at once.
  const refreshRanks = (): void => {
    try {
      ctx.db
        .select({ id: serverTable.id })
        .from(serverTable)
        .all()
        .filter((row) => isCraftAttack(row.id))
        .forEach((row) => {
          writeConfig(row.id);
          if (servers.live(row.id).state === 'running') {
            void servers.command(row.id, 'mornicraft reload', null).catch(() => undefined);
          }
        });
    } catch (err) {
      ctx.log.warn({ err }, 'mornicraft: ranks not updated');
    }
  };
  ctx.events.on('access.changed', refreshRanks);
  ctx.events.on('minecraft.linked', refreshRanks);

  // After a panel update: plugin and config are in place at once (the plugin itself loads at the next restart).
  setTimeout(() => {
    // The panel may be shutting down by now (tests start and stop it quickly): then there is nothing to do.
    const ids = (() => {
      try {
        return ctx.db.select({ id: serverTable.id }).from(serverTable).all();
      } catch {
        return [];
      }
    })();
    ids
      .filter((row) => isCraftAttack(row.id))
      .forEach((row) => {
        try {
          if (equip(row.id) && servers.live(row.id).state === 'running') waitToRestart(row.id);
        } catch (err) {
          ctx.log.warn({ err, serverId: row.id }, 'mornicraft refresh failed');
        }
        void allVersionsOnce(row.id);
      });
  }, REFRESH_DELAY_MS).unref();

  return {
    fitVersion,
    setUp,
    pregenerate,
    publicSetting,
    setPublic,
    publicStats,
    playerCommands,
    isCraftAttack,
    morniCraft,
    setMorniCraft,
    badgePack: badgePackFile,
  };
}
