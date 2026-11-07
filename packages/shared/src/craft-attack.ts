import type { SoftwareId } from './software.js';

/**
 * "Craft Attack": a ready-made survival server for a group of friends, set up in one go when ordering –
 * the right plugins, settings for a whitelisted friends server, a floating spawn island with a start elytra,
 * /spawn, a pre-generated world and a public statistics page (who died when and how, play time, kills).
 */

/** Plugins come from Modrinth; Paper and Purpur run them. */
export const CRAFT_ATTACK_SOFTWARE: readonly SoftwareId[] = ['paper', 'purpur'];

export interface CraftAttackPlugin {
  /** Modrinth project id. */
  readonly id: string;
  readonly name: string;
  /** Must fit the server version: the order picks the newest version all of these support. */
  readonly required: boolean;
}

export const CRAFT_ATTACK_PLUGINS: readonly CraftAttackPlugin[] = [
  { id: 'hXiIvTyT', name: 'EssentialsX', required: true },
  { id: 'sYpvDxGJ', name: 'EssentialsX Spawn', required: true },
  { id: 'fALzjamp', name: 'Chunky', required: false },
  // The start elytra: double jump at the spawn to glide down, F (Java) / sneak (Bedrock) to boost.
  { id: 'NAFqBu99', name: 'SpawnElytra', required: false },
];

/** server.properties for a friends' survival world. */
export const CRAFT_ATTACK_PROPERTIES: Readonly<Record<string, string>> = {
  difficulty: 'normal',
  gamemode: 'survival',
  pvp: 'true',
  'white-list': 'true',
  'enforce-whitelist': 'true',
  // Non-operators cannot break the spawn island and its launch decks (blocks around the world spawn).
  'spawn-protection': '44',
  'view-distance': '10',
  'simulation-distance': '8',
  'max-players': '40',
  'allow-flight': 'false',
  'spawn-monsters': 'true',
};

/** The world around the spawn is generated before anyone plays (blocks of radius). */
export const CRAFT_ATTACK_PREGEN_RADIUS = 1500;

/** One death, from the server log. */
export interface PublicDeath {
  /** ISO time. */
  readonly at: string;
  readonly player: string;
  /** In words, German ("wurde von einem Zombie getötet"); the original when it is not known. */
  readonly how: string;
  /** The killer when it was a player. */
  readonly byPlayer: string | null;
}

export interface PublicPlayer {
  readonly name: string;
  readonly uuid: string;
  readonly online: boolean;
  readonly playTimeSeconds: number;
  readonly deaths: number;
  readonly playerKills: number;
  readonly mobKills: number;
  /** Blocks walked, swum, flown … */
  readonly distanceBlocks: number;
  readonly lastSeen: string | null;
}

/** The public statistics page of a server (no login). */
export interface PublicStats {
  readonly name: string;
  /** The panel's language: visitors without a login see the page in it. */
  readonly locale: 'de' | 'en';
  readonly motd: string | null;
  readonly address: string | null;
  readonly running: boolean;
  readonly playersOnline: number;
  readonly playersMax: number;
  readonly players: readonly PublicPlayer[];
  readonly deaths: readonly PublicDeath[];
  readonly updatedAt: string;
}

export interface PublicStatsSetting {
  readonly enabled: boolean;
  /** Path of the page: /stats/<slug>. */
  readonly slug: string;
}
