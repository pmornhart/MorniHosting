import { z } from 'zod';
import { crashFixSchema } from '@mornihosting/shared';
import { actorOf, requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import type { CrashHelpService } from './service.js';

const params = z.object({ id: z.string().min(1) });
const RATE = { max: 10, timeWindow: '1 minute' } as const;

export function registerCrashRoutes(app: Api, ctx: AppContext, crash: CrashHelpService): void {
  app.get('/api/servers/:id/crash', { schema: { params } }, async (request) => {
    ctx.access.assertAny(requireAuth(request).user, request.params.id);
    return { help: crash.help(request.params.id) };
  });

  app.post(
    '/api/servers/:id/crash/fix',
    { schema: { params, body: crashFixSchema }, config: { rateLimit: RATE } },
    async (request) => {
      const user = requireAuth(request).user;
      const done = await crash.fix(
        request.params.id,
        request.body.fix,
        request.body.start,
        user,
        actorOf(request),
      );
      return { done };
    },
  );
}
