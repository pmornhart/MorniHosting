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

/** One command of the Craft Attack help list (in-game /info and the panel). */
export interface CraftAttackCommand {
  /** What to type, or the key to press ("2× Leertaste"). */
  readonly use: { readonly de: string; readonly en: string };
  readonly text: { readonly de: string; readonly en: string };
  /** Only for operators (OP). Everything else every player may use. */
  readonly opOnly?: boolean;
}

export interface CraftAttackCommandGroup {
  readonly id: 'spawn' | 'home' | 'teleport' | 'chat' | 'info' | 'op';
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
      { use: same('/spawn'), text: { de: 'Zurück zur Spawn-Insel', en: 'Back to the spawn island' } },
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
      { use: same('/home [name]'), text: { de: 'Bringt dich nach Hause', en: 'Takes you home' } },
      { use: same('/home'), text: { de: 'Zeigt alle deine Zuhause', en: 'Lists all your homes' } },
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
