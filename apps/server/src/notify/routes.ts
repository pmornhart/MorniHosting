import { z } from 'zod';
import {
  createServerSchema,
  decisionSchema,
  discordClaimSchema,
  discordSettingsSchema,
  notifyPrefsSchema,
  type ApprovalsView,
  type DiscordLinkCode,
  type DiscordLinked,
  type DiscordSettingsView,
  type NotifySettingsView,
  type ServerRequestView,
} from '@mornihosting/shared';
import { actorOf, requireAdmin, requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { HTTP_NO_CONTENT } from '../lib/http-status.js';
import type { ApprovalService } from './approvals.js';
import type { NotifyService } from './service.js';

/** Discord bot (admins), own notification choices, approvals of accounts and server requests. */

const REQUEST_LIMIT = 5;
const REQUEST_WINDOW = '1 hour';
const TEST_LIMIT = 5;
const TEST_WINDOW = '1 minute';
const userParams = z.object({ id: z.coerce.number().int().positive() });
const requestParams = z.object({ id: z.string().min(1).max(64) });

export function registerNotifyRoutes(
  app: Api,
  ctx: AppContext,
  notify: NotifyService,
  approvals: ApprovalService,
): void {
  app.get('/api/discord', async (request): Promise<DiscordSettingsView> => {
    requireAdmin(request);
    return notify.discordView();
  });
  app.put(
    '/api/discord',
    { schema: { body: discordSettingsSchema } },
    async (request): Promise<DiscordSettingsView> => {
      requireAdmin(request);
      const view = await notify.setDiscord(request.body.token);
      ctx.audit.record(actorOf(request), 'discord.settings', null, { bot: view.botName });
      return view;
    },
  );
  app.delete('/api/discord', async (request, reply) => {
    requireAdmin(request);
    notify.clearDiscord();
    ctx.audit.record(actorOf(request), 'discord.removed');
    return reply.code(HTTP_NO_CONTENT).send();
  });

  app.get('/api/account/notifications', async (request): Promise<NotifySettingsView> =>
    notify.settingsFor(requireAuth(request).user),
  );
  app.put(
    '/api/account/notifications',
    { schema: { body: notifyPrefsSchema } },
    async (request): Promise<NotifySettingsView> => notify.setPrefs(requireAuth(request).user, request.body),
  );
  app.post('/api/account/discord/code', async (request): Promise<DiscordLinkCode> => {
    if (!notify.discordView().configured) throw badRequest('discord_not_configured');
    return notify.linkCode(requireAuth(request).user);
  });
  app.post(
    '/api/account/discord/test',
    { config: { rateLimit: { max: TEST_LIMIT, timeWindow: TEST_WINDOW } } },
    async (request, reply) => {
      await notify.testDm(requireAuth(request).user);
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );
  app.post(
    '/api/account/discord/peek',
    { schema: { body: discordClaimSchema } },
    async (request): Promise<{ name: string }> => {
      requireAuth(request);
      return notify.peekClaim(request.body.token);
    },
  );
  app.post(
    '/api/account/discord/claim',
    { schema: { body: discordClaimSchema } },
    async (request): Promise<DiscordLinked> => notify.claim(requireAuth(request).user, request.body.token),
  );
  app.delete('/api/account/discord', async (request, reply) => {
    notify.unlink(requireAuth(request).user);
    return reply.code(HTTP_NO_CONTENT).send();
  });

  app.get('/api/approvals', async (request): Promise<ApprovalsView> => {
    requireAdmin(request);
    return approvals.view();
  });
  app.post('/api/approvals/users/:id/approve', { schema: { params: userParams } }, async (request) => {
    requireAdmin(request);
    return approvals.approveUser(request.params.id, actorOf(request));
  });
  app.post(
    '/api/approvals/users/:id/reject',
    { schema: { params: userParams, body: decisionSchema } },
    async (request) => {
      requireAdmin(request);
      return approvals.rejectUser(request.params.id, request.body.note, actorOf(request));
    },
  );

  app.post(
    '/api/server-requests',
    {
      schema: { body: createServerSchema },
      config: { rateLimit: { max: REQUEST_LIMIT, timeWindow: REQUEST_WINDOW } },
    },
    async (request): Promise<ServerRequestView> => {
      const auth = requireAuth(request);
      if (auth.user.isAdmin || auth.user.canCreateServers) throw badRequest('request_not_needed');
      return approvals.request(request.body, auth.user);
    },
  );
  app.get('/api/server-requests/mine', async (request): Promise<ServerRequestView[]> =>
    approvals.mine(requireAuth(request).user),
  );
  app.post('/api/server-requests/:id/approve', { schema: { params: requestParams } }, async (request) => {
    requireAdmin(request);
    return approvals.approveRequest(request.params.id, actorOf(request));
  });
  app.post(
    '/api/server-requests/:id/reject',
    { schema: { params: requestParams, body: decisionSchema } },
    async (request) => {
      requireAdmin(request);
      return approvals.rejectRequest(request.params.id, request.body.note, actorOf(request));
    },
  );
}
