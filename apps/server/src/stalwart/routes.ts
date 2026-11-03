import { stalwartConnectSchema, type StalwartConnectResult, type StalwartView } from '@mornihosting/shared';
import { actorOf, requireAdmin } from '../auth/context.js';
import type { Api } from '../context.js';
import { HTTP_NO_CONTENT } from '../lib/http-status.js';
import type { StalwartService } from './service.js';

/** Admin → E-Mail → "Stalwart verbinden". */

const CONNECT_LIMIT = 5;
const CONNECT_WINDOW = '1 minute';
const limited = { rateLimit: { max: CONNECT_LIMIT, timeWindow: CONNECT_WINDOW } };

export function registerStalwartRoutes(app: Api, stalwart: StalwartService): void {
  app.get('/api/stalwart', async (request): Promise<StalwartView> => {
    requireAdmin(request);
    return stalwart.view();
  });

  app.post(
    '/api/stalwart/connect',
    { schema: { body: stalwartConnectSchema }, config: limited },
    async (request): Promise<StalwartConnectResult> => {
      const auth = requireAdmin(request);
      return stalwart.connect(request.body, actorOf(request), {
        email: auth.user.email,
        locale: auth.user.locale,
        name: auth.user.displayName || auth.user.username,
      });
    },
  );

  app.post('/api/stalwart/check', { config: limited }, async (request): Promise<StalwartView> => {
    requireAdmin(request);
    return stalwart.check();
  });

  app.delete('/api/stalwart', async (request, reply) => {
    requireAdmin(request);
    await stalwart.disconnect(actorOf(request));
    return reply.code(HTTP_NO_CONTENT).send();
  });
}
