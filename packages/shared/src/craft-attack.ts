import type { SoftwareId } from './software.js';

/**
 * "MorniCraft" (in the code still "craft attack"): a ready-made survival server for a group of friends, set up in one
 * go when ordering – the panel's own MorniCraft plugin (/spawn, homes, teleports, messages, start elytra, protected
 * spawn, sidebar), settings for a whitelisted friends server, a floating spawn island over the sea, a pre-generated
 * world, every Minecraft version can join (ViaVersion) and a public statistics page.
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

/** Plugins from Modrinth besides the panel's own MorniCraft plugin (which comes with the panel). */
export const CRAFT_ATTACK_PLUGINS: readonly CraftAttackPlugin[] = [
  { id: 'fALzjamp', name: 'Chunky', required: false },
];

/** What the admin sets for a MorniCraft server in the dashboard (written into the plugin's config). */
export interface MorniCraftSettings {
  /** Seconds to stand still before /spawn, /home, /tpa, /back (0 = at once). */
  readonly teleportDelay: number;
  readonly maxHomes: number;
  /** Nobody but operators builds or breaks on the spawn island. */
  readonly spawnProtection: boolean;
  readonly spawnRadius: number;
  readonly sleepAtSpawn: boolean;
  readonly pvpAtSpawn: boolean;
  readonly elytra: boolean;
  readonly elytraRadius: number;
  readonly elytraBoost: boolean;
  readonly tpa: boolean;
  readonly back: boolean;
  /** The big welcome, once per player. */
  readonly welcome: boolean;
  /** The bar on the right (time, online, commands). */
  readonly sidebar: boolean;
  /** Link to the personal command page in /info (needs a panel domain). */
  readonly showLink: boolean;
  readonly tnt: boolean;
  readonly creeperDamage: boolean;
  readonly fireSpread: boolean;
  readonly endermanGrief: boolean;
  readonly rules: readonly string[];
  /** Highest first; shown as symbol + colour in chat, tab list and above the head. */
  readonly ranks: readonly MorniCraftRank[];
  /**
   * Ranks as small coloured badges in the chat (own pixel icons; needs the panel's domain – players get a tiny
   * resource pack when they join). Off, or for players without the pack: the symbols.
   */
  readonly badges: boolean;
  /** Whoever dies gets a grave with all their things and experience (and their head). */
  readonly graves: boolean;
  /** Minutes only the dead player (and the team) may open their grave; then anyone. */
  readonly gravePrivateMinutes: number;
  /** Kills and deaths next to every name in the tab list. */
  readonly tabStats: boolean;
  /** Combat log: seconds "in combat" after a hit between players (no teleports, logging out = death); 0 = off. */
  readonly combatSeconds: number;
}

/** What a rank may do (each switch stands for one or more server permissions, see RANK_PERMISSION_NODES). */
export const RANK_PERMISSIONS = [
  'build',
  'instant',
  'homes',
  'kick',
  'ban',
  'moderate',
  'gamemode',
  'teleport',
  'world',
  'whitelist',
  'reload',
] as const;
export type RankPermission = (typeof RANK_PERMISSIONS)[number];

/** The permission nodes behind each switch (MorniCraft's own and the vanilla commands Paper guards with them). */
export const RANK_PERMISSION_NODES: Readonly<Record<RankPermission, readonly string[]>> = {
  build: ['mornicraft.build'],
  instant: ['mornicraft.instant'],
  homes: ['mornicraft.unlimitedhomes'],
  kick: ['minecraft.command.kick'],
  ban: [
    'minecraft.command.ban',
    'minecraft.command.ban-ip',
    'minecraft.command.pardon',
    'minecraft.command.pardon-ip',
    'minecraft.command.banlist',
  ],
  moderate: ['mornicraft.moderate'],
  gamemode: ['minecraft.command.gamemode'],
  teleport: ['minecraft.command.teleport', 'minecraft.command.tp'],
  world: ['minecraft.command.time', 'minecraft.command.weather'],
  whitelist: ['minecraft.command.whitelist'],
  reload: ['mornicraft.admin'],
};

/** Panel roles whose members (with a linked Minecraft account) get a rank by themselves. */
export const RANK_SOURCES = ['none', 'owner', 'moderator'] as const;
export type RankSource = (typeof RANK_SOURCES)[number];

export interface MorniCraftRank {
  /** a-z, 0-9, _ and - (stays the same when the name changes). */
  readonly id: string;
  readonly name: string;
  /** One symbol in front of the name ("♛"), or empty. */
  readonly symbol: string;
  /** #rrggbb */
  readonly color: string;
  readonly permissions: readonly RankPermission[];
  /** Minecraft names of the players with this rank. */
  readonly players: readonly string[];
  /** Everyone without another rank has this one (at most one rank). */
  readonly isDefault: boolean;
  /** Also everyone with this role on the server in the panel (with a linked Minecraft account). */
  readonly fromPanel: RankSource;
}

/** Symbols that look right in Java and Bedrock. */
export const RANK_SYMBOLS = [
  '♛',
  '✦',
  '⚔',
  '✚',
  '⚒',
  '▶',
  '★',
  '❤',
  '☀',
  '☘',
  '⚡',
  '♪',
  '✎',
  '⚑',
  '❖',
  '✿',
] as const;

/** Colours to pick from (any #rrggbb works). */
export const RANK_COLORS = [
  '#ff5555',
  '#ff9f1a',
  '#ffd23f',
  '#55ff55',
  '#3dd6c4',
  '#55aaff',
  '#a78bfa',
  '#ff6ad5',
  '#c08a5b',
  '#aaaaaa',
] as const;

export const MAX_RANKS = 20;

const ALL_RANK_PERMISSIONS: readonly RankPermission[] = RANK_PERMISSIONS;

/** The ranks every MorniCraft server starts with. */
export const DEFAULT_RANKS: readonly MorniCraftRank[] = [
  {
    id: 'owner',
    name: 'Owner',
    symbol: '♛',
    color: '#ff5555',
    permissions: ALL_RANK_PERMISSIONS,
    players: [],
    isDefault: false,
    fromPanel: 'owner',
  },
  {
    id: 'admin',
    name: 'Admin',
    symbol: '✦',
    color: '#ff9f1a',
    permissions: ALL_RANK_PERMISSIONS,
    players: [],
    isDefault: false,
    fromPanel: 'none',
  },
  {
    id: 'moderator',
    name: 'Moderator',
    symbol: '⚔',
    color: '#55aaff',
    permissions: ['instant', 'kick', 'ban', 'moderate', 'teleport'],
    players: [],
    isDefault: false,
    fromPanel: 'moderator',
  },
  {
    id: 'supporter',
    name: 'Supporter',
    symbol: '✚',
    color: '#55ff55',
    permissions: ['instant', 'kick', 'moderate'],
    players: [],
    isDefault: false,
    fromPanel: 'none',
  },
  {
    id: 'builder',
    name: 'Builder',
    symbol: '⚒',
    color: '#c08a5b',
    permissions: ['build', 'gamemode'],
    players: [],
    isDefault: false,
    fromPanel: 'none',
  },
  {
    id: 'media',
    name: 'Media',
    symbol: '▶',
    color: '#ff6ad5',
    permissions: ['homes'],
    players: [],
    isDefault: false,
    fromPanel: 'none',
  },
  {
    id: 'vip',
    name: 'VIP',
    symbol: '★',
    color: '#ffd23f',
    permissions: ['homes'],
    players: [],
    isDefault: false,
    fromPanel: 'none',
  },
  {
    id: 'player',
    name: 'Spieler',
    symbol: '',
    color: '#aaaaaa',
    permissions: [],
    players: [],
    isDefault: true,
    fromPanel: 'none',
  },
];

export const MORNICRAFT_DEFAULTS: MorniCraftSettings = {
  teleportDelay: 5,
  maxHomes: 5,
  spawnProtection: true,
  spawnRadius: 55,
  sleepAtSpawn: false,
  pvpAtSpawn: false,
  elytra: true,
  elytraRadius: 45,
  elytraBoost: true,
  tpa: true,
  back: true,
  welcome: true,
  sidebar: true,
  showLink: true,
  tnt: true,
  creeperDamage: true,
  fireSpread: true,
  endermanGrief: true,
  rules: [
    'Sei nett zu allen.',
    'Nichts kaputt machen, was anderen gehört.',
    'Keine Cheats, keine Hacks.',
    'Viel Spaß!',
  ],
  ranks: DEFAULT_RANKS,
  badges: true,
  graves: true,
  gravePrivateMinutes: 15,
  tabStats: true,
  combatSeconds: 15,
};

/** GET /api/servers/:id/mornicraft */
export interface MorniCraftState {
  /** A MorniCraft server (its world carries the spawn datapack). */
  readonly active: boolean;
  /** Path part of the public pages (/befehle/<slug>/<name>, /stats/<slug>). */
  readonly slug: string | null;
  readonly settings: MorniCraftSettings;
  /** The plugin file the panel brings along is there (an image built without it cannot install it). */
  readonly pluginAvailable: boolean;
  /** Minecraft names the panel gives a rank by itself (owners and moderators with a linked account). */
  readonly panelMembers: Readonly<Record<'owner' | 'moderator', readonly string[]>>;
  /** Where players get the badges' resource pack from, or null (no panel domain yet: badges can't be shown). */
  readonly badgePackUrl: string | null;
}

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

/** One command of the Craft Attack help list (in-game /info and the panel). */
export interface CraftAttackCommand {
  /** What to type, or the key to press ("2× Leertaste"). */
  readonly use: { readonly de: string; readonly en: string };
  readonly text: { readonly de: string; readonly en: string };
  /** Only for operators (OP). Everything else every player may use. */
  readonly opOnly?: boolean;
}

export interface CraftAttackCommandGroup {
  readonly id: 'spawn' | 'home' | 'teleport' | 'chat' | 'info' | 'mod' | 'op';
  readonly title: { readonly de: string; readonly en: string };
  readonly commands: readonly CraftAttackCommand[];
}

const same = (text: string): { readonly de: string; readonly en: string } => ({ de: text, en: text });

/** Everything players can do on a Craft Attack server (all allowed without operator rights). */
export const CRAFT_ATTACK_COMMANDS: readonly CraftAttackCommandGroup[] = [
  {
    id: 'spawn',
    title: { de: 'Spawn & Fliegen', en: 'Spawn & flying' },
    commands: [
      {
        use: same('/spawn'),
        text: {
          de: 'Zurück zur Spawn-Insel (5 Sekunden stillstehen)',
          en: 'Back to the spawn island (stand still for 5 seconds)',
        },
      },
      {
        use: { de: '2× Leertaste', en: 'Space twice' },
        text: {
          de: 'Auf der Spawn-Insel: losgleiten wie mit einer Elytra (kein Fallschaden)',
          en: 'On the spawn island: glide like with an elytra (no fall damage)',
        },
      },
      {
        use: { de: 'F (Bedrock: Schleichen)', en: 'F (Bedrock: sneak)' },
        text: { de: 'Im Gleitflug: ein Schub nach vorne', en: 'While gliding: one boost forward' },
      },
    ],
  },
  {
    id: 'home',
    title: { de: 'Zuhause', en: 'Homes' },
    commands: [
      {
        use: same('/sethome [name]'),
        text: { de: 'Merkt sich, wo du gerade stehst', en: 'Remembers where you are standing' },
      },
      { use: same('/home <name>'), text: { de: 'Bringt dich nach Hause', en: 'Takes you home' } },
      {
        use: same('/home'),
        text: {
          de: 'Deine Zuhause als Betten: hinreisen, neu setzen, löschen',
          en: 'Your homes as beds: go there, set new ones, delete',
        },
      },
      { use: same('/delhome <name>'), text: { de: 'Löscht ein Zuhause', en: 'Deletes a home' } },
      {
        use: same('/back'),
        text: {
          de: 'Zurück zum letzten Ort – auch nach dem Tod',
          en: 'Back to your last place – also after dying',
        },
      },
    ],
  },
  {
    id: 'teleport',
    title: { de: 'Zu Freunden', en: 'To your friends' },
    commands: [
      {
        use: same('/tpa <spieler>'),
        text: { de: 'Fragt, ob du zu jemandem darfst', en: 'Asks to teleport to someone' },
      },
      {
        use: same('/tpahere <spieler>'),
        text: { de: 'Fragt, ob jemand zu dir kommt', en: 'Asks someone to come to you' },
      },
      { use: same('/tpaccept'), text: { de: 'Anfrage annehmen', en: 'Accept a request' } },
      { use: same('/tpdeny'), text: { de: 'Anfrage ablehnen', en: 'Deny a request' } },
    ],
  },
  {
    id: 'chat',
    title: { de: 'Chat', en: 'Chat' },
    commands: [
      { use: same('/msg <spieler> <text>'), text: { de: 'Private Nachricht', en: 'Private message' } },
      {
        use: same('/r <text>'),
        text: { de: 'Auf die letzte Nachricht antworten', en: 'Reply to the last message' },
      },
      {
        use: same('/mail send <spieler> <text>'),
        text: { de: 'Nachricht für später (auch offline)', en: 'Message for later (also offline)' },
      },
      { use: same('/mail read'), text: { de: 'Deine Post lesen', en: 'Read your mail' } },
      {
        use: same('/ignore <spieler>'),
        text: { de: 'Jemanden im Chat ausblenden', en: 'Hide someone in the chat' },
      },
      {
        use: same('/afk'),
        text: { de: 'Zeigt allen, dass du kurz weg bist', en: 'Shows everyone you are away' },
      },
    ],
  },
  {
    id: 'info',
    title: { de: 'Infos', en: 'Info' },
    commands: [
      { use: same('/info'), text: { de: 'Diese Liste im Spiel', en: 'This list in the game' } },
      { use: same('/list'), text: { de: 'Wer gerade online ist', en: 'Who is online' } },
      { use: same('/team'), text: { de: 'Wer im Team ist (Ränge)', en: 'Who is on the team (ranks)' } },
      {
        use: same('/seen <spieler>'),
        text: { de: 'Wann jemand zuletzt da war', en: 'When someone was last online' },
      },
      { use: same('/near'), text: { de: 'Wer in deiner Nähe ist', en: 'Who is near you' } },
      { use: same('/getpos'), text: { de: 'Deine Koordinaten', en: 'Your coordinates' } },
      {
        use: same('/ping'),
        text: { de: 'Deine Verbindung zum Server', en: 'Your connection to the server' },
      },
      { use: same('/rules'), text: { de: 'Die Regeln', en: 'The rules' } },
      {
        use: same('/streamer'),
        text: {
          de: 'Streamer-Modus: IPs, Koordinaten und Nachrichten verstecken',
          en: 'Streamer mode: hide IPs, coordinates and messages',
        },
      },
      {
        use: same('/leiste'),
        text: { de: 'Leiste rechts ein- oder ausblenden', en: 'Show or hide the bar on the right' },
      },
    ],
  },
  {
    id: 'mod',
    title: { de: 'Team (Moderation)', en: 'Team (moderation)' },
    commands: [
      {
        use: { de: 'Ducken + Rechtsklick', en: 'Sneak + right click' },
        text: {
          de: 'Auf einen Spieler: Team-Menü (Zuhause, Inventar, Gefängnis, Stumm …)',
          en: 'On a player: team menu (homes, inventory, jail, mute …)',
        },
        opOnly: true,
      },
      {
        use: same('/mod <spieler>'),
        text: { de: 'Team-Menü für einen Spieler', en: 'Team menu for a player' },
        opOnly: true,
      },
      {
        use: same('/gefaengnis <spieler> [10m|1h|1d] [grund]'),
        text: { de: 'Ins Gefängnis (Standard 10 Minuten)', en: 'Send to jail (10 minutes by default)' },
        opOnly: true,
      },
      {
        use: same('/frei <spieler>'),
        text: { de: 'Aus dem Gefängnis holen', en: 'Release from jail' },
        opOnly: true,
      },
      {
        use: same('/stumm <spieler> [10m|1h|1d]'),
        text: { de: 'Stummschalten', en: 'Mute' },
        opOnly: true,
      },
      {
        use: same('/entstummen <spieler>'),
        text: { de: 'Wieder schreiben lassen', en: 'Unmute' },
        opOnly: true,
      },
      {
        use: same('/einfrieren <spieler>'),
        text: { de: 'Einfrieren / auftauen', en: 'Freeze / unfreeze' },
        opOnly: true,
      },
    ],
  },
  {
    id: 'op',
    title: { de: 'Nur für Admins (OP)', en: 'Admins only (OP)' },
    commands: [
      {
        use: same('/whitelist add <spieler>'),
        text: { de: 'Jemanden mitspielen lassen', en: 'Let someone join' },
        opOnly: true,
      },
      {
        use: same('/gamemode <modus> [spieler]'),
        text: { de: 'Spielmodus ändern (z. B. creative)', en: 'Change the game mode (e.g. creative)' },
        opOnly: true,
      },
      {
        use: same('/tp <spieler>'),
        text: { de: 'Ohne Anfrage zu jemandem springen', en: 'Jump to someone without asking' },
        opOnly: true,
      },
      { use: same('/kick <spieler>'), text: { de: 'Jemanden rauswerfen', en: 'Kick someone' }, opOnly: true },
      { use: same('/ban <spieler>'), text: { de: 'Jemanden sperren', en: 'Ban someone' }, opOnly: true },
      {
        use: same('/chunky status'),
        text: { de: 'Wie weit die Welt vorgeneriert ist', en: 'How far the world is pre-generated' },
        opOnly: true,
      },
    ],
  },
];

/** What the personal command page of a player shows (`/befehle/<server>/<name>`). */
export interface CraftAttackPlayerCommands {
  readonly server: string;
  /** The panel's language (visitors have no account). */
  readonly locale: 'de' | 'en';
  readonly name: string;
  /** Account UUID (null if never on the server): the head follows skin changes faster than by name. */
  readonly uuid: string | null;
  /** Has played on the server before. */
  readonly known: boolean;
  readonly online: boolean;
  readonly op: boolean;
  /** The whitelist is on and the player is not on it (and no OP). */
  readonly locked: boolean;
  /** Bedrock player (via Geyser/Floodgate): boost with sneaking instead of F. */
  readonly bedrock: boolean;
  /** Names of the player's homes (EssentialsX). */
  readonly homes: readonly string[];
}
