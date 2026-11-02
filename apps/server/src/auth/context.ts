import type { FastifyRequest } from 'fastify';
import type { UserInfo } from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { users } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export type UserRow = typeof users.$inferSelect;

export interface AuthContext {
  readonly user: UserRow;
  readonly sessionId: string | null;
  readonly csrfToken: string | null;
  readonly tokenId: number | null;
}

/** Request-scoped auth, kept beside the request instead of on it. */
const authByRequest = new WeakMap<FastifyRequest, AuthContext>();

export function setAuth(request: FastifyRequest, auth: AuthContext): void {
  authByRequest.set(request, auth);
}

export function getAuth(request: FastifyRequest): AuthContext | undefined {
  return authByRequest.get(request);
}

export function requireAuth(request: FastifyRequest): AuthContext {
  const auth = authByRequest.get(request);
  if (!auth) throw unauthorized();
  return auth;
}

export function requireAdmin(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (!auth.user.isAdmin) throw forbidden('admin_only');
  return auth;
}

export function actorOf(request: FastifyRequest): Actor {
  const auth = authByRequest.get(request);
  return { userId: auth?.user.id ?? null, username: auth?.user.username ?? null, ip: request.ip };
}

export function toUserInfo(row: UserRow): UserInfo {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName || row.username,
    isAdmin: row.isAdmin,
    canCreateServers: row.isAdmin || row.canCreateServers,
    locale: row.locale,
    theme: row.theme,
    totpEnabled: row.totpEnabled,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    disabled: row.disabled,
    minecraft:
      row.minecraftName && row.minecraftUuid ? { name: row.minecraftName, uuid: row.minecraftUuid } : null,
    email: row.email,
    approvalPending: row.approvalPending,
  };
}
