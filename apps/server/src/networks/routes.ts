import { z } from 'zod';
import { networkCreateSchema, networkMemberSchema, networkUpdateSchema } from '@mornihosting/shared';
import { actorOf, requireAdmin, requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import type { NetworkService } from './service.js';

const idParams = z.object({ id: z.string().min(1) });

/**
 * Networks span several servers, so only admins create and change them. Anyone with access to a server sees
 * which network it is in (`/api/servers/:id/network`).
 */
export function registerNetworkRoutes(app: Api, ctx: AppContext, networks: NetworkService): void {
  app.get('/api/networks', async (request) => {
    requireAdmin(request);
    return networks.list();
  });

  app.post('/api/networks', { schema: { body: networkCreateSchema } }, async (request) => {
    requireAdmin(request);
    return networks.create(request.body, actorOf(request));
  });

  app.get('/api/networks/:id', { schema: { params: idParams } }, async (request) => {
    requireAdmin(request);
    return networks.get(request.params.id);
  });

  app.patch(
    '/api/networks/:id',
    { schema: { params: idParams, body: networkUpdateSchema } },
    async (request) => {
      requireAdmin(request);
      return networks.update(request.params.id, request.body, actorOf(request));
    },
  );

  app.delete('/api/networks/:id', { schema: { params: idParams } }, async (request) => {
    requireAdmin(request);
    await networks.remove(request.params.id, actorOf(request));
    return { ok: true };
  });

  app.post(
    '/api/networks/:id/members',
    { schema: { params: idParams, body: networkMemberSchema } },
    async (request) => {
      requireAdmin(request);
      return networks.addMember(request.params.id, request.body, actorOf(request));
    },
  );

  app.delete(
    '/api/networks/:id/members/:serverId',
    { schema: { params: z.object({ id: z.string().min(1), serverId: z.string().min(1) }) } },
    async (request) => {
      requireAdmin(request);
      return networks.removeMember(request.params.id, request.params.serverId, actorOf(request));
    },
  );

  app.get('/api/servers/:id/network', { schema: { params: idParams } }, async (request) => {
    ctx.access.assertAny(requireAuth(request).user, request.params.id);
    return { network: networks.ofServer(request.params.id) };
  });
}
