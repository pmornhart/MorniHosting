import { randomInt } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import {
  wantsNotice,
  type DiscordLinkCode,
  type DiscordSettingsView,
  type DiscordLinked,
  type DmError,
  type NotifyPrefsInput,
  type NotifySettingsView,
  type NotifyTopic,
} from '@mornihosting/shared';
import type { UserRow } from '../auth/context.js';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { badRequest, errorMessage } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { UpstreamError } from '../lib/http-client.js';
import { MS_PER_MINUTE } from '../lib/units.js';
import type { MailKind, MailVars } from '../mail/templates.js';
import type { MailService } from '../mail/service.js';
import { BOT_AVATAR_PNG_BASE64 } from './bot-avatar.js';
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
/** Discord's "Cannot send messages to this user": DMs from apps are switched off or the app was removed. */
const DISCORD_CANNOT_DM = 50007;
const CLAIM_TOKEN_BYTES = 24;
const WELCOME_WAIT_MS = 2000;
const ACTION_SEPARATOR = ':';
export const COLOUR_INFO = 0x10b981;
export const COLOUR_DONE = 0x059669;
export const COLOUR_DECLINED = 0xdc2626;

interface StoredDiscord {
  tokenSealed: string;
  appId: string;
  botName: string;
  /** Which look (picture + description) the bot got last; a newer BRAND_VERSION is applied once at start. */
  brandVersion?: number;
}

const WELCOME: DiscordMessage = {
  title: '👋 Hallo von MorniHosting',
  text: 'Dein Discord ist jetzt verbunden. Hier bekommst du ab sofort deine Benachrichtigungen – Freigaben, Abstürze und Antworten auf deine Anfragen.',
  colour: COLOUR_INFO,
};

/** Raise when picture or description change, so existing bots get the new look once. */
const BRAND_VERSION = 1;
const BOT_DESCRIPTION =
  'Der Bot von MorniHosting – deinem eigenen Server-Panel für Minecraft und mehr. 🟩\n\n' +
  'Er schreibt dir privat: neue Registrierungen und Server-Anfragen mit Knöpfen zum Freigeben, Abstürze deiner Server und Antworten auf deine Anfragen.\n\n' +
  'Verbinden: im Panel unter „Mein Konto → Benachrichtigungen“ einen Code holen und /verbinden <code> schicken.';

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
  /** Link from the /verbinden button: which Discord account it is for (shown before confirming). */
  readonly peekClaim: (token: string) => { readonly name: string };
  /** Confirmed in the panel: links that Discord account to the signed-in person and says hello. */
  readonly claim: (user: UserRow, token: string) => Promise<DiscordLinked>;
  readonly unlink: (user: UserRow) => void;
  /** Sends a test DM to the person's linked Discord and reports a failure (e.g. DMs from apps blocked). */
  readonly testDm: (user: UserRow) => Promise<void>;
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
  const state: {
    online: boolean;
    error: string | null;
    disconnect: (() => void) | null;
    brandError: string | null;
  } = {
    online: false,
    error: null,
    disconnect: null,
    brandError: null,
  };
  /** Last failed private message per Discord user (kept in memory; cleared by the next one that works). */
  const dmErrors = new Map<string, DmError>();
  /** Links handed out by /verbinden: token → the Discord account that asked (10 minutes, one use). */
  const claims = new Map<string, { discordId: string; name: string; expires: number }>();

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

  const serverInstallUrl = (): string | null => {
    const s = stored();
    return s
      ? `https://discord.com/oauth2/authorize?client_id=${s.appId}&integration_type=0&scope=bot%20applications.commands&permissions=0`
      : null;
  };

  /** Sends one DM and remembers whether it went through, so the panel can say why nothing arrived. */
  const deliverDm = async (discordId: string, message: DiscordMessage): Promise<DmError | null> => {
    const t = token();
    if (!t) return null;
    try {
      await api.sendDm(t, discordId, message);
      dmErrors.delete(discordId);
      return null;
    } catch (err) {
      const failure: DmError = {
        at: new Date().toISOString(),
        message: errorMessage(err),
        blocked: err instanceof DiscordError && err.code === DISCORD_CANNOT_DM,
      };
      dmErrors.set(discordId, failure);
      log.warn({ err: failure.message, discordId }, 'discord message failed');
      return failure;
    }
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
      branded: (stored()?.brandVersion ?? 0) >= BRAND_VERSION,
      brandError: state.brandError,
      serverInstallUrl: serverInstallUrl(),
      lastDmError: [...dmErrors.values()].toSorted((a, b) => b.at.localeCompare(a.at))[0] ?? null,
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

  /** Links a Discord account to a panel account (and unlinks it from anyone else). */
  const linkAccount = (userId: number, discordId: string, discordName: string): void => {
    db.update(users)
      .set({ discordId: null, discordName: null })
      .where(and(eq(users.discordId, discordId), ne(users.id, userId)))
      .run();
    db.update(users).set({ discordId, discordName }).where(eq(users.id, userId)).run();
    ctx.audit.record({ userId, username: discordName, ip: null }, 'account.discord_linked');
  };

  /** /verbinden without a code: a button that opens the panel, where the signed-in person confirms. */
  const offerLink = (interaction: DiscordInteraction): void => {
    const base = mail.panelUrl();
    if (!base) {
      reply(interaction, REPLY_MESSAGE, {
        title: 'Fast geschafft',
        text: 'Hol dir im Panel unter „Mein Konto → Benachrichtigungen“ einen Code und gib ihn bei /verbinden im Feld „code“ ein.',
      });
      return;
    }
    const token = randomToken(CLAIM_TOKEN_BYTES);
    claims.set(token, {
      discordId: interaction.userId,
      name: interaction.userName,
      expires: Date.now() + LINK_TTL_MS,
    });
    reply(interaction, REPLY_MESSAGE, {
      title: 'Mit MorniHosting verbinden',
      text: 'Klick auf den Knopf – im Panel bestätigst du mit einem Klick, fertig.',
      buttons: [{ label: 'Jetzt verbinden', url: `${base}/discord-link#${token}` }],
    });
  };

  const link = async (interaction: DiscordInteraction): Promise<void> => {
    if (!interaction.value.trim()) {
      offerLink(interaction);
      return;
    }
    const entry = codes.get(interaction.value.trim());
    if (!entry || entry.expires < Date.now()) {
      reply(interaction, REPLY_MESSAGE, {
        title: 'Code ungültig',
        text: 'Hol dir in MorniHosting unter „Mein Konto → Benachrichtigungen“ einen neuen Code (gilt 10 Minuten).',
      });
      return;
    }
    codes.delete(interaction.value.trim());
    linkAccount(entry.userId, interaction.userId, interaction.userName);
    // The first message from the bot opens the private chat. Discord wants an answer within three seconds,
    // so the reply waits for the DM only briefly and then says what happened.
    const welcome = deliverDm(interaction.userId, WELCOME);
    const waited = await Promise.race([
      welcome,
      new Promise<'slow'>((resolve) => setTimeout(() => resolve('slow'), WELCOME_WAIT_MS)),
    ]);
    const invite = serverInstallUrl();
    reply(
      interaction,
      REPLY_MESSAGE,
      waited === null || waited === 'slow'
        ? {
            title: '✅ Verbunden',
            text: 'Ich habe dir gerade privat geschrieben – schau bei deinen Direktnachrichten. Dort kommen ab jetzt deine MorniHosting-Benachrichtigungen an.',
          }
        : {
            title: '✅ Verbunden – aber ich darf dir nicht privat schreiben',
            text: waited.blocked
              ? `Discord lässt meine Nachricht nicht durch, weil wir keinen gemeinsamen Server haben (oder Direktnachrichten von Apps aus sind). Lösung: Hol mich auf einen deiner Server – dort schreibe ich nichts, aber dann darf ich dir privat schreiben: ${invite ?? ''}`
              : `Discord meldet: ${waited.message}`,
          },
    );
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
    if (interaction.type === INTERACTION_COMMAND) void link(interaction);
    if (interaction.type === INTERACTION_COMPONENT) void click(interaction);
  };

  /** Gives the bot the MorniHosting picture and description, once per BRAND_VERSION. */
  const brand = async (t: string): Promise<void> => {
    try {
      await api.brand(t, {
        avatar: `data:image/png;base64,${BOT_AVATAR_PNG_BASE64}`,
        description: BOT_DESCRIPTION,
      });
      const s = stored();
      if (s) settings.setValue(DISCORD_KEY, { ...s, brandVersion: BRAND_VERSION } satisfies StoredDiscord);
      state.brandError = null;
    } catch (err) {
      // Discord limits picture changes; the next start tries again.
      state.brandError = errorMessage(err);
      log.warn({ err: state.brandError }, 'discord profile update failed');
    }
  };

  /**
   * The bot is on a server now: everyone whose welcome could not be delivered (no shared server yet) gets it now,
   * so linking always ends with a message from the bot.
   */
  const retryWelcomes = (): void => {
    [...dmErrors.entries()]
      .filter(([, failure]) => failure.blocked)
      .forEach(([discordId]) => {
        void deliverDm(discordId, WELCOME);
      });
  };

  const start = (): void => {
    state.disconnect?.();
    state.disconnect = null;
    const t = token();
    const s = stored();
    if (!t || !s) return;
    // Panels set up before /verbinden worked everywhere get the new command once at start.
    void quietly(() => api.registerCommands(t, s.appId), 'discord command update failed');
    if ((s.brandVersion ?? 0) < BRAND_VERSION) void brand(t);
    state.disconnect = api.connect(
      t,
      onInteraction,
      (online, error) => {
        state.online = online;
        state.error = error;
      },
      retryWelcomes,
    );
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
        serverInstallUrl: serverInstallUrl(),
        lastDmError: user.discordId ? (dmErrors.get(user.discordId) ?? null) : null,
      },
      emailSet: Boolean(user.email),
    };
  };

  const fresh = (user: UserRow): UserRow =>
    db.select().from(users).where(eq(users.id, user.id)).get() ?? user;

  const tell: NotifyService['tell'] = (people, topic, notice) => {
    const t = token();
    // Whatever does not go out lands in the outbox with the reason, so a missing message can be explained.
    const skipped = (channel: 'mail' | 'discord', person: UserRow, subject: string, detail: string): void =>
      mail.note({ channel, to: person.username, subject, ok: false, detail });
    people
      .filter((person) => !person.disabled)
      .forEach((person) => {
        const n = notice(person);
        const subject = n.discord.title;
        if (!wantsNotice(person.notify, topic)) {
          skipped('discord', person, subject, `${person.username} hat diese Benachrichtigung ausgeschaltet`);
          return;
        }
        if (n.mail && !person.email) skipped('mail', person, subject, 'Keine E-Mail-Adresse im Konto');
        if (n.mail && person.email && !wantsNotice(person.notify, 'email'))
          skipped('mail', person, subject, 'Mails sind in den Benachrichtigungen ausgeschaltet');
        if (n.mail && person.email && wantsNotice(person.notify, 'email'))
          mail.deliver(person.email, n.mail.kind, person.locale, {
            name: person.displayName || person.username,
            ...n.mail.vars,
          });
        if (!t) return;
        if (!person.discordId) {
          skipped(
            'discord',
            person,
            subject,
            `${person.username} hat Discord nicht verbunden (Mein Konto → Benachrichtigungen)`,
          );
          return;
        }
        if (!wantsNotice(person.notify, 'discord')) {
          skipped('discord', person, subject, 'Discord ist in den Benachrichtigungen ausgeschaltet');
          return;
        }
        void (async () => {
          const failure = await deliverDm(person.discordId ?? '', n.discord);
          mail.note({
            channel: 'discord',
            to: person.username,
            subject,
            ok: !failure,
            detail: failure
              ? failure.blocked
                ? 'Discord lässt die Nachricht nicht durch: Bot auf einen gemeinsamen Server holen'
                : failure.message
              : 'zugestellt',
          });
        })();
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
    peekClaim: (token) => {
      const entry = claims.get(token);
      if (!entry || entry.expires < Date.now()) throw badRequest('discord_link_expired');
      return { name: entry.name };
    },
    claim: async (user, token) => {
      const entry = claims.get(token);
      claims.delete(token);
      if (!entry || entry.expires < Date.now()) throw badRequest('discord_link_expired');
      linkAccount(user.id, entry.discordId, entry.name);
      return { name: entry.name, dm: await deliverDm(entry.discordId, WELCOME) };
    },
    linkCode: (user) => {
      [...codes].filter(([, e]) => e.userId === user.id).forEach(([code]) => codes.delete(code));
      const code = String(randomInt(CODE_MIN, CODE_MAX));
      const expires = Date.now() + LINK_TTL_MS;
      codes.set(code, { userId: user.id, expires });
      return { code, expiresAt: new Date(expires).toISOString() };
    },
    testDm: async (user) => {
      const t = token();
      const person = fresh(user);
      if (!t) throw badRequest('discord_not_configured');
      if (!person.discordId) throw badRequest('discord_not_linked');
      const failure = await deliverDm(person.discordId, {
        title: '🎉 Test-Nachricht',
        text: `Hallo ${person.displayName || person.username}, das hat geklappt! Ab jetzt bekommst du deine MorniHosting-Benachrichtigungen hier.`,
        colour: COLOUR_INFO,
      });
      if (failure?.blocked) throw badRequest('discord_dm_blocked');
      if (failure) throw badRequest('discord_dm_failed', { message: failure.message });
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
