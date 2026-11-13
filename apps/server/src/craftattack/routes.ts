import { z } from 'zod';
import { actorOf, requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { morniCraftSettingsSchema } from './mornicraft.js';
import { publicStatsInputSchema, type CraftAttackService } from './service.js';
import { teamActionSchema } from './team-board.js';

const params = z.object({ id: z.string().min(1) });
/** The public page is open to everyone; it refreshes itself, so a generous limit per visitor. */
const PUBLIC_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };
const ZIP_SUFFIX = '.zip';
/** The team dashboard reloads every few seconds; buttons are rarer. */
const TEAM_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } };
const TEAM_ACTION_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const TEAM_KEY_HEADER = 'x-team-key';
const slugParams = z.object({ slug: z.string().min(1).max(60) });
const keyOf = (headers: Record<string, unknown>): string => {
  const key = headers[TEAM_KEY_HEADER];
  return typeof key === 'string' ? key : '';
};

export function registerCraftAttackRoutes(app: Api, ctx: AppContext, craftAttack: CraftAttackService): void {
  app.get('/api/servers/:id/public-stats', { schema: { params } }, async (request) => {
    ctx.access.assertAny(requireAuth(request).user, request.params.id);
    return craftAttack.publicSetting(request.params.id);
  });

  app.get('/api/servers/:id/mornicraft', { schema: { params } }, async (request) => {
    ctx.access.assertAny(requireAuth(request).user, request.params.id);
    return craftAttack.morniCraft(request.params.id);
  });

  app.put(
    '/api/servers/:id/mornicraft',
    { schema: { params, body: morniCraftSettingsSchema } },
    async (request) => {
      ctx.access.assert(requireAuth(request).user, request.params.id, 'config');
      const state = await craftAttack.setMorniCraft(request.params.id, request.body);
      ctx.audit.record(actorOf(request), 'server.mornicraft', request.params.id, {});
      return state;
    },
  );

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

  // No login: the personal command page, opened from the link /info shows in the game.
  app.get(
    '/api/public/commands/:slug/:name',
    {
      schema: {
        params: z.object({
          slug: z.string().min(1).max(60),
          // Java names (3–16 letters, digits, _) and Bedrock names via Floodgate (".Name").
          name: z.string().regex(/^\.?\w{1,32}$/), // eslint-disable-line ts-patterns/require-regex-example -- "Steve_1", ".BedrockKid" ok; "a/b" not
        }),
      },
      config: PUBLIC_LIMIT,
    },
    async (request) => craftAttack.playerCommands(request.params.slug, request.params.name),
  );
  // The team dashboard (/teamdashboard in the game): no panel login – the personal key from the link counts, it is
  // checked against the file the plugin wrote; what it shows and allows follows the rank in the game.
  app.get('/api/public/team/:slug', { schema: { params: slugParams }, config: TEAM_LIMIT }, async (request) =>
    craftAttack.teamView(request.params.slug, keyOf(request.headers)),
  );
  app.post(
    '/api/public/team/:slug/action',
    { schema: { params: slugParams, body: teamActionSchema }, config: TEAM_ACTION_LIMIT },
    async (request) => {
      craftAttack.teamAction(request.params.slug, keyOf(request.headers), request.body);
      return { ok: true };
    },
  );
  app.put(
    '/api/public/team/:slug/rules',
    {
      schema: { params: slugParams, body: z.object({ rules: morniCraftSettingsSchema.shape.rules }) },
      config: TEAM_ACTION_LIMIT,
    },
    async (request) => {
      await craftAttack.teamRules(request.params.slug, keyOf(request.headers), request.body.rules);
      return { ok: true };
    },
  );
  // The badges' resource pack: Minecraft clients load it without logging in (the address is in the plugin's config).
  app.get(
    '/api/public/packs/:file',
    {
      schema: {
        // "freunde.zip": the server's public name. https://regex101.com/?flavor=javascript&regex=%5E%5Ba-z0-9-%5D%7B1%2C60%7D%5C.zip%24&testString=freunde.zip
        params: z.object({ file: z.string().regex(/^[a-z0-9-]{1,60}\.zip$/) }),
      },
      config: PUBLIC_LIMIT,
    },
    async (request, reply) => {
      const pack = craftAttack.badgePack(request.params.file.slice(0, -ZIP_SUFFIX.length));
      if (!pack) throw notFound('pack_not_found');
      return reply
        .header('content-type', 'application/zip')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(pack);
    },
  );
}
