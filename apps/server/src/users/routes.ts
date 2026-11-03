import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  accessUpdateSchema,
  passwordResetSchema,
  roleInputSchema,
  userCreateSchema,
  userUpdateSchema,
  type PasswordResetResult,
  type RoleEntry,
  type UserListEntry,
} from '@mornihosting/shared';
import { actorOf, requireAdmin, toUserInfo, type UserRow } from '../auth/context.js';
import { hashPassword, randomPassword } from '../auth/passwords.js';
import type { Api, AppContext } from '../context.js';
import type { MailService } from '../mail/service.js';
import { passkeys, roles, serverAccess, servers, users } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { HTTP_NO_CONTENT } from '../lib/http-status.js';

/** Admin pages: people, what they may do on which server, and the roles that bundle those rights. */

const userParams = z.object({ userId: z.coerce.number().int().positive() });
const roleParams = z.object({ roleId: z.coerce.number().int().positive() });

type RoleRow = typeof roles.$inferSelect;

const toRole = (r: RoleRow): RoleEntry => ({
  id: r.id,
  name: r.name,
  description: r.description,
  permissions: r.permissions,
  builtIn: r.builtIn !== null,
});

export function registerUserRoutes(app: Api, ctx: AppContext, mail: MailService): void {
  const { db } = ctx;

  const userOf = (id: number): UserRow => {
    const row = db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw notFound();
    return row;
  };
  const roleOf = (id: number): RoleRow => {
    const row = db.select().from(roles).where(eq(roles.id, id)).get();
    if (!row) throw notFound();
    return row;
  };
  const usernameTaken = (username: string, exceptId?: number): boolean =>
    db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          sql`lower(${users.username}) = lower(${username})`,
          exceptId === undefined ? undefined : ne(users.id, exceptId),
        ),
      )
      .get() !== undefined;
  const emailTaken = (email: string, exceptId?: number): boolean =>
    db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = ${email.toLowerCase()}`,
          exceptId === undefined ? undefined : ne(users.id, exceptId),
        ),
      )
      .get() !== undefined;
  /** Other active administrators besides `userId`. */
  const otherAdmins = (userId: number): number =>
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isAdmin, true), eq(users.disabled, false), ne(users.id, userId)))
      .all().length;
  const listEntry = (row: UserRow): UserListEntry => ({
    ...toUserInfo(row),
    access: db
      .select({ serverId: serverAccess.serverId, roleId: serverAccess.roleId })
      .from(serverAccess)
      .where(eq(serverAccess.userId, row.id))
      .all(),
  });

  /* ---------- Users ---------- */

  app.get('/api/users', async (request) => {
    requireAdmin(request);
    return db.select().from(users).all().map(listEntry);
  });

  app.post('/api/users', { schema: { body: userCreateSchema } }, async (request) => {
    requireAdmin(request);
    const input = request.body;
    if (usernameTaken(input.username)) throw conflict('username_taken');
    if (input.email && emailTaken(input.email)) throw conflict('email_taken');
    const row = db
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName ?? '',
        passwordHash: await hashPassword(input.password),
        mustChangePassword: true,
        isAdmin: input.isAdmin,
        canCreateServers: input.isAdmin || input.canCreateServers,
        locale: input.locale,
        email: input.email ?? null,
      })
      .returning()
      .get();
    mail.welcome(row);
    ctx.audit.record(actorOf(request), 'user.create', null, { username: row.username, admin: row.isAdmin });
    return listEntry(row);
  });

  app.patch(
    '/api/users/:userId',
    { schema: { params: userParams, body: userUpdateSchema } },
    async (request) => {
      const auth = requireAdmin(request);
      const target = userOf(request.params.userId);
      const input = request.body;
      const self = target.id === auth.user.id;
      const losesAdmin = (input.isAdmin === false || input.disabled === true) && target.isAdmin;
      if (self && input.disabled) throw badRequest('cannot_disable_self');
      if (losesAdmin && otherAdmins(target.id) === 0) throw conflict('last_admin');
      if (input.email && emailTaken(input.email, target.id)) throw conflict('email_taken');
      const passwordHash = input.password ? await hashPassword(input.password) : undefined;
      db.update(users)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.isAdmin !== undefined ? { isAdmin: input.isAdmin } : {}),
          ...(input.canCreateServers !== undefined ? { canCreateServers: input.canCreateServers } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(passwordHash ? { passwordHash, mustChangePassword: target.id !== auth.user.id } : {}),
        })
        .where(eq(users.id, target.id))
        .run();
      // A new password or a locked account ends every open session of that person.
      if (passwordHash || input.disabled)
        ctx.sessions.destroyAllFor(target.id, self ? (auth.sessionId ?? undefined) : undefined);
      ctx.audit.record(actorOf(request), 'user.update', null, {
        username: target.username,
        changed: Object.keys(input).filter((k) => k !== 'password' || passwordHash),
      });
      if (input.isAdmin !== undefined || input.disabled !== undefined)
        ctx.events.emit('access.changed', { userId: target.id });
      return listEntry(userOf(target.id));
    },
  );

  app.post(
    '/api/users/:userId/reset-password',
    { schema: { params: userParams, body: passwordResetSchema } },
    async (request): Promise<PasswordResetResult> => {
      const auth = requireAdmin(request);
      const target = userOf(request.params.userId);
      // Your own password belongs on the account page, where the old one is asked first.
      if (target.id === auth.user.id) throw badRequest('cannot_reset_self');
      const password = randomPassword();
      const { removeSecondFactors } = request.body;
      db.update(users)
        .set({
          passwordHash: await hashPassword(password),
          mustChangePassword: true,
          ...(removeSecondFactors ? { totpEnabled: false, totpSecret: null } : {}),
        })
        .where(eq(users.id, target.id))
        .run();
      if (removeSecondFactors) db.delete(passkeys).where(eq(passkeys.userId, target.id)).run();
      ctx.sessions.destroyAllFor(target.id);
      ctx.audit.record(actorOf(request), 'user.password_reset', null, {
        username: target.username,
        removeSecondFactors,
      });
      return { password };
    },
  );

  app.delete('/api/users/:userId', { schema: { params: userParams } }, async (request, reply) => {
    const auth = requireAdmin(request);
    const target = userOf(request.params.userId);
    if (target.id === auth.user.id) throw badRequest('cannot_delete_self');
    if (target.isAdmin && otherAdmins(target.id) === 0) throw conflict('last_admin');
    ctx.sessions.destroyAllFor(target.id);
    db.delete(users).where(eq(users.id, target.id)).run();
    ctx.audit.record(actorOf(request), 'user.delete', null, { username: target.username });
    ctx.events.emit('access.changed', { userId: target.id });
    return reply.code(HTTP_NO_CONTENT).send();
  });

  app.put(
    '/api/users/:userId/access',
    { schema: { params: userParams, body: accessUpdateSchema } },
    async (request) => {
      requireAdmin(request);
      const target = userOf(request.params.userId);
      const entries = [...new Map(request.body.access.map((a) => [a.serverId, a])).values()];
      entries.forEach((a) => {
        if (!db.select({ id: servers.id }).from(servers).where(eq(servers.id, a.serverId)).get()) {
          throw badRequest('server_not_found');
        }
        roleOf(a.roleId);
      });
      db.transaction((tx) => {
        tx.delete(serverAccess).where(eq(serverAccess.userId, target.id)).run();
        if (entries.length) {
          tx.insert(serverAccess)
            .values(entries.map((a) => ({ userId: target.id, serverId: a.serverId, roleId: a.roleId })))
            .run();
        }
      });
      ctx.audit.record(actorOf(request), 'user.access', null, {
        username: target.username,
        servers: entries.length,
      });
      ctx.events.emit('access.changed', { userId: target.id });
      return listEntry(target);
    },
  );

  /* ---------- Roles ---------- */

  app.get('/api/roles', async (request) => {
    requireAdmin(request);
    return db.select().from(roles).all().map(toRole);
  });

  app.post('/api/roles', { schema: { body: roleInputSchema } }, async (request) => {
    requireAdmin(request);
    const row = db
      .insert(roles)
      .values({
        name: request.body.name,
        description: request.body.description,
        permissions: [...new Set(request.body.permissions)],
      })
      .returning()
      .get();
    ctx.audit.record(actorOf(request), 'role.create', null, { name: row.name, permissions: row.permissions });
    return toRole(row);
  });

  app.patch(
    '/api/roles/:roleId',
    { schema: { params: roleParams, body: roleInputSchema } },
    async (request) => {
      requireAdmin(request);
      const current = roleOf(request.params.roleId);
      if (current.builtIn) throw badRequest('builtin_role');
      const row = db
        .update(roles)
        .set({
          name: request.body.name,
          description: request.body.description,
          permissions: [...new Set(request.body.permissions)],
        })
        .where(eq(roles.id, current.id))
        .returning()
        .get();
      ctx.audit.record(actorOf(request), 'role.update', null, {
        name: row.name,
        permissions: row.permissions,
      });
      return toRole(row);
    },
  );

  app.delete('/api/roles/:roleId', { schema: { params: roleParams } }, async (request, reply) => {
    requireAdmin(request);
    const current = roleOf(request.params.roleId);
    if (current.builtIn) throw badRequest('builtin_role');
    const inUse = db.select().from(serverAccess).where(eq(serverAccess.roleId, current.id)).all().length;
    if (inUse) throw conflict('role_in_use', { count: inUse });
    db.delete(roles).where(eq(roles.id, current.id)).run();
    ctx.audit.record(actorOf(request), 'role.delete', null, { name: current.name });
    return reply.code(HTTP_NO_CONTENT).send();
  });
}
