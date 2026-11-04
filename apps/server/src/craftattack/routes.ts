import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import { publicStatsInputSchema, type CraftAttackService } from './service.js';

const params = z.object({ id: z.string().min(1) });
/** The public page is open to everyone; it refreshes itself, so a generous limit per visitor. */
const PUBLIC_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };

export function registerCraftAttackRoutes(app: Api, ctx: AppContext, craftAttack: CraftAttackService): void {
  app.get('/api/servers/:id/public-stats', { schema: { params } }, async (request) => {
    ctx.access.assertAny(requireAuth(request).user, request.params.id);
    return craftAttack.publicSetting(request.params.id);
  });

  app.put(
    '/api/servers/:id/public-stats',
    { schema: { params, body: publicStatsInputSchema } },
    async (request) => {
      ctx.access.assert(requireAuth(request).user, request.params.id, 'config');
      return craftAttack.setPublic(request.params.id, request.body);
    },
  );

  // No login: anyone with the link sees who plays and who died how.
  app.get(
    '/api/public/stats/:slug',
    { schema: { params: z.object({ slug: z.string().min(1).max(60) }) }, config: PUBLIC_LIMIT },
    async (request) => craftAttack.publicStats(request.params.slug),
  );
}
