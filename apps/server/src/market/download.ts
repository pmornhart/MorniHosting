import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AppError } from '../lib/errors.js';
import { fetchResponse, UpstreamError, upstreamToAppError } from '../lib/http-client.js';
import { HTTP_PAYLOAD_TOO_LARGE, HTTP_UNPROCESSABLE } from '../lib/http-status.js';
import { MS_PER_SECOND } from '../lib/units.js';
import type { FileToDownload } from './types.js';

/**
 * Downloads a marketplace file without trusting anyone: HTTPS only, every redirect must stay on the
 * hosts of the four marketplaces, a size cap while streaming, and the hash checked when the API gave one.
 */

const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  'cdn.modrinth.com',
  'hangarcdn.papermc.io',
  'hangar.papermc.io',
  'api.spiget.org',
  'cdn.spiget.org',
  'edge.forgecdn.net',
  'mediafilez.forgecdn.net',
  'media.forgecdn.net',
  // Only reached through the Geyser one-click (market/geysermc.ts), always with a sha256.
  'download.geysermc.org',
]);

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_SECONDS = 180;
const REDIRECT_FROM = 300;
const REDIRECT_UNTIL = 400;
const TEMP_ID_BYTES = 6;

function assertAllowed(url: URL): void {
  if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new AppError(HTTP_UNPROCESSABLE, 'market_download_host', { host: url.hostname });
  }
}

async function follow(url: string, hops: number): Promise<Response> {
  const parsed = new URL(url);
  assertAllowed(parsed);
  const response = await fetchResponse(parsed.href, {
    redirect: 'manual',
    headers: { accept: '*/*' },
    timeoutMs: DOWNLOAD_TIMEOUT_SECONDS * MS_PER_SECOND,
  });
  if (response.status >= REDIRECT_FROM && response.status < REDIRECT_UNTIL) {
    const location = response.headers.get('location');
    if (!location || hops >= MAX_REDIRECTS) throw new UpstreamError(url, response.status, 'bad redirect');
    return follow(new URL(location, parsed).href, hops + 1);
  }
  if (!response.ok || !response.body)
    throw new UpstreamError(url, response.status, `HTTP ${response.status}`);
  return response;
}

/** Files with a known hash are kept here once, so the next server with the same plugin needs no download. */
const cacheName = (file: FileToDownload): string | null =>
  file.hash ? `${file.hash.algorithm}-${file.hash.value.toLowerCase()}` : null;

/**
 * Streams the file into `dir` under a temporary name and returns that path once size and hash are fine.
 * With `cacheDir`, a file whose hash the API gave is taken from (and stored in) that folder: the hash proves
 * it is the same file, so the second Geyser or Voice-Chat install is a local copy.
 */
export async function downloadVerified(
  file: FileToDownload,
  dir: string,
  maxBytes: number,
  cacheDir?: string,
): Promise<string> {
  const cached = cacheDir && cacheName(file) ? path.join(cacheDir, cacheName(file) ?? '') : null;
  if (cached && fs.existsSync(cached) && fs.statSync(cached).size <= maxBytes) {
    const copy = path.join(dir, `.${crypto.randomBytes(TEMP_ID_BYTES).toString('hex')}.download`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(cached, copy);
    return copy;
  }
  const temp = await fetchVerified(file, dir, maxBytes);
  if (cached) {
    try {
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.copyFileSync(temp, `${cached}.part`);
      fs.renameSync(`${cached}.part`, cached);
    } catch {
      // A full disk only costs the next download; the file itself is fine.
    }
  }
  return temp;
}

async function fetchVerified(file: FileToDownload, dir: string, maxBytes: number): Promise<string> {
  const response = await (async () => {
    try {
      return await follow(file.url, 0);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw upstreamToAppError(err, 'market_unavailable');
    }
  })();
  const hash = file.hash ? crypto.createHash(file.hash.algorithm) : null;
  const state = { bytes: 0 };
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      state.bytes += chunk.length;
      if (state.bytes > maxBytes) {
        callback(new AppError(HTTP_PAYLOAD_TOO_LARGE, 'file_too_large'));
        return;
      }
      hash?.update(chunk);
      callback(null, chunk);
    },
  });
  const temp = path.join(dir, `.${crypto.randomBytes(TEMP_ID_BYTES).toString('hex')}.download`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      guard,
      fs.createWriteStream(temp),
    );
  } catch (err) {
    fs.rmSync(temp, { force: true });
    if (err instanceof AppError) throw err;
    throw upstreamToAppError(err, 'market_unavailable');
  }
  if (hash && file.hash && hash.digest('hex').toLowerCase() !== file.hash.value.toLowerCase()) {
    fs.rmSync(temp, { force: true });
    throw new AppError(HTTP_UNPROCESSABLE, 'market_hash_mismatch');
  }
  return temp;
}
