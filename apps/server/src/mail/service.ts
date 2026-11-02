import { and, eq, lt, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import {
  SOFTWARE,
  type ConfirmResult,
  type Locale,
  type MailAttempt,
  type MailEndpoint,
  type MailQuickInput,
  type MailQuickResult,
  type MailQuickTry,
  type MailSecurity,
  type MailSettingsInput,
  type MailSettingsView,
  type MailStatus,
  type MailTestResult,
  type RegisterResult,
  type SignupSettings,
} from '@mornihosting/shared';
import net from 'node:net';
import { hashPassword } from '../auth/passwords.js';
import type { UserRow } from '../auth/context.js';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { mailTokens, servers, users } from '../db/schema.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, errorMessage, forbidden } from '../lib/errors.js';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '../lib/units.js';
import { connectionInfo } from '../servers/connectivity.js';
import type { ServerService } from '../servers/service.js';
import { CRASH_REASONS } from '../webhooks/messages.js';
import { realNetwork, runMailCheck, SMTP_CONNECT_TIMEOUT_MS, type MailNetwork } from './check.js';
import { candidateHosts, closeness } from './quick.js';
import { formatWhen, oneLine, renderMail, type MailKind, type MailVars } from './templates.js';

/** Sending mail: the SMTP settings, one-time links, and the flows built on them (sign-up, password reset, orders). */

export interface SmtpConfig {
  readonly host: string;
  /** Address actually dialled (e.g. a LAN IP); empty means `host`. TLS is always checked against `host`. */
  readonly internalHost: string;
  readonly port: number;
  readonly security: MailSecurity;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

export interface OutgoingMail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface MailTransport {
  readonly sendMail: (mail: OutgoingMail) => Promise<unknown>;
  /** Connects and logs in without sending; transports without it count as fine. */
  readonly verify?: () => Promise<unknown>;
}
/** Tests plug in a fake transport here instead of talking to a mail server. */
export type TransportFactory = (config: SmtpConfig) => MailTransport;

interface StoredMail {
  host: string;
  /** Missing in settings saved before this field existed. */
  internalHost?: string;
  port: number;
  security: MailSecurity;
  user: string;
  passwordSealed: string;
  from: string;
  registration: boolean;
  registrationOrders: boolean;
  /** Missing in settings saved before it existed: then approval is required. */
  registrationApproval?: boolean;
  crashMails: boolean;
}

export interface MailService {
  readonly view: () => MailSettingsView;
  readonly save: (input: MailSettingsInput) => MailSettingsView;
  readonly clear: () => void;
  readonly status: () => MailStatus;
  readonly configured: () => boolean;
  readonly panelUrl: () => string | null;
  /** Sends and reports a failure to the caller (admin test). */
  readonly send: (to: string, kind: MailKind, locale: Locale, vars: Partial<MailVars>) => Promise<void>;
  /** Sends without waiting; a failure is only logged (notifications). */
  readonly deliver: (to: string, kind: MailKind, locale: Locale, vars: Partial<MailVars>) => void;
  /** Quick start: finds server, port and encryption from address + password, saves them and sends a test mail. */
  readonly quick: (
    input: MailQuickInput,
    to: string,
    locale: Locale,
    vars: Partial<MailVars>,
  ) => Promise<MailQuickResult>;
  /** Test mail, step by step; tries 465/TLS and 587/STARTTLS when the saved port does not answer and keeps what works. */
  readonly test: (to: string, locale: Locale, vars: Partial<MailVars>) => Promise<MailTestResult>;
  readonly welcome: (user: UserRow) => void;
  readonly register: (input: RegisterInput) => Promise<RegisterResult>;
  readonly signup: () => SignupSettings;
  readonly setSignup: (input: SignupSettings) => SignupSettings;
  readonly confirm: (token: string) => ConfirmResult;
  readonly forgot: (email: string) => void;
  readonly reset: (token: string, password: string, actor: Actor) => Promise<void>;
  readonly startEmailChange: (user: UserRow, email: string) => void;
  readonly init: (servers: ServerService) => void;
  readonly purgeStale: () => void;
}

export interface RegisterInput {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly locale: Locale;
  readonly ip: string;
}

const MAIL_KEY = 'mail';
/** "Konto anfragen" on the start page, on unless an admin switched it off. */
const SIGNUP_KEY = 'signup';
const SMTP_SOCKET_TIMEOUT_SECONDS = 30;
const SMTP_SOCKET_TIMEOUT_MS = SMTP_SOCKET_TIMEOUT_SECONDS * MS_PER_SECOND;
/** Tried in this order when the saved port/encryption gets no answer. */
const FALLBACKS: readonly MailEndpoint[] = [
  { port: 465, security: 'tls' }, // eslint-disable-line ts-patterns/no-magic-numbers -- SMTP with implicit TLS
  { port: 587, security: 'starttls' }, // eslint-disable-line ts-patterns/no-magic-numbers -- SMTP submission
];
/** Problems a different port or encryption can fix; a wrong password or a bad certificate cannot. */
const PORT_PROBLEMS = new Set(['port_closed', 'timeout', 'wrong_security']);
const SIGNUP_TTL_MS = MS_PER_DAY;
const RESET_TTL_MS = MS_PER_HOUR;
const RESEND_AFTER_MS = MS_PER_MINUTE;
const TOKEN_BYTES = 32;
const CRASH_MAIL_GAP_MS = 15 * MS_PER_MINUTE;
const MB_PER_GB = 1024;
const SMTP_ERROR_MAX = 200;
const LOG_ADDRESS_VISIBLE = 2;

const defaultSender = (domain: string): string => `MorniHosting <noreply@${domain || 'localhost'}>`;

const planText = (memoryMb: number): string =>
  memoryMb >= MB_PER_GB ? `${Number((memoryMb / MB_PER_GB).toFixed(1))} GB RAM` : `${memoryMb} MB RAM`;

const realTransport: TransportFactory = (config) =>
  nodemailer.createTransport({
    host: config.internalHost || config.host,
    port: config.port,
    // Dialling an IP: SNI and the certificate check still use the real name. Verification is never switched off.
    ...(config.internalHost && !net.isIP(config.host) ? { tls: { servername: config.host } } : {}),
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: SMTP_CONNECT_TIMEOUT_MS,
    greetingTimeout: SMTP_CONNECT_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  });

export function createMailService(
  ctx: AppContext,
  factory: TransportFactory = realTransport,
  network: MailNetwork = realNetwork,
): MailService {
  const { db, settings, secrets, log } = ctx;

  const stored = (): StoredMail | undefined => settings.getValue<StoredMail>(MAIL_KEY);
  const configured = (): boolean => stored() !== undefined;
  const panelUrl = (): string | null => {
    const domain = settings.get().panelDomain;
    return domain ? `https://${domain}` : null;
  };
  const localeOf = (user: UserRow): Locale => user.locale;
  const nameOf = (user: UserRow): string => oneLine(user.displayName || user.username);

  const view = (): MailSettingsView => {
    const s = stored();
    return {
      configured: s !== undefined,
      passwordSet: Boolean(s?.passwordSealed),
      linksPossible: panelUrl() !== null,
      host: s?.host ?? '',
      internalHost: s?.internalHost ?? '',
      port: s?.port ?? 587, // eslint-disable-line ts-patterns/no-magic-numbers -- the standard submission port
      security: s?.security ?? 'starttls',
      user: s?.user ?? '',
      from: s?.from ?? defaultSender(settings.get().panelDomain),
      registration: signup().enabled,
      registrationOrders: s?.registrationOrders ?? false,
      registrationApproval: s?.registrationApproval ?? true,
      crashMails: s?.crashMails ?? false,
    };
  };

  const mailReady = (): boolean => configured() && panelUrl() !== null;
  const signup = (): SignupSettings =>
    settings.getValue<SignupSettings>(SIGNUP_KEY) ?? { enabled: stored()?.registration ?? true };

  const status = (): MailStatus => ({ registration: signup().enabled, passwordReset: mailReady() });

  const smtp = (): SmtpConfig => {
    const s = stored();
    if (!s) throw badRequest('mail_not_configured');
    return {
      host: s.host,
      internalHost: s.internalHost ?? '',
      port: s.port,
      security: s.security,
      user: s.user,
      password: s.passwordSealed ? secrets.decrypt(s.passwordSealed) : '',
      from: s.from,
    };
  };

  const send: MailService['send'] = async (to, kind, locale, vars) => {
    const config = smtp();
    const message = renderMail(kind, locale, {
      name: '',
      link: null,
      host: settings.get().panelDomain || null,
      ...vars,
    });
    try {
      await factory(config).sendMail({ from: config.from, to, ...message });
    } catch (err) {
      log.warn({ err, kind }, 'mail could not be sent');
      throw badRequest('mail_failed', { message: oneLine(errorMessage(err)).slice(0, SMTP_ERROR_MAX) });
    }
  };

  const test: MailService['test'] = async (to, locale, vars) => {
    const saved = smtp();
    const message = renderMail('test', locale, {
      name: '',
      link: null,
      host: settings.get().panelDomain || null,
      ...vars,
    });
    const check = (config: SmtpConfig, withSend: boolean) => {
      const transport = factory(config);
      return runMailCheck(
        config,
        network,
        {
          verify: () => transport.verify?.() ?? Promise.resolve(true),
          send: () => transport.sendMail({ from: config.from, to, ...message }),
        },
        withSend,
      );
    };
    const first = await check(saved, true);
    const attempts: MailAttempt[] = [{ port: saved.port, security: saved.security, problem: first.problem }];
    const result = (outcome: typeof first, switchedTo: MailEndpoint | null): MailTestResult => ({
      ok: outcome.problem === null,
      sentTo: to,
      steps: outcome.steps,
      problem: outcome.problem,
      message: outcome.message,
      attempts,
      switchedTo,
    });
    if (first.problem === null || !PORT_PROBLEMS.has(first.problem)) return result(first, null);

    const others = FALLBACKS.filter((e) => e.port !== saved.port || e.security !== saved.security);
    const probes = await Promise.all(others.map((e) => check({ ...saved, ...e }, false)));
    const problems = probes.map((probe) => probe.problem);
    others.forEach((e, i) => attempts.push({ ...e, problem: problems[i] ?? null }));
    const found = others.find((_, i) => problems[i] === null);
    if (!found) return result(first, null);

    const s = stored();
    if (s)
      settings.setValue(MAIL_KEY, { ...s, port: found.port, security: found.security } satisfies StoredMail);
    log.info({ port: found.port, security: found.security }, 'mail: switched to a port that answers');
    return result(await check({ ...saved, ...found }, true), found);
  };

  const quick: MailService['quick'] = async (input, to, locale, vars) => {
    const hosts = await candidateHosts(input.email, input.internalHost, network);
    const configs: SmtpConfig[] = hosts.flatMap((host) =>
      FALLBACKS.map((endpoint) => ({
        host,
        internalHost: input.internalHost,
        ...endpoint,
        user: input.email,
        password: input.password,
        from: `MorniHosting <${input.email}>`,
      })),
    );
    const outcomes = await Promise.all(
      configs.map((config) => {
        const transport = factory(config);
        return runMailCheck(
          config,
          network,
          {
            verify: () => transport.verify?.() ?? Promise.resolve(true),
            send: () => Promise.resolve(true),
          },
          false,
        );
      }),
    );
    const tried: MailQuickTry[] = configs.map((c, i) => ({
      host: c.host,
      port: c.port,
      security: c.security,
      problem: outcomes[i]?.problem ?? null,
    }));
    const winner = configs.find((_, i) => outcomes[i]?.problem === null);
    if (!winner) {
      const best = outcomes
        .map((outcome, i) => ({ outcome, i }))
        .toSorted((a, b) => closeness(a.outcome.problem) - closeness(b.outcome.problem))[0];
      const at = best ? tried[best.i] : undefined;
      return {
        found: null,
        tried,
        test: null,
        closest: best && at ? { ...at, steps: best.outcome.steps, message: best.outcome.message } : null,
      };
    }
    const previous = view();
    settings.setValue(MAIL_KEY, {
      host: winner.host,
      internalHost: winner.internalHost,
      port: winner.port,
      security: winner.security,
      user: winner.user,
      passwordSealed: secrets.encrypt(input.password),
      from: previous.configured ? previous.from : winner.from,
      registration: previous.registration,
      registrationOrders: previous.registrationOrders,
      registrationApproval: previous.registrationApproval,
      crashMails: previous.crashMails,
    } satisfies StoredMail);
    log.info({ host: winner.host, port: winner.port }, 'mail: quick start found a server');
    const found = { host: winner.host, port: winner.port, security: winner.security };
    return { found, tried, test: await test(to, locale, vars), closest: null };
  };

  /** Mails nobody waits for: a failure is logged, never shown to (or timed for) the visitor. */
  const sendQuietly = (to: string, kind: MailKind, locale: Locale, vars: Partial<MailVars>): void => {
    if (!configured()) return;
    send(to, kind, locale, vars).catch((err: unknown) => {
      log.warn({ err, kind, to: `${to.slice(0, LOG_ADDRESS_VISIBLE)}…` }, 'mail dropped');
    });
  };

  /* ---------- One-time links ---------- */

  type Purpose = typeof mailTokens.$inferSelect.purpose;

  const issue = (userId: number, purpose: Purpose, ttlMs: number, email: string | null = null): string => {
    const token = randomToken(TOKEN_BYTES);
    db.delete(mailTokens)
      .where(and(eq(mailTokens.userId, userId), eq(mailTokens.purpose, purpose)))
      .run();
    db.insert(mailTokens)
      .values({
        userId,
        purpose,
        tokenHash: sha256Hex(token),
        email,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      })
      .run();
    return token;
  };

  /** A recent link for this person and purpose already went out: do not send another one right away. */
  const justIssued = (userId: number, purpose: Purpose, ttlMs: number): boolean => {
    const row = db
      .select({ expiresAt: mailTokens.expiresAt })
      .from(mailTokens)
      .where(and(eq(mailTokens.userId, userId), eq(mailTokens.purpose, purpose)))
      .get();
    return row !== undefined && Date.parse(row.expiresAt) - Date.now() > ttlMs - RESEND_AFTER_MS;
  };

  /** Finds the link, deletes it (one use only) and returns it; undefined when unknown, used or expired. */
  const consume = (
    token: string,
    purposes: readonly Purpose[],
  ): typeof mailTokens.$inferSelect | undefined => {
    const row = db
      .select()
      .from(mailTokens)
      .where(eq(mailTokens.tokenHash, sha256Hex(token)))
      .get();
    if (!row) return undefined;
    db.delete(mailTokens).where(eq(mailTokens.id, row.id)).run();
    return purposes.includes(row.purpose) && Date.parse(row.expiresAt) > Date.now() ? row : undefined;
  };

  const linkTo = (path: string, token?: string): string | null => {
    const base = panelUrl();
    if (!base) return null;
    return token ? `${base}${path}?token=${encodeURIComponent(token)}` : `${base}${path}`;
  };

  const userByEmail = (email: string): UserRow | undefined =>
    db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .get();

  /* ---------- Flows ---------- */

  const purgeStale = (): void => {
    const cutoff = new Date(Date.now() - SIGNUP_TTL_MS).toISOString();
    db.delete(users)
      .where(and(eq(users.signupPending, true), lt(users.createdAt, cutoff)))
      .run();
    db.delete(mailTokens).where(lt(mailTokens.expiresAt, new Date().toISOString())).run();
  };

  const register: MailService['register'] = async (input) => {
    if (!status().registration) throw forbidden('registration_closed');
    purgeStale();
    const taken = db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${input.username.toLowerCase()}`)
      .get();
    if (taken) throw conflict('username_taken');
    const existing = userByEmail(input.email);
    // Without mail nobody can confirm an address: the request goes straight to the admins.
    if (!mailReady()) {
      if (existing) return { next: 'wait_approval' };
      const row = db
        .insert(users)
        .values({
          username: input.username,
          email: input.email,
          passwordHash: await hashPassword(input.password),
          locale: input.locale,
          approvalPending: true,
          canCreateServers: stored()?.registrationOrders ?? false,
        })
        .returning()
        .get();
      ctx.audit.record({ userId: row.id, username: row.username, ip: input.ip }, 'auth.register');
      ctx.events.emit('user.awaiting_approval', { userId: row.id });
      return { next: 'wait_approval' };
    }
    if (existing) {
      // Same answer as for a new address: nobody can find out which addresses have an account.
      if (existing.signupPending) {
        if (!justIssued(existing.id, 'register', SIGNUP_TTL_MS)) {
          const token = issue(existing.id, 'register', SIGNUP_TTL_MS);
          sendQuietly(input.email, 'register', existing.locale, {
            name: nameOf(existing),
            link: linkTo('/verify', token),
          });
        }
      } else {
        sendQuietly(input.email, 'already_registered', localeOf(existing), {
          name: nameOf(existing),
          link: linkTo('/'),
        });
      }
      return { next: 'verify_email' };
    }
    const row = db
      .insert(users)
      .values({
        username: input.username,
        email: input.email,
        passwordHash: await hashPassword(input.password),
        locale: input.locale,
        signupPending: true,
        approvalPending: stored()?.registrationApproval ?? true,
        canCreateServers: stored()?.registrationOrders ?? false,
      })
      .returning()
      .get();
    ctx.audit.record({ userId: row.id, username: row.username, ip: input.ip }, 'auth.register');
    sendQuietly(input.email, 'register', input.locale, {
      name: row.username,
      link: linkTo('/verify', issue(row.id, 'register', SIGNUP_TTL_MS)),
    });
    return { next: 'verify_email' };
  };

  const confirm: MailService['confirm'] = (token) => {
    const row = consume(token, ['register', 'email_change']);
    if (!row) throw badRequest('link_invalid');
    const user = db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user) throw badRequest('link_invalid');
    if (row.purpose === 'register') {
      db.update(users).set({ signupPending: false }).where(eq(users.id, user.id)).run();
      ctx.audit.record({ userId: user.id, username: user.username, ip: null }, 'auth.email_confirmed');
      if (!user.approvalPending) return { kind: 'register' };
      ctx.events.emit('user.awaiting_approval', { userId: user.id });
      return { kind: 'register_pending' };
    }
    const other = row.email ? userByEmail(row.email) : undefined;
    if (!row.email || (other && other.id !== user.id)) throw conflict('email_taken');
    db.update(users).set({ email: row.email }).where(eq(users.id, user.id)).run();
    ctx.audit.record({ userId: user.id, username: user.username, ip: null }, 'account.email_changed');
    return { kind: 'email_change' };
  };

  const forgot: MailService['forgot'] = (email) => {
    if (!status().passwordReset) throw forbidden('reset_unavailable');
    const user = userByEmail(email);
    if (!user || user.disabled || user.signupPending) return;
    if (justIssued(user.id, 'password_reset', RESET_TTL_MS)) return;
    sendQuietly(email, 'password_reset', localeOf(user), {
      name: nameOf(user),
      link: linkTo('/reset', issue(user.id, 'password_reset', RESET_TTL_MS)),
    });
  };

  const reset: MailService['reset'] = async (token, password, actor) => {
    const row = consume(token, ['password_reset']);
    const user = row ? db.select().from(users).where(eq(users.id, row.userId)).get() : undefined;
    if (!row || !user || user.disabled) throw badRequest('link_invalid');
    db.update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, user.id))
      .run();
    db.delete(mailTokens).where(eq(mailTokens.userId, user.id)).run();
    ctx.sessions.destroyAllFor(user.id);
    ctx.audit.record({ ...actor, userId: user.id, username: user.username }, 'auth.password_forgotten');
  };

  const startEmailChange: MailService['startEmailChange'] = (user, email) => {
    if (!configured() || !panelUrl()) throw badRequest('mail_not_configured');
    const owner = userByEmail(email);
    if (owner && owner.id !== user.id) throw conflict('email_taken');
    if (owner) return;
    const token = issue(user.id, 'email_change', SIGNUP_TTL_MS, email);
    sendQuietly(email, 'email_change', localeOf(user), {
      name: nameOf(user),
      link: linkTo('/verify', token),
    });
  };

  const welcome: MailService['welcome'] = (user) => {
    if (!user.email) return;
    sendQuietly(user.email, 'welcome', localeOf(user), {
      name: nameOf(user),
      username: user.username,
      link: linkTo('/'),
    });
  };

  /* ---------- Orders and crashes ---------- */

  const init: MailService['init'] = (serverService) => {
    const lastCrashMail = new Map<string, number>();
    ctx.events.on('server.created', ({ serverId, userId }) => {
      void (async () => {
        const user = db.select().from(users).where(eq(users.id, userId)).get();
        const row = db.select().from(servers).where(eq(servers.id, serverId)).get();
        if (!user?.email || !row || !configured()) return;
        const info = await connectionInfo(serverService.row(serverId), settings);
        const host = info.domain ?? info.publicIp ?? info.lanIp;
        const named = Boolean(row.domain) && info.domain !== null;
        const address = host && (named && row.edition === 'java' ? host : `${host}:${info.sharePort}`);
        sendQuietly(user.email, 'server_ordered', localeOf(user), {
          name: nameOf(user),
          server: row.name,
          plan: planText(row.memoryMb),
          software: `${SOFTWARE[row.software].label} ${row.version}`,
          address: address || null,
          when: formatWhen(localeOf(user), new Date()),
          link: linkTo(`/servers/${serverId}`),
        });
      })().catch((err: unknown) => log.warn({ err }, 'order mail failed'));
    });
    ctx.events.on('server.crashed', ({ serverId, crash }) => {
      if (!stored()?.crashMails) return;
      const last = lastCrashMail.get(serverId) ?? 0;
      if (Date.now() - last < CRASH_MAIL_GAP_MS) return;
      lastCrashMail.set(serverId, Date.now());
      const row = db.select().from(servers).where(eq(servers.id, serverId)).get();
      if (!row) return;
      db.select()
        .from(users)
        .where(and(eq(users.isAdmin, true), eq(users.disabled, false)))
        .all()
        .filter((admin) => admin.email)
        .forEach((admin) =>
          sendQuietly(admin.email ?? '', 'server_crashed', localeOf(admin), {
            name: nameOf(admin),
            server: row.name,
            reason: CRASH_REASONS[localeOf(admin)][crash.ruleId] ?? crash.ruleId,
            when: formatWhen(localeOf(admin), new Date()),
            link: linkTo(`/servers/${serverId}`),
          }),
        );
    });
  };

  return {
    view,
    save: (input) => {
      const previous = stored();
      const passwordSealed = input.password
        ? secrets.encrypt(input.password)
        : (previous?.passwordSealed ?? '');
      settings.setValue(SIGNUP_KEY, { enabled: input.registration } satisfies SignupSettings);
      settings.setValue(MAIL_KEY, {
        host: input.host,
        internalHost: input.internalHost,
        port: input.port,
        security: input.security,
        user: input.user,
        passwordSealed,
        from: input.from,
        registration: input.registration,
        registrationOrders: input.registrationOrders,
        registrationApproval: input.registrationApproval,
        crashMails: input.crashMails,
      } satisfies StoredMail);
      return view();
    },
    clear: () => settings.deleteValue(MAIL_KEY),
    status,
    configured,
    panelUrl,
    send,
    deliver: sendQuietly,
    quick,
    test,
    welcome,
    register,
    signup,
    setSignup: (input) => {
      settings.setValue(SIGNUP_KEY, input);
      return signup();
    },
    confirm,
    forgot,
    reset,
    startEmailChange,
    init,
    purgeStale,
  };
}
