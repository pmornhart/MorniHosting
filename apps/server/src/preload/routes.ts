import { z } from 'zod';
import { SOFTWARE_IDS } from '@mornihosting/shared';
import { requireAdmin } from '../auth/context.js';
import type { Api } from '../context.js';
import { HTTP_ACCEPTED, HTTP_NO_CONTENT } from '../lib/http-status.js';
import type { PreloadService } from './service.js';

const params = z.object({ software: z.enum(SOFTWARE_IDS) });

/** Admin area → "Spiele vorladen": what is downloaded already, and buttons to download or remove it. */
export function registerPreloadRoutes(app: Api, preload: PreloadService): void {
  app.get('/api/preload', async (request) => {
    requireAdmin(request);
    return preload.list();
  });

  app.post('/api/preload', async (request, reply) => {
    const auth = requireAdmin(request);
    preload.startAll(auth.user);
    return reply.code(HTTP_ACCEPTED).send(preload.list());
  });

  app.post('/api/preload/update-all', async (request, reply) => {
    const auth = requireAdmin(request);
    preload.updateAll(auth.user);
    return reply.code(HTTP_ACCEPTED).send(preload.list());
  });

  app.post('/api/preload/:software', { schema: { params } }, async (request, reply) => {
    const auth = requireAdmin(request);
    preload.start(request.params.software, auth.user);
    return reply.code(HTTP_ACCEPTED).send(preload.list());
  });

  app.delete('/api/preload', async (request, reply) => {
    requireAdmin(request);
    await preload.removeAll();
    return reply.code(HTTP_NO_CONTENT).send();
  });

  app.delete('/api/preload/:software', { schema: { params } }, async (request, reply) => {
    requireAdmin(request);
    await preload.remove(request.params.software);
    return reply.code(HTTP_NO_CONTENT).send();
  });
}
