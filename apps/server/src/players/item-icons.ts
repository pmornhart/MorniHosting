import fs from 'node:fs';
import path from 'node:path';
import { itemWikiName } from '@mornihosting/shared';
import { z } from 'zod';
import type { Api, AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { fetchResponse } from '../lib/http-client.js';

/**
 * Item and mob pictures for the player page. The panel fetches each one once from the Minecraft Wiki and keeps
 * it in its data folder (nothing in the repository); misses are remembered so an unknown modded item is not
 * asked for again and again. The browser only ever talks to the panel.
 */
const WIKI = 'https://minecraft.wiki/images';
const MAX_BYTES = 256 * 1024;
const CACHE_SECONDS = 7 * 86400;
const MISS_RETRY_MS = 86400 * 1000;
/** Pictures are cached; this only stops someone from asking for thousands of made-up items. */
const ICON_LIMIT = { rateLimit: { max: 600, timeWindow: '1 minute' } };
const PNG = 'image/png';
// Vanilla ids. Matches "golden_pickaxe", "oak_log"; rejects "../x", "Golden" and anything with a namespace.
// https://regex101.com/?flavor=javascript&regex=%5E%5Ba-z0-9_%5D%7B1%2C64%7D%24&testString=golden_pickaxe%0A..%2Fx%0AGolden
const ID = /^[a-z0-9_]{1,64}$/;
const params = z.object({ kind: z.enum(['item', 'mob']), id: z.string().regex(ID) });

/** "golden_pickaxe" → "Golden_Pickaxe" (spawn eggs keep every word capitalised). */
const title = (id: string): string =>
  id
    .split('_')
    .map((w) => (w ? `${w[0]?.toUpperCase()}${w.slice(1)}` : w))
    .join('_');

export function registerItemIconRoutes(app: Api, ctx: AppContext): void {
  const dir = path.join(ctx.config.dataDir, 'cache', 'item-icons');
  const pending = new Map<string, Promise<string | null>>();

  const fetchOnce = async (kind: 'item' | 'mob', id: string): Promise<string | null> => {
    const file = path.join(dir, `${kind}-${id}.png`);
    const miss = `${file}.missing`;
    if (fs.existsSync(file)) return file;
    try {
      if (Date.now() - fs.statSync(miss).mtimeMs < MISS_RETRY_MS) return null;
    } catch {
      // no earlier miss
    }
    fs.mkdirSync(dir, { recursive: true });
    try {
      const name = kind === 'mob' ? `${title(id)}_Spawn_Egg` : itemWikiName(id);
      const response = await fetchResponse(`${WIKI}/Invicon_${name}.png`, { headers: { accept: PNG } });
      const data = Buffer.from(await response.arrayBuffer());
      if (!(response.headers.get('content-type') ?? '').startsWith(PNG) || data.length > MAX_BYTES)
        throw new Error('not a picture');
      fs.writeFileSync(file, data);
      return file;
    } catch (err) {
      ctx.log.debug({ err, kind, id }, 'item picture not available');
      fs.writeFileSync(miss, '');
      return null;
    }
  };

  // No login: the same pictures show on the team dashboard (/teamdashboard), which has no panel session.
  app.get('/api/item-icons/:kind/:id', { schema: { params }, config: ICON_LIMIT }, async (request, reply) => {
    const { kind, id } = request.params;
    const key = `${kind}/${id}`;
    const running = pending.get(key) ?? fetchOnce(kind, id);
    pending.set(key, running);
    const file = await running;
    pending.delete(key);
    if (!file) throw notFound('no_item_icon');
    return reply
      .header('content-type', PNG)
      .header('cache-control', `private, max-age=${CACHE_SECONDS}`)
      .send(fs.createReadStream(file));
  });
}
