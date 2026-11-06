import fs from 'node:fs';
import path from 'node:path';
import type { ImpressumInfo } from '@mornihosting/shared';
import { actorOf, requireAdmin } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { HTTP_NO_CONTENT, HTTP_PAYLOAD_TOO_LARGE } from '../lib/http-status.js';

/**
 * The imprint page (/impressum): an admin uploads one picture in the admin area, everybody sees it, also without
 * logging in. It lives only in this panel's data folder, never in the (public) repository.
 */

const BYTES_PER_KB = 1024;
const MAX_MB = 10;
const FOLDER = 'impressum';
/** Picture types by their first bytes (the file name and the browser's claim do not count). */
const KINDS: readonly { readonly ext: string; readonly type: string; readonly magic: Buffer }[] = [
  { ext: 'png', type: 'image/png', magic: Buffer.from('89504e47', 'hex') },
  { ext: 'jpg', type: 'image/jpeg', magic: Buffer.from('ffd8ff', 'hex') },
  { ext: 'webp', type: 'image/webp', magic: Buffer.from('52494646', 'hex') },
];
const SETTINGS_KEY = 'impressum';

interface Stored {
  readonly ext: string;
  readonly updatedAt: string;
}

export function registerImpressumRoutes(app: Api, ctx: AppContext): void {
  const dir = path.join(ctx.config.dataDir, FOLDER);
  const stored = (): Stored | null => ctx.settings.getValue<Stored>(SETTINGS_KEY) ?? null;
  const fileOf = (s: Stored): string => path.join(dir, `image.${s.ext}`);
  const info = (): ImpressumInfo => {
    const s = stored();
    return s && fs.existsSync(fileOf(s))
      ? { hasImage: true, updatedAt: s.updatedAt }
      : { hasImage: false, updatedAt: null };
  };

  app.get('/api/public/impressum', async (): Promise<ImpressumInfo> => info());

  app.get('/api/public/impressum/image', async (_request, reply) => {
    const s = stored();
    if (!s || !fs.existsSync(fileOf(s))) throw notFound('impressum_missing');
    const kind = KINDS.find((k) => k.ext === s.ext);
    return reply
      .type(kind?.type ?? 'application/octet-stream')
      .header('cache-control', 'public, max-age=300')
      .send(fs.createReadStream(fileOf(s)));
  });

  app.post('/api/impressum/image', async (request): Promise<ImpressumInfo> => {
    requireAdmin(request);
    const file = await request.file({ limits: { fileSize: MAX_MB * BYTES_PER_KB * BYTES_PER_KB } });
    if (!file) throw badRequest('upload_failed');
    const buffer = await file.toBuffer();
    if (file.file.truncated) throw new AppError(HTTP_PAYLOAD_TOO_LARGE, 'impressum_too_big', { mb: MAX_MB });
    const kind = KINDS.find((k) => buffer.subarray(0, k.magic.length).equals(k.magic));
    if (!kind) throw badRequest('impressum_not_image');
    fs.mkdirSync(dir, { recursive: true });
    const old = stored();
    if (old && old.ext !== kind.ext) fs.rmSync(fileOf(old), { force: true });
    const next: Stored = { ext: kind.ext, updatedAt: new Date().toISOString() };
    fs.writeFileSync(fileOf(next), buffer);
    ctx.settings.setValue(SETTINGS_KEY, next);
    ctx.audit.record(actorOf(request), 'impressum.update');
    return info();
  });

  app.delete('/api/impressum/image', async (request, reply) => {
    requireAdmin(request);
    const old = stored();
    if (old) fs.rmSync(fileOf(old), { force: true });
    ctx.settings.deleteValue(SETTINGS_KEY);
    return reply.code(HTTP_NO_CONTENT).send();
  });
}
