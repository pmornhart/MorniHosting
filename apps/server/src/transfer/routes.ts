import {
  transferExportSchema,
  transferImportSchema,
  type TransferCode,
  type TransferResult,
} from '@mornihosting/shared';
import { actorOf, requireAdmin } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import type { TransferService } from './service.js';

const LIMIT = 5;
const WINDOW = '1 minute';
/** Long enough for the answer to reach the browser before the panel stops. */
const RESTART_DELAY_MS = 1500;

/**
 * Admins only. After an import the panel restarts (the container comes back by itself), so the Discord bot,
 * DNS, NetBird and HTTPS start with the new settings.
 */
export function registerTransferRoutes(app: Api, ctx: AppContext, transfer: TransferService): void {
  app.post(
    '/api/transfer/export',
    { schema: { body: transferExportSchema }, config: { rateLimit: { max: LIMIT, timeWindow: WINDOW } } },
    async (request): Promise<TransferCode> => {
      requireAdmin(request);
      const result = transfer.exportCode(request.body.password);
      ctx.audit.record(actorOf(request), 'transfer.export', null, { parts: result.parts.length });
      return result;
    },
  );
  app.post(
    '/api/transfer/import',
    { schema: { body: transferImportSchema }, config: { rateLimit: { max: LIMIT, timeWindow: WINDOW } } },
    async (request): Promise<TransferResult> => {
      requireAdmin(request);
      const result = transfer.importCode(request.body.code, request.body.password);
      ctx.audit.record(actorOf(request), 'transfer.import', null, { from: result.from || '–' });
      // Only a real installation restarts; the simulated one (tests, demo) keeps running.
      const restarting = ctx.docker.kind === 'docker';
      if (restarting) setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_DELAY_MS);
      return { ...result, restarting };
    },
  );
}
