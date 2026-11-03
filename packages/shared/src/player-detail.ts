import { z } from 'zod';

/** Everything the panel knows about one Minecraft (Java) player, read from the server's files (also offline). */

export interface ItemStack {
  /** e.g. "minecraft:golden_pickaxe" or "stinkendreich:smoking". */
  readonly id: string;
  readonly count: number;
  /** A name given on an anvil or by a plugin, plain text. */
  readonly customName: string | null;
  /** Inventory slot: 0-8 hotbar, 9-35 main, ender chest 0-26. */
  readonly slot: number;
}

export interface StatCount {
  readonly id: string;
  readonly count: number;
}

export interface PlayerTravel {
  readonly walk: number;
  readonly sprint: number;
  readonly crouch: number;
  readonly swim: number;
  readonly ride: number;
  readonly fly: number;
  readonly total: number;
}

export interface PlayerChatLine {
  /** ISO time if the log file gave a date, else null. */
  readonly at: string | null;
  readonly kind: 'chat' | 'command';
  readonly text: string;
}

export type PlayerGamemode = 'survival' | 'creative' | 'adventure' | 'spectator';

export interface KnownPlayer {
  readonly name: string;
  readonly uuid: string;
  readonly online: boolean;
  readonly op: boolean;
  readonly banned: boolean;
  readonly whitelisted: boolean;
  /** When the server last saved this player (≈ last seen). */
  readonly savedAt: string | null;
}

export interface PlayerDetail extends KnownPlayer {
  readonly health: number | null;
  readonly maxHealth: number;
  readonly food: number | null;
  readonly level: number | null;
  /** 0 … 1 towards the next level. */
  readonly levelProgress: number | null;
  readonly gamemode: PlayerGamemode | null;
  /** "overworld", "the_nether", "the_end" or a custom dimension. */
  readonly world: string | null;
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly playTimeSeconds: number;
  readonly sinceRestSeconds: number | null;
  readonly sinceDeathSeconds: number | null;
  readonly deaths: number;
  readonly playerKills: number;
  readonly mobKills: number;
  readonly pickedUp: readonly StatCount[];
  readonly used: readonly StatCount[];
  readonly killed: readonly StatCount[];
  readonly travel: PlayerTravel;
  readonly inventory: readonly ItemStack[];
  readonly armor: {
    readonly head: ItemStack | null;
    readonly chest: ItemStack | null;
    readonly legs: ItemStack | null;
    readonly feet: ItemStack | null;
    readonly offhand: ItemStack | null;
  };
  readonly enderChest: readonly ItemStack[];
  /** Last chat messages and commands, newest first. */
  readonly chat: readonly PlayerChatLine[];
  readonly hasData: boolean;
  readonly refreshedAt: string;
}

export const PLAYER_GAMEMODES: readonly PlayerGamemode[] = ['survival', 'creative', 'adventure', 'spectator'];

const COORDINATE_LIMIT = 30_000_000;
const coordinate = z.number().finite().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT);

/** Changes the panel can make while the player is online (sent as console commands). */
export const playerAdjustSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['health', 'food', 'level']), direction: z.enum(['up', 'down']) }),
  z.object({
    kind: z.literal('gamemode'),
    gamemode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  }),
  z.object({ kind: z.literal('teleport'), x: coordinate, y: coordinate, z: coordinate }),
]);
export type PlayerAdjust = z.infer<typeof playerAdjustSchema>;
