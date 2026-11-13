import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { z } from 'zod';
import type { Api, AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { fetchJson, fetchResponse } from '../lib/http-client.js';
import { BYTES_PER_KB, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '../lib/units.js';

/**
 * Player faces straight from Mojang (Philip: a new skin did not show for days – the picture service in between
 * kept the old one). The panel asks Mojang for the account's current skin at most every few minutes, cuts out
 * the face with the hat layer and keeps the picture per skin in its data folder.
 */
const PROFILE = 'https://sessionserver.mojang.com/session/minecraft/profile';
const NAMES = 'https://api.mojang.com/users/profiles/minecraft';
const TEXTURES = 'https://textures.minecraft.net/texture/';
const PROFILE_FRESH_MINUTES = 5;
const MISS_FRESH_MINUTES = 30;
const PROFILE_FRESH_MS = PROFILE_FRESH_MINUTES * MS_PER_MINUTE;
const MISS_FRESH_MS = MISS_FRESH_MINUTES * MS_PER_MINUTE;
/** Names → accounts change rarely. */
const NAME_FRESH_HOURS = 6;
const NAME_FRESH_MS = NAME_FRESH_HOURS * MS_PER_HOUR;
/** After Mojang did not answer: next try. */
const RETRY_SECONDS = 30;
const RETRY_MS = RETRY_SECONDS * MS_PER_SECOND;
const BROWSER_SECONDS = PROFILE_FRESH_MS / MS_PER_SECOND;
const MAX_SKIN_KB = 64;
const MAX_SKIN_BYTES = MAX_SKIN_KB * BYTES_PER_KB;
/** Skin pixels of the face, and the size of the picture handed out. */
const FACE = 8;
const OUT = 64;
const SCALE = OUT / FACE;
/** Face and hat layer on the skin (both 8×8). */
const FACE_AT = { x: FACE, y: FACE } as const;
const HAT_X = 40;
const HAT_AT = { x: HAT_X, y: FACE } as const;
const OPAQUE = 255;
const RGBA = 4;
const TMP_BYTES = 4;
/** Lots of faces on one page (player lists), but nobody needs thousands a minute. */
const HEADS_PER_MINUTE = 600;
const HEAD_LIMIT = { rateLimit: { max: HEADS_PER_MINUTE, timeWindow: '1 minute' } };

// Account uuid with or without dashes, or a Java name. Matches "069a79f4-44e9-4726-a5be-fca90e38aaf5",
// "069a79f444e94726a5befca90e38aaf5", "Lena_Baut"; rejects "../x", "Finn 2015".
// https://regex101.com/?flavor=javascript&regex=%5E(%5B0-9a-f%5D%7B32%7D%7C%5B0-9a-f-%5D%7B36%7D%7C%5BA-Za-z0-9_%5D%7B3%2C16%7D)%24&testString=069a79f4-44e9-4726-a5be-fca90e38aaf5%0ALena_Baut%0A..%2Fx
const WHO = /^([0-9a-f]{32}|[0-9a-f-]{36}|[A-Za-z0-9_]{3,16})$/;
// Plain uuid (32 hex digits after removing dashes). Matches "069a79f444e94726a5befca90e38aaf5"; rejects "Lena_Baut".
// https://regex101.com/?flavor=javascript&regex=%5E%5B0-9a-f%5D%7B32%7D%24&testString=069a79f444e94726a5befca90e38aaf5%0ALena_Baut
const UUID = /^[0-9a-f]{32}$/;
// Skin hash at the end of a textures.minecraft.net address. Matches "…/texture/3b60a1f6d562f52aaebbf1434f1de147933a3affe0e764fa49ea057536623cd3"; rejects "…/texture/../x".
// https://regex101.com/?flavor=javascript&regex=%5E%5B0-9a-f%5D%7B16%2C80%7D%24&testString=3b60a1f6d562f52aaebbf1434f1de147933a3affe0e764fa49ea057536623cd3%0A..%2Fx
const SKIN_HASH = /^[0-9a-f]{16,80}$/;

const params = z.object({ who: z.string().regex(WHO) });
const nameSchema = z.object({ id: z.string() });
const profileSchema = z.object({
  properties: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
});
const texturesSchema = z.object({
  textures: z.object({ SKIN: z.object({ url: z.string() }).optional() }).default({}),
});

interface Known {
  readonly at: number;
  /** null: the account has no own skin (or does not exist). */
  readonly hash: string | null;
}

/** The face (with the hat layer on top) as a 64×64 picture, each skin pixel as an 8×8 block. */
export function faceOf(skin: Buffer): Buffer {
  const source = PNG.sync.read(skin);
  const out = new PNG({ width: OUT, height: OUT });
  const pixel = (x: number, y: number): readonly number[] => {
    const i = (y * source.width + x) * RGBA;
    return [...source.data.subarray(i, i + RGBA)];
  };
  const hatPixels = Array.from({ length: FACE * FACE }, (_, n) =>
    pixel(HAT_AT.x + (n % FACE), HAT_AT.y + Math.floor(n / FACE)),
  );
  // Old 64×32 skins often have a solid hat layer; Minecraft only shows it if some of it is see-through.
  const legacy = source.height < source.width;
  const hasHat = !legacy || hatPixels.some((p) => (p.at(-1) ?? 0) < OPAQUE);
  Array.from({ length: OUT * OUT }, (_, n) => n).forEach((n) => {
    const x = n % OUT;
    const y = Math.floor(n / OUT);
    const fx = Math.floor(x / SCALE);
    const fy = Math.floor(y / SCALE);
    const hat = hasHat ? pixel(HAT_AT.x + fx, HAT_AT.y + fy) : [];
    const [r, g, b] = (hat.at(-1) ?? 0) > 0 ? hat : pixel(FACE_AT.x + fx, FACE_AT.y + fy);
    out.data.set([r ?? 0, g ?? 0, b ?? 0, OPAQUE], n * RGBA);
  });
  return PNG.sync.write(out);
}

export function registerHeadRoutes(app: Api, ctx: AppContext): void {
  const dir = path.join(ctx.config.dataDir, 'cache', 'heads');
  const known = new Map<string, Known>();
  const names = new Map<string, { at: number; uuid: string | null }>();

  /** Last skin per account on disk: after a restart or while Mojang says "too many requests" the face stays right. */
  const lastFile = (uuid: string): string => path.join(dir, 'accounts', uuid);
  const lastKnown = (uuid: string): string | null => {
    try {
      const hash = fs.readFileSync(lastFile(uuid), 'utf8').trim();
      return SKIN_HASH.test(hash) ? hash : null;
    } catch {
      return null;
    }
  };
  const remember = (uuid: string, hash: string): void => {
    try {
      fs.mkdirSync(path.dirname(lastFile(uuid)), { recursive: true });
      fs.writeFileSync(lastFile(uuid), hash);
    } catch {
      // only a cache
    }
  };

  const uuidOf = async (who: string): Promise<string | null> => {
    const plain = who.replaceAll('-', '').toLowerCase();
    if (UUID.test(plain)) return plain;
    const key = who.toLowerCase();
    const cached = names.get(key);
    if (cached && Date.now() - cached.at < (cached.uuid ? NAME_FRESH_MS : RETRY_MS)) return cached.uuid;
    // Names change rarely: when Mojang does not answer, the uuid known so far stays.
    const uuid = await fetchJson(`${NAMES}/${encodeURIComponent(who)}`)
      .then((body) => nameSchema.parse(body).id.toLowerCase())
      .catch(() => cached?.uuid ?? null);
    names.set(key, { at: Date.now(), uuid });
    return uuid;
  };

  /**
   * The current skin of the account, asked again after a few minutes. When Mojang does not answer (it limits how
   * often one may ask), the last known skin stays and the next try comes soon – never a made-up face for half an hour.
   */
  const skinHash = async (uuid: string): Promise<string | null> => {
    const cached = known.get(uuid);
    const fresh = cached?.hash ? PROFILE_FRESH_MS : MISS_FRESH_MS;
    if (cached && Date.now() - cached.at < fresh) return cached.hash;
    const answer = await fetchJson(`${PROFILE}/${uuid}`)
      .then((body): { hash: string | null } => {
        const property = profileSchema.parse(body).properties.find((p) => p.name === 'textures');
        if (!property) return { hash: null };
        const textures = texturesSchema.parse(
          JSON.parse(Buffer.from(property.value, 'base64').toString('utf8')),
        );
        const url = textures.textures.SKIN?.url ?? '';
        const tail = url.split('/').pop() ?? '';
        const ok = url.replace('http://', 'https://').startsWith(TEXTURES) && SKIN_HASH.test(tail);
        return { hash: ok ? tail : null };
      })
      .catch(() => null);
    if (answer) {
      known.set(uuid, { at: Date.now(), hash: answer.hash });
      if (answer.hash) remember(uuid, answer.hash);
      return answer.hash;
    }
    const last = cached?.hash ?? lastKnown(uuid);
    // Try again in a moment (the "fresh" window minus the retry time has already passed).
    known.set(uuid, { at: Date.now() - (last ? PROFILE_FRESH_MS : MISS_FRESH_MS) + RETRY_MS, hash: last });
    return last;
  };

  const faceFile = async (hash: string): Promise<string> => {
    const file = path.join(dir, `${hash}.png`);
    if (fs.existsSync(file)) return file;
    const response = await fetchResponse(`${TEXTURES}${hash}`, { headers: { accept: 'image/png' } });
    const skin = Buffer.from(await response.arrayBuffer());
    if (skin.length > MAX_SKIN_BYTES) throw new Error('skin too big');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(TMP_BYTES).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, faceOf(skin));
    fs.renameSync(tmp, file);
    return file;
  };

  // No login: the same faces show on public pages (statistics, team dashboard).
  app.get('/api/heads/:who', { schema: { params }, config: HEAD_LIMIT }, async (request, reply) => {
    const uuid = await uuidOf(request.params.who);
    const hash = uuid ? await skinHash(uuid) : null;
    const file = hash ? await faceFile(hash).catch(() => null) : null;
    // No own skin (or Mojang unreachable the first time): the page draws a face itself.
    if (!file) throw notFound('no_head');
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', `public, max-age=${BROWSER_SECONDS}`)
      .send(fs.readFileSync(file));
  });
}
