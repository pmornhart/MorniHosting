import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { apiTokens, users } from '../db/schema.js';
import { sha256Hex, safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { HTTP_FORBIDDEN } from '../lib/http-status.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../lib/units.js';
import { setAuth } from './context.js';
import { SESSION_COOKIE, SESSION_TTL_MS, type SessionRow } from './sessions.js';

const UNSAFE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
const BEARER_PREFIX = 'Bearer ';
export const API_TOKEN_PREFIX = 'mh_';
const CSRF_HEADER = 'x-csrf-token';
/** Paths that work before anyone is logged in; they are still protected by the origin check. */
const CSRF_EXEMPT: readonly string[] = [
  '/api/auth/login',
  '/api/setup',
  '/api/auth/two-factor',
  '/api/auth/logout',
  '/api/auth/passkey/options',
  '/api/auth/passkey/login',
  '/api/auth/register',
  '/api/auth/confirm',
  '/api/auth/forgot',
  '/api/auth/reset',
];
const TOKEN_TOUCH_MS = MS_PER_MINUTE;
const HTTPS = 'https:';

/** Sessions waiting for their second factor, by request. */
const pendingByRequest = new WeakMap<FastifyRequest, SessionRow>();

export function pendingSession(request: FastifyRequest): SessionRow | undefined {
  return pendingByRequest.get(request);
}

/** True when the request arrived through the panel domain the admin entered in the admin area. */
export function onPanelDomain(ctx: AppContext, hostname: string): boolean {
  const domain = ctx.settings.get().panelDomain;
  return domain !== '' && hostname.toLowerCase() === domain;
}

/**
 * The page the request comes from, as the browser reports it (Origin; pages cannot fake it), when that page
 * is the panel domain over HTTPS. A proxy may pass on its own target address as Host (NetBird without
 * "Pass Host Header"); the Origin still names the real address.
 */
export function panelOrigin(ctx: AppContext, request: FastifyRequest): URL | null {
  const origin = request.headers.origin;
  if (!origin || !URL.canParse(origin)) return null;
  const url = new URL(origin);
  return url.protocol === HTTPS && onPanelDomain(ctx, url.hostname) ? url : null;
}

/**
 * HTTPS as the browser sees it. Behind a proxy that says so (MH_TRUST_PROXY) the protocol is known;
 * some proxies (e.g. NetBird's) do not send X-Forwarded-Proto, so the admin's panel domain counts too:
 * it is the address that is meant to be served over HTTPS.
 */
export function servedOverHttps(ctx: AppContext, request: FastifyRequest): boolean {
  return (
    request.protocol === 'https' || onPanelDomain(ctx, request.hostname) || panelOrigin(ctx, request) !== null
  );
}

function cookieSecure(ctx: AppContext, request: FastifyRequest): boolean {
  const mode = ctx.config.cookieSecure;
  return mode === 'auto' ? servedOverHttps(ctx, request) : mode === 'true';
}

export function setSessionCookie(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(ctx, request),
    path: '/',
    maxAge: SESSION_TTL_MS / MS_PER_SECOND,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Fetch metadata the browser sets itself (pages cannot fake it): "same-origin" is the panel's own page,
 * "none" a request the user started. It stays correct when a proxy rewrites the Host header.
 */
const OWN_PAGE_SITES: readonly string[] = ['same-origin', 'none'];

/**
 * Rejects cross-site requests: a browser always sends Origin on unsafe requests and WebSocket handshakes.
 * Pages from the panel's own domain count as the same site even when a proxy rewrites the Host header.
 */
export function originAllowed(ctx: AppContext, request: FastifyRequest): boolean {
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && OWN_PAGE_SITES.includes(site)) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!URL.canParse(origin)) return false;
  return new URL(origin).host === request.host || panelOrigin(ctx, request) !== null;
}

function resolveApiToken(ctx: AppContext, request: FastifyRequest, raw: string): boolean {
  const now = new Date().toISOString();
  const row = ctx.db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, sha256Hex(raw)),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
      ),
    )
    .get();
  if (!row || row.user.disabled || row.user.approvalPending) return false;
  if (!row.token.lastUsedAt || Date.now() - Date.parse(row.token.lastUsedAt) > TOKEN_TOUCH_MS) {
    ctx.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id)).run();
  }
  setAuth(request, { user: row.user, sessionId: null, csrfToken: null, tokenId: row.token.id });
  return true;
}

/** Resolves who is calling (session cookie or API token) and enforces CSRF and origin rules. */
export function createAuthHook(ctx: AppContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.url.startsWith('/api/')) return;
    const unsafe = UNSAFE_METHODS.includes(request.method);
    if (unsafe && !originAllowed(ctx, request)) throw new AppError(HTTP_FORBIDDEN, 'bad_origin');

    const authorization = request.headers.authorization;
    if (authorization?.startsWith(BEARER_PREFIX)) {
      const raw = authorization.slice(BEARER_PREFIX.length).trim();
      if (raw.startsWith(API_TOKEN_PREFIX) && resolveApiToken(ctx, request, raw)) return;
      throw new AppError(HTTP_FORBIDDEN, 'invalid_token');
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const resolved = ctx.sessions.resolve(token);
    if (!resolved) {
      clearSessionCookie(reply);
      return;
    }
    if (resolved.session.pendingTwoFactor) {
      pendingByRequest.set(request, resolved.session);
      return;
    }
    setAuth(request, {
      user: resolved.user,
      sessionId: resolved.session.id,
      csrfToken: resolved.session.csrfToken,
      tokenId: null,
    });
    const path = request.url.split('?')[0] ?? '';
    if (unsafe && !CSRF_EXEMPT.includes(path)) {
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, resolved.session.csrfToken)) {
        throw new AppError(HTTP_FORBIDDEN, 'csrf');
      }
    }
  };
}
