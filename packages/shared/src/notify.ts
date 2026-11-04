import { z } from 'zod';
import type { CreateServerInput } from './api.js';

/** Notifications by mail and Discord private message, account approval and server requests. */

/** What someone can be told about. "approvals" only reaches admins. */
export const NOTIFY_TOPICS = ['approvals', 'crashes', 'decisions'] as const;
export type NotifyTopic = (typeof NOTIFY_TOPICS)[number];
export const NOTIFY_CHANNELS = ['email', 'discord'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * Every single reason the panel writes to someone, each one can be switched off on its own ("Mein Konto" →
 * Benachrichtigungen). `selfFixing`: it repairs itself, a message is only for information.
 */
export const NOTIFY_KINDS = [
  'server-crash',
  'server-restart',
  'backup-failed',
  'disk',
  'panel-restart',
  'docker',
  'container-restart',
  'host-offline',
  'host-storage',
  'netbird',
  'netbird-exit',
  'netbird-heal',
  'dns',
  'mail-failed',
  'registration',
  'server-request',
  'payment',
  'decision',
  'server-online',
  'other',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export const NOTIFY_KIND_INFO: Readonly<
  Record<NotifyKind, { readonly topic: NotifyTopic; readonly selfFixing: boolean }>
> = {
  'server-crash': { topic: 'crashes', selfFixing: false },
  'server-restart': { topic: 'crashes', selfFixing: true },
  'backup-failed': { topic: 'crashes', selfFixing: false },
  disk: { topic: 'crashes', selfFixing: false },
  'panel-restart': { topic: 'crashes', selfFixing: true },
  docker: { topic: 'crashes', selfFixing: true },
  'container-restart': { topic: 'crashes', selfFixing: true },
  'host-offline': { topic: 'crashes', selfFixing: false },
  'host-storage': { topic: 'crashes', selfFixing: false },
  netbird: { topic: 'crashes', selfFixing: true },
  'netbird-exit': { topic: 'crashes', selfFixing: true },
  'netbird-heal': { topic: 'crashes', selfFixing: true },
  dns: { topic: 'crashes', selfFixing: true },
  'mail-failed': { topic: 'crashes', selfFixing: false },
  registration: { topic: 'approvals', selfFixing: false },
  'server-request': { topic: 'approvals', selfFixing: false },
  payment: { topic: 'approvals', selfFixing: false },
  decision: { topic: 'decisions', selfFixing: false },
  'server-online': { topic: 'decisions', selfFixing: false },
  other: { topic: 'crashes', selfFixing: false },
};

/** Alert keys of the panel and its watchdogs (guard.sh, dauerbetrieb.sh) → kind; "server:<id>" uses the part before ":". */
const ALERT_KEY_KINDS: Readonly<Record<string, NotifyKind>> = {
  server: 'server-restart',
  backup: 'backup-failed',
  mail: 'mail-failed',
  'netbird-exit': 'netbird-exit',
  'netbird-heal': 'netbird-heal',
  netbird: 'netbird',
  dns: 'dns',
  docker: 'docker',
  panel: 'panel-restart',
  disk: 'disk',
  'host-exit': 'host-offline',
  storage: 'host-storage',
  container: 'container-restart',
};
export const alertKind = (key: string): NotifyKind => ALERT_KEY_KINDS[key.split(':')[0] ?? ''] ?? 'other';

/** Saved per person; anything missing counts as "on", `muted` lists the single kinds switched off. */
export type NotifyPrefs = Partial<Record<NotifyTopic | NotifyChannel, boolean>> & {
  readonly muted?: readonly NotifyKind[];
};
export const notifyPrefsSchema = z.object({
  ...(Object.fromEntries([...NOTIFY_TOPICS, ...NOTIFY_CHANNELS].map((key) => [key, z.boolean()])) as Record<
    NotifyTopic | NotifyChannel,
    z.ZodBoolean
  >),
  muted: z.array(z.enum(NOTIFY_KINDS)).max(NOTIFY_KINDS.length).default([]),
});
export type NotifyPrefsInput = z.infer<typeof notifyPrefsSchema>;

export const wantsNotice = (prefs: NotifyPrefs, key: NotifyTopic | NotifyChannel): boolean =>
  prefs[key] !== false;
export const wantsKind = (prefs: NotifyPrefs, kind: NotifyKind): boolean =>
  !(prefs.muted ?? []).includes(kind);

export interface NotifySettingsView {
  readonly prefs: NotifyPrefsInput;
  readonly discord: {
    /** The panel has a Discord bot set up (admin area). */
    readonly available: boolean;
    readonly linked: boolean;
    readonly name: string | null;
    /** Link to add the bot to one's own Discord account (no server needed). */
    readonly installUrl: string | null;
    readonly serverInstallUrl: string | null;
    /** The last message to this person that did not go through. */
    readonly lastDmError: DmError | null;
  };
  readonly emailSet: boolean;
}

export interface DiscordLinkCode {
  readonly code: string;
  readonly expiresAt: string;
}

const TOKEN_MAX = 200;
export const discordSettingsSchema = z.object({ token: z.string().trim().min(1).max(TOKEN_MAX) });

export interface DiscordSettingsView {
  readonly configured: boolean;
  readonly botName: string | null;
  readonly appId: string | null;
  readonly installUrl: string | null;
  /** The bot is online (connected to Discord) and can receive button clicks. */
  readonly online: boolean;
  readonly error: string | null;
  /** The bot already has the MorniHosting picture and description. */
  readonly branded: boolean;
  /** Why setting picture/description failed last time (retried at the next start). */
  readonly brandError: string | null;
  /** Link to put the bot on one of your servers: then Discord lets it write to you privately. */
  readonly serverInstallUrl: string | null;
  /** The last private message that did not go through, if any. */
  readonly lastDmError: DmError | null;
}

export interface DmError {
  readonly at: string;
  /** Discord's own words. */
  readonly message: string;
  /** Discord refused because there is no shared server or DMs from apps are off. */
  readonly blocked: boolean;
}

export const SERVER_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ServerRequestStatus = (typeof SERVER_REQUEST_STATUSES)[number];

export interface ServerRequestView {
  readonly id: string;
  readonly user: { readonly id: number; readonly username: string; readonly displayName: string };
  readonly input: Omit<CreateServerInput, 'eula'>;
  readonly status: ServerRequestStatus;
  readonly note: string;
  readonly serverId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
}

const NOTE_MAX = 300;
export const decisionSchema = z.object({ note: z.string().trim().max(NOTE_MAX).default('') });

export interface PendingUser {
  readonly id: number;
  readonly username: string;
  readonly email: string | null;
  /** False until the person clicked the link in their sign-up mail; they can log in only after both. */
  readonly emailConfirmed: boolean;
  readonly createdAt: string;
}

export interface ApprovalsView {
  readonly users: readonly PendingUser[];
  readonly requests: readonly ServerRequestView[];
}

export const discordClaimSchema = z.object({ token: z.string().min(1).max(TOKEN_MAX) });
export interface DiscordLinked {
  readonly name: string;
  /** Set when the welcome message could not be delivered. */
  readonly dm: DmError | null;
}
