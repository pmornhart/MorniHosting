import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { fetchResponse, UpstreamError } from '../lib/http-client.js';
import { HTTP_BAD_GATEWAY, HTTP_FORBIDDEN, HTTP_UNAUTHORIZED } from '../lib/http-status.js';

/**
 * The calls of Stalwart's management API (version 1.0, free edition) the panel needs. Stalwart 1.0 manages
 * everything over JMAP: `POST /jmap/` with the methods `x:<Object>/get|set|query` and the capability
 * `urn:stalwart:jmap`. https://stalw.art/docs/ref/
 * Only objects of the free (AGPL) edition are used: Domain, Account, DnsServer — no SCIM, no tenants.
 */

const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'] as const;
const MESSAGE_MAX = 200;
const AUTH_FAILURES: readonly number[] = [HTTP_UNAUTHORIZED, HTTP_FORBIDDEN];
const CALL_ID = 'c1';
const NEW_ID = 'new1';

export type StalwartDnsProvider =
  | { readonly kind: 'inwx'; readonly user: string; readonly pass: string; readonly otp?: string }
  | { readonly kind: 'cloudflare'; readonly token: string };

export interface StalwartDomain {
  readonly id: string;
  readonly name: string;
  readonly dnsServerId: string | null;
  readonly zoneFile: string;
}

export interface StalwartClient {
  /** Logs in once; throws `stalwart_login` on a wrong password. */
  readonly verify: () => Promise<void>;
  readonly domains: () => Promise<StalwartDomain[]>;
  readonly createDomain: (name: string) => Promise<string>;
  readonly setDomainDns: (domainId: string, dnsServerId: string | null) => Promise<void>;
  /** Finds the DNS server the panel created earlier (by its description) or creates it. */
  readonly ensureDnsServer: (provider: StalwartDnsProvider, description: string) => Promise<string>;
  readonly findAccount: (name: string, domainId: string) => Promise<string | null>;
  readonly createAccount: (name: string, domainId: string, password: string) => Promise<string>;
  readonly setAccountPassword: (accountId: string, password: string) => Promise<void>;
  /** Asks whether a login works (the sender account after creating it). */
  readonly canLogin: (username: string, password: string) => Promise<boolean>;
}

export type StalwartClientFactory = (url: string, username: string, password: string) => StalwartClient;

const methodResponse = z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]);
const envelope = z.object({ methodResponses: z.array(methodResponse) });
const setError = z.object({ type: z.string().catch('error'), description: z.string().nullish() });
const setAnswer = z.object({
  created: z.record(z.string(), z.object({ id: z.string() })).nullish(),
  notCreated: z.record(z.string(), setError).nullish(),
  notUpdated: z.record(z.string(), setError).nullish(),
});
const domainSchema = z.object({
  id: z.string(),
  name: z.string(),
  dnsManagement: z.object({ dnsServerId: z.string().nullish() }).catch({}).nullish(),
  dnsZoneFile: z.string().nullish(),
});
const accountSchema = z.object({
  id: z.string(),
  '@type': z.string().catch('User'),
  name: z.string().catch(''),
  domainId: z.string().nullish(),
});
const dnsServerSchema = z.object({ id: z.string(), description: z.string().catch('') });

const secret = (value: string) => ({ '@type': 'Value', secret: value });

/** The DNS server object for Stalwart, built from the access the panel already has. */
export function dnsServerObject(provider: StalwartDnsProvider, description: string): Record<string, unknown> {
  if (provider.kind === 'cloudflare')
    return { '@type': 'Cloudflare', description, secret: secret(provider.token) };
  return {
    '@type': 'Inwx',
    description,
    username: provider.user,
    password: secret(provider.pass),
    sharedSecret: provider.otp ? secret(provider.otp) : { '@type': 'None' },
    sandbox: false,
  };
}

const failure = (code: string, message: string): AppError =>
  new AppError(HTTP_BAD_GATEWAY, code, { message: message.slice(0, MESSAGE_MAX) });

export const createStalwartClient: StalwartClientFactory = (url, username, password) => {
  const origin = new URL(url).origin;
  const basic = (user: string, pass: string): string =>
    `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const adminAuth = basic(username, password);

  const send = async (path: string, auth: string, body?: unknown): Promise<Response> => {
    try {
      return await fetchResponse(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const host = err instanceof UpstreamError ? new URL(err.url).host : origin;
      throw new AppError(HTTP_BAD_GATEWAY, 'stalwart_unreachable', { host }, { cause: err });
    }
  };

  /** One JMAP method call; JMAP errors become `stalwart_rejected` with Stalwart's own description. */
  const call = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await send('/jmap/', adminAuth, {
      using: USING,
      methodCalls: [[method, args, CALL_ID]],
    });
    if (AUTH_FAILURES.includes(response.status)) throw failure('stalwart_login', `HTTP ${response.status}`);
    const text = await response.text();
    if (!response.ok) throw failure('stalwart_rejected', `${method}: HTTP ${response.status} ${text}`);
    const parsed = envelope.safeParse(JSON.parse(text || 'null'));
    if (!parsed.success) throw failure('stalwart_old_version', `${method}: ${text}`);
    const empty: Record<string, unknown> = {};
    const [name, answer] = parsed.data.methodResponses[0] ?? ['error', empty];
    if (name === 'error') {
      const type = String(answer['type'] ?? 'error');
      // An unknown method means a Stalwart before 1.0 (management over REST, no `x:` objects yet).
      if (type === 'unknownMethod' || type === 'unknownCapability')
        throw failure('stalwart_old_version', `${method}: ${type}`);
      if (type === 'forbidden') throw failure('stalwart_forbidden', `${method}`);
      throw failure('stalwart_rejected', `${method}: ${type} ${String(answer['description'] ?? '')}`);
    }
    return answer;
  };

  const set = async (object: string, args: Record<string, unknown>): Promise<string | null> => {
    const answer = setAnswer.parse(await call(`x:${object}/set`, args));
    const problem = answer.notCreated?.[NEW_ID] ?? Object.values(answer.notUpdated ?? {})[0];
    if (problem)
      throw failure(
        problem.type === 'forbidden' ? 'stalwart_forbidden' : 'stalwart_rejected',
        `x:${object}/set: ${problem.type} ${problem.description ?? ''}`,
      );
    return answer.created?.[NEW_ID]?.id ?? null;
  };
  const create = async (object: string, value: Record<string, unknown>): Promise<string> => {
    const id = await set(object, { create: { [NEW_ID]: value } });
    if (!id) throw failure('stalwart_rejected', `x:${object}/set: no id`);
    return id;
  };
  const list = async <TValue>(object: string, schema: z.ZodType<TValue>, properties?: string[]) => {
    const answer = await call(`x:${object}/get`, { ids: null, ...(properties ? { properties } : {}) });
    const items = Array.isArray(answer['list']) ? answer['list'] : [];
    return items.flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  };

  const passwordCredential = (value: string) => ({ '0': { '@type': 'Password', secret: value } });

  return {
    verify: async () => {
      const response = await send('/jmap/session', adminAuth);
      if (AUTH_FAILURES.includes(response.status)) throw failure('stalwart_login', `HTTP ${response.status}`);
      if (!response.ok) throw failure('stalwart_rejected', `/jmap/session: HTTP ${response.status}`);
      await call('x:Domain/get', { ids: [] });
    },
    domains: async () =>
      (await list('Domain', domainSchema)).map((d) => ({
        id: d.id,
        name: d.name.toLowerCase(),
        dnsServerId: d.dnsManagement?.dnsServerId ?? null,
        zoneFile: d.dnsZoneFile ?? '',
      })),
    createDomain: (name) =>
      create('Domain', {
        name,
        aliases: {},
        certificateManagement: { '@type': 'Manual' },
        dnsManagement: { '@type': 'Manual' },
        subAddressing: { '@type': 'Enabled' },
      }),
    setDomainDns: async (domainId, dnsServerId) => {
      const dnsManagement = dnsServerId ? { '@type': 'Automatic', dnsServerId } : { '@type': 'Manual' };
      await set('Domain', { update: { [domainId]: { dnsManagement } } });
    },
    ensureDnsServer: async (provider, description) => {
      const object = dnsServerObject(provider, description);
      const existing = (await list('DnsServer', dnsServerSchema)).find((s) => s.description === description);
      if (!existing) return create('DnsServer', object);
      await set('DnsServer', { update: { [existing.id]: object } });
      return existing.id;
    },
    findAccount: async (name, domainId) =>
      (await list('Account', accountSchema)).find(
        (a) => a['@type'] === 'User' && a.name.toLowerCase() === name && a.domainId === domainId,
      )?.id ?? null,
    createAccount: (name, domainId, value) =>
      create('Account', {
        '@type': 'User',
        name,
        domainId,
        credentials: passwordCredential(value),
        aliases: {},
        memberGroupIds: {},
        quotas: {},
        roles: { '@type': 'User' },
        permissions: { '@type': 'Inherit' },
        encryptionAtRest: { '@type': 'Disabled' },
        description: 'MorniHosting',
      }),
    setAccountPassword: async (accountId, value) => {
      await set('Account', { update: { [accountId]: { credentials: passwordCredential(value) } } });
    },
    canLogin: async (user, pass) => (await send('/jmap/session', basic(user, pass))).ok,
  };
};
