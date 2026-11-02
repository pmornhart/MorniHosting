import { Secret, TOTP } from 'otpauth';
import { z } from 'zod';
import type { DnsProvider } from '@mornihosting/shared';
import { AppError } from '../lib/errors.js';
import { fetchResponse, UpstreamError } from '../lib/http-client.js';
import { HTTP_BAD_GATEWAY, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED } from '../lib/http-status.js';

/**
 * The few DNS calls the panel needs at Cloudflare and IONOS: list the domains (zones) a key may manage,
 * find a record, and create, change or delete it. Records point at a home connection whose IP changes,
 * so they get a short time to live.
 * https://developers.cloudflare.com/api/resources/dns/subresources/records/
 * https://developer.hosting.ionos.de/docs/dns
 */

/** Seconds; the shortest both providers accept, so a new home IP spreads quickly. */
const TTL = 60;
const MESSAGE_MAX = 200;
const ZONES_PER_PAGE = 50;
const AUTH_FAILURES: readonly number[] = [HTTP_UNAUTHORIZED, HTTP_FORBIDDEN];

export interface SrvData {
  readonly priority: number;
  readonly weight: number;
  readonly port: number;
  readonly target: string;
}

export type DnsRecordInput =
  | { readonly type: 'A'; readonly name: string; readonly ip: string }
  | { readonly type: 'SRV'; readonly name: string; readonly srv: SrvData };

export interface DnsZone {
  readonly id: string;
  readonly name: string;
}

export interface DnsClient {
  readonly zones: () => Promise<DnsZone[]>;
  /** The id of an existing record with this type and name, e.g. one made by hand before. */
  readonly find: (
    zoneId: string,
    type: DnsRecordInput['type'] | 'AAAA',
    name: string,
  ) => Promise<string | null>;
  readonly create: (zoneId: string, record: DnsRecordInput) => Promise<string>;
  readonly update: (zoneId: string, id: string, record: DnsRecordInput) => Promise<void>;
  /** Deleting a record that is already gone counts as done. */
  readonly remove: (zoneId: string, id: string) => Promise<void>;
}

export type DnsClientFactory = (provider: DnsProvider, token: string) => DnsClient;

/** JSON from text, or null when it is none. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Collapses line breaks so a message fits on one line. */
function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, ' ').trim();
}

/** The body as JSON, or null when there is none (e.g. an empty answer to DELETE). */
async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Calls one provider's API and turns its refusals into errors the panel can show. */
function caller(base: string, headers: Record<string, string>, messageOf: (body: unknown) => string | null) {
  const host = new URL(base).host;
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    try {
      return await fetchResponse(`${base}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const where = err instanceof UpstreamError ? new URL(err.url).host : host;
      throw new AppError(HTTP_BAD_GATEWAY, 'dns_unreachable', { host: where }, { cause: err });
    }
  };
  const refuse = async (response: Response): Promise<AppError> => {
    if (AUTH_FAILURES.includes(response.status))
      return new AppError(HTTP_BAD_GATEWAY, 'dns_unauthorized', { host });
    const message = messageOf(await bodyOf(response)) ?? `HTTP ${response.status}`;
    return new AppError(HTTP_BAD_GATEWAY, 'dns_rejected', { message: message.slice(0, MESSAGE_MAX) });
  };
  const json = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await send(method, path, body);
    if (!response.ok) throw await refuse(response);
    return bodyOf(response);
  };
  const remove = async (path: string): Promise<void> => {
    const response = await send('DELETE', path);
    if (!response.ok && response.status !== HTTP_NOT_FOUND) throw await refuse(response);
  };
  return { json, remove };
}

/* ---------- Cloudflare ---------- */

const cfErrors = z.object({ errors: z.array(z.object({ message: z.string() })) });
const cfZones = z.object({ result: z.array(z.object({ id: z.string(), name: z.string() })) });
const cfRecords = z.object({ result: z.array(z.object({ id: z.string() })) });
const cfRecord = z.object({ result: z.object({ id: z.string() }) });

function cloudflareBody(record: DnsRecordInput): Record<string, unknown> {
  // Minecraft is not web traffic: Cloudflare's proxy ("orange cloud") must stay off.
  return record.type === 'A'
    ? { type: 'A', name: record.name, content: record.ip, ttl: TTL, proxied: false }
    : { type: 'SRV', name: record.name, ttl: TTL, data: record.srv };
}

function cloudflare(token: string): DnsClient {
  const api = caller('https://api.cloudflare.com/client/v4', { authorization: `Bearer ${token}` }, (body) => {
    const parsed = cfErrors.safeParse(body);
    return parsed.success ? (parsed.data.errors[0]?.message ?? null) : null;
  });
  const zone = (id: string): string => `/zones/${encodeURIComponent(id)}/dns_records`;
  return {
    zones: async () => cfZones.parse(await api.json('GET', `/zones?per_page=${ZONES_PER_PAGE}`)).result,
    find: async (zoneId, type, name) => {
      const query = `?type=${type}&name=${encodeURIComponent(name)}`;
      return cfRecords.parse(await api.json('GET', `${zone(zoneId)}${query}`)).result[0]?.id ?? null;
    },
    create: async (zoneId, record) =>
      cfRecord.parse(await api.json('POST', zone(zoneId), cloudflareBody(record))).result.id,
    update: async (zoneId, id, record) => {
      await api.json('PUT', `${zone(zoneId)}/${encodeURIComponent(id)}`, cloudflareBody(record));
    },
    remove: (zoneId, id) => api.remove(`${zone(zoneId)}/${encodeURIComponent(id)}`),
  };
}

/* ---------- IONOS ---------- */

const ionosErrors = z.array(z.object({ message: z.string() }));
const ionosZones = z.array(z.object({ id: z.string(), name: z.string() }));
const ionosZone = z.object({ records: z.array(z.object({ id: z.string() })).catch([]) });
const ionosCreated = z.array(z.object({ id: z.string() })).min(1);

/** IONOS keeps the SRV priority in its own field and "weight port target" as the content. */
function ionosBody(record: DnsRecordInput): Record<string, unknown> {
  return record.type === 'A'
    ? { name: record.name, type: 'A', content: record.ip, ttl: TTL, disabled: false }
    : {
        name: record.name,
        type: 'SRV',
        content: `${record.srv.weight} ${record.srv.port} ${record.srv.target}`,
        prio: record.srv.priority,
        ttl: TTL,
        disabled: false,
      };
}

function ionos(token: string): DnsClient {
  const api = caller('https://api.hosting.ionos.com/dns/v1', { 'x-api-key': token }, (body) => {
    const parsed = ionosErrors.safeParse(body);
    return parsed.success ? (parsed.data[0]?.message ?? null) : null;
  });
  const zone = (id: string): string => `/zones/${encodeURIComponent(id)}`;
  return {
    zones: async () => ionosZones.parse(await api.json('GET', '/zones')),
    find: async (zoneId, type, name) => {
      const query = `?recordType=${type}&recordName=${encodeURIComponent(name)}`;
      return ionosZone.parse(await api.json('GET', `${zone(zoneId)}${query}`)).records[0]?.id ?? null;
    },
    create: async (zoneId, record) =>
      ionosCreated.parse(await api.json('POST', `${zone(zoneId)}/records`, [ionosBody(record)]))[0]?.id ?? '',
    update: async (zoneId, id, record) => {
      await api.json('PUT', `${zone(zoneId)}/records/${encodeURIComponent(id)}`, ionosBody(record));
    },
    remove: (zoneId, id) => api.remove(`${zone(zoneId)}/records/${encodeURIComponent(id)}`),
  };
}

/* ---------- INWX ---------- */

/** INWX logs in with the account's user name and password (plus the 2FA secret if 2FA is on). */
const inwxCredentials = z.object({
  user: z.string().min(1),
  pass: z.string().min(1),
  otp: z.string().optional(),
});
const inwxAnswer = z.object({
  code: z.coerce.number(),
  msg: z.string().catch(''),
  resData: z.unknown().optional(),
});
const inwxLogin = z.object({ tfa: z.union([z.string(), z.number()]).optional() }).catch({});
const inwxDomains = z
  .object({ domains: z.array(z.object({ domain: z.string() })).catch([]) })
  .catch({ domains: [] });
const inwxRecords = z
  .object({ record: z.array(z.object({ id: z.union([z.number(), z.string()]) })).catch([]) })
  .catch({ record: [] });
const inwxCreated = z.object({ id: z.union([z.number(), z.string()]) });
/** Answers from 1000 up to 1999 mean success; 2200–2202 is a failed login. */
const INWX_OK_FROM = 1000;
const INWX_OK_UNTIL = 2000;
const INWX_AUTH_FROM = 2200;
const INWX_AUTH_UNTIL = 2203;
const INWX_GONE = 2303;
/** INWX does not accept a shorter time to live. */
const INWX_TTL = 300;
// Line breaks in an answer: "a\r\n  b" becomes "a b".
// https://regex101.com/?flavor=javascript&regex=%5Cs*%5B%5Cr%5Cn%5D%2B%5Cs*&flags=g&testString=a%0D%0A%20%20b
const LINE_BREAKS = /\s*[\r\n]+\s*/g;
const NO_2FA = '0';
// Spaces in a pasted 2FA secret: "JBSW Y3DP" becomes "JBSWY3DP".
// https://regex101.com/?flavor=javascript&regex=%5Cs&flags=g&testString=JBSW%20Y3DP
const WHITESPACE = /\s/g;

class InwxRefusal extends Error {
  override readonly name = 'InwxRefusal';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** INWX names are relative to the domain: "reich" for reich.example.de, "" for the domain itself. */
function relativeName(name: string, zone: string): string {
  return name === zone ? '' : name.slice(0, -(zone.length + 1));
}

function inwx(token: string): DnsClient {
  const parsed = inwxCredentials.safeParse(
    (() => {
      try {
        return JSON.parse(token) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  const endpoint = 'https://api.domrobot.com/jsonrpc/';
  const host = new URL(endpoint).host;
  const session: { cookie: string | null } = { cookie: null };
  const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const response = await (async () => {
      try {
        return await fetchResponse(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(session.cookie ? { cookie: session.cookie } : {}),
          },
          body: JSON.stringify({ method, params }),
        });
      } catch (err) {
        throw new AppError(HTTP_BAD_GATEWAY, 'dns_unreachable', { host }, { cause: err });
      }
    })();
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (cookie) session.cookie = cookie;
    // INWX labels its JSON "text/json"; read the text so an odd answer can be shown as it is.
    const text = await response.text().catch(() => '');
    const answer = inwxAnswer.safeParse(parseJson(text));
    if (!answer.success)
      throw new AppError(HTTP_BAD_GATEWAY, 'dns_rejected', {
        message: `${method}: HTTP ${response.status} ${oneLine(text).slice(0, MESSAGE_MAX) || '(leer)'}`,
      });
    const { code, msg } = answer.data;
    if (code >= INWX_OK_FROM && code < INWX_OK_UNTIL) return answer.data.resData;
    // INWX answers "Authentication error" for a wrong user name or password (or 2FA code).
    if (code >= INWX_AUTH_FROM && code < INWX_AUTH_UNTIL)
      throw new AppError(HTTP_BAD_GATEWAY, 'dns_inwx_login');
    throw new InwxRefusal(code, msg);
  };
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    try {
      return await rpc(method, params);
    } catch (err) {
      if (err instanceof InwxRefusal)
        throw new AppError(HTTP_BAD_GATEWAY, 'dns_rejected', { message: err.message.slice(0, MESSAGE_MAX) });
      throw err;
    }
  };
  const login = async (): Promise<void> => {
    if (session.cookie) return;
    if (!parsed.success) throw new AppError(HTTP_BAD_GATEWAY, 'dns_unauthorized', { host });
    const { user, pass, otp } = parsed.data;
    const answer = inwxLogin.parse(await call('account.login', { user, pass }));
    if (answer.tfa === undefined || String(answer.tfa) === NO_2FA) return;
    if (!otp) throw new AppError(HTTP_BAD_GATEWAY, 'dns_inwx_2fa');
    const tan = new TOTP({ secret: Secret.fromBase32(otp.replace(WHITESPACE, '').toUpperCase()) }).generate();
    try {
      await call('account.unlock', { tan });
    } catch (err) {
      if (err instanceof AppError && err.code === 'dns_inwx_login')
        throw new AppError(HTTP_BAD_GATEWAY, 'dns_inwx_2fa_wrong');
      throw err;
    }
  };
  const body = (zone: string, record: DnsRecordInput): Record<string, unknown> =>
    record.type === 'A'
      ? { type: 'A', name: relativeName(record.name, zone), content: record.ip, ttl: INWX_TTL }
      : {
          type: 'SRV',
          name: relativeName(record.name, zone),
          content: `${record.srv.weight} ${record.srv.port} ${record.srv.target}`,
          prio: record.srv.priority,
          ttl: INWX_TTL,
        };
  return {
    zones: async () => {
      await login();
      return inwxDomains
        .parse(await call('nameserver.list', {}))
        .domains.map((d) => ({ id: d.domain, name: d.domain }));
    },
    find: async (zone, type, name) => {
      await login();
      const found = inwxRecords.parse(
        await call('nameserver.info', { domain: zone, type, name: relativeName(name, zone) }),
      );
      const id = found.record[0]?.id;
      return id === undefined ? null : String(id);
    },
    create: async (zone, record) => {
      await login();
      return String(
        inwxCreated.parse(await call('nameserver.createRecord', { domain: zone, ...body(zone, record) })).id,
      );
    },
    update: async (zone, id, record) => {
      await login();
      await call('nameserver.updateRecord', { id: Number(id), ...body(zone, record) });
    },
    remove: async (_zone, id) => {
      await login();
      try {
        await rpc('nameserver.deleteRecord', { id: Number(id) });
      } catch (err) {
        if (!(err instanceof InwxRefusal && err.code === INWX_GONE)) throw err;
      }
    },
  };
}

const CLIENTS: Readonly<Record<DnsProvider, (token: string) => DnsClient>> = { cloudflare, ionos, inwx };

export const createDnsClient: DnsClientFactory = (provider, token) => CLIENTS[provider](token);
