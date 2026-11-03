import { count, eq, sql } from 'drizzle-orm';
import {
  accountUpdateSchema,
  loginInputSchema,
  passwordChangeSchema,
  setupInputSchema,
  twoFactorDisableSchema,
  twoFactorInputSchema,
  type LoginResponse,
  type MeResponse,
  type SystemStatus,
} from '@mornihosting/shared';
import type { Api, AppContext } from '../context.js';
import type { MailService } from '../mail/service.js';
import { users } from '../db/schema.js';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import { HTTP_FORBIDDEN, HTTP_NO_CONTENT } from '../lib/http-status.js';
import { actorOf, requireAuth, toUserInfo, type UserRow } from './context.js';
import { clearSessionCookie, pendingSession, setSessionCookie } from './hook.js';
import { passkeySupport } from './passkeys.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './passwords.js';
import { newTotpSecret, totpSetupData, verifyTotp } from './totp.js';

const LOGIN_LIMIT = 10;
const LOGIN_WINDOW = '1 minute';
export const loginRateLimit = { rateLimit: { max: LOGIN_LIMIT, timeWindow: LOGIN_WINDOW } };

export function meFor(ctx: AppContext, user: UserRow, csrfToken: string): MeResponse {
  return { user: toUserInfo(user), csrfToken, access: ctx.access.accessMap(user) };
}

function userCount(ctx: AppContext): number {
  return ctx.db.select({ n: count() }).from(users).get()?.n ?? 0;
}

/** By user name, or by e-mail address when the input has an "@" (user names cannot contain one). */
function findUser(ctx: AppContext, username: string): UserRow | undefined {
  const column = username.includes('@') ? users.email : users.username;
  return ctx.db
    .select()
    .from(users)
    .where(eq(sql`lower(${column})`, username.toLowerCase()))
    .get();
}

export function registerAuthRoutes(app: Api, ctx: AppContext, mail: MailService): void {
  app.get('/api/system/status', async (request): Promise<SystemStatus> => {
    const docker = await (async () => {
      try {
        await ctx.docker.ping();
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    })();
    return {
      setupRequired: !userCount(ctx),
      version: ctx.config.version,
      docker,
      demo: ctx.config.demo,
      defaultLocale: ctx.settings.get().defaultLocale,
      passkeys: passkeySupport(ctx, request),
      panelDomain: ctx.settings.get().panelDomain || null,
      mail: mail.status(),
    };
  });

  app.post(
    '/api/setup',
    { schema: { body: setupInputSchema }, config: loginRateLimit },
    async (request, reply) => {
      if (userCount(ctx)) throw conflict('setup_done');
      const { username, password, locale } = request.body;
      const inserted = ctx.db
        .insert(users)
        .values({
          username,
          passwordHash: await hashPassword(password),
          isAdmin: true,
          canCreateServers: true,
          locale,
        })
        .returning()
        .get();
      ctx.settings.update({ defaultLocale: locale });
      const { token, session } = ctx.sessions.create(inserted.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        pendingTwoFactor: false,
      });
      setSessionCookie(ctx, request, reply, token);
      ctx.audit.record({ userId: inserted.id, username, ip: request.ip }, 'setup.complete');
      return meFor(ctx, inserted, session.csrfToken);
    },
  );

  app.post(
    '/api/auth/login',
    { schema: { body: loginInputSchema }, config: loginRateLimit },
    async (request, reply) => {
      const { username, password } = request.body;
      const user = findUser(ctx, username);
      if (!user) {
        await burnPasswordCheck(password);
        throw unauthorized('invalid_credentials');
      }
      const valid = await verifyPassword(user.passwordHash, password);
      if (!valid || user.disabled) {
        ctx.audit.record({ userId: user.id, username: user.username, ip: request.ip }, 'auth.login_failed');
        throw unauthorized('invalid_credentials');
      }
      // Only after the right password, so the message does not tell strangers which names exist.
      if (user.signupPending) throw new AppError(HTTP_FORBIDDEN, 'email_unconfirmed');
      if (user.approvalPending) throw new AppError(HTTP_FORBIDDEN, 'account_pending_approval');
      const pending = user.totpEnabled;
      const { token, session } = ctx.sessions.create(user.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        pendingTwoFactor: pending,
      });
      setSessionCookie(ctx, request, reply, token);
      if (pending) return { status: 'two-factor' } satisfies LoginResponse;
      const now = new Date().toISOString();
      ctx.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).run();
      ctx.audit.record({ userId: user.id, username: user.username, ip: request.ip }, 'auth.login');
      return {
        status: 'ok',
        me: meFor(ctx, { ...user, lastLoginAt: now }, session.csrfToken),
      } satisfies LoginResponse;
    },
  );

  app.post(
    '/api/auth/two-factor',
    { schema: { body: twoFactorInputSchema }, config: loginRateLimit },
    async (request): Promise<LoginResponse> => {
      const pending = pendingSession(request);
      if (!pending) throw unauthorized('no_pending_login');
      const user = ctx.db.select().from(users).where(eq(users.id, pending.userId)).get();
      if (!user?.totpSecret || !verifyTotp(ctx.secrets.decrypt(user.totpSecret), request.body.code)) {
        ctx.audit.record(
          { userId: pending.userId, username: user?.username ?? null, ip: request.ip },
          'auth.two_factor_failed',
        );
        throw unauthorized('invalid_code');
      }
      const session = ctx.sessions.completeTwoFactor(pending.id);
      const now = new Date().toISOString();
      ctx.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).run();
      ctx.audit.record({ userId: user.id, username: user.username, ip: request.ip }, 'auth.login');
      return { status: 'ok', me: meFor(ctx, { ...user, lastLoginAt: now }, session.csrfToken) };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = requireAuthOrPending(request);
    if (auth) ctx.sessions.destroy(auth);
    clearSessionCookie(reply);
    return reply.code(HTTP_NO_CONTENT).send();
  });

  function requireAuthOrPending(request: Parameters<typeof pendingSession>[0]): string | null {
    const pending = pendingSession(request);
    if (pending) return pending.id;
    try {
      return requireAuth(request).sessionId;
    } catch {
      return null;
    }
  }

  app.get('/api/auth/me', async (request): Promise<MeResponse> => {
    const auth = requireAuth(request);
    return meFor(ctx, auth.user, auth.csrfToken ?? '');
  });

  app.patch(
    '/api/account',
    { schema: { body: accountUpdateSchema } },
    async (request): Promise<MeResponse> => {
      const auth = requireAuth(request);
      const patch = Object.fromEntries(Object.entries(request.body).filter(([, v]) => v !== undefined));
      ctx.db.update(users).set(patch).where(eq(users.id, auth.user.id)).run();
      const user = ctx.db.select().from(users).where(eq(users.id, auth.user.id)).get() ?? auth.user;
      return meFor(ctx, user, auth.csrfToken ?? '');
    },
  );

  app.post(
    '/api/account/password',
    { schema: { body: passwordChangeSchema }, config: loginRateLimit },
    async (request, reply) => {
      const auth = requireAuth(request);
      if (!(await verifyPassword(auth.user.passwordHash, request.body.current)))
        throw badRequest('wrong_password');
      ctx.db
        .update(users)
        .set({ passwordHash: await hashPassword(request.body.next), mustChangePassword: false })
        .where(eq(users.id, auth.user.id))
        .run();
      ctx.sessions.destroyAllFor(auth.user.id, auth.sessionId ?? undefined);
      ctx.audit.record(actorOf(request), 'account.password_changed');
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  app.post('/api/account/two-factor/setup', async (request) => {
    const auth = requireAuth(request);
    if (auth.user.totpEnabled) throw conflict('two_factor_active');
    const secret = newTotpSecret();
    ctx.db
      .update(users)
      .set({ totpSecret: ctx.secrets.encrypt(secret) })
      .where(eq(users.id, auth.user.id))
      .run();
    return totpSetupData(secret, auth.user.username);
  });

  app.post('/api/account/two-factor/enable', { schema: { body: twoFactorInputSchema } }, async (request) => {
    const auth = requireAuth(request);
    const sealed = auth.user.totpSecret;
    if (!sealed || !verifyTotp(ctx.secrets.decrypt(sealed), request.body.code))
      throw badRequest('invalid_code');
    ctx.db.update(users).set({ totpEnabled: true }).where(eq(users.id, auth.user.id)).run();
    ctx.audit.record(actorOf(request), 'account.two_factor_enabled');
    return { enabled: true };
  });

  app.post(
    '/api/account/two-factor/disable',
    { schema: { body: twoFactorDisableSchema } },
    async (request) => {
      const auth = requireAuth(request);
      const sealed = auth.user.totpSecret;
      const passwordOk = await verifyPassword(auth.user.passwordHash, request.body.password);
      if (!passwordOk || !sealed || !verifyTotp(ctx.secrets.decrypt(sealed), request.body.code)) {
        throw new AppError(HTTP_FORBIDDEN, 'invalid_code');
      }
      ctx.db
        .update(users)
        .set({ totpEnabled: false, totpSecret: null })
        .where(eq(users.id, auth.user.id))
        .run();
      ctx.audit.record(actorOf(request), 'account.two_factor_disabled');
      return { enabled: false };
    },
  );
}
