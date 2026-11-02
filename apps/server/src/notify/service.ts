import { randomInt } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import {
  wantsNotice,
  type DiscordLinkCode,
  type DiscordSettingsView,
  type NotifyPrefsInput,
  type NotifySettingsView,
  type NotifyTopic,
} from '@mornihosting/shared';
import type { UserRow } from '../auth/context.js';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { badRequest, errorMessage } from '../lib/errors.js';
import { UpstreamError } from '../lib/http-client.js';
import { MS_PER_MINUTE } from '../lib/units.js';
import type { MailKind, MailVars } from '../mail/templates.js';
import type { MailService } from '../mail/service.js';
import {
  DiscordError,
  INTERACTION_COMMAND,
  INTERACTION_COMPONENT,
  realDiscord,
  REPLY_MESSAGE,
  REPLY_UPDATE_MESSAGE,
  type DiscordApi,
  type DiscordInteraction,
  type DiscordMessage,
} from './discord.js';

/**
 * Notifications by mail and Discord private message, and the buttons in those messages. Each person chooses
 * topics and channels in "Mein Konto"; a person's Discord account is linked once with /verbinden <code>.
 */

const DISCORD_KEY = 'discord';
const LINK_TTL_MS = 10 * MS_PER_MINUTE; // eslint-disable-line ts-patterns/no-magic-numbers -- ten minutes to type the code
const CODE_MIN = 100000;
const CODE_MAX = 1000000;
const ACTION_PREFIX = 'mh';
const ACTION_SEPARATOR = ':';
export const COLOUR_INFO = 0x10b981;
export const COLOUR_DONE = 0x059669;
export const COLOUR_DECLINED = 0xdc2626;

interface StoredDiscord {
  tokenSealed: string;
  appId: string;
  botName: string;
}

export interface Notice {
  readonly mail?: { readonly kind: MailKind; readonly vars: Partial<MailVars> };
  readonly discord: DiscordMessage;
}

/** A button in a DM was clicked by the linked person; returns what the message should say afterwards. */
export type ActionHandler = (target: string, by: UserRow) => Promise<DiscordMessage>;

export interface NotifyService {
  readonly discordView: () => DiscordSettingsView;
  readonly setDiscord: (token: string) => Promise<DiscordSettingsView>;
  readonly clearDiscord: () => void;
  readonly settingsFor: (user: UserRow) => NotifySettingsView;
  readonly setPrefs: (user: UserRow, prefs: NotifyPrefsInput) => NotifySettingsView;
  readonly linkCode: (user: UserRow) => DiscordLinkCode;
  readonly unlink: (user: UserRow) => void;
  /** Tells each person about something, by every channel they chose for this topic. */
  readonly tell: (
    people: readonly UserRow[],
    topic: NotifyTopic,
    notice: (person: UserRow) => Notice,
  ) => void;
  readonly admins: () => UserRow[];
  readonly onAction: (action: string, handler: ActionHandler) => void;
  /** Button id for a DM: "mh:<action>:<target>". */
  readonly actionId: (action: string, target: string) => string;
  readonly start: () => void;
  readonly stop: () => void;
}

export function createNotifyService(
  ctx: AppContext,
  mail: MailService,
  api: DiscordApi = realDiscord,
): NotifyService {
  const { db, settings, secrets, log } = ctx;
  const codes = new Map<string, { userId: number; expires: number }>();
  const actions = new Map<string, ActionHandler>();
  const state: { online: boolean; error: string | null; disconnect: (() => void) | null } = {
    online: false,
    error: null,
    disconnect: null,
  };

  const stored = (): StoredDiscord | undefined => settings.getValue<StoredDiscord>(DISCORD_KEY);
  const token = (): string | null => {
    const s = stored();
    return s ? secrets.decrypt(s.tokenSealed) : null;
  };
  const installUrl = (): string | null => {
    const s = stored();
    return s
      ? `https://discord.com/oauth2/authorize?client_id=${s.appId}&integration_type=1&scope=applications.commands`
      : null;
  };

  const discordView = (): DiscordSettingsView => {
    const s = stored();
    return {
      configured: s !== undefined,
      botName: s?.botName ?? null,
      appId: s?.appId ?? null,
      installUrl: installUrl(),
      online: state.online,
      error: state.error,
    };
  };

  const userByDiscord = (discordId: string): UserRow | undefined =>
    db.select().from(users).where(eq(users.discordId, discordId)).get();

  /** Fire and forget: a lost reply only leaves the button spinning. */
  const quietly = async (work: () => Promise<void>, what: string): Promise<void> => {
    try {
      await work();
    } catch (err) {
      log.warn({ err: errorMessage(err) }, what);
    }
  };

  const reply = (interaction: DiscordInteraction, type: number, message: DiscordMessage | null): void => {
    void quietly(() => api.reply(interaction, type, message), 'discord reply failed');
  };

  const link = (interaction: DiscordInteraction): void => {
    const entry = codes.get(interaction.value.trim());
    if (!entry || entry.expires < Date.now()) {
      reply(interaction, REPLY_MESSAGE, {
        title: 'Code ungültig',
        text: 'Hol dir in MorniHosting unter „Mein Konto → Benachrichtigungen“ einen neuen Code (gilt 10 Minuten).',
      });
      return;
    }
    codes.delete(interaction.value.trim());
    db.update(users)
      .set({ discordId: null, discordName: null })
      .where(and(eq(users.discordId, interaction.userId), ne(users.id, entry.userId)))
      .run();
    db.update(users)
      .set({ discordId: interaction.userId, discordName: interaction.userName })
      .where(eq(users.id, entry.userId))
      .run();
    ctx.audit.record(
      { userId: entry.userId, username: interaction.userName, ip: null },
      'account.discord_linked',
    );
    reply(interaction, REPLY_MESSAGE, {
      title: '✅ Verbunden',
      text: 'Ab jetzt bekommst du deine MorniHosting-Benachrichtigungen hier per Direktnachricht.',
    });
  };

  const click = async (interaction: DiscordInteraction): Promise<void> => {
    const [prefix, action = '', target = ''] = interaction.value.split(ACTION_SEPARATOR);
    const handler = prefix === ACTION_PREFIX ? actions.get(action) : undefined;
    const person = userByDiscord(interaction.userId);
    if (!handler || !person || person.disabled) {
      reply(interaction, REPLY_MESSAGE, {
        title: 'Nicht möglich',
        text: 'Dieser Discord-Account ist mit keinem aktiven MorniHosting-Konto verbunden.',
      });
      return;
    }
    try {
      reply(interaction, REPLY_UPDATE_MESSAGE, await handler(target, person));
    } catch (err) {
      reply(interaction, REPLY_MESSAGE, { title: 'Hat nicht geklappt', text: errorMessage(err) });
    }
  };

  const onInteraction = (interaction: DiscordInteraction): void => {
    if (interaction.type === INTERACTION_COMMAND) link(interaction);
    if (interaction.type === INTERACTION_COMPONENT) void click(interaction);
  };

  const start = (): void => {
    state.disconnect?.();
    state.disconnect = null;
    const t = token();
    if (!t) return;
    state.disconnect = api.connect(t, onInteraction, (online, error) => {
      state.online = online;
      state.error = error;
    });
  };

  const settingsFor = (user: UserRow): NotifySettingsView => {
    const prefs = user.notify;
    return {
      prefs: {
        approvals: wantsNotice(prefs, 'approvals'),
        crashes: wantsNotice(prefs, 'crashes'),
        decisions: wantsNotice(prefs, 'decisions'),
        email: wantsNotice(prefs, 'email'),
        discord: wantsNotice(prefs, 'discord'),
      },
      discord: {
        available: stored() !== undefined,
        linked: Boolean(user.discordId),
        name: user.discordName,
        installUrl: installUrl(),
      },
      emailSet: Boolean(user.email),
    };
  };

  const fresh = (user: UserRow): UserRow =>
    db.select().from(users).where(eq(users.id, user.id)).get() ?? user;

  const tell: NotifyService['tell'] = (people, topic, notice) => {
    const t = token();
    people
      .filter((person) => !person.disabled && wantsNotice(person.notify, topic))
      .forEach((person) => {
        const n = notice(person);
        if (n.mail && person.email && wantsNotice(person.notify, 'email'))
          mail.deliver(person.email, n.mail.kind, person.locale, {
            name: person.displayName || person.username,
            ...n.mail.vars,
          });
        if (t && person.discordId && wantsNotice(person.notify, 'discord'))
          void quietly(() => api.sendDm(t, person.discordId ?? '', n.discord), 'discord message failed');
      });
  };

  return {
    discordView,
    setDiscord: async (newToken) => {
      try {
        const bot = await api.whoAmI(newToken);
        await api.registerCommands(newToken, bot.id);
        settings.setValue(DISCORD_KEY, {
          tokenSealed: secrets.encrypt(newToken),
          appId: bot.id,
          botName: bot.name,
        } satisfies StoredDiscord);
      } catch (err) {
        if (err instanceof DiscordError) throw badRequest('discord_token_invalid', { message: err.message });
        if (err instanceof UpstreamError) throw badRequest('discord_unreachable');
        throw err;
      }
      start();
      return discordView();
    },
    clearDiscord: () => {
      state.disconnect?.();
      state.disconnect = null;
      state.online = false;
      state.error = null;
      settings.deleteValue(DISCORD_KEY);
    },
    settingsFor: (user) => settingsFor(fresh(user)),
    setPrefs: (user, prefs) => {
      db.update(users).set({ notify: prefs }).where(eq(users.id, user.id)).run();
      return settingsFor(fresh(user));
    },
    linkCode: (user) => {
      [...codes].filter(([, e]) => e.userId === user.id).forEach(([code]) => codes.delete(code));
      const code = String(randomInt(CODE_MIN, CODE_MAX));
      const expires = Date.now() + LINK_TTL_MS;
      codes.set(code, { userId: user.id, expires });
      return { code, expiresAt: new Date(expires).toISOString() };
    },
    unlink: (user) => {
      db.update(users).set({ discordId: null, discordName: null }).where(eq(users.id, user.id)).run();
    },
    tell,
    admins: () =>
      db
        .select()
        .from(users)
        .where(and(eq(users.isAdmin, true), eq(users.disabled, false)))
        .all(),
    onAction: (action, handler) => {
      actions.set(action, handler);
    },
    actionId: (action, target) => [ACTION_PREFIX, action, target].join(ACTION_SEPARATOR),
    start,
    stop: () => {
      state.disconnect?.();
      state.disconnect = null;
    },
  };
}
