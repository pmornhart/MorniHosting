import { quotaSchema, userQuotaSchema, type MyQuota, type QuotaView } from '@mornihosting/shared';
import { z } from 'zod';
import { actorOf, requireAdmin, requireAuth } from '../auth/context.js';
import type { Api } from '../context.js';
import type { QuotaService } from './service.js';

/** Admin area → quotas: defaults for everyone and own limits per person. */
export function registerQuotaRoutes(app: Api, quota: QuotaService): void {
  app.get('/api/quotas', async (request): Promise<QuotaView> => {
    requireAdmin(request);
    return quota.view();
  });
  // Everyone signed in: how much RAM one server of theirs may get (the order pages show no more).
  app.get('/api/quotas/mine', async (request): Promise<MyQuota> => quota.mine(requireAuth(request).user));
  app.put('/api/quotas/defaults', { schema: { body: quotaSchema } }, async (request): Promise<QuotaView> => {
    requireAdmin(request);
    return quota.setDefaults(request.body, actorOf(request));
  });
  app.put(
    '/api/quotas/users/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: userQuotaSchema } },
    async (request): Promise<QuotaView> => {
      requireAdmin(request);
      return quota.setUserQuota(request.params.id, request.body.quota, actorOf(request));
    },
  );
}
