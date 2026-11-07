import { z } from 'zod';
import { couponOf, couponSchema } from './payments.js';
import { SERVER_PERMISSIONS, type ServerPermission } from './permissions.js';
import { scheduleSpecSchema, SCHEDULE_ACTIONS, type ScheduleAction, type ScheduleSpec } from './schedule.js';
import {
  EDITIONS,
  JAVA_TAGS,
  SOFTWARE_IDS,
  type Edition,
  type JavaTag,
  type SoftwareId,
} from './software.js';
import type { NetbirdServerInfo } from './netbird.js';

export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const THEMES = ['dark', 'light', 'system'] as const;
export type Theme = (typeof THEMES)[number];

const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
const NAME_MAX = 40;
const DISPLAY_NAME_MAX = 60;
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const MEMORY_MIN_MB = 512;
const MEMORY_MAX_MB = 131072;
const COMMAND_MAX = 1000;
const VERSION_MAX = 64;
const DOMAIN_MAX = 253;
const KEEP_MAX = 365;
const EXCLUDE_MAX = 50;
const TOKEN_NAME_MAX = 60;
const TOKEN_DAYS_MAX = 3650;
const URL_MAX = 2048;
const SEED_MAX = 64;
const TIMEZONE_MAX = 80;

// Usernames: letters, digits, dot, dash, underscore. Matches "philip_m", "Morni.2"; rejects "phil ip" and "ä".
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9._-%5D%2B%24&flags=gm&testString=philip_m%0AMorni.2%0Aphil%20ip%0A%C3%A4
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
// A six-digit one-time code: matches "042917"; rejects "42917" and "04291a".
// https://regex101.com/?flavor=javascript&regex=%5E%5Cd%7B6%7D%24&flags=gm&testString=042917%0A42917%0A04291a
const TOTP_PATTERN = /^\d{6}$/;
// Host names: labels of letters, digits and dashes joined by dots. Matches "mc.morncloud.de"; rejects "mc..de" and "-a.de".
// https://regex101.com/?flavor=javascript&regex=%5E%28%3F%3D.%7B1%2C253%7D%24%29%28%3F!-%29%5BA-Za-z0-9-%5D%7B1%2C63%7D%28%3F%3C!-%29%28%5C.%28%3F!-%29%5BA-Za-z0-9-%5D%7B1%2C63%7D%28%3F%3C!-%29%29*%24&flags=gm&testString=mc.morncloud.de%0Amc..de%0A-a.de
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
// Minecraft player names: 3 to 16 letters, digits or underscores (Bedrock gamertags may contain spaces).
// Matches "Lena_Baut", "Finn 2015"; rejects "ab" and "Name!".
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_%20.%5D%7B3%2C32%7D%24&flags=gm&testString=Lena_Baut%0AFinn%202015%0Aab%0AName!
const PLAYER_PATTERN = /^[A-Za-z0-9_ .]{3,32}$/;

export const usernameSchema = z.string().trim().min(USERNAME_MIN).max(USERNAME_MAX).regex(USERNAME_PATTERN);
export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
const EMAIL_MAX = 254;
/** Mail addresses are stored lower-case; zod's check keeps out spaces and line breaks (no header injection). */
export const emailSchema = z.string().trim().toLowerCase().max(EMAIL_MAX).email();
export const totpCodeSchema = z.string().trim().regex(TOTP_PATTERN);
export const hostnameSchema = z.string().trim().max(DOMAIN_MAX).regex(HOSTNAME_PATTERN);
export const playerNameSchema = z.string().trim().regex(PLAYER_PATTERN);
// Java account names: 3 to 16 letters, digits or underscores. Matches "Lena_Baut"; rejects "ab", "Finn 2015", "Name!".
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_%5D%7B3%2C16%7D%24&flags=gm&testString=Lena_Baut%0Aab%0AFinn%202015%0AName!
const JAVA_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
export const minecraftLinkSchema = z.object({ name: z.string().trim().regex(JAVA_NAME_PATTERN) });
export const portSchema = z.number().int().min(PORT_MIN).max(PORT_MAX);
export const memorySchema = z.number().int().min(MEMORY_MIN_MB).max(MEMORY_MAX_MB);

/** Room for the "-bedrock" and "-voice" endings within the 63 characters of a DNS label. */
const NETBIRD_NAME_MAX = 40;
// A name in front of the NetBird domain: lowercase letters, digits and inner dashes.
// Matches "survival", "mc-2"; rejects "-mc", "mc-", "Mein Server" and "mc.alt".
// https://regex101.com/?flavor=javascript&regex=%5E%5Ba-z0-9%5D(%5Ba-z0-9-%5D*%5Ba-z0-9%5D)%3F%24&flags=gm&testString=survival%0Amc-2%0A-mc%0Amc-%0AMein%20Server%0Amc.alt
const NETBIRD_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const netbirdNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(NETBIRD_NAME_MAX)
  .regex(NETBIRD_NAME_PATTERN);

/* ---------- Auth and account ---------- */

export const setupInputSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  locale: z.enum(LOCALES),
});
export type SetupInput = z.infer<typeof setupInputSchema>;

export const loginInputSchema = z.object({
  /** User name or e-mail address. */
  username: z.string().trim().min(1).max(EMAIL_MAX),
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const twoFactorInputSchema = z.object({ code: totpCodeSchema });

export const accountUpdateSchema = z.object({
  displayName: z.string().trim().max(DISPLAY_NAME_MAX).optional(),
  locale: z.enum(LOCALES).optional(),
  theme: z.enum(THEMES).optional(),
});

export const passwordChangeSchema = z.object({
  current: z.string().min(1).max(PASSWORD_MAX),
  next: passwordSchema,
});

export const twoFactorDisableSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX),
  code: totpCodeSchema,
});

export interface UserInfo {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly canCreateServers: boolean;
  readonly locale: Locale;
  readonly theme: Theme;
  readonly totpEnabled: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly disabled: boolean;
  /** The linked Minecraft (Java) account: its head is shown, and on servers the user owns they are OP. */
  readonly minecraft: MinecraftAccount | null;
  /** Mail address for notifications and "password forgotten"; null if none was given. */
  readonly email: string | null;
  /** Signed up and waits for an admin (approvals page). */
  readonly approvalPending: boolean;
  /** The password came from an admin (new account or reset): right after signing in, a new one must be set. */
  readonly mustChangePassword: boolean;
}

export interface MinecraftAccount {
  readonly name: string;
  readonly uuid: string;
}

export interface MeResponse {
  readonly user: UserInfo;
  readonly csrfToken: string;
  /** Effective rights per server id; admins get every right on every server. */
  readonly access: Readonly<Record<string, readonly ServerPermission[]>>;
}

export type LoginResponse =
  { readonly status: 'ok'; readonly me: MeResponse } | { readonly status: 'two-factor' };

/**
 * Whether this browser address can use passkeys: WebAuthn needs HTTPS (or localhost), and once the
 * panel has its own domain, passkeys belong to that domain.
 */
export type PasskeySupport = 'ok' | 'needs_https' | 'wrong_host';

export interface SystemStatus {
  readonly setupRequired: boolean;
  readonly version: string;
  readonly docker: { readonly ok: boolean; readonly message?: string };
  readonly demo: boolean;
  readonly defaultLocale: Locale;
  readonly passkeys: PasskeySupport;
  /** The panel's own domain from the admin area, or null. */
  readonly panelDomain: string | null;
  /** What the start page may offer: depends on the mail settings in the admin area. */
  readonly mail: MailStatus;
}

export interface MailStatus {
  /** People may sign up themselves (mail confirmation required). */
  readonly registration: boolean;
  /** "Password forgotten" works (mail server set up and the panel's domain known). */
  readonly passwordReset: boolean;
}

/* ---------- Servers ---------- */

export const SERVER_STATES = ['installing', 'stopped', 'starting', 'running', 'stopping', 'crashed'] as const;
export type ServerState = (typeof SERVER_STATES)[number];

const GAME_SETTING_MAX = 200;
const GAME_SETTING_KEY_MAX = 40;
export const gameSettingsSchema = z.record(
  z.string().max(GAME_SETTING_KEY_MAX),
  z.string().trim().max(GAME_SETTING_MAX),
);

/** Settings of another game as the settings page sees them: secrets only as "stored". */
export interface GameSettingsView {
  readonly values: Readonly<Record<string, string>>;
  readonly secretsSet: readonly string[];
}

const CPU_LIMIT_MAX = 512;
const DISK_LIMIT_MIN_MB = 512;
const DISK_LIMIT_MAX_MB = 104_857_600;
const CPU_LIMIT_STEP = 0.5;
export const cpuLimitSchema = z.number().min(CPU_LIMIT_STEP).max(CPU_LIMIT_MAX).multipleOf(CPU_LIMIT_STEP);
export const diskLimitSchema = z.number().int().min(DISK_LIMIT_MIN_MB).max(DISK_LIMIT_MAX_MB);

/** Extras someone can tick when ordering a Minecraft server. */
export const ADD_ON_KEYS = ['geyser', 'via', 'voice', 'backups', 'craftattack'] as const;
export type AddOnKey = (typeof ADD_ON_KEYS)[number];
/** What happens after an order, in this order: plugins load, add-ons get set up, the server starts the first time. */
export const SETUP_STEPS = ['download', ...ADD_ON_KEYS, 'start', 'pregen'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export interface SetupProgress {
  readonly pending: readonly SetupStep[];
  readonly done: readonly SetupStep[];
}

export const createServerSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  edition: z.enum(EDITIONS),
  software: z.enum(SOFTWARE_IDS),
  version: z.string().trim().min(1).max(VERSION_MAX),
  memoryMb: memorySchema,
  port: portSchema,
  eula: z.literal(true),
  autoStart: z.boolean().default(true),
  startNow: z.boolean().default(true),
  /** Name in front of the NetBird domain (admins with NetBird set up); the panel creates the services. */
  netbirdName: netbirdNameSchema.optional(),
  /** Settings of another game (GameField keys from games.ts). */
  gameSettings: gameSettingsSchema.optional(),
  /** Limits for the server (admins); people with a quota get what is left of it when empty. */
  cpuLimit: cpuLimitSchema.nullable().optional(),
  diskLimitMb: diskLimitSchema.nullable().optional(),
  /** Add-ons from the order page: set up by the panel one after another, before the first start. */
  addOns: z
    .object({
      geyser: z.boolean().default(false),
      /** ViaVersion + ViaBackwards (ViaFabric on Fabric): players with older and newer game versions join. */
      via: z.boolean().default(false),
      voice: z.boolean().default(false),
      backups: z.boolean().default(false),
      /** Craft Attack package (Paper/Purpur): plugins, settings, spawn, public statistics. */
      craftattack: z.boolean().default(false),
    })
    .optional(),
  /** Voucher from the order page ("MORNI"); unknown codes are refused. */
  coupon: couponSchema.optional().refine((code) => !code || couponOf(code) !== null, 'coupon_unknown'),
});
export type CreateServerInput = z.infer<typeof createServerSchema>;

export const updateServerSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX).optional(),
  memoryMb: memorySchema.optional(),
  port: portSchema.optional(),
  autoStart: z.boolean().optional(),
  domain: z.union([hostnameSchema, z.literal('')]).optional(),
  /** Port friends use from outside, e.g. the one NetBird or playit.gg assigned; null = same as port. */
  publicPort: portSchema.nullable().optional(),
  javaTag: z.enum(JAVA_TAGS).nullable().optional(),
  version: z.string().trim().min(1).max(VERSION_MAX).optional(),
  /** Another server software (Java only, server stopped, see SWITCHABLE_SOFTWARE); needs a version for it. */
  software: z.enum(SOFTWARE_IDS).optional(),
  /** Admins only: CPU cores and disk space; null = no limit. */
  cpuLimit: cpuLimitSchema.nullable().optional(),
  diskLimitMb: diskLimitSchema.nullable().optional(),
});
export type UpdateServerInput = z.infer<typeof updateServerSchema>;

export const voiceChatInputSchema = z.object({
  enabled: z.boolean(),
  /** Outside UDP port when NetBird, playit.gg or the router use another one; null = host port. */
  publicPort: portSchema.nullable().optional(),
});

export interface VoiceChatResult {
  readonly enabled: boolean;
  readonly port: number | null;
  readonly voiceHost: string | null;
  readonly restartRequired: boolean;
}

export const commandInputSchema = z.object({ command: z.string().trim().min(1).max(COMMAND_MAX) });

export const SERVER_ACTIONS = ['start', 'stop', 'restart', 'kill'] as const;
export type ServerAction = (typeof SERVER_ACTIONS)[number];

export interface ServerLive {
  readonly state: ServerState;
  readonly playersOnline: number;
  readonly playersMax: number;
  readonly players: readonly string[];
  readonly cpuPercent: number | null;
  readonly memoryMb: number | null;
  readonly tps: number | null;
  /** Size of the server's folder (worlds, plugins, …), measured about once a minute. */
  readonly diskMb: number | null;
  /** Bytes received and sent since the server started. */
  readonly netRxBytes: number | null;
  readonly netTxBytes: number | null;
  readonly startedAt: string | null;
  /** 0 to 100 while a server installs or starts, if known. */
  readonly progress: number | null;
  /** While a game downloads its files (steamcmd): how much, how fast. */
  readonly download?: {
    readonly doneBytes: number;
    readonly totalBytes: number;
    readonly bytesPerSecond: number | null;
  } | null;
  /** While the panel still sets up a freshly ordered server: what is left and what is done. */
  readonly setup?: SetupProgress | null;
}

export interface CrashInfo {
  readonly at: string;
  readonly ruleId: string;
  /** Values for the explanation, e.g. the missing plugin's name. */
  readonly params: Readonly<Record<string, string>>;
  readonly excerpt: readonly string[];
}

export interface ServerSummary {
  readonly id: string;
  readonly name: string;
  readonly edition: Edition;
  readonly software: SoftwareId;
  readonly version: string;
  readonly memoryMb: number;
  /** CPU cores the server may use, null = no limit. */
  readonly cpuLimit: number | null;
  /** Disk space the server may take in MB, null = no limit. */
  readonly diskLimitMb: number | null;
  readonly port: number;
  readonly address: string;
  readonly autoStart: boolean;
  readonly hasIcon: boolean;
  readonly live: ServerLive;
  readonly crash: CrashInfo | null;
  readonly createdAt: string;
}

export interface ServerDetail extends ServerSummary {
  readonly javaTag: JavaTag | null;
  readonly domain: string | null;
  readonly image: string;
  readonly geyser: boolean;
  /** Host UDP port Bedrock players use when Geyser is on. */
  readonly geyserPort: number | null;
  /** Outside UDP port for Bedrock players when a tunnel gives another one (NetBird). */
  readonly geyserPublicPort: number | null;
  readonly publicPort: number | null;
  readonly voiceChat: boolean;
  /** Host UDP port of Simple Voice Chat when it is on. */
  readonly voicePort: number | null;
  readonly voicePublicPort: number | null;
  /** What players' voice chat mods connect to (voice_host), e.g. "mc.example.de:24454". */
  readonly voiceHost: string | null;
  /** Addresses the panel set up in NetBird for this server, or null. */
  readonly netbird: NetbirdServerInfo | null;
  readonly permissions: readonly ServerPermission[];
  /** Other games: their settings and every port players need (Minecraft: null / empty). */
  readonly gameSettings: GameSettingsView | null;
  readonly gamePorts: readonly {
    readonly key: string;
    readonly port: number;
    readonly protocol: 'tcp' | 'udp';
  }[];
}

export interface VersionOption {
  readonly id: string;
  readonly stable: boolean;
}

export interface ConnectionInfo {
  readonly domain: string | null;
  readonly publicIp: string | null;
  readonly lanIp: string | null;
  readonly port: number;
  /** Port to share together with the domain (a tunnel's port, or the server port). */
  readonly sharePort: number;
  readonly protocol: 'tcp' | 'udp';
  readonly reachable: ReachabilityResult | null;
  /** The person looking at the page is in the same home network: they join via the LAN address. */
  readonly viewerAtHome?: boolean;
  /** The own domain has a Minecraft SRV record for this server: Java players type just the name, no port. */
  readonly srv?: boolean;
}

export interface ReachabilityResult {
  readonly status: 'reachable' | 'unreachable' | 'unknown';
  readonly checkedAt: string;
  readonly target: string;
}

export interface HostInfo {
  readonly name: string;
  readonly cpuPercent: number | null;
  readonly cpuCores: number;
  readonly memoryUsedMb: number;
  readonly memoryTotalMb: number;
  readonly diskUsedGb: number | null;
  readonly diskTotalGb: number | null;
}

export interface StatsPoint {
  readonly t: string;
  readonly cpu: number | null;
  readonly mem: number | null;
  readonly players: number | null;
  readonly tps: number | null;
}

/* ---------- Files ---------- */

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'dir';
  readonly size: number;
  readonly modifiedAt: string;
}

export interface TrashEntry {
  readonly id: string;
  readonly name: string;
  readonly originalPath: string;
  readonly type: 'file' | 'dir';
  readonly deletedAt: string;
  readonly size: number;
}

const PATH_MAX = 1024;
export const relPathSchema = z.string().max(PATH_MAX);
export const writeFileSchema = z.object({ path: relPathSchema, content: z.string() });
export const renameSchema = z.object({ from: relPathSchema, to: relPathSchema });
export const pathsSchema = z.object({ paths: z.array(relPathSchema).min(1) });
export const mkdirSchema = z.object({ path: relPathSchema });
export const zipSchema = z.object({
  paths: z.array(relPathSchema).min(1),
  name: z.string().trim().min(1).max(NAME_MAX),
});
export const unzipSchema = z.object({ path: relPathSchema, destination: relPathSchema });

/* ---------- Players and worlds ---------- */

export const PLAYER_ACTIONS = [
  'op',
  'deop',
  'kick',
  'ban',
  'pardon',
  'whitelist-add',
  'whitelist-remove',
] as const;
export type PlayerAction = (typeof PLAYER_ACTIONS)[number];
const REASON_MAX = 200;
export const playerActionSchema = z.object({
  action: z.enum(PLAYER_ACTIONS),
  name: playerNameSchema,
  reason: z.string().trim().max(REASON_MAX).optional(),
});

export interface PlayerEntry {
  readonly name: string;
  readonly uuid: string | null;
}
export interface PlayersResponse {
  readonly online: readonly PlayerEntry[];
  readonly ops: readonly PlayerEntry[];
  readonly whitelist: readonly PlayerEntry[];
  readonly banned: readonly (PlayerEntry & { readonly reason: string | null })[];
  readonly whitelistEnabled: boolean;
}

export interface WorldInfo {
  readonly name: string;
  readonly active: boolean;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}
export const resetWorldSchema = z.object({ seed: z.string().trim().max(SEED_MAX).optional() });
export const switchWorldSchema = z.object({ name: z.string().trim().min(1).max(NAME_MAX) });

/* ---------- Marketplace ---------- */

export const MARKET_SOURCES = ['modrinth', 'hangar', 'spiget', 'curseforge'] as const;
export type MarketSource = (typeof MARKET_SOURCES)[number];
/** Where installed files can come from: the searchable marketplaces plus GeyserMC's own downloads (Geyser one-click). */
export type ContentSource = MarketSource | 'geysermc';
export const MARKET_SORTS = ['relevance', 'downloads', 'updated'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];
export type Compatibility = 'yes' | 'no' | 'unknown';

const QUERY_MAX = 100;
const PAGE_MAX = 100;
const PROJECT_ID_MAX = 100;
const FILE_NAME_MAX = 200;

export const marketSearchSchema = z.object({
  source: z.enum(MARKET_SOURCES).default('modrinth'),
  q: z.string().trim().max(QUERY_MAX).default(''),
  sort: z.enum(MARKET_SORTS).default('downloads'),
  page: z.coerce.number().int().min(0).max(PAGE_MAX).default(0),
  compatibleOnly: z.enum(['true', 'false']).default('true'),
});

export interface MarketProject {
  readonly source: MarketSource;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly author: string;
  readonly downloads: number;
  readonly iconUrl: string | null;
  readonly updatedAt: string | null;
  readonly url: string;
  readonly compatible: Compatibility;
  /** False when the file is only offered on an external website or behind a paywall. */
  readonly installable: boolean;
  readonly installed: boolean;
}

export interface MarketSearchResult {
  readonly hits: readonly MarketProject[];
  readonly total: number;
  readonly pageSize: number;
}

export interface MarketVersion {
  readonly id: string;
  readonly name: string;
  readonly gameVersions: readonly string[];
  readonly publishedAt: string | null;
  readonly channel: 'release' | 'beta' | 'alpha';
  readonly compatible: boolean;
}

export const marketInstallSchema = z.object({
  source: z.enum(MARKET_SOURCES),
  projectId: z.string().trim().min(1).max(PROJECT_ID_MAX),
  versionId: z.string().trim().min(1).max(PROJECT_ID_MAX).optional(),
});
export type MarketInstallInput = z.infer<typeof marketInstallSchema>;

export interface InstalledContent {
  readonly fileName: string;
  readonly enabled: boolean;
  readonly size: number;
  readonly modifiedAt: string;
  readonly source: ContentSource | 'upload';
  readonly projectId: string | null;
  readonly name: string;
  readonly versionName: string | null;
  readonly iconUrl: string | null;
  readonly url: string | null;
  readonly dependencyOf: string | null;
  readonly update: { readonly versionId: string; readonly versionName: string } | null;
}

export interface InstallResult {
  readonly installed: readonly {
    readonly name: string;
    readonly fileName: string;
    readonly dependency: boolean;
  }[];
  /** Required dependencies the panel could not fetch itself (only on an external website). */
  readonly manual: readonly { readonly name: string; readonly url: string | null }[];
}

export const contentFileSchema = z.object({ fileName: z.string().trim().min(1).max(FILE_NAME_MAX) });

/* ---------- Backups ---------- */

export const backupSettingsSchema = z.object({
  keep: z.number().int().min(1).max(KEEP_MAX),
  exclude: z.array(z.string().trim().min(1).max(PATH_MAX)).max(EXCLUDE_MAX),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

export interface BackupEntry {
  readonly id: number;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly kind: 'manual' | 'scheduled' | 'before-restore';
  readonly status: 'running' | 'done' | 'failed';
  readonly error: string | null;
}

/* ---------- Schedules ---------- */

export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  action: z.enum(SCHEDULE_ACTIONS),
  command: z.string().trim().max(COMMAND_MAX).optional(),
  spec: scheduleSpecSchema,
  enabled: z.boolean().default(true),
  /** For restarts: warn players this many minutes before. */
  warnMinutes: z.number().int().min(0).max(NAME_MAX).default(0),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export interface ScheduleEntry {
  readonly id: number;
  readonly name: string;
  readonly action: ScheduleAction;
  readonly command: string | null;
  readonly spec: ScheduleSpec;
  readonly enabled: boolean;
  readonly warnMinutes: number;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastResult: 'ok' | 'failed' | null;
}

/* ---------- Webhooks ---------- */

export const WEBHOOK_KINDS = ['discord', 'slack', 'teams', 'generic'] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
export const WEBHOOK_EVENTS = [
  'server.started',
  'server.stopped',
  'server.crashed',
  'backup.done',
  'backup.failed',
  'player.joined',
  'player.left',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// Webhook URLs must use HTTPS: the protocol "https" matches; "http" and "ftp" are rejected.
// https://regex101.com/?flavor=javascript&regex=%5Ehttps%24&flags=gm&testString=https%0Ahttp%0Aftp
const HTTPS_ONLY = /^https$/;

export const webhookInputSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  kind: z.enum(WEBHOOK_KINDS),
  url: z.url({ protocol: HTTPS_ONLY }).max(URL_MAX),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  serverId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type WebhookInput = z.infer<typeof webhookInputSchema>;

export interface WebhookEntry {
  readonly id: number;
  readonly name: string;
  readonly kind: WebhookKind;
  /** Only the host is returned; the full URL is a secret. */
  readonly urlHost: string;
  readonly events: readonly WebhookEvent[];
  readonly serverId: string | null;
  readonly enabled: boolean;
  readonly lastStatus: number | null;
  readonly lastAt: string | null;
}

/* ---------- Users, roles, tokens, audit ---------- */

export const userCreateSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(DISPLAY_NAME_MAX).optional(),
  isAdmin: z.boolean().default(false),
  canCreateServers: z.boolean().default(false),
  locale: z.enum(LOCALES).default('de'),
  email: emailSchema.optional(),
});
export const passwordResetSchema = z.object({
  /** Also switch off 2FA and remove passkeys, e.g. when the phone is lost. */
  removeSecondFactors: z.boolean().default(false),
});

export interface PasswordResetResult {
  /** Shown exactly once to the admin who reset it. */
  readonly password: string;
}

export const userUpdateSchema = z.object({
  displayName: z.string().trim().max(DISPLAY_NAME_MAX).optional(),
  password: passwordSchema.optional(),
  isAdmin: z.boolean().optional(),
  canCreateServers: z.boolean().optional(),
  disabled: z.boolean().optional(),
  /** null removes the address. */
  email: emailSchema.nullable().optional(),
});
export const accessUpdateSchema = z.object({
  access: z.array(z.object({ serverId: z.string(), roleId: z.number().int() })),
});

export const roleInputSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  description: z.string().trim().max(REASON_MAX).default(''),
  permissions: z.array(z.enum(SERVER_PERMISSIONS)),
});

export interface RoleEntry {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly ServerPermission[];
  readonly builtIn: boolean;
}

export interface UserAccessEntry {
  readonly serverId: string;
  readonly roleId: number;
}

export interface UserListEntry extends UserInfo {
  readonly access: readonly UserAccessEntry[];
}

export const tokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(TOKEN_NAME_MAX),
  expiresInDays: z.number().int().min(1).max(TOKEN_DAYS_MAX).nullable().default(null),
});

export interface ApiTokenEntry {
  readonly id: number;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
}

/* ---------- Passkeys ---------- */

const PASSKEY_NAME_MAX = 60;
const WEBAUTHN_FIELD_MAX = 16_384;
const b64url = z.string().max(WEBAUTHN_FIELD_MAX);

/** What the browser hands over after creating a passkey (WebAuthn RegistrationResponseJSON). */
export const passkeyRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(PASSKEY_NAME_MAX),
  response: z.object({
    id: b64url,
    rawId: b64url,
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: b64url,
      attestationObject: b64url,
      transports: z.array(z.string().max(NAME_MAX)).optional(),
    }),
    authenticatorAttachment: z.string().max(NAME_MAX).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
  }),
});

/** What the browser hands over after signing in with a passkey (WebAuthn AuthenticationResponseJSON). */
export const passkeyLoginSchema = z.object({
  response: z.object({
    id: b64url,
    rawId: b64url,
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: b64url,
      authenticatorData: b64url,
      signature: b64url,
      userHandle: b64url.optional(),
    }),
    authenticatorAttachment: z.string().max(NAME_MAX).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
  }),
});

export interface PasskeyEntry {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface AuditEntry {
  readonly id: number;
  readonly at: string;
  readonly username: string | null;
  readonly serverId: string | null;
  readonly serverName: string | null;
  readonly action: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly ip: string | null;
}

/* ---------- Panel settings and updates ---------- */

export const settingsUpdateSchema = z.object({
  panelDomain: z.union([hostnameSchema, z.literal('')]).optional(),
  publicAddress: z.union([hostnameSchema, z.literal('')]).optional(),
  lanIp: z.union([z.ipv4(), z.literal('')]).optional(),
  publicIpLookup: z.boolean().optional(),
  reachabilityCheck: z.boolean().optional(),
  curseforgeApiKey: z.string().trim().max(URL_MAX).optional(),
  timezone: z.string().trim().max(TIMEZONE_MAX).optional(),
  defaultLocale: z.enum(LOCALES).optional(),
  checkUpdates: z.boolean().optional(),
});

export interface PanelSettings {
  /** The panel's own domain (e.g. panel.example.de); passkeys belong to it. */
  readonly panelDomain: string;
  readonly publicAddress: string;
  readonly lanIp: string;
  readonly publicIpLookup: boolean;
  readonly reachabilityCheck: boolean;
  readonly curseforgeConfigured: boolean;
  readonly timezone: string;
  readonly defaultLocale: Locale;
  readonly checkUpdates: boolean;
}

/** One change on the update branch, newest first: the first line of its commit message. */
/** What one line of an update did: new feature, bug fixed, made better, taken out, or something else. */
export type ChangeKind = 'new' | 'fixed' | 'improved' | 'removed' | 'other';
export const CHANGE_KINDS: readonly ChangeKind[] = ['new', 'fixed', 'improved', 'removed', 'other'];

export interface ChangeItem {
  readonly kind: ChangeKind;
  readonly text: string;
}

export interface UpdateChange {
  readonly sha: string;
  readonly title: string;
  readonly date: string;
  /** The details of the change, sorted by kind (from the lines of the commit message). */
  readonly items: readonly ChangeItem[];
}

/** Where an update stands: asked for, running on the host (with its step), finished or failed. */
export interface UpdateRun {
  readonly state: 'requested' | 'stuck' | 'running' | 'done' | 'failed';
  /** pull = new code, build = new panel image, restart = panel restarts. */
  readonly step: 'pull' | 'build' | 'restart' | null;
  readonly at: string;
  /** The last lines the host updater printed. */
  readonly log: readonly string[];
}

export interface UpdateInfo {
  /** The running version: a commit ("b886c33"), a release ("1.2.0") or "dev". */
  readonly current: string;
  /** Version number of the running panel ("1.0.84"); null when it was built without one. */
  readonly currentVersion: string | null;
  /** Version number the newest update will have. */
  readonly latestVersion: string | null;
  /** Short commit of the newest version on the update branch. */
  readonly latest: string | null;
  readonly latestDate: string | null;
  readonly available: boolean;
  /** How many changes the running panel is behind. */
  readonly behind: number;
  readonly changes: readonly UpdateChange[];
  /** All changes on GitHub. */
  readonly url: string | null;
  readonly checkedAt: string | null;
  /** The last check failed (no internet, GitHub limit); the panel tries again later. */
  readonly checkFailed: boolean;
  /** True when the host updater (install.sh) is installed and listening. */
  readonly canSelfUpdate: boolean;
  readonly updating: boolean;
  readonly run: UpdateRun | null;
}

/** The running version for the badge in the menu, and what changed up to it. */
export interface Changelog {
  /** Release number ("1.0.0") when the panel was built from or after a release tag. */
  readonly release: string | null;
  /** Short commit the panel was built from; null for a build without git ("dev"). */
  readonly commit: string | null;
  /** The latest changes up to the running version, newest first. */
  readonly changes: readonly UpdateChange[];
  /** All changes on GitHub. */
  readonly url: string | null;
  /** GitHub could not be asked (no internet, limit); the list is empty then. */
  readonly failed: boolean;
}

export type { ScheduleAction, ScheduleSpec, ServerPermission, SoftwareId, Edition, JavaTag };

/* ---------- WebSocket ---------- */

export type WsServerMessage =
  | { readonly type: 'live'; readonly serverId: string; readonly live: ServerLive }
  | { readonly type: 'console'; readonly serverId: string; readonly line: string }
  | { readonly type: 'console-history'; readonly serverId: string; readonly lines: readonly string[] }
  | { readonly type: 'deleted'; readonly serverId: string }
  /** Sign-ups or server requests changed: reload the approvals, own requests and server list. */
  | { readonly type: 'approvals' }
  | { readonly type: 'error'; readonly code: string }
  | { readonly type: 'pong' };

export type WsClientMessage =
  /** First message of every socket: proves it was opened by the panel's own page. */
  | { readonly type: 'hello'; readonly csrf: string }
  | { readonly type: 'subscribe'; readonly channel: 'servers' }
  | { readonly type: 'subscribe'; readonly channel: 'console'; readonly serverId: string }
  | { readonly type: 'unsubscribe'; readonly channel: 'console'; readonly serverId: string }
  | { readonly type: 'ping' };

export interface ApiErrorBody {
  readonly error: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly message?: string;
}

/* ---------- Import ---------- */

export const importConfirmSchema = z.object({
  stagingId: z.string().min(1).max(VERSION_MAX),
  name: z.string().trim().min(1).max(NAME_MAX),
  software: z.enum(SOFTWARE_IDS),
  version: z.string().trim().min(1).max(VERSION_MAX),
  memoryMb: memorySchema,
  port: portSchema,
  eula: z.literal(true),
  startNow: z.boolean().default(false),
});
export type ImportConfirmInput = z.infer<typeof importConfirmSchema>;

export interface ImportDetectionResult {
  readonly stagingId: string;
  readonly edition: Edition;
  readonly software: SoftwareId;
  readonly version: string | null;
  readonly files: number;
  readonly bytes: number;
  readonly worlds: readonly string[];
  readonly plugins: number;
  readonly mods: number;
}

/** "Preload" in the admin area: download a game before anyone orders a server of it. */
export type PreloadState = 'none' | 'queued' | 'loading' | 'ready' | 'failed';
export interface PreloadItem {
  readonly software: SoftwareId;
  readonly version: string | null;
  /** "template": a hidden server downloads everything once; "image": only the program image (game comes inside). */
  readonly mode: 'template' | 'image';
  readonly state: PreloadState;
  /** 0–100 while loading, if known. */
  readonly progress: number | null;
  readonly download: ServerLive['download'];
  /** Rough size of the download in GB, from the catalog. */
  readonly sizeGb: number | null;
  readonly error: string | null;
  readonly doneAt: string | null;
  /** Last hourly look for updates (they install by themselves). */
  readonly checkedAt: string | null;
  /** A newer version than the downloaded one is out (Minecraft software); null when there is none or unknown. */
  readonly newVersion: string | null;
}

/** The imprint page: a picture uploaded in the admin area (shown at /impressum, also without logging in). */
export interface ImpressumInfo {
  readonly hasImage: boolean;
  readonly updatedAt: string | null;
}

/** "All versions" (ViaVersion): which software can have it and whether it is on. */
export const VIA_SOFTWARE: readonly SoftwareId[] = ['paper', 'purpur', 'custom', 'velocity', 'fabric'];
export interface ViaStatus {
  readonly enabled: boolean;
  readonly restartRequired: boolean;
}
