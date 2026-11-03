/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  MailSettingsView,
  MailTestRun,
  StalwartConnectResult,
  StalwartView,
} from '@mornihosting/shared';
import type { MailNetwork } from '../src/mail/check.js';
import type { OutgoingMail } from '../src/mail/service.js';
import { dnsServerObject } from '../src/stalwart/client.js';
import { parseZoneFile, type StalwartResolver } from '../src/stalwart/service.js';
import { authHeaders, createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

const STALWART = 'http://192.168.178.116:8080';
const ADMIN_PASSWORD = 'stalwart-admin-pw';
const CF_TOKEN = 'cf-test-token';
const ZONE = { id: 'zone-1', name: 'mornihosting.de' };
const PUBLIC_IP = '203.0.113.171';

type Json = Record<string, unknown>;
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** Stalwart 1.0 (JMAP `x:` objects), Cloudflare's DNS API and ipify — just what the panel uses. */
function createFakeInternet() {
  const domains = new Map<string, Json>();
  const accounts = new Map<string, Json>();
  const dnsServers = new Map<string, Json>();
  const cfRecords: Json[] = [];
  const seq = { next: 1 };
  const calls: string[] = [];
  const zoneFile = (d: Json) =>
    [
      `; zone for ${String(d['name'])}`,
      `${String(d['name'])}. IN MX 10 mail.${String(d['name'])}.`,
      `${String(d['name'])}. IN TXT "v=spf1 mx -all"`,
      `v1-ed25519-20261103._domainkey.${String(d['name'])}. IN TXT "v=DKIM1; k=ed25519; " "p=ABC"`,
      `_dmarc.${String(d['name'])}. IN TXT "v=DMARC1; p=reject"`,
    ].join('\n');
  const passwordOf = (a: Json) =>
    String(((a['credentials'] as Record<string, Json>)['0'] ?? {})['secret'] ?? '');
  const logins = () => [
    basic('admin', ADMIN_PASSWORD),
    ...[...accounts.values()].map((a) => {
      const domain = domains.get(String(a['domainId']));
      return basic(`${String(a['name'])}@${String(domain?.['name'])}`, passwordOf(a));
    }),
  ];
  const queued = new Map<string, Json>();
  const tables: Record<string, Map<string, Json>> = {
    Domain: domains,
    Account: accounts,
    DnsServer: dnsServers,
    QueuedMessage: queued,
  };

  const jmap = (method: string, args: Json): [string, Json, string] => {
    calls.push(method);
    if (method === 'x:Log/query') return [method, { ids: [] }, 'c1'];
    const [, object = '', fn = ''] = /^x:(\w+)\/(\w+)$/.exec(method) ?? [];
    const table = tables[object];
    if (!table) return ['error', { type: 'unknownMethod' }, 'c1'];
    if (fn === 'get') {
      const ids = args['ids'] as string[] | null;
      const list = [...table.values()]
        .filter((v) => ids === null || ids.includes(String(v['id'])))
        .map((v) => (object === 'Domain' ? { ...v, dnsZoneFile: zoneFile(v) } : v));
      return [method, { list }, 'c1'];
    }
    const created: Record<string, Json> = {};
    Object.entries((args['create'] ?? {}) as Record<string, Json>).forEach(([key, value]) => {
      const id = `id${seq.next++}`;
      table.set(id, { ...value, id });
      created[key] = { id };
    });
    Object.entries((args['update'] ?? {}) as Record<string, Json>).forEach(([id, patch]) => {
      table.set(id, { ...table.get(id), ...patch });
    });
    return [method, { created }, 'c1'];
  };

  const handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(urlOf(input));
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (url.hostname === 'api.ipify.org') return new Response('198.51.100.7');
    if (url.hostname === 'www.mail-tester.com')
      return Response.json({
        displayedMark: '9.5/10',
        spamAssassin: { rules: [{ code: 'NO_UNSUB', description: 'Kein Abmelde-Link', score: 0.5 }] },
      });
    if (url.origin === STALWART) {
      if (!logins().includes(auth)) return new Response('', { status: 401 });
      if (url.pathname === '/jmap/session') return Response.json({ accounts: {} });
      const body = JSON.parse(String(init?.body)) as { methodCalls: [string, Json, string][] };
      const [method, args] = body.methodCalls[0] ?? ['', {}];
      if (auth !== basic('admin', ADMIN_PASSWORD))
        return Response.json({ methodResponses: [['error', { type: 'forbidden' }, 'c1']] });
      return Response.json({ methodResponses: [jmap(method, args)] });
    }
    if (url.hostname !== 'api.cloudflare.com') return new Response('', { status: 404 });
    if (url.pathname === '/client/v4/zones') return Response.json({ success: true, result: [ZONE] });
    const method = init?.method ?? 'GET';
    if (method === 'GET')
      return Response.json({
        success: true,
        result: cfRecords.filter(
          (r) => r['type'] === url.searchParams.get('type') && r['name'] === url.searchParams.get('name'),
        ),
      });
    if (method === 'POST') {
      const record = { ...(JSON.parse(String(init?.body)) as Json), id: `rec-${seq.next++}` };
      cfRecords.push(record);
      return Response.json({ success: true, result: record });
    }
    return Response.json({ success: true, result: {} });
  };
  return { domains, accounts, dnsServers, queued, cfRecords, calls, handle };
}

/** DNS as the world sees it after Stalwart published its records (PTR still missing at the hoster). */
const resolver: StalwartResolver = {
  a: async (name) => (name === 'mail.mornihosting.de' ? [PUBLIC_IP] : []),
  ptr: async () => ['static.cloud4all.example'],
  mx: async () => ['mail.mornihosting.de'],
  txt: async (name) =>
    ({
      'mornihosting.de': ['v=spf1 mx -all'],
      '_dmarc.mornihosting.de': ['v=DMARC1; p=reject'],
      'v1-ed25519-20261103._domainkey.mornihosting.de': ['v=DKIM1; k=ed25519; p=ABC'],
    })[name] ?? [],
};
const mailNetwork: MailNetwork = { lookup: async () => '192.168.178.116', connect: async () => undefined };

describe('Stalwart connection', () => {
  let t: TestApp;
  let s: Session;
  let fake: ReturnType<typeof createFakeInternet>;
  let sent: OutgoingMail[];
  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(s) });
  const connect = async (body: object = {}) =>
    (
      await call('POST', '/api/stalwart/connect', {
        url: STALWART,
        password: ADMIN_PASSWORD,
        publicIp: PUBLIC_IP,
        ...body,
      })
    ).json<StalwartConnectResult>();

  beforeEach(async () => {
    fake = createFakeInternet();
    sent = [];
    vi.stubGlobal('fetch', fake.handle);
    t = await createTestApp(
      {},
      {
        stalwartResolver: resolver,
        mailNetwork,
        mailTransport: () => ({
          verify: async () => true,
          sendMail: async (mail) => {
            sent.push(mail);
            if (mail.to === 'kaputt@example.de') throw new Error('550 5.1.1 Mailbox unbekannt');
            return { response: `250 2.0.0 Message queued with id q${sent.length}` };
          },
        }),
      },
    );
    s = await setupAdmin(t);
    await call('PUT', '/api/dns', { provider: 'cloudflare', token: CF_TOKEN, zoneId: ZONE.id });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.cleanup();
  });

  test('sets everything up: domain, DNS hand-over, sender account, SMTP, test mail, checks', async () => {
    const result = await connect();
    expect(result.steps.map((step) => `${step.key}:${step.state}`)).toEqual([
      'login:ok',
      'domain:ok',
      'dns:ok',
      'account:ok',
      'smtp:ok',
      'test:ok',
    ]);
    expect(result.ok).toBe(true);
    // Domain at Stalwart publishes its records through a DNS server with the panel's Cloudflare token.
    const domain = [...fake.domains.values()][0];
    expect(domain?.['name']).toBe('mornihosting.de');
    const dnsServer = [...fake.dnsServers.values()][0];
    expect(dnsServer).toMatchObject({
      '@type': 'Cloudflare',
      description: 'MorniHosting',
      secret: { secret: CF_TOKEN },
    });
    expect(domain?.['dnsManagement']).toEqual({ '@type': 'Automatic', dnsServerId: dnsServer?.['id'] });
    // Sender account and the panel's mail settings.
    expect([...fake.accounts.values()][0]).toMatchObject({
      '@type': 'User',
      name: 'noreply',
      roles: { '@type': 'User' },
    });
    const mail = (await call('GET', '/api/mail')).json<MailSettingsView>();
    expect(mail).toMatchObject({
      host: 'mail.mornihosting.de',
      internalHost: '192.168.178.116',
      user: 'noreply@mornihosting.de',
      from: 'MorniHosting <noreply@mornihosting.de>',
    });
    expect(sent).toHaveLength(1);
    // The mail server's name points at its public IP; the wildcard of the panel would point elsewhere.
    expect(fake.cfRecords.find((r) => r['name'] === 'mail.mornihosting.de')).toMatchObject({
      type: 'A',
      content: PUBLIC_IP,
    });
    // Checks: all fine except the reverse lookup, which only the hoster can set.
    const checks = Object.fromEntries(result.view.checks.map((c) => [c.key, c.ok]));
    expect(checks).toEqual({ a: true, ptr: false, mx: true, spf: true, dkim: true, dmarc: true });
    expect(result.view.records.map((r) => r.type)).toEqual(['MX', 'TXT', 'TXT', 'TXT']);
  });

  test('connecting again keeps the domain and account, renews the password, keeps the admin password', async () => {
    await connect();
    const again = await connect({ password: '' });
    expect(again.ok).toBe(true);
    expect(fake.domains.size).toBe(1);
    expect(fake.accounts.size).toBe(1);
    expect(fake.dnsServers.size).toBe(1);
    expect(again.steps.find((step) => step.key === 'account')?.detail).toContain('neues Passwort');
  });

  test('a wrong admin password stops at the login, nothing is saved', async () => {
    const result = await connect({ password: 'falsch' });
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ key: 'login', state: 'failed' });
    expect(result.steps[0]?.detail).toContain('stalwart_login');
    expect(result.steps.slice(1).every((step) => step.state === 'skipped')).toBe(true);
    expect((await call('GET', '/api/stalwart')).json<StalwartView>().connected).toBe(false);
  });

  test('without DNS hand-over the records are only shown; disconnect removes the A record', async () => {
    const result = await connect({ publishDns: false });
    expect(result.steps.find((step) => step.key === 'dns')).toMatchObject({
      state: 'skipped',
      detail: 'off',
    });
    expect(fake.dnsServers.size).toBe(0);
    expect(result.view.dnsAutomatic).toBe(false);
    expect((await call('DELETE', '/api/stalwart')).statusCode).toBe(204);
    expect((await call('GET', '/api/stalwart')).json<StalwartView>().connected).toBe(false);
  });

  test('mail tests: several addresses, followed through the Stalwart queue, mail-tester score, kept as history', async () => {
    await connect();
    const started = (
      await call('POST', '/api/mail/tests', {
        recipients: ['ich@gmail.com', 'ich@outlook.de', 'kaputt@example.de'],
        spamScore: true,
      })
    ).json<MailTestRun>();
    expect(started.recipients.map((r) => `${r.to}:${r.state}`)).toEqual([
      'ich@gmail.com:queued',
      'ich@outlook.de:queued',
      'kaputt@example.de:failed',
      `${started.spam?.address}:queued`,
    ]);
    expect(started.spam?.address).toMatch(/^test-[0-9a-f]{9}@srv1\.mail-tester\.com$/);
    expect(started.recipients[2]?.detail).toContain('550 5.1.1');
    // Stalwart: Gmail still being retried, Outlook done.
    fake.queued.set('m1', {
      id: 'm1',
      createdAt: new Date().toISOString(),
      returnPath: 'noreply@mornihosting.de',
      recipients: {
        'ich@gmail.com': {
          retryDue: '2026-11-03T12:26:00Z',
          status: {
            '@type': 'TemporaryFailure',
            errorType: 'TlsError',
            errorMessage: 'Handshake failed',
            responseHostname: 'alt1.gmail-smtp-in.l.google.com',
          },
        },
        'ich@outlook.de': {
          status: {
            '@type': 'Completed',
            responseHostname: 'mx.outlook.com',
            responseCode: 250,
            responseEnhanced: '2.6.0',
            responseMessage: 'Queued mail for delivery',
          },
        },
      },
    });
    const [run] = (await call('GET', '/api/mail/tests')).json<MailTestRun[]>();
    const byTo = Object.fromEntries((run?.recipients ?? []).map((r) => [r.to, r]));
    expect(byTo['ich@gmail.com']).toMatchObject({
      state: 'retrying',
      remoteHost: 'alt1.gmail-smtp-in.l.google.com',
      detail: 'Handshake failed',
      nextRetry: '2026-11-03T12:26:00Z',
    });
    expect(byTo['ich@outlook.de']).toMatchObject({
      state: 'delivered',
      detail: '250 2.6.0 Queued mail for delivery',
    });
    expect(run?.spam).toMatchObject({ state: 'done', score: 9.5, problems: ['Kein Abmelde-Link (−0.5)'] });
    expect(run?.tracked).toBe(true);
    // A second run comes first in the history.
    await call('POST', '/api/mail/tests', { recipients: ['zwei@gmx.de'] });
    const history = (await call('GET', '/api/mail/tests')).json<MailTestRun[]>();
    expect(history.map((r) => r.recipients[0]?.to)).toEqual(['zwei@gmx.de', 'ich@gmail.com']);
    // Nothing to test is refused.
    expect((await call('POST', '/api/mail/tests', { recipients: [] })).statusCode).toBe(400);
  });

  test('only admins', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/stalwart' });
    expect(response.statusCode).toBe(401);
  });
});

describe('Stalwart helpers', () => {
  test('reads the zone file, joins split TXT values', () => {
    const records = parseZoneFile(
      [
        '$ORIGIN example.de.',
        '; comment',
        'example.de. 3600 IN MX 10 mail.example.de.',
        'x._domainkey.example.de. IN TXT "v=DKIM1; " "p=AB"',
      ].join('\n'),
    );
    expect(records).toEqual([
      { name: 'example.de', type: 'MX', value: '10 mail.example.de.' },
      { name: 'x._domainkey.example.de', type: 'TXT', value: 'v=DKIM1; p=AB' },
    ]);
  });

  test('INWX access becomes an INWX DNS server, with the 2FA secret if there is one', () => {
    expect(dnsServerObject({ kind: 'inwx', user: 'philip', pass: 'pw', otp: 'OTP' }, 'MorniHosting')).toEqual(
      {
        '@type': 'Inwx',
        description: 'MorniHosting',
        username: 'philip',
        password: { '@type': 'Value', secret: 'pw' },
        sharedSecret: { '@type': 'Value', secret: 'OTP' },
        sandbox: false,
      },
    );
  });
});
