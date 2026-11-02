import type { FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  passkeyLoginSchema,
  passkeyRegistrationSchema,
  type LoginResponse,
  type PasskeyEntry,
} from '@mornihosting/shared';
import type { Api, AppContext } from '../context.js';
import { passkeys, users } from '../db/schema.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { HTTP_NO_CONTENT } from '../lib/http-status.js';
import { actorOf, requireAuth, type AuthContext } from './context.js';
import { setSessionCookie } from './hook.js';
import { createChallengeStore, passkeyScope } from './passkeys.js';
import { loginRateLimit, meFor } from './routes.js';

/**
 * Passkeys: sign in without a password (fingerprint, face, device PIN or a security key).
 * Adding one needs a real login session; signing in with one skips the 2FA code, because a passkey
 * already is two factors in one (the device and the unlock).
 */

const RP_NAME = 'MorniHosting';
const REGISTRATION_KEY_PREFIX = 'add:';

type PasskeyRow = typeof passkeys.$inferSelect;

const toEntry = (row: PasskeyRow): PasskeyEntry => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

/** A stable WebAuthn user handle, so one device keeps one passkey per account. */
const userHandle = (userId: number): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`mh-user-${userId}`);

function sessionAuth(request: FastifyRequest): AuthContext & { readonly sessionId: string } {
  const auth = requireAuth(request);
  // An API key must not be able to add a way to sign in.
  if (auth.sessionId === null) throw forbidden('session_required');
  return { ...auth, sessionId: auth.sessionId };
}

export function registerPasskeyRoutes(app: Api, ctx: AppContext): void {
  const challenges = createChallengeStore();
  const listFor = (userId: number): PasskeyEntry[] =>
    ctx.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .orderBy(asc(passkeys.createdAt))
      .all()
      .map(toEntry);

  app.get('/api/account/passkeys', async (request) => listFor(requireAuth(request).user.id));

  app.post('/api/account/passkeys/options', async (request) => {
    const auth = sessionAuth(request);
    const scope = passkeyScope(ctx, request);
    const existing = ctx.db.select().from(passkeys).where(eq(passkeys.userId, auth.user.id)).all();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: scope.rpID,
      userName: auth.user.username,
      userDisplayName: auth.user.displayName || auth.user.username,
      userID: userHandle(auth.user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    challenges.put(REGISTRATION_KEY_PREFIX + auth.sessionId, options.challenge);
    return options;
  });

  app.post(
    '/api/account/passkeys',
    { schema: { body: passkeyRegistrationSchema } },
    async (request): Promise<PasskeyEntry[]> => {
      const auth = sessionAuth(request);
      const scope = passkeyScope(ctx, request);
      const expectedChallenge = challenges.take(REGISTRATION_KEY_PREFIX + auth.sessionId);
      if (!expectedChallenge) throw unauthorized('passkey_expired');
      const result = await (async () => {
        try {
          return await verifyRegistrationResponse({
            // Checked by the schema above; the library wants its own (structurally equal) type.
            response: request.body.response as RegistrationResponseJSON,
            expectedChallenge,
            expectedOrigin: scope.origin,
            expectedRPID: scope.rpID,
            requireUserVerification: false,
          });
        } catch (err) {
          request.log.info({ err }, 'passkey registration rejected');
          return null;
        }
      })();
      if (!result?.verified) throw unauthorized('passkey_failed');
      const { credential } = result.registrationInfo;
      ctx.db
        .insert(passkeys)
        .values({
          id: credential.id,
          userId: auth.user.id,
          name: request.body.name,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: credential.transports ?? [],
        })
        .onConflictDoNothing()
        .run();
      ctx.audit.record(actorOf(request), 'account.passkey_added', null, { name: request.body.name });
      return listFor(auth.user.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/account/passkeys/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const row = ctx.db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.id, request.params.id), eq(passkeys.userId, auth.user.id)))
      .get();
    if (!row) throw notFound('passkey_not_found');
    ctx.db.delete(passkeys).where(eq(passkeys.id, row.id)).run();
    ctx.audit.record(actorOf(request), 'account.passkey_removed', null, { name: row.name });
    return reply.code(HTTP_NO_CONTENT).send();
  });

  app.post('/api/auth/passkey/options', { config: loginRateLimit }, async (request) => {
    const scope = passkeyScope(ctx, request);
    // No user is named: the device offers its passkeys for this domain (discoverable credentials).
    const options = await generateAuthenticationOptions({ rpID: scope.rpID, userVerification: 'preferred' });
    challenges.put(options.challenge, options.challenge);
    return options;
  });

  app.post(
    '/api/auth/passkey/login',
    { schema: { body: passkeyLoginSchema }, config: loginRateLimit },
    async (request, reply): Promise<LoginResponse> => {
      const scope = passkeyScope(ctx, request);
      // Checked by the schema above; the library wants its own (structurally equal) type.
      const response = request.body.response as AuthenticationResponseJSON;
      const found = ctx.db
        .select({ passkey: passkeys, user: users })
        .from(passkeys)
        .innerJoin(users, eq(users.id, passkeys.userId))
        .where(eq(passkeys.id, response.id))
        .get();
      if (!found) throw unauthorized('passkey_unknown');
      const { passkey, user } = found;
      const result = await (async () => {
        try {
          return await verifyAuthenticationResponse({
            response,
            expectedChallenge: (challenge) => challenges.take(challenge) !== undefined,
            expectedOrigin: scope.origin,
            expectedRPID: scope.rpID,
            credential: {
              id: passkey.id,
              publicKey: Buffer.from(passkey.publicKey, 'base64url'),
              counter: passkey.counter,
              transports: passkey.transports,
            },
            requireUserVerification: false,
          });
        } catch (err) {
          request.log.info({ err }, 'passkey sign-in rejected');
          return null;
        }
      })();
      const actor = { userId: user.id, username: user.username, ip: request.ip };
      if (!result?.verified || user.disabled || user.signupPending || user.approvalPending) {
        ctx.audit.record(actor, 'auth.login_failed', null, { method: 'passkey' });
        throw unauthorized('passkey_failed');
      }
      const now = new Date().toISOString();
      ctx.db
        .update(passkeys)
        .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: now })
        .where(eq(passkeys.id, passkey.id))
        .run();
      ctx.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).run();
      const { token, session } = ctx.sessions.create(user.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        pendingTwoFactor: false,
      });
      setSessionCookie(ctx, request, reply, token);
      ctx.audit.record(actor, 'auth.login', null, { method: 'passkey', passkey: passkey.name });
      return { status: 'ok', me: meFor(ctx, { ...user, lastLoginAt: now }, session.csrfToken) };
    },
  );
}
