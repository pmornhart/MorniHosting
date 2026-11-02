import { z } from 'zod';
import type { CreateServerInput } from './api.js';

/** Notifications by mail and Discord private message, account approval and server requests. */

/** What someone can be told about. "approvals" only reaches admins. */
export const NOTIFY_TOPICS = ['approvals', 'crashes', 'decisions'] as const;
export type NotifyTopic = (typeof NOTIFY_TOPICS)[number];
export const NOTIFY_CHANNELS = ['email', 'discord'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** Saved per person; anything missing counts as "on". */
export type NotifyPrefs = Partial<Record<NotifyTopic | NotifyChannel, boolean>>;
export const notifyPrefsSchema = z.object(
  Object.fromEntries([...NOTIFY_TOPICS, ...NOTIFY_CHANNELS].map((key) => [key, z.boolean()])) as Record<
    NotifyTopic | NotifyChannel,
    z.ZodBoolean
  >,
);
export type NotifyPrefsInput = z.infer<typeof notifyPrefsSchema>;

export const wantsNotice = (prefs: NotifyPrefs, key: NotifyTopic | NotifyChannel): boolean =>
  prefs[key] !== false;

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
  readonly createdAt: string;
}

export interface ApprovalsView {
  readonly users: readonly PendingUser[];
  readonly requests: readonly ServerRequestView[];
}
