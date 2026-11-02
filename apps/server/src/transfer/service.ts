import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { TransferCode, TransferResult } from '@mornihosting/shared';
import type { AppContext } from '../context.js';
import { settings } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';

/**
 * The move code: every panel setting (domain, mail, Discord bot, NetBird, DNS, HTTPS, DDoS, sign-up)
 * in one text. Secrets are stored sealed with this panel's MH_SECRET, so they are opened here and sealed
 * again with the other panel's key; on the way the whole code is encrypted with a password of the admin's
 * choice (scrypt + AES-256-GCM). Servers, users and files stay where they are.
 */

const PREFIX = 'MH1-';
const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const CIPHER = 'aes-256-gcm';
/** scrypt cost: about 0.1 s per try, so guessing the password from a leaked code stays slow. */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const SEALED_PREFIX = 'v1:';
const SECRET_MARK = '$secret';
// Line breaks and spaces that sneak in when a long code is copied: "MH1-ab\n cd" becomes "MH1-abcd".
// https://regex101.com/?flavor=javascript&regex=%5Cs%2B&flags=gu&testString=MH1-ab%0A%20cd
const WHITESPACE = /\s+/gu;

interface Payload {
  readonly v: number;
  readonly from: string;
  readonly at: string;
  readonly settings: Record<string, unknown>;
}

export interface TransferService {
  readonly exportCode: (password: string) => TransferCode;
  readonly importCode: (code: string, password: string) => Omit<TransferResult, 'restarting'>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Applies `leaf` to every string and `node` to every object, depth first. */
function walk(
  value: unknown,
  leaf: (text: string) => unknown,
  node: (obj: Record<string, unknown>) => unknown,
): unknown {
  if (typeof value === 'string') return leaf(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, leaf, node));
  if (!isRecord(value)) return value;
  const replaced = node(value);
  if (replaced !== value) return replaced;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, leaf, node)]));
}

const keyFor = (password: string, salt: Buffer): Buffer => scryptSync(password, salt, KEY_BYTES, SCRYPT);

export function createTransferService(ctx: AppContext): TransferService {
  const exportCode: TransferService['exportCode'] = (password) => {
    const rows = ctx.db.select().from(settings).all();
    // Sealed values become { $secret: plain } so the other panel can seal them with its own key.
    const open = (text: string): unknown => {
      if (!text.startsWith(SEALED_PREFIX)) return text;
      try {
        return { [SECRET_MARK]: ctx.secrets.decrypt(text) };
      } catch {
        return text;
      }
    };
    const payload: Payload = {
      v: FORMAT_VERSION,
      from: ctx.settings.get().panelDomain,
      at: new Date().toISOString(),
      settings: Object.fromEntries(rows.map((row) => [row.key, walk(row.value, open, (o) => o)])),
    };
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, keyFor(password, salt), iv);
    const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(payload))), cipher.final()]);
    const code = PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString('base64url');
    return { code, parts: rows.map((row) => row.key) };
  };

  const importCode: TransferService['importCode'] = (code, password) => {
    const compact = code.replace(WHITESPACE, '');
    if (!compact.startsWith(PREFIX)) throw badRequest('transfer_code_invalid');
    const raw = Buffer.from(compact.slice(PREFIX.length), 'base64url');
    const header = SALT_BYTES + IV_BYTES + TAG_BYTES;
    if (raw.length <= header) throw badRequest('transfer_code_invalid');
    const salt = raw.subarray(0, SALT_BYTES);
    const iv = raw.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
    const tag = raw.subarray(SALT_BYTES + IV_BYTES, header);
    const payload = (() => {
      try {
        const decipher = createDecipheriv(CIPHER, keyFor(password, salt), iv, { authTagLength: TAG_BYTES });
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(raw.subarray(header)), decipher.final()]);
        return JSON.parse(gunzipSync(plain).toString('utf8')) as unknown;
      } catch {
        // A wrong password and a damaged code look the same to AES-GCM.
        throw badRequest('transfer_password_wrong');
      }
    })();
    if (!isRecord(payload) || payload.v !== FORMAT_VERSION || !isRecord(payload.settings))
      throw badRequest('transfer_code_invalid');
    const seal = (obj: Record<string, unknown>): unknown => {
      const keys = Object.keys(obj);
      const secret = obj[SECRET_MARK];
      return keys.length === 1 && typeof secret === 'string' ? ctx.secrets.encrypt(secret) : obj;
    };
    const entries = Object.entries(payload.settings);
    ctx.db.transaction((tx) => {
      entries.forEach(([key, value]) => {
        const sealed = walk(value, (text) => text, seal);
        tx.insert(settings)
          .values({ key, value: sealed })
          .onConflictDoUpdate({ target: settings.key, set: { value: sealed } })
          .run();
      });
    });
    return { parts: entries.map(([key]) => key), from: typeof payload.from === 'string' ? payload.from : '' };
  };

  return { exportCode, importCode };
}
