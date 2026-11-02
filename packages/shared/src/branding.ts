/**
 * Logos of the projects MorniHosting works with, as the projects publish them: PaperMC asks to use its CDN and
 * allows its logo in server selectors (https://docs.papermc.io/misc/assets/); Purpur, Fabric, Forge and NeoForge
 * from their own sites (Fabric's as shown on Modrinth); Geyser and Simple Voice Chat as shown on Modrinth.
 * Nothing is copied into this repository. Vanilla keeps its grass block (Mojang's logos are not used).
 */
export const PROJECT_LOGOS = Object.freeze({
  paper: 'https://assets.papermc.io/brand/papermc_logo.min.svg',
  purpur: 'https://purpurmc.org/images/purpur.svg',
  fabric: 'https://cdn.modrinth.com/data/P7dR8mSH/icon.png',
  forge: 'https://files.minecraftforge.net/static/images/apple-touch-icon.png',
  neoforge: 'https://neoforged.net/img/authors/neoforged.png',
  velocity: 'https://assets.papermc.io/brand/velocity_logo_blue.min.svg',
  geyser: 'https://cdn.modrinth.com/data/wKkoqHrH/6e8e781d5669ecef9e19a73b5c2eed060d6f73e7_96.webp',
  voicechat: 'https://cdn.modrinth.com/data/9eGKb6K1/icon.png',
});
export type LogoProject = keyof typeof PROJECT_LOGOS;

import { GAME_IDS, GAMES, steamHeaderUrl, type GameId } from './games.js';

/**
 * Background pictures for the game cards: Mojang's key art as the Minecraft Wiki hosts it, and the GeyserMC
 * logo from geysermc.org. (minecraft.net itself refuses automated downloads.)
 */
export const GAME_ART_SOURCES = Object.freeze({
  java: 'https://minecraft.wiki/images/thumb/Minecraft_Key_Art_2024.jpg/1200px-Minecraft_Key_Art_2024.jpg',
  bedrock:
    'https://minecraft.wiki/images/thumb/Minecraft_Java_%26_Bedrock_Edition_key_art.jpg/1200px-Minecraft_Java_%26_Bedrock_Edition_key_art.jpg',
  crossplay: 'https://geysermc.org/img/geyser-1760-860.png',
  // Hytale is not on Steam: the picture of its announcement trailer, as hytale.com itself shows it.
  hytale: 'https://img.youtube.com/vi/o77MzDQT1cg/maxresdefault.jpg',
  // Other games: the header picture of their Steam store page.
  ...(Object.fromEntries(
    GAME_IDS.flatMap((id) => {
      const url = steamHeaderUrl(GAMES[id]);
      return url ? [[id, url]] : [];
    }),
  ) as Partial<Record<GameId, string>>),
});
export type GameArtId = keyof typeof GAME_ART_SOURCES;
export const GAME_ART_IDS = Object.keys(GAME_ART_SOURCES) as [GameArtId, ...GameArtId[]];
