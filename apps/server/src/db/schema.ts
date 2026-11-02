import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  BackupSettings,
  CreateServerInput,
  CrashInfo,
  Edition,
  JavaTag,
  Locale,
  NetbirdPurpose,
  NotifyPrefs,
  ScheduleAction,
  ScheduleSpec,
  ServerPermission,
  ServerRequestStatus,
  SoftwareId,
  Theme,
  WebhookEvent,
  WebhookKind,
} from '@mornihosting/shared';

const DEFAULT_BACKUP_KEEP = 7;
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  keep: DEFAULT_BACKUP_KEEP,
  exclude: ['logs/', 'cache/', 'crash-reports/'],
};

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    displayName: text('display_name').notNull().default(''),
    passwordHash: text('password_hash').notNull(),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    canCreateServers: integer('can_create_servers', { mode: 'boolean' }).notNull().default(false),
    locale: text('locale').$type<Locale>().notNull().default('de'),
    theme: text('theme').$type<Theme>().notNull().default('dark'),
    totpSecret: text('totp_secret'),
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    lastLoginAt: text('last_login_at'),
    /** The user's own Minecraft account (Java), for the head and automatic OP on their servers. */
    minecraftName: text('minecraft_name'),
    minecraftUuid: text('minecraft_uuid'),
    /** Optional, unique (any case); used for mails and "password forgotten". */
    email: text('email'),
    /** Registered on the start page and the mail link was not opened yet: cannot log in. */
    signupPending: integer('signup_pending', { mode: 'boolean' }).notNull().default(false),
    /** Registered and confirmed, but an admin still has to let them in: cannot log in. */
    approvalPending: integer('approval_pending', { mode: 'boolean' }).notNull().default(false),
    /** Linked Discord account: the bot writes to this person by private message. */
    discordId: text('discord_id'),
    discordName: text('discord_name'),
    /** Which notifications this person wants, and how (see NotifyPrefs). */
    notify: text('notify', { mode: 'json' })
      .$type<NotifyPrefs>()
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => [
    uniqueIndex('users_username_nocase').on(sql`lower(${t.username})`),
    uniqueIndex('users_email_nocase').on(sql`lower(${t.email})`),
    uniqueIndex('users_minecraft_uuid').on(t.minecraftUuid),
    uniqueIndex('users_discord_id').on(t.discordId),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    /** Set while the password was correct but the second factor is still missing. */
    pendingTwoFactor: integer('pending_two_factor', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

export const apiTokens = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdAt: createdAt(),
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
});

/** WebAuthn credentials ("Passkeys"); the id is the credential id the authenticator gave out. */
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** COSE public key, base64url. */
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [index('passkeys_user').on(t.userId)],
);

export const roles = sqliteTable('roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  permissions: text('permissions', { mode: 'json' }).$type<ServerPermission[]>().notNull(),
  builtIn: text('built_in'),
});

export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  edition: text('edition').$type<Edition>().notNull(),
  software: text('software').$type<SoftwareId>().notNull(),
  version: text('version').notNull(),
  memoryMb: integer('memory_mb').notNull(),
  port: integer('port').notNull(),
  rconPassword: text('rcon_password').notNull(),
  javaTag: text('java_tag').$type<JavaTag>(),
  image: text('image').notNull(),
  containerId: text('container_id'),
  domain: text('domain'),
  autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(true),
  extraPorts: text('extra_ports', { mode: 'json' })
    .$type<{ port: number; containerPort?: number; protocol: 'tcp' | 'udp'; purpose: string }[]>()
    .notNull()
    .default([]),
  extraEnv: text('extra_env', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  /** Settings of other games (see GameField in games.ts); secret fields are stored encrypted. */
  gameSettings: text('game_settings', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  geyser: integer('geyser', { mode: 'boolean' }).notNull().default(false),
  /** Port friends use from outside when a tunnel or proxy (NetBird, playit.gg) gives another one. */
  publicPort: integer('public_port'),
  voiceChat: integer('voice_chat', { mode: 'boolean' }).notNull().default(false),
  /** Outside UDP port for Simple Voice Chat, when it differs from the host port. */
  voicePublicPort: integer('voice_public_port'),
  /** Outside UDP port for Geyser (Bedrock players), when a tunnel gives another one. */
  geyserPublicPort: integer('geyser_public_port'),
  /** Name in front of the NetBird domain ("survival" → survival.example.de); the panel keeps NetBird in sync. */
  netbirdName: text('netbird_name'),
  backupSettings: text('backup_settings', { mode: 'json' })
    .$type<BackupSettings>()
    .notNull()
    .default(DEFAULT_BACKUP_SETTINGS),
  crash: text('crash', { mode: 'json' }).$type<CrashInfo | null>(),
  /** The state the owner wants: a server that should run is restarted after a panel restart. */
  desiredRunning: integer('desired_running', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: text('updated_at'),
});

export const serverAccess = sqliteTable(
  'server_access',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.serverId] })],
);

export const backups = sqliteTable(
  'backups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    kind: text('kind').$type<'manual' | 'scheduled' | 'before-restore'>().notNull(),
    status: text('status').$type<'running' | 'done' | 'failed'>().notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('backups_server').on(t.serverId)],
);

export const schedules = sqliteTable('schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  action: text('action').$type<ScheduleAction>().notNull(),
  command: text('command'),
  spec: text('spec', { mode: 'json' }).$type<ScheduleSpec>().notNull(),
  cron: text('cron').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  warnMinutes: integer('warn_minutes').notNull().default(0),
  lastRunAt: text('last_run_at'),
  lastResult: text('last_result').$type<'ok' | 'failed'>(),
  createdAt: createdAt(),
});

export const webhooks = sqliteTable('webhooks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').$type<WebhookKind>().notNull(),
  url: text('url').notNull(),
  urlHost: text('url_host').notNull(),
  events: text('events', { mode: 'json' }).$type<WebhookEvent[]>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastStatus: integer('last_status'),
  lastAt: text('last_at'),
  createdAt: createdAt(),
});

export const installedContent = sqliteTable(
  'installed_content',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    provider: text('provider')
      .$type<'modrinth' | 'hangar' | 'spiget' | 'curseforge' | 'geysermc' | 'upload'>()
      .notNull(),
    projectId: text('project_id'),
    projectName: text('project_name').notNull(),
    versionId: text('version_id'),
    versionName: text('version_name'),
    fileName: text('file_name').notNull(),
    iconUrl: text('icon_url'),
    /** Installed automatically because another project needs it. */
    dependencyOf: text('dependency_of'),
    installedAt: createdAt(),
  },
  (t) => [index('content_server').on(t.serverId)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: createdAt(),
    userId: integer('user_id'),
    username: text('username'),
    serverId: text('server_id'),
    action: text('action').notNull(),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
  },
  (t) => [index('audit_at').on(t.at), index('audit_server').on(t.serverId)],
);

export const stats = sqliteTable(
  'stats',
  {
    serverId: text('server_id').notNull(),
    at: integer('at').notNull(),
    cpu: real('cpu'),
    memMb: real('mem_mb'),
    players: integer('players'),
    tps: real('tps'),
  },
  (t) => [index('stats_server_at').on(t.serverId, t.at)],
);

/**
 * Reverse-proxy services the panel created in the admin's NetBird account. Not tied to the servers table:
 * after a server is deleted its rows stay until the services are gone in NetBird too.
 */
export const netbirdServices = sqliteTable('netbird_services', {
  /** Service id in NetBird. */
  id: text('id').primaryKey(),
  /** Null for the panel's own service. */
  serverId: text('server_id'),
  purpose: text('purpose').$type<NetbirdPurpose>().notNull(),
  domain: text('domain').notNull(),
  mode: text('mode').$type<'http' | 'tcp' | 'udp'>().notNull(),
  targetPort: integer('target_port').notNull(),
  listenPort: integer('listen_port'),
  createdAt: createdAt(),
});

/** DNS records the panel keeps at the own domain's provider (Cloudflare, IONOS): one A and one SRV per server. */
export const dnsRecords = sqliteTable('dns_records', {
  /** Record id at the DNS provider. */
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull(),
  type: text('type').$type<'A' | 'SRV'>().notNull(),
  name: text('name').notNull(),
  /** What the record says right now: the IP for A, "port target" for SRV. */
  content: text('content').notNull(),
  createdAt: createdAt(),
});

/**
 * Operators the panel added because a user with a linked Minecraft account owns the server. Only these are
 * taken away again; operators added by hand stay.
 */
export const panelOps = sqliteTable(
  'panel_ops',
  {
    serverId: text('server_id').notNull(),
    uuid: text('uuid').notNull(),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.uuid] })],
);

/** One-time links sent by mail (confirm registration, confirm new address, reset password). Only the hash is kept. */
export const mailTokens = sqliteTable(
  'mail_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').$type<'register' | 'email_change' | 'password_reset'>().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** The address a change is about (email_change only). */
    email: text('email'),
    expiresAt: text('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('mail_tokens_user').on(t.userId)],
);

/** Someone without the right to order asked for a server; an admin approves (it is created then) or declines. */
export const serverRequests = sqliteTable(
  'server_requests',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    input: text('input', { mode: 'json' }).$type<CreateServerInput>().notNull(),
    status: text('status').$type<ServerRequestStatus>().notNull().default('pending'),
    note: text('note').notNull().default(''),
    serverId: text('server_id'),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('server_requests_status').on(t.status)],
);
