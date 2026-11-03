import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { teamAddSchema, teamRoleSchema, type TeamView } from '@mornihosting/shared';
import { actorOf, requireAuth, type UserRow } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import { roles, serverAccess, servers, users } from '../db/schema.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { HTTP_NO_CONTENT, HTTP_NOT_FOUND } from '../lib/http-status.js';

/**
 * Team of one server: admins and the server's owners add people (by user name or e-mail – they need an
 * account), give them a role and remove them. Only admins hand out the owner role, because owners count
 * towards the person's quota; the last owner of a server stays unless an admin changes it.
 */

const OWNER = 'owner';
const AT = '@';
const LOOKUP_LIMIT = 20;
const LOOKUP_WINDOW = '1 minute';
const serverParams = z.object({ id: z.string().min(1) });
const memberParams = z.object({ id: z.string().min(1), userId: z.coerce.number().int().positive() });

export function registerTeamRoutes(app: Api, ctx: AppContext): void {
  const { db } = ctx;

  const serverOf = (id: string) => {
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) throw notFound('server_not_found');
    return row;
  };
  const roleRow = (roleId: number) => {
    const role = db.select().from(roles).where(eq(roles.id, roleId)).get();
    if (!role) throw badRequest('role_not_found');
    return role;
  };
  const isOwnerOn = (userId: number, serverId: string): boolean =>
    db
      .select({ id: serverAccess.userId })
      .from(serverAccess)
      .innerJoin(roles, eq(roles.id, serverAccess.roleId))
      .where(
        and(eq(serverAccess.userId, userId), eq(serverAccess.serverId, serverId), eq(roles.builtIn, OWNER)),
      )
      .get() !== undefined;
  const ownersOf = (serverId: string): number =>
    db
      .select({ id: serverAccess.userId })
      .from(serverAccess)
      .innerJoin(roles, eq(roles.id, serverAccess.roleId))
      .where(and(eq(serverAccess.serverId, serverId), eq(roles.builtIn, OWNER)))
      .all().length;
  const canManage = (user: UserRow, serverId: string): boolean =>
    user.isAdmin || isOwnerOn(user.id, serverId);
  const requireManager = (user: UserRow, serverId: string): void => {
    if (!canManage(user, serverId)) throw forbidden('team_no_permission');
  };
  /** Owners may give every role but "owner"; admins every role. */
  const assertAssignable = (user: UserRow, roleId: number): void => {
    if (roleRow(roleId).builtIn === OWNER && !user.isAdmin) throw forbidden('team_owner_admin_only');
  };

  const view = (user: UserRow, serverId: string): TeamView => {
    const members = db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        roleId: roles.id,
        roleName: roles.name,
        builtIn: roles.builtIn,
      })
      .from(serverAccess)
      .innerJoin(users, eq(users.id, serverAccess.userId))
      .innerJoin(roles, eq(roles.id, serverAccess.roleId))
      .where(eq(serverAccess.serverId, serverId))
      .all()
      .map((m) => ({ ...m, you: m.userId === user.id }))
      .toSorted(
        (a, b) =>
          Number(b.builtIn === OWNER) - Number(a.builtIn === OWNER) || a.username.localeCompare(b.username),
      );
    const manage = canManage(user, serverId);
    return {
      members,
      roles: manage
        ? db
            .select()
            .from(roles)
            .all()
            .map((r) => ({
              id: r.id,
              name: r.name,
              builtIn: r.builtIn,
              permissions: r.permissions,
              assignable: user.isAdmin || r.builtIn !== OWNER,
            }))
        : [],
      canManage: manage,
    };
  };

  const changed = (userId: number): void => {
    ctx.events.emit('access.changed', { userId });
  };

  app.get(
    '/api/servers/:id/team',
    { schema: { params: serverParams } },
    async (request): Promise<TeamView> => {
      const auth = requireAuth(request);
      serverOf(request.params.id);
      ctx.access.assertAny(auth.user, request.params.id);
      return view(auth.user, request.params.id);
    },
  );

  app.post(
    '/api/servers/:id/team',
    {
      schema: { params: serverParams, body: teamAddSchema },
      config: { rateLimit: { max: LOOKUP_LIMIT, timeWindow: LOOKUP_WINDOW } },
    },
    async (request): Promise<TeamView> => {
      const auth = requireAuth(request);
      const server = serverOf(request.params.id);
      requireManager(auth.user, server.id);
      assertAssignable(auth.user, request.body.roleId);
      const who = request.body.who.toLowerCase();
      const column = who.includes(AT) ? users.email : users.username;
      const person = db
        .select()
        .from(users)
        .where(sql`lower(${column}) = ${who}`)
        .get();
      if (!person) throw new AppError(HTTP_NOT_FOUND, 'team_user_unknown', { who: request.body.who });
      if (person.id === auth.user.id) throw badRequest('team_self');
      if (person.isAdmin) throw conflict('team_user_admin', { name: person.username });
      if (person.disabled || person.approvalPending || person.signupPending)
        throw conflict('team_user_inactive', { name: person.username });
      db.insert(serverAccess)
        .values({ userId: person.id, serverId: server.id, roleId: request.body.roleId })
        .onConflictDoUpdate({
          target: [serverAccess.userId, serverAccess.serverId],
          set: { roleId: request.body.roleId },
        })
        .run();
      ctx.audit.record(actorOf(request), 'server.team_add', server.id, {
        username: person.username,
        role: roleRow(request.body.roleId).name,
      });
      changed(person.id);
      return view(auth.user, server.id);
    },
  );

  app.put(
    '/api/servers/:id/team/:userId',
    { schema: { params: memberParams, body: teamRoleSchema } },
    async (request): Promise<TeamView> => {
      const auth = requireAuth(request);
      const server = serverOf(request.params.id);
      requireManager(auth.user, server.id);
      assertAssignable(auth.user, request.body.roleId);
      const { userId } = request.params;
      if (
        !db
          .select()
          .from(serverAccess)
          .where(and(eq(serverAccess.serverId, server.id), eq(serverAccess.userId, userId)))
          .get()
      )
        throw notFound('team_member_unknown');
      const losesOwner = isOwnerOn(userId, server.id) && roleRow(request.body.roleId).builtIn !== OWNER;
      if (losesOwner && !auth.user.isAdmin) throw forbidden('team_owner_admin_only');
      if (losesOwner && ownersOf(server.id) <= 1) throw conflict('team_last_owner');
      db.update(serverAccess)
        .set({ roleId: request.body.roleId })
        .where(and(eq(serverAccess.serverId, server.id), eq(serverAccess.userId, userId)))
        .run();
      ctx.audit.record(actorOf(request), 'server.team_role', server.id, {
        userId,
        role: roleRow(request.body.roleId).name,
      });
      changed(userId);
      return view(auth.user, server.id);
    },
  );

  app.delete(
    '/api/servers/:id/team/:userId',
    { schema: { params: memberParams } },
    async (request, reply) => {
      const auth = requireAuth(request);
      const server = serverOf(request.params.id);
      const { userId } = request.params;
      // Anyone may leave a server themselves; removing others needs a manager.
      if (userId !== auth.user.id) requireManager(auth.user, server.id);
      if (isOwnerOn(userId, server.id)) {
        if (!auth.user.isAdmin && userId !== auth.user.id) throw forbidden('team_owner_admin_only');
        if (ownersOf(server.id) <= 1) throw conflict('team_last_owner');
      }
      db.delete(serverAccess)
        .where(and(eq(serverAccess.serverId, server.id), eq(serverAccess.userId, userId)))
        .run();
      ctx.audit.record(actorOf(request), 'server.team_remove', server.id, { userId });
      changed(userId);
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );
}
