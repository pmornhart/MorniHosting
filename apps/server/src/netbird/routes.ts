import { z } from 'zod';
import {
  netbirdConfigSchema,
  netbirdDiscoverSchema,
  netbirdDomainServerSchema,
  netbirdExitSchema,
  netbirdPanelSchema,
  netbirdServerSchema,
  routerForwardsSchema,
} from '@mornihosting/shared';
import { actorOf, requireAdmin } from '../auth/context.js';
import type { Api } from '../context.js';
import type { DnsAutomation } from '../dns/service.js';
import type { RouterForwards } from '../gateway/forwards.js';
import type { NetbirdExit } from './exit.js';
import type { NetbirdAutomation } from './service.js';

/** The list asks NetBird (at most once a minute per port, or now with "Neu prüfen"): plenty for one admin page. */
const FORWARD_CHECKS_PER_MINUTE = 30;

/** NetBird automation (admins only): it acts with the admin's NetBird token, so nobody else may use it. */
export function registerNetbirdRoutes(
  app: Api,
  parts: {
    readonly netbird: NetbirdAutomation;
    readonly dns: DnsAutomation;
    readonly exit: NetbirdExit;
    readonly forwards: RouterForwards;
  },
): void {
  const { netbird, dns, exit, forwards } = parts;
  app.get('/api/netbird', async (request) => {
    requireAdmin(request);
    return netbird.status();
  });

  app.post('/api/netbird/discover', { schema: { body: netbirdDiscoverSchema } }, async (request) => {
    requireAdmin(request);
    return netbird.discover(request.body);
  });

  app.put('/api/netbird', { schema: { body: netbirdConfigSchema } }, async (request) => {
    requireAdmin(request);
    const status = await netbird.configure(request.body, actorOf(request));
    // A connected own domain (INWX, Cloudflare …) from now on only tidies up behind NetBird.
    await dns.netbirdConnected();
    return status;
  });

  app.delete('/api/netbird', async (request) => {
    requireAdmin(request);
    // The exit route belongs to this NetBird connection; it goes first, while the token is still known.
    await exit.remove().catch(() => undefined);
    return netbird.disconnect(actorOf(request));
  });

  app.get('/api/netbird/exit', async (request) => {
    requireAdmin(request);
    return exit.status();
  });

  app.put('/api/netbird/exit', { schema: { body: netbirdExitSchema } }, async (request) => {
    requireAdmin(request);
    return exit.set(request.body, actorOf(request));
  });

  app.post('/api/netbird/panel', { schema: { body: netbirdPanelSchema } }, async (request) => {
    requireAdmin(request);
    return netbird.setupPanel(request.body, actorOf(request));
  });

  // The server players reach on the domain itself (e.g. a network's proxy on "moinmorni.net").
  app.put('/api/netbird/domain-server', { schema: { body: netbirdDomainServerSchema } }, async (request) => {
    requireAdmin(request);
    return netbird.setDomainServer(request.body.serverId, actorOf(request));
  });

  // Other products' domains through the address router ("Weitere Domains über diesen Verteiler").
  app.get(
    '/api/netbird/forwards',
    {
      schema: { querystring: z.object({ fresh: z.enum(['1']).optional() }) },
      config: { rateLimit: { max: FORWARD_CHECKS_PER_MINUTE, timeWindow: '1 minute' } },
    },
    async (request) => {
      requireAdmin(request);
      return forwards.status(request.query.fresh === '1');
    },
  );

  app.put('/api/netbird/forwards', { schema: { body: routerForwardsSchema } }, async (request) => {
    requireAdmin(request);
    return forwards.save(request.body.forwards, actorOf(request));
  });

  app.put(
    '/api/servers/:id/netbird',
    { schema: { params: z.object({ id: z.string().min(1) }), body: netbirdServerSchema } },
    async (request) => {
      requireAdmin(request);
      // NetBird hands out the address when it is connected; the own domain then only tidies up the name.
      const actor = actorOf(request);
      if (netbird.status().configured) {
        const info = await netbird.setServerName(request.params.id, request.body.name, actor);
        if (dns.configured()) await dns.syncServer(request.params.id);
        return { netbird: info };
      }
      return { netbird: await dns.setServerName(request.params.id, request.body.name, actor) };
    },
  );
}
