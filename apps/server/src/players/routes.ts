import { z } from 'zod';
import { playerAdjustSchema } from '@mornihosting/shared';
import { actorOf, requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import { HTTP_NO_CONTENT } from '../lib/http-status.js';
import type { PlayerDetailService } from './detail.js';

const RATE = { max: 30, timeWindow: '1 minute' } as const;
const params = z.object({ id: z.string().min(1), uuid: z.string().min(1).max(40) });

/** Player details (inventory, stats, chat) and quick changes for online players. */
export function registerPlayerDetailRoutes(app: Api, ctx: AppContext, details: PlayerDetailService): void {
  app.get(
    '/api/servers/:id/players/known',
    { schema: { params: z.object({ id: z.string().min(1) }) } },
    async (request) => {
      ctx.access.assert(requireAuth(request).user, request.params.id, 'players');
      return details.known(request.params.id);
    },
  );

  app.get(
    '/api/servers/:id/players/known/:uuid',
    {
      schema: { params, querystring: z.object({ fresh: z.enum(['1']).optional() }) },
      config: { rateLimit: RATE },
    },
    async (request) => {
      ctx.access.assert(requireAuth(request).user, request.params.id, 'players');
      return details.detail(request.params.id, request.params.uuid, request.query.fresh === '1');
    },
  );

  app.post(
    '/api/servers/:id/players/known/:uuid/adjust',
    { schema: { params, body: playerAdjustSchema }, config: { rateLimit: RATE } },
    async (request, reply) => {
      const user = requireAuth(request).user;
      ctx.access.assert(user, request.params.id, 'players');
      ctx.access.assert(user, request.params.id, 'commands');
      await details.adjust(request.params.id, request.params.uuid, request.body);
      ctx.audit.record(actorOf(request), 'player.adjust', request.params.id, {
        player: request.params.uuid,
        kind: request.body.kind,
      });
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );
}
