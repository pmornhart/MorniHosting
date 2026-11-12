import fs from 'node:fs';
import os from 'node:os';
import { and, eq } from 'drizzle-orm';
import {
  CPU_STEP,
  DEFAULT_QUOTA,
  NO_QUOTA,
  withServerMemory,
  type MyQuota,
  type Quota,
  type QuotaUsage,
  type QuotaView,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { UserRow } from '../auth/context.js';
import type { AppContext } from '../context.js';
import { roles, serverAccess, servers as serverTable, users } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { hostMemoryMb } from '../system/host.js';
import type { QuotaGuard, ServerService } from '../servers/service.js';

/**
 * Quotas: how much RAM, disk, CPU and how many servers a person may own in total. Admins set defaults for
 * everyone and, where needed, own limits per person. Admins themselves have none. The servers service asks
 * before it creates a server or makes one bigger; the CPU limit goes to Docker, the disk limit is checked at
 * every start against the folder's real size.
 */

const DEFAULTS_KEY = 'quota';
const OWNER_ROLE = 'owner';
const BYTES_PER_MB = 1024 * 1024;

export interface QuotaService extends QuotaGuard {
  readonly view: () => QuotaView;
  /** What the person may order (RAM per server), for the order pages and server settings. */
  readonly mine: (user: UserRow) => MyQuota;
  readonly setDefaults: (quota: Quota, actor: Actor) => QuotaView;
  readonly setUserQuota: (userId: number, quota: Quota | null, actor: Actor) => QuotaView;
}

/** What the machine has, so the admin sees how much there is to hand out. */
function hostOf(dataDir: string): QuotaView['host'] {
  const diskMb = (() => {
    try {
      const s = fs.statfsSync(dataDir);
      return Math.round((s.blocks * s.bsize) / BYTES_PER_MB);
    } catch {
      return null;
    }
  })();
  return { memoryMb: hostMemoryMb(), cpus: os.cpus().length, diskMb };
}

export function createQuotaService(ctx: AppContext, servers: ServerService): QuotaService {
  const { db } = ctx;
  const defaults = (): Quota => {
    const stored = ctx.settings.getValue<Quota>(DEFAULTS_KEY);
    return stored ? withServerMemory(stored, DEFAULT_QUOTA.serverMemoryMb) : DEFAULT_QUOTA;
  };
  /** Own limits saved before "RAM per server" existed take the default for it. */
  const own = (user: UserRow): Quota | null =>
    user.quota ? withServerMemory(user.quota, defaults().serverMemoryMb) : null;
  const effective = (user: UserRow): Quota => (user.isAdmin ? NO_QUOTA : (own(user) ?? defaults()));

  /** Servers a person owns (role "Besitzer"); admins' own servers have no owner entry. */
  const ownedIds = (userId: number): string[] =>
    db
      .select({ id: serverAccess.serverId })
      .from(serverAccess)
      .innerJoin(roles, eq(roles.id, serverAccess.roleId))
      .where(and(eq(serverAccess.userId, userId), eq(roles.builtIn, OWNER_ROLE)))
      .all()
      .map((r) => r.id);

  const usage = (userId: number, exceptId: string | null = null): QuotaUsage => {
    const rows = ownedIds(userId)
      .filter((id) => id !== exceptId)
      .map((id) => db.select().from(serverTable).where(eq(serverTable.id, id)).get())
      .filter((r) => r !== undefined);
    return {
      servers: rows.length,
      memoryMb: rows.reduce((sum, r) => sum + r.memoryMb, 0),
      diskMb: rows.reduce((sum, r) => sum + (r.diskLimitMb ?? 0), 0),
      diskUsedMb: rows.reduce((sum, r) => sum + (servers.live(r.id).diskMb ?? 0), 0),
      cpus: rows.reduce((sum, r) => sum + (r.cpuLimit ?? 0), 0),
    };
  };

  const ownerOf: QuotaGuard['ownerOf'] = (serverId) => {
    const owner = db
      .select({ user: users })
      .from(serverAccess)
      .innerJoin(roles, eq(roles.id, serverAccess.roleId))
      .innerJoin(users, eq(users.id, serverAccess.userId))
      .where(and(eq(serverAccess.serverId, serverId), eq(roles.builtIn, OWNER_ROLE)))
      .get();
    return owner?.user ?? null;
  };

  const limitsFor: QuotaGuard['limitsFor'] = (owner, wanted) => {
    const quota = effective(owner);
    const used = usage(owner.id);
    // A fair share, so the first server does not take everything: split what is left over the server
    // slots still free, or (without a server limit) in proportion to the RAM the new server gets.
    const share = (limit: number | null, already: number, step: number): number | null => {
      if (limit === null) return null;
      const left = Math.max(0, limit - already);
      const slots = quota.servers === null ? null : Math.max(1, quota.servers - used.servers);
      const byRam = quota.memoryMb && quota.memoryMb > 0 ? (limit * wanted.memoryMb) / quota.memoryMb : left;
      const fair = slots === null ? byRam : left / slots;
      return Math.floor(Math.min(left, fair) / step) * step;
    };
    return {
      cpuLimit: wanted.cpuLimit ?? share(quota.cpus, used.cpus, CPU_STEP),
      diskLimitMb: wanted.diskLimitMb ?? share(quota.diskMb, used.diskMb, 1),
    };
  };

  // RAM per server: only more than the limit is refused. A server that already has more (an admin gave
  // it) keeps it, and making it smaller is always fine.
  const checkServerMemory: QuotaGuard['checkServerMemory'] = (person, serverId, memoryMb) => {
    if (person.isAdmin) return;
    const limit = effective(person).serverMemoryMb;
    if (limit === null || memoryMb <= limit) return;
    const current =
      serverId === null
        ? 0
        : (db
            .select({ memoryMb: serverTable.memoryMb })
            .from(serverTable)
            .where(eq(serverTable.id, serverId))
            .get()?.memoryMb ?? 0);
    if (memoryMb > current) throw conflict('quota_server_memory', { limit });
  };

  const check: QuotaGuard['check'] = (owner, serverId, next) => {
    if (owner.isAdmin) return;
    checkServerMemory(owner, serverId, next.memoryMb);
    const quota = effective(owner);
    const used = usage(owner.id, serverId);
    const over = (code: string, limit: number | null, wanted: number, already: number): void => {
      if (limit !== null && already + wanted > limit) throw conflict(code, { limit, used: already });
    };
    over('quota_servers', quota.servers, serverId === null ? 1 : 0, used.servers);
    over('quota_memory', quota.memoryMb, next.memoryMb, used.memoryMb);
    // A missing limit under a quota means "all that is left", which is never more than the quota.
    if (quota.cpus !== null && next.cpuLimit !== null && next.cpuLimit <= 0)
      throw conflict('quota_cpus', { limit: quota.cpus, used: used.cpus });
    over('quota_cpus', quota.cpus, next.cpuLimit ?? 0, used.cpus);
    if (quota.diskMb !== null && next.diskLimitMb !== null && next.diskLimitMb <= 0)
      throw conflict('quota_disk', { limit: quota.diskMb, used: used.diskMb });
    over('quota_disk', quota.diskMb, next.diskLimitMb ?? 0, used.diskMb);
  };

  const view = (): QuotaView => ({
    defaults: defaults(),
    host: hostOf(ctx.config.dataDir),
    users: db
      .select()
      .from(users)
      .all()
      .filter((u) => !u.approvalPending)
      .map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName || u.username,
        isAdmin: u.isAdmin,
        own: own(u),
        effective: effective(u),
        usage: usage(u.id),
      })),
  });

  const guard: QuotaGuard = { limitsFor, check, checkServerMemory, ownerOf };
  servers.useQuota(guard);

  return {
    ...guard,
    view,
    mine: (user) => ({ serverMemoryMb: effective(user).serverMemoryMb }),
    setDefaults: (quota, actor) => {
      ctx.settings.setValue(DEFAULTS_KEY, quota);
      ctx.audit.record(actor, 'quota.defaults', null, quota);
      return view();
    },
    setUserQuota: (userId, quota, actor) => {
      const user = db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) throw notFound('user_not_found');
      db.update(users).set({ quota }).where(eq(users.id, userId)).run();
      ctx.audit.record(actor, 'quota.user', null, { username: user.username, ...(quota ?? { reset: true }) });
      return view();
    },
  };
}
