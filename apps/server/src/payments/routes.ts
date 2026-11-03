import { z } from 'zod';
import { markPaidSchema } from '@mornihosting/shared';
import { actorOf, requireAdmin, requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import type { PaymentsService } from './service.js';

const RATE = { max: 20, timeWindow: '1 minute' } as const;

export function registerPaymentRoutes(app: Api, ctx: AppContext, payments: PaymentsService): void {
  app.post(
    '/api/coupons/check',
    { schema: { body: z.object({ code: z.string().trim().min(1).max(32) }) }, config: { rateLimit: RATE } },
    async (request) => {
      requireAuth(request);
      return payments.check(request.body.code);
    },
  );

  app.get('/api/payments', async (request) => {
    requireAdmin(request);
    return payments.view();
  });

  app.get('/api/payments/mine', async (request) => payments.mine(requireAuth(request).user.id));

  app.put(
    '/api/payments/:id',
    { schema: { params: z.object({ id: z.coerce.number().int().positive() }), body: markPaidSchema } },
    async (request) => {
      const auth = requireAdmin(request);
      const result = payments.mark(
        request.params.id,
        request.body.month,
        request.body.paid,
        auth.user.username,
      );
      ctx.audit.record(actorOf(request), request.body.paid ? 'payment.paid' : 'payment.unpaid', null, {
        charge: request.params.id,
        month: request.body.month,
      });
      return result;
    },
  );
}
