import path from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Actor } from '../audit/service.js';
import type { UserRow } from '../auth/context.js';
import type { AppContext } from '../context.js';
import { panelOps, roles, serverAccess, servers as serverTable, users } from '../db/schema.js';
import { conflict } from '../lib/errors.js';
import { createKeyedLock } from '../lib/locks.js';
import { lookupProfile, OP_LEVEL, readList, writeList } from '../servers/players.js';
import type { ServerService } from '../servers/service.js';

/**
 * Linked Minecraft accounts: a user enters their Java name once; on every Java server they own (panel admins
 * and the built-in owner role) the panel makes that account an operator. Operators the panel added are
 * remembered, so only those are removed again when the account is unlinked or the role goes away.
 */

const OWNER_ROLE = 'owner';
const OPS_FILE = 'ops.json';

interface Player {
  readonly uuid: string;
  readonly name: string;
}

interface OpsPlan {
  readonly add: readonly Player[];
  readonly remove: readonly Player[];
}

export interface MinecraftLinkService {
  readonly link: (user: UserRow, name: string, actor: Actor) => Promise<UserRow>;
  readonly unlink: (user: UserRow, actor: Actor) => Promise<UserRow>;
}

export function createMinecraftLinkService(ctx: AppContext, servers: ServerService): MinecraftLinkService {
  const lock = createKeyedLock();
  const userRow = (id: number): UserRow | undefined =>
    ctx.db.select().from(users).where(eq(users.id, id)).get();

  /** Linked, active users who own the server: panel admins and holders of the built-in owner role. */
  const owners = (serverId: string): Player[] => {
    const ownerIds = new Set(
      ctx.db
        .select({ userId: serverAccess.userId })
        .from(serverAccess)
        .innerJoin(roles, eq(roles.id, serverAccess.roleId))
        .where(and(eq(serverAccess.serverId, serverId), eq(roles.builtIn, OWNER_ROLE)))
        .all()
        .map((r) => r.userId),
    );
    return ctx.db
      .select()
      .from(users)
      .where(and(isNotNull(users.minecraftUuid), eq(users.disabled, false)))
      .all()
      .filter((u) => u.isAdmin || ownerIds.has(u.id))
      .map((u) => ({ uuid: u.minecraftUuid ?? '', name: u.minecraftName ?? '' }));
  };

  const opsFile = (serverId: string): string => path.join(servers.dir(serverId), OPS_FILE);

  /** What to change on one server; nothing for Bedrock (it has no Java accounts) or a deleted server. */
  const planFor = (serverId: string): OpsPlan => {
    const row = ctx.db.select().from(serverTable).where(eq(serverTable.id, serverId)).get();
    if (!row || row.edition !== 'java') return { add: [], remove: [] };
    const wanted = owners(serverId);
    const granted = ctx.db.select().from(panelOps).where(eq(panelOps.serverId, serverId)).all();
    const current = readList(opsFile(serverId));
    // Someone who already is an operator (added by hand) is left alone and not taken over.
    const isOp = (p: Player): boolean =>
      current.some((o) => o.uuid?.toLowerCase() === p.uuid || o.name.toLowerCase() === p.name.toLowerCase());
    return {
      add: wanted.filter((w) => !granted.some((g) => g.uuid === w.uuid) && !isOp(w)),
      remove: granted.filter((g) => !wanted.some((w) => w.uuid === g.uuid)),
    };
  };

  const remember = (serverId: string, plan: OpsPlan): void => {
    plan.add.forEach((p) =>
      ctx.db
        .insert(panelOps)
        .values({ serverId, ...p })
        .onConflictDoNothing()
        .run(),
    );
    plan.remove.forEach((p) =>
      ctx.db
        .delete(panelOps)
        .where(and(eq(panelOps.serverId, serverId), eq(panelOps.uuid, p.uuid)))
        .run(),
    );
  };

  /** While the server is off: edit ops.json directly (it is read at the next start). */
  const applyOffline = (serverId: string, plan: OpsPlan): void => {
    if (!plan.add.length && !plan.remove.length) return;
    const file = opsFile(serverId);
    const removed = new Set(plan.remove.map((p) => p.uuid));
    const kept = readList(file).filter((o) => !removed.has(o.uuid?.toLowerCase() ?? ''));
    const added = plan.add.map((p) => ({
      uuid: p.uuid,
      name: p.name,
      level: OP_LEVEL,
      bypassesPlayerLimit: false,
    }));
    writeList(file, [...kept, ...added]);
    remember(serverId, plan);
  };

  /** While it runs: the console, so the change applies at once. */
  const applyOnline = async (serverId: string, plan: OpsPlan): Promise<void> => {
    await Promise.all([
      ...plan.add.map((p) => servers.quietCommand(serverId, `op ${p.name}`)),
      ...plan.remove.map((p) => servers.quietCommand(serverId, `deop ${p.name}`)),
    ]);
    remember(serverId, plan);
  };

  const syncServer = async (serverId: string): Promise<void> => {
    try {
      await lock(serverId, async () => {
        const plan = planFor(serverId);
        if (servers.live(serverId).state === 'running') await applyOnline(serverId, plan);
        else applyOffline(serverId, plan);
      });
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'operators for linked accounts not updated');
    }
  };
  const syncAll = async (): Promise<void> => {
    await Promise.all(
      ctx.db
        .select({ id: serverTable.id })
        .from(serverTable)
        .all()
        .map((r) => syncServer(r.id)),
    );
  };

  servers.onCreated((id) => syncServer(id));
  // Right before a start ops.json is brought up to date, so the server reads the right operators.
  servers.onBeforeStart((id) => {
    try {
      applyOffline(id, planFor(id));
    } catch (err) {
      ctx.log.warn({ err, serverId: id }, 'operators for linked accounts not written');
    }
  });
  ctx.events.on('access.changed', () => void syncAll());
  ctx.events.on('server.deleted', ({ serverId }) => {
    ctx.db.delete(panelOps).where(eq(panelOps.serverId, serverId)).run();
  });

  return {
    link: async (user, name, actor) => {
      const profile = await lookupProfile(name);
      const other = ctx.db.select().from(users).where(eq(users.minecraftUuid, profile.uuid)).get();
      if (other && other.id !== user.id) throw conflict('minecraft_taken', { name: profile.name });
      ctx.db
        .update(users)
        .set({ minecraftName: profile.name, minecraftUuid: profile.uuid })
        .where(eq(users.id, user.id))
        .run();
      ctx.audit.record(actor, 'account.minecraft_link', null, { name: profile.name });
      await syncAll();
      ctx.events.emit('minecraft.linked', { userId: user.id });
      return userRow(user.id) ?? user;
    },
    unlink: async (user, actor) => {
      ctx.db
        .update(users)
        .set({ minecraftName: null, minecraftUuid: null })
        .where(eq(users.id, user.id))
        .run();
      ctx.audit.record(actor, 'account.minecraft_unlink', null, { name: user.minecraftName });
      await syncAll();
      ctx.events.emit('minecraft.linked', { userId: user.id });
      return userRow(user.id) ?? user;
    },
  };
}
