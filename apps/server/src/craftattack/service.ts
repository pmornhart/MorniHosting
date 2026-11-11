import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CRAFT_ATTACK_PLUGINS,
  CRAFT_ATTACK_PREGEN_RADIUS,
  CRAFT_ATTACK_PROPERTIES,
  CRAFT_ATTACK_SOFTWARE,
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
import { SPAWN_PACK_DIR, spawnElytraConfig, writeSpawnPack } from './spawn.js';
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
/** The SpawnElytra plugin's data folder (its name in plugin.yml). */
const ELYTRA_FOLDER = 'SpawnElytra';

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
  };

  const pregenerate: CraftAttackService['pregenerate'] = async (serverId) => {
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

  // Worlds with the Craft Attack spawn get the newest datapack before each start; it repairs older islands once
  // (see fixWaterCommands) and never builds anything twice.
  servers.onBeforeStart((serverId) => {
    try {
      const dir = servers.dir(serverId);
      const level = readPropertiesFile(dir).values['level-name'] || 'world';
      const worldDir = path.join(dir, path.basename(level));
      if (fs.existsSync(path.join(worldDir, 'datapacks', SPAWN_PACK_DIR))) writeSpawnPack(worldDir);
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'craft attack datapack update failed');
    }
  });

  return { fitVersion, setUp, pregenerate, publicSetting, setPublic, publicStats };
}
