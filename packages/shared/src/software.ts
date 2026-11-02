import { GAME_IDS, GAMES, type GameId } from './games.js';

export const MINECRAFT_EDITIONS = ['java', 'bedrock'] as const;
export type MinecraftEdition = (typeof MINECRAFT_EDITIONS)[number];
/** Minecraft's two editions, then every other game (see games.ts); for those the edition is the game id. */
export const EDITIONS = [...MINECRAFT_EDITIONS, ...GAME_IDS] as const;
export type Edition = MinecraftEdition | GameId;

export function isMinecraft(edition: Edition): edition is MinecraftEdition {
  return (MINECRAFT_EDITIONS as readonly string[]).includes(edition);
}

const MINECRAFT_NAMES: Readonly<Record<MinecraftEdition, string>> = {
  java: 'Minecraft Java Edition',
  bedrock: 'Minecraft Bedrock Edition',
};

/** The game a server runs, as people call it: "Minecraft Java Edition", "Factorio" … */
export function gameName(edition: Edition): string {
  return isMinecraft(edition) ? MINECRAFT_NAMES[edition] : GAMES[edition].label;
}

export const SOFTWARE_IDS = [
  'vanilla',
  'paper',
  'purpur',
  'fabric',
  'forge',
  'neoforge',
  'velocity',
  'bedrock',
  'custom',
  ...GAME_IDS,
] as const;
export type SoftwareId = (typeof SOFTWARE_IDS)[number];

export type ContentKind = 'plugins' | 'mods' | 'none';
export type JavaTag = 'java8' | 'java17' | 'java21' | 'java25';

export interface CurseForgeTarget {
  readonly classId: number;
  readonly modLoaderType: number;
}

export interface SoftwareInfo {
  readonly id: SoftwareId;
  readonly edition: Edition;
  readonly label: string;
  /** What the marketplace installs for this software. */
  readonly content: ContentKind;
  /** Folder (relative to the server root) where plugins or mods live. */
  readonly contentDir: 'plugins' | 'mods' | null;
  /** A proxy forwards players to other servers instead of hosting a world. */
  readonly proxy: boolean;
  /** Modrinth loader tags that are compatible, in order of preference. */
  readonly modrinthLoaders: readonly string[];
  /** Hangar platform, if Hangar has plugins for this software. */
  readonly hangarPlatform: 'PAPER' | 'VELOCITY' | null;
  /** SpigotMC resources (via Spiget) run on this software. */
  readonly spiget: boolean;
  readonly curseforge: CurseForgeTarget | null;
  /** The command that reports ticks per second, if any. */
  readonly tpsCommand: 'tps' | 'tick query' | null;
  /** Game port inside the container. */
  readonly defaultPort: number;
  readonly protocol: 'tcp' | 'udp';
  readonly recommended?: boolean;
}

export const PORT_JAVA = 25565;
export const PORT_VELOCITY = 25577;
export const PORT_BEDROCK = 19132;
/** Simple Voice Chat's default UDP port. */
export const PORT_VOICE_CHAT = 24454;
export const PORT_RCON = 25575;

// CurseForge API ids: class 5 = Bukkit plugins, class 6 = mods; loader 1 = Forge, 4 = Fabric, 6 = NeoForge.
const CF_CLASS_PLUGINS = 5;
const CF_CLASS_MODS = 6;
const CF_LOADER_ANY = 0;
const CF_LOADER_FORGE = 1;
const CF_LOADER_FABRIC = 4;
const CF_LOADER_NEOFORGE = 6;

const PAPER_LOADERS = ['paper', 'spigot', 'bukkit'] as const;

const javaServer = {
  edition: 'java',
  proxy: false,
  defaultPort: PORT_JAVA,
  protocol: 'tcp',
} as const;

export const SOFTWARE: Readonly<Record<SoftwareId, SoftwareInfo>> = Object.freeze({
  vanilla: {
    ...javaServer,
    id: 'vanilla',
    label: 'Vanilla',
    content: 'none',
    contentDir: null,
    modrinthLoaders: [],
    hangarPlatform: null,
    spiget: false,
    curseforge: null,
    tpsCommand: 'tick query',
  },
  paper: {
    ...javaServer,
    id: 'paper',
    label: 'Paper',
    content: 'plugins',
    contentDir: 'plugins',
    modrinthLoaders: PAPER_LOADERS,
    hangarPlatform: 'PAPER',
    spiget: true,
    curseforge: { classId: CF_CLASS_PLUGINS, modLoaderType: CF_LOADER_ANY },
    tpsCommand: 'tps',
    recommended: true,
  },
  purpur: {
    ...javaServer,
    id: 'purpur',
    label: 'Purpur',
    content: 'plugins',
    contentDir: 'plugins',
    modrinthLoaders: ['purpur', ...PAPER_LOADERS],
    hangarPlatform: 'PAPER',
    spiget: true,
    curseforge: { classId: CF_CLASS_PLUGINS, modLoaderType: CF_LOADER_ANY },
    tpsCommand: 'tps',
  },
  fabric: {
    ...javaServer,
    id: 'fabric',
    label: 'Fabric',
    content: 'mods',
    contentDir: 'mods',
    modrinthLoaders: ['fabric'],
    hangarPlatform: null,
    spiget: false,
    curseforge: { classId: CF_CLASS_MODS, modLoaderType: CF_LOADER_FABRIC },
    tpsCommand: 'tick query',
  },
  forge: {
    ...javaServer,
    id: 'forge',
    label: 'Forge',
    content: 'mods',
    contentDir: 'mods',
    modrinthLoaders: ['forge'],
    hangarPlatform: null,
    spiget: false,
    curseforge: { classId: CF_CLASS_MODS, modLoaderType: CF_LOADER_FORGE },
    tpsCommand: null,
  },
  neoforge: {
    ...javaServer,
    id: 'neoforge',
    label: 'NeoForge',
    content: 'mods',
    contentDir: 'mods',
    modrinthLoaders: ['neoforge'],
    hangarPlatform: null,
    spiget: false,
    curseforge: { classId: CF_CLASS_MODS, modLoaderType: CF_LOADER_NEOFORGE },
    tpsCommand: null,
  },
  velocity: {
    ...javaServer,
    id: 'velocity',
    label: 'Velocity',
    content: 'plugins',
    contentDir: 'plugins',
    proxy: true,
    modrinthLoaders: ['velocity'],
    hangarPlatform: 'VELOCITY',
    spiget: false,
    curseforge: null,
    tpsCommand: null,
    defaultPort: PORT_VELOCITY,
  },
  bedrock: {
    id: 'bedrock',
    edition: 'bedrock',
    label: 'Bedrock Dedicated Server',
    content: 'none',
    contentDir: null,
    proxy: false,
    modrinthLoaders: [],
    hangarPlatform: null,
    spiget: false,
    curseforge: null,
    tpsCommand: null,
    defaultPort: PORT_BEDROCK,
    protocol: 'udp',
    recommended: true,
  },
  custom: {
    ...javaServer,
    id: 'custom',
    label: 'Eigene Server-JAR',
    content: 'plugins',
    contentDir: 'plugins',
    modrinthLoaders: PAPER_LOADERS,
    hangarPlatform: 'PAPER',
    spiget: true,
    curseforge: null,
    tpsCommand: null,
  },
  ...gameSoftware(),
} satisfies Record<SoftwareId, SoftwareInfo>);

/** Every other game is its own "software" with nothing to install from the marketplace. */
function gameSoftware(): Record<GameId, SoftwareInfo> {
  const entries = GAME_IDS.map((id): [GameId, SoftwareInfo] => {
    const game = GAMES[id];
    const [main] = game.ports;
    return [
      id,
      {
        id,
        edition: id,
        label: game.label,
        content: 'none',
        contentDir: null,
        proxy: false,
        modrinthLoaders: [],
        hangarPlatform: null,
        spiget: false,
        curseforge: null,
        tpsCommand: null,
        defaultPort: main.defaultPort,
        protocol: main.protocol,
        recommended: true,
      },
    ];
  });
  return Object.fromEntries(entries) as Record<GameId, SoftwareInfo>;
}

/** Java server software a server can switch between in place (same world folder, new server jar). */
export const SWITCHABLE_SOFTWARE: readonly SoftwareId[] = [
  'vanilla',
  'paper',
  'purpur',
  'fabric',
  'forge',
  'neoforge',
];

export const CREATABLE_SOFTWARE: Readonly<Record<Edition, readonly SoftwareId[]>> = Object.freeze({
  java: ['vanilla', 'paper', 'purpur', 'fabric', 'forge', 'neoforge', 'velocity'],
  bedrock: ['bedrock'],
  ...Object.fromEntries(GAME_IDS.map((id) => [id, [id]])),
} as unknown as Record<Edition, readonly SoftwareId[]>);

// Version separators: "1.21.4-rc1" splits into "1", "21", "4", "rc1"; "26.3" into "26", "3".
// https://regex101.com/?flavor=javascript&regex=%5B.%5C-%2B%5D&flags=g&testString=1.21.4-rc1%0A26.3%0A1.20%2Bbuild
const VERSION_SEPARATOR = /[.\-+]/;
// Only plain digits count as a version number part: matches "21", rejects "rc1" and "4a".
// https://regex101.com/?flavor=javascript&regex=%5E%5Cd%2B%24&flags=gm&testString=21%0Arc1%0A4a
const DIGITS_ONLY = /^\d+$/;

/** Splits "1.21.4" or "26.3" into numbers; the first non-numeric part ends the list. */
export function parseMcVersion(version: string): number[] {
  const parts = version.split(VERSION_SEPARATOR);
  const firstText = parts.findIndex((part) => !DIGITS_ONLY.test(part));
  const numeric = firstText === -1 ? parts : parts.slice(0, firstText);
  return numeric.map(Number);
}

export function compareMcVersions(a: string, b: string): number {
  const pa = parseMcVersion(a);
  const pb = parseMcVersion(b);
  const length = Math.max(pa.length, pb.length);
  const diff = Array.from({ length }, (_, i) => (pa[i] ?? 0) - (pb[i] ?? 0)).find(Boolean);
  return diff ?? 0;
}

// Minecraft switched to year-based versions with 26.1, which needs Java 25.
const FIRST_YEAR_VERSION = 26;
const JAVA21_FROM = '1.20.5';
const JAVA17_FROM = '1.17';

const JAVA_BY_MIN_VERSION: readonly (readonly [string, JavaTag])[] = [
  [JAVA21_FROM, 'java21'],
  [JAVA17_FROM, 'java17'],
];

/** Picks the Java runtime a Minecraft version needs. */
export function javaTagFor(software: SoftwareId, version: string): JavaTag {
  if (software === 'velocity') return 'java21';
  const major = parseMcVersion(version)[0] ?? 0;
  if (major >= FIRST_YEAR_VERSION) return 'java25';
  if (major !== 1) return 'java21';
  const match = JAVA_BY_MIN_VERSION.find(([min]) => compareMcVersions(version, min) >= 0);
  return match?.[1] ?? 'java8';
}

export const JAVA_TAGS: readonly JavaTag[] = ['java25', 'java21', 'java17', 'java8'];

const MB_PER_GB = 1024;
const MEMORY_SMALL_MB = MB_PER_GB;
const MEMORY_DEFAULT_MB = 3072;
const MEMORY_MODDED_MB = 6144;

const RECOMMENDED_MEMORY_MB: Readonly<Record<SoftwareId, number>> = Object.freeze({
  vanilla: MEMORY_DEFAULT_MB,
  paper: MEMORY_DEFAULT_MB,
  purpur: MEMORY_DEFAULT_MB,
  fabric: MEMORY_DEFAULT_MB,
  forge: MEMORY_MODDED_MB,
  neoforge: MEMORY_MODDED_MB,
  velocity: MEMORY_SMALL_MB,
  bedrock: MEMORY_SMALL_MB,
  custom: MEMORY_DEFAULT_MB,
  ...Object.fromEntries(GAME_IDS.map((id) => [id, GAMES[id].recommendedGb * MB_PER_GB])),
} as Record<SoftwareId, number>);

/** Recommended memory in MB for a new server. */
export function recommendedMemoryMb(software: SoftwareId): number {
  return RECOMMENDED_MEMORY_MB[software];
}
