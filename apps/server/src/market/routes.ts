import { z } from 'zod';
import {
  MARKET_SOURCES,
  SOFTWARE,
  contentFileSchema,
  marketInstallSchema,
  marketSearchSchema,
  type MarketSource,
} from '@mornihosting/shared';
import { actorOf, requireAuth } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { HTTP_NO_CONTENT, HTTP_PAYLOAD_TOO_LARGE } from '../lib/http-status.js';
import { eachFile } from '../lib/multipart.js';
import type { ServerService } from '../servers/service.js';
import type { MarketService } from './service.js';

const idParams = z.object({ id: z.string().min(1) });
const UPDATE_CHECKS_PER_MINUTE = 6;

export interface SourceInfo {
  readonly source: MarketSource;
  readonly available: boolean;
  /** Why a source is off: not offered for this software, or the CurseForge key is missing. */
  readonly reason: 'software' | 'key' | null;
}

function reasonOf(offered: boolean, keyMissing: boolean): SourceInfo['reason'] {
  if (!offered) return 'software';
  return keyMissing ? 'key' : null;
}

export function registerMarketRoutes(
  app: Api,
  ctx: AppContext,
  servers: ServerService,
  market: MarketService,
): void {
  const allow = (request: Parameters<typeof requireAuth>[0], serverId: string): void => {
    ctx.access.assert(requireAuth(request).user, serverId, 'plugins');
    servers.row(serverId);
  };

  app.get(
    '/api/servers/:id/market/sources',
    { schema: { params: idParams } },
    async (request): Promise<SourceInfo[]> => {
      allow(request, request.params.id);
      const software = SOFTWARE[servers.row(request.params.id).software];
      const offered: Readonly<Record<MarketSource, boolean>> = {
        modrinth: software.modrinthLoaders.length > 0,
        hangar: software.hangarPlatform !== null,
        spiget: software.spiget,
        curseforge: software.curseforge !== null,
      };
      const hasKey = ctx.settings.curseforgeKey() !== null;
      return MARKET_SOURCES.map((source) => {
        const keyMissing = source === 'curseforge' && offered[source] && !hasKey;
        return {
          source,
          available: offered[source] && !keyMissing,
          reason: reasonOf(offered[source], keyMissing),
        };
      });
    },
  );

  app.get(
    '/api/servers/:id/market/search',
    { schema: { params: idParams, querystring: marketSearchSchema } },
    async (request) => {
      allow(request, request.params.id);
      const { source, q, sort, page, compatibleOnly } = request.query;
      return market.search(request.params.id, source, {
        q,
        sort,
        page,
        compatibleOnly: compatibleOnly === 'true',
      });
    },
  );

  app.get(
    '/api/servers/:id/market/:source/:projectId/versions',
    {
      schema: {
        params: idParams.extend({
          source: marketInstallSchema.shape.source,
          projectId: marketInstallSchema.shape.projectId,
        }),
      },
    },
    async (request) => {
      allow(request, request.params.id);
      return market.versions(request.params.id, request.params.source, request.params.projectId);
    },
  );

  app.post(
    '/api/servers/:id/market/install',
    { schema: { params: idParams, body: marketInstallSchema } },
    async (request) => {
      allow(request, request.params.id);
      return market.install(request.params.id, request.body, actorOf(request));
    },
  );

  // Update counts for every server the person may manage plugins on (dashboard badges, tab dot).
  app.get('/api/content/updates', async (request) => {
    const user = requireAuth(request).user;
    const ids = servers
      .list(user)
      .map((s) => s.id)
      .filter((id) => ctx.access.permissionsFor(user, id).includes('plugins'));
    return market.updateCounts(ids);
  });

  app.get('/api/servers/:id/content', { schema: { params: idParams } }, async (request) => {
    allow(request, request.params.id);
    return market.list(request.params.id);
  });

  app.post(
    '/api/servers/:id/content/check-updates',
    {
      schema: { params: idParams },
      config: { rateLimit: { max: UPDATE_CHECKS_PER_MINUTE, timeWindow: '1 minute' } },
    },
    async (request) => {
      allow(request, request.params.id);
      return market.checkUpdates(request.params.id);
    },
  );

  app.post(
    '/api/servers/:id/content/update',
    { schema: { params: idParams, body: contentFileSchema } },
    async (request) => {
      allow(request, request.params.id);
      return market.update(request.params.id, request.body.fileName, actorOf(request));
    },
  );

  app.post(
    '/api/servers/:id/content/toggle',
    { schema: { params: idParams, body: contentFileSchema.extend({ enabled: z.boolean() }) } },
    async (request, reply) => {
      allow(request, request.params.id);
      market.setEnabled(request.params.id, request.body.fileName, request.body.enabled, actorOf(request));
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  app.post(
    '/api/servers/:id/content/delete',
    { schema: { params: idParams, body: contentFileSchema } },
    async (request, reply) => {
      allow(request, request.params.id);
      market.remove(request.params.id, request.body.fileName, actorOf(request));
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  app.post('/api/servers/:id/content/upload', { schema: { params: idParams } }, async (request) => {
    allow(request, request.params.id);
    const uploaded = await eachFile(
      request.files({ limits: { fileSize: ctx.config.pluginUploadBytes } })[Symbol.asyncIterator](),
      async (file) => {
        await market.upload(request.params.id, file.filename, file.file, actorOf(request));
        if (file.file.truncated) throw new AppError(HTTP_PAYLOAD_TOO_LARGE, 'file_too_large');
        return file.filename;
      },
    );
    return { uploaded, content: market.list(request.params.id) };
  });
}
