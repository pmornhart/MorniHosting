import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { tokenCreateSchema, type ApiTokenEntry } from '@mornihosting/shared';
import type { Api, AppContext } from '../context.js';
import { apiTokens } from '../db/schema.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { forbidden, notFound } from '../lib/errors.js';
import { HTTP_NO_CONTENT } from '../lib/http-status.js';
import { MS_PER_DAY } from '../lib/units.js';
import { actorOf, requireAuth } from './context.js';
import { API_TOKEN_PREFIX } from './hook.js';

/** Personal API keys. Only the hash is stored; the key itself is shown exactly once. */

const tokenParams = z.object({ tokenId: z.coerce.number().int().positive() });
const PREFIX_SHOWN = 10;

type Row = typeof apiTokens.$inferSelect;

const toEntry = (r: Row): ApiTokenEntry => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
  expiresAt: r.expiresAt,
  scopes: r.scopes ?? null,
});

export function registerTokenRoutes(app: Api, ctx: AppContext): void {
  app.get('/api/tokens', async (request) => {
    const auth = requireAuth(request);
    return ctx.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, auth.user.id))
      .orderBy(desc(apiTokens.id))
      .all()
      .map(toEntry);
  });

  app.post('/api/tokens', { schema: { body: tokenCreateSchema } }, async (request) => {
    const auth = requireAuth(request);
    // A key cannot make new keys; that needs a real login.
    if (auth.tokenId !== null) throw forbidden('session_required');
    const token = `${API_TOKEN_PREFIX}${randomToken()}`;
    const expiresAt = request.body.expiresInDays
      ? new Date(Date.now() + request.body.expiresInDays * MS_PER_DAY).toISOString()
      : null;
    const row = ctx.db
      .insert(apiTokens)
      .values({
        userId: auth.user.id,
        name: request.body.name,
        tokenHash: sha256Hex(token),
        prefix: token.slice(0, PREFIX_SHOWN),
        expiresAt,
        scopes: request.body.scopes,
      })
      .returning()
      .get();
    ctx.audit.record(actorOf(request), 'token.create', null, {
      name: row.name,
      expiresAt,
      scopes: row.scopes?.join(',') ?? 'alle',
    });
    return { token, entry: toEntry(row) };
  });

  app.delete('/api/tokens/:tokenId', { schema: { params: tokenParams } }, async (request, reply) => {
    const auth = requireAuth(request);
    const where = and(eq(apiTokens.id, request.params.tokenId), eq(apiTokens.userId, auth.user.id));
    const row = ctx.db.select().from(apiTokens).where(where).get();
    if (!row) throw notFound();
    ctx.db.delete(apiTokens).where(where).run();
    ctx.audit.record(actorOf(request), 'token.delete', null, { name: row.name });
    return reply.code(HTTP_NO_CONTENT).send();
  });
}
