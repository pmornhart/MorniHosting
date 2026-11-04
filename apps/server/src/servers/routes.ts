import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  SERVER_ACTIONS,
  SERVER_PERMISSIONS,
  SOFTWARE_IDS,
  commandInputSchema,
  createServerSchema,
  gameSettingsSchema,
  updateServerSchema,
  type ServerAction,
  type StatsPoint,
} from '@mornihosting/shared';
import { actorOf, requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import { dnsRecords, servers as serverTable, stats } from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';
import { HTTP_ACCEPTED, HTTP_NO_CONTENT } from '../lib/http-status.js';
import { isHomeNetworkAddress } from '../lib/net-guard.js';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../lib/units.js';
import { hostInfo } from '../system/host.js';
import { checkReachability, connectionInfo } from './connectivity.js';
import type { ServerService } from './service.js';
import { versionsFor } from './versions.js';

const idParams = z.object({ id: z.string().min(1) });
const RANGE_BUCKET_MINUTES_DAY = 10;
const DAYS_IN_WEEK = 7;
const RECHECK_LIMIT = 6;
const STATS_RANGES = {
  '1h': { span: MS_PER_HOUR, bucket: MS_PER_MINUTE },
  '24h': { span: MS_PER_DAY, bucket: RANGE_BUCKET_MINUTES_DAY * MS_PER_MINUTE },
  '7d': { span: DAYS_IN_WEEK * MS_PER_DAY, bucket: MS_PER_HOUR },
} as const;

export function registerServerRoutes(
  app: Api,
  ctx: AppContext,
  servers: ServerService,
  orders: Pick<ServerService, 'create'>,
): void {
  const { access } = ctx;

  app.get('/api/servers', async (request) => servers.list(requireAuth(request).user));

  app.post('/api/servers', { schema: { body: createServerSchema } }, async (request) => {
    const auth = requireAuth(request);
    if (!auth.user.isAdmin && !auth.user.canCreateServers) throw forbidden('cannot_create_servers');
    return orders.create(request.body, actorOf(request), auth.user);
  });

  app.get('/api/servers/:id', { schema: { params: idParams } }, async (request) => {
    const auth = requireAuth(request);
    access.assertAny(auth.user, request.params.id);
    return servers.detail(request.params.id, auth.user);
  });

  app.patch(
    '/api/servers/:id',
    { schema: { params: idParams, body: updateServerSchema } },
    async (request) => {
      const auth = requireAuth(request);
      access.assert(auth.user, request.params.id, 'config');
      return servers.update(request.params.id, request.body, actorOf(request));
    },
  );

  app.put(
    '/api/servers/:id/game-settings',
    { schema: { params: idParams, body: z.object({ values: gameSettingsSchema }) } },
    async (request, reply) => {
      const auth = requireAuth(request);
      access.assert(auth.user, request.params.id, 'config');
      servers.setGameSettings(request.params.id, request.body.values, actorOf(request));
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  app.delete(
    '/api/servers/:id',
    {
      schema: {
        params: idParams,
        querystring: z.object({ deleteFiles: z.enum(['true', 'false']).default('false') }),
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const isOwner =
        access.permissionsFor(auth.user, request.params.id).length === SERVER_PERMISSIONS.length;
      if (!isOwner) throw forbidden('owner_only');
      await servers.remove(request.params.id, request.query.deleteFiles === 'true', actorOf(request));
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  const actions: Readonly<
    Record<ServerAction, (id: string, actor: ReturnType<typeof actorOf>) => Promise<void>>
  > = {
    start: servers.start,
    stop: servers.stop,
    restart: servers.restart,
    kill: servers.kill,
  };

  app.post(
    '/api/servers/:id/actions/:action',
    { schema: { params: z.object({ id: z.string(), action: z.enum(SERVER_ACTIONS) }) } },
    async (request, reply) => {
      const auth = requireAuth(request);
      access.assert(auth.user, request.params.id, 'control');
      await actions[request.params.action](request.params.id, actorOf(request));
      return reply.code(HTTP_ACCEPTED).send(servers.live(request.params.id));
    },
  );

  app.post(
    '/api/servers/:id/command',
    { schema: { params: idParams, body: commandInputSchema } },
    async (request) => {
      const auth = requireAuth(request);
      access.assert(auth.user, request.params.id, 'commands');
      const answer = await servers.command(request.params.id, request.body.command, actorOf(request));
      return { answer };
    },
  );

  app.get('/api/servers/:id/console', { schema: { params: idParams } }, async (request) => {
    const auth = requireAuth(request);
    access.assert(auth.user, request.params.id, 'console');
    return { lines: servers.logs(request.params.id) };
  });

  app.post('/api/servers/:id/crash/dismiss', { schema: { params: idParams } }, async (request, reply) => {
    const auth = requireAuth(request);
    access.assert(auth.user, request.params.id, 'control');
    ctx.db.run(sql`UPDATE servers SET crash = NULL WHERE id = ${request.params.id}`);
    return reply.code(HTTP_NO_CONTENT).send();
  });

  app.get('/api/servers/:id/connection', { schema: { params: idParams } }, async (request) => {
    const auth = requireAuth(request);
    access.assertAny(auth.user, request.params.id);
    // Friends outside need the public address; someone at home only gets in through the LAN address.
    return {
      ...(await connectionInfo(servers.row(request.params.id), ctx.settings)),
      viewerAtHome: isHomeNetworkAddress(request.ip),
      srv:
        ctx.db
          .select({ id: dnsRecords.id })
          .from(dnsRecords)
          .where(and(eq(dnsRecords.serverId, request.params.id), eq(dnsRecords.type, 'SRV')))
          .get() !== undefined,
    };
  });

  app.post(
    '/api/servers/:id/connection/check',
    { schema: { params: idParams }, config: { rateLimit: { max: RECHECK_LIMIT, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireAuth(request);
      access.assertAny(auth.user, request.params.id);
      return checkReachability(servers.row(request.params.id), ctx.settings);
    },
  );

  app.get(
    '/api/servers/:id/stats',
    {
      schema: {
        params: idParams,
        querystring: z.object({ range: z.enum(['1h', '24h', '7d']).default('1h') }),
      },
    },
    async (request): Promise<StatsPoint[]> => {
      const auth = requireAuth(request);
      access.assertAny(auth.user, request.params.id);
      const { span, bucket } = STATS_RANGES[request.query.range];
      const since = Date.now() - span;
      const rows = ctx.db.all<{
        t: number;
        cpu: number | null;
        mem: number | null;
        players: number | null;
        tps: number | null;
      }>(
        sql`SELECT (${stats.at} / ${bucket}) * ${bucket} AS t, avg(${stats.cpu}) AS cpu, avg(${stats.memMb}) AS mem,
                   max(${stats.players}) AS players, avg(${stats.tps}) AS tps
            FROM ${stats} WHERE ${stats.serverId} = ${request.params.id} AND ${stats.at} > ${since}
            GROUP BY t ORDER BY t`,
      );
      return rows.map((r) => ({
        t: new Date(r.t).toISOString(),
        cpu: r.cpu,
        mem: r.mem,
        players: r.players,
        tps: r.tps,
      }));
    },
  );

  app.get('/api/servers/:id/icon', { schema: { params: idParams } }, async (request, reply) => {
    const auth = requireAuth(request);
    access.assertAny(auth.user, request.params.id);
    const file = path.join(servers.dir(request.params.id), 'server-icon.png');
    if (!fs.existsSync(file)) throw notFound('no_icon');
    return reply
      .type('image/png')
      .header('cache-control', 'private, max-age=60')
      .send(fs.createReadStream(file));
  });

  app.get(
    '/api/versions/:software',
    { schema: { params: z.object({ software: z.enum(SOFTWARE_IDS) }) } },
    async (request) => {
      requireAuth(request);
      return versionsFor(request.params.software);
    },
  );

  app.get('/api/host', async (request) => {
    requireAuth(request);
    const live = ctx.db
      .select({ id: serverTable.id })
      .from(serverTable)
      .all()
      .map((r) => servers.live(r.id));
    return hostInfo(ctx.docker, ctx.config.dataDir, {
      cpuPercent: live.reduce((sum, l) => sum + (l.cpuPercent ?? 0), 0),
      memoryMb: live.reduce((sum, l) => sum + (l.memoryMb ?? 0), 0),
    });
  });
}
