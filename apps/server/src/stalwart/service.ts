import {
  stalwartConnectSchema,
  type Locale,
  type StalwartCheck,
  type StalwartConnectInput,
  type StalwartConnectResult,
  type StalwartRecord,
  type StalwartStep,
  type StalwartView,
} from '@mornihosting/shared';
import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import type { DnsAutomation } from '../dns/service.js';
import { randomToken } from '../lib/crypto.js';
import { AppError, badRequest, errorMessage } from '../lib/errors.js';
import { isPrivateAddress } from '../lib/net-guard.js';
import type { MailService } from '../mail/service.js';
import {
  createStalwartClient,
  type StalwartClient,
  type StalwartClientFactory,
  type StalwartDnsProvider,
} from './client.js';

/**
 * "Stalwart verbinden": one form with the address and admin login of a Stalwart mail server. The panel then
 * creates the mail domain and a sender account there, uses that account for its own mails, lets Stalwart publish
 * its DNS records through the panel's DNS access, and checks what the world sees (A, PTR, MX, SPF, DKIM, DMARC).
 */

const SETTINGS_KEY = 'stalwart';
const DNS_SERVER_DESCRIPTION = 'MorniHosting';
const SENDER_PASSWORD_BYTES = 24;
const DETAIL_MAX = 200;
const RECORD_TYPES = new Set(['MX', 'TXT', 'CNAME', 'SRV', 'TLSA', 'CAA', 'A', 'AAAA']);
const DKIM_MARK = '._domainkey.';
const DMARC_PREFIX = '_dmarc.';
const SPF_START = 'v=spf1';
const DMARC_START = 'v=DMARC1';

interface Stored {
  readonly url: string;
  readonly username: string;
  readonly passwordSealed: string;
  readonly domain: string;
  readonly hostname: string;
  readonly sender: string;
  readonly publicIp: string;
  readonly dnsAutomatic: boolean;
}

/** DNS lookups the checks need; tests plug in a fake. */
export interface StalwartResolver {
  readonly a: (name: string) => Promise<string[]>;
  readonly ptr: (ip: string) => Promise<string[]>;
  readonly mx: (name: string) => Promise<string[]>;
  readonly txt: (name: string) => Promise<string[]>;
}

// Trailing dot of a fully qualified name. Matches "mail.example.de." (the dot), not "mail.example.de".
// https://regex101.com/?flavor=javascript&regex=%5C.%24&testString=mail.example.de.%0Amail.example.de
const TRAILING_DOT = /\.$/;
// Runs of spaces or tabs between zone file columns. Matches the gap in "example.de.  IN MX", not "IN".
// https://regex101.com/?flavor=javascript&regex=%5Cs%2B&testString=example.de.%20%20IN%20MX
const WHITESPACE = /\s+/;
// Joint between two quoted TXT parts. Matches '" "' in '"v=DKIM1; p=AB" "CD"', not '"single"'.
// https://regex101.com/?flavor=javascript&regex=%22%5Cs%2B%22&flags=g&testString=%22v%3DDKIM1%3B%20p%3DAB%22%20%22CD%22
const QUOTE_JOINT = /"\s+"/g;
// Quote at the start or end of a TXT value. Matches the quotes of '"v=spf1 mx -all"', not 'v=spf1'.
// https://regex101.com/?flavor=javascript&regex=%5E%22%7C%22%24&flags=g&testString=%22v%3Dspf1%20mx%20-all%22
const OUTER_QUOTES = /^"|"$/g;

const quietly = async (lookup: () => Promise<string[]>): Promise<string[]> => {
  try {
    return await lookup();
  } catch {
    return [];
  }
};
const bare = (name: string): string => name.toLowerCase().replace(TRAILING_DOT, '');

export const systemStalwartResolver: StalwartResolver = {
  a: (name) => quietly(() => dnsPromises.resolve4(name)),
  ptr: (ip) => quietly(async () => (await dnsPromises.reverse(ip)).map(bare)),
  mx: (name) => quietly(async () => (await dnsPromises.resolveMx(name)).map((m) => bare(m.exchange))),
  txt: (name) => quietly(async () => (await dnsPromises.resolveTxt(name)).map((parts) => parts.join(''))),
};

/**
 * Reads the records out of Stalwart's zone file. Lines look like
 * `mail._domainkey.example.de. IN TXT "v=DKIM1; …"` or `example.de. 3600 IN MX 10 mail.example.de.`;
 * comments (`;`) and `$ORIGIN`/`$TTL` lines are skipped.
 */
export function parseZoneFile(zone: string): StalwartRecord[] {
  return zone.split('\n').flatMap((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('$')) return [];
    const parts = line.split(WHITESPACE);
    const typeAt = parts.findIndex((part, i) => i > 0 && RECORD_TYPES.has(part.toUpperCase()));
    if (typeAt < 1) return [];
    const value = parts
      .slice(typeAt + 1)
      .join(' ')
      .replace(QUOTE_JOINT, '')
      .replace(OUTER_QUOTES, '');
    return [{ name: bare(parts[0] ?? ''), type: (parts[typeAt] ?? '').toUpperCase(), value }];
  });
}

const mxTarget = (records: readonly StalwartRecord[]): string | null => {
  const mx = records.find((r) => r.type === 'MX');
  return mx ? bare(mx.value.split(' ').at(-1) ?? '') || null : null;
};

export interface StalwartService {
  readonly view: () => StalwartView;
  readonly connect: (
    input: StalwartConnectInput,
    actor: Actor,
    admin: { email: string | null; locale: Locale; name: string },
  ) => Promise<StalwartConnectResult>;
  /** Loads the records again from Stalwart and checks DNS. */
  readonly check: () => Promise<StalwartView>;
  readonly disconnect: (actor: Actor) => Promise<void>;
  /** The connected Stalwart (for following test mails), null when none is connected. */
  readonly client: () => StalwartClient | null;
}

export function createStalwartService(
  ctx: AppContext,
  mail: MailService,
  dns: DnsAutomation,
  clientFactory: StalwartClientFactory = createStalwartClient,
  resolver: StalwartResolver = systemStalwartResolver,
): StalwartService {
  const state: { records: StalwartRecord[]; checks: StalwartCheck[]; checkedAt: string | null } = {
    records: [],
    checks: [],
    checkedAt: null,
  };
  const stored = (): Stored | null => ctx.settings.getValue<Stored>(SETTINGS_KEY) ?? null;

  /** The DNS access the panel can hand to Stalwart (INWX or Cloudflare; Stalwart has no IONOS support). */
  const dnsProvider = (domain: string): StalwartDnsProvider | null => {
    const access = dns.access();
    if (!access || (domain !== access.zone && !domain.endsWith(`.${access.zone}`))) return null;
    if (access.provider === 'cloudflare') return { kind: 'cloudflare', token: access.token };
    if (access.provider !== 'inwx') return null;
    try {
      const creds = JSON.parse(access.token) as { user?: string; pass?: string; otp?: string };
      return creds.user && creds.pass
        ? { kind: 'inwx', user: creds.user, pass: creds.pass, otp: creds.otp }
        : null;
    } catch {
      return null;
    }
  };

  const suggestedDomain = (): string => dns.access()?.zone ?? ctx.settings.get().panelDomain;

  const view = (): StalwartView => {
    const s = stored();
    const domain = s?.domain ?? suggestedDomain();
    return {
      connected: s !== null,
      url: s?.url ?? '',
      username: s?.username ?? 'admin',
      domain,
      hostname: s?.hostname ?? '',
      sender: s?.sender ?? 'noreply',
      publicIp: s?.publicIp ?? '',
      dnsAutomatic: s?.dnsAutomatic ?? false,
      dnsProvider: domain ? (dnsProvider(domain)?.kind ?? null) : null,
      records: state.records,
      checks: state.checks,
      checkedAt: state.checkedAt,
      suggestedDomain: suggestedDomain(),
    };
  };

  const runChecks = async (s: Stored): Promise<void> => {
    const has = (list: readonly string[], value: string): boolean => list.includes(value);
    const aRecords = await resolver.a(s.hostname);
    const ip = s.publicIp || aRecords[0] || '';
    const [ptr, mx, rootTxt, dmarcTxt] = await Promise.all([
      ip ? resolver.ptr(ip) : Promise.resolve([]),
      resolver.mx(s.domain),
      resolver.txt(s.domain),
      resolver.txt(`${DMARC_PREFIX}${s.domain}`),
    ]);
    const spf = rootTxt.find((t) => t.startsWith(SPF_START)) ?? '';
    const dmarc = dmarcTxt.find((t) => t.startsWith(DMARC_START)) ?? '';
    const dkimWanted = state.records.filter((r) => r.type === 'TXT' && r.name.includes(DKIM_MARK));
    const dkimFound = await Promise.all(dkimWanted.map(async (r) => (await resolver.txt(r.name)).length > 0));
    const spfOk = spf !== '' && (spf.includes(' mx') || (ip !== '' && spf.includes(`ip4:${ip}`)));
    state.checks = [
      {
        key: 'a',
        ok: aRecords.length > 0 && (!s.publicIp || has(aRecords, s.publicIp)),
        found: aRecords.join(', '),
        expected: `${s.hostname} → ${s.publicIp || '…'}`,
      },
      {
        key: 'ptr',
        ok: ip ? has(ptr, s.hostname) : null,
        found: ptr.join(', '),
        expected: `${ip} → ${s.hostname}`,
      },
      { key: 'mx', ok: has(mx, s.hostname), found: mx.join(', '), expected: `10 ${s.hostname}` },
      { key: 'spf', ok: spfOk, found: spf, expected: `${SPF_START} mx -all` },
      {
        key: 'dkim',
        ok: dkimWanted.length === 0 ? null : dkimFound.some(Boolean),
        found: dkimWanted
          .filter((_, i) => dkimFound[i])
          .map((r) => r.name)
          .join(', '),
        expected: dkimWanted.map((r) => r.name).join(', '),
      },
      { key: 'dmarc', ok: dmarc !== '', found: dmarc, expected: `${DMARC_START}; p=none` },
    ];
    state.checkedAt = new Date().toISOString();
  };

  const clientOf = (s: Stored) => clientFactory(s.url, s.username, ctx.secrets.decrypt(s.passwordSealed));

  const loadRecords = async (s: Stored): Promise<void> => {
    const domain = (await clientOf(s).domains()).find((d) => d.name === s.domain);
    state.records = domain ? parseZoneFile(domain.zoneFile) : [];
  };

  const detailOf = (err: unknown): string => {
    if (err instanceof AppError)
      return `${err.code}${err.params['message'] ? `: ${err.params['message']}` : ''}`;
    return errorMessage(err).slice(0, DETAIL_MAX);
  };

  const connect: StalwartService['connect'] = async (rawInput, actor, admin) => {
    const input = stalwartConnectSchema.parse(rawInput);
    const url = new URL(input.url);
    const domain = input.domain || suggestedDomain();
    if (!domain) throw badRequest('stalwart_no_domain');
    const previous = stored();
    // An empty password keeps the saved one (the form never gets it back).
    const password =
      input.password || (previous?.url === input.url ? ctx.secrets.decrypt(previous.passwordSealed) : '');
    if (!password) throw badRequest('stalwart_password_missing');
    const client = clientFactory(input.url, input.username, password);
    const steps: StalwartStep[] = [];
    const finish = (ok: boolean): StalwartConnectResult => {
      const done = new Set(steps.map((s) => s.key));
      const skipped = (['login', 'domain', 'dns', 'account', 'smtp', 'test'] as const)
        .filter((key) => !done.has(key))
        .map((key): StalwartStep => ({ key, state: 'skipped', detail: '' }));
      return { ok, steps: [...steps, ...skipped], view: view() };
    };
    const attempt = async <TValue>(key: StalwartStep['key'], run: () => Promise<TValue>) => {
      try {
        return await run();
      } catch (err) {
        steps.push({ key, state: 'failed', detail: detailOf(err) });
        return null;
      }
    };

    if ((await attempt('login', () => client.verify())) === null && steps.length) return finish(false);
    steps.push({ key: 'login', state: 'ok', detail: input.username });

    const domainId = await attempt('domain', async () => {
      const existing = (await client.domains()).find((d) => d.name === domain);
      steps.push({
        key: 'domain',
        state: 'ok',
        detail: existing ? `${domain} (vorhanden)` : `${domain} (neu)`,
      });
      return existing?.id ?? (await client.createDomain(domain));
    });
    if (!domainId) return finish(false);

    const provider = input.publishDns ? dnsProvider(domain) : null;
    const dnsAutomatic =
      (await attempt('dns', async () => {
        if (!provider) {
          steps.push({ key: 'dns', state: 'skipped', detail: input.publishDns ? 'no_provider' : 'off' });
          return false;
        }
        const serverId = await client.ensureDnsServer(provider, DNS_SERVER_DESCRIPTION);
        await client.setDomainDns(domainId, serverId);
        steps.push({ key: 'dns', state: 'ok', detail: provider.kind });
        return true;
      })) ?? false;

    const zone = (await client.domains().catch(() => [])).find((d) => d.id === domainId)?.zoneFile ?? '';
    state.records = parseZoneFile(zone);
    const hostname = mxTarget(state.records) ?? (net.isIP(url.hostname) ? `mail.${domain}` : url.hostname);
    const urlIp = net.isIPv4(url.hostname) && !isPrivateAddress(url.hostname) ? url.hostname : '';
    const publicIp = input.publicIp || urlIp;
    if (publicIp)
      await dns
        .setMailHost(hostname, publicIp)
        .catch((err: unknown) => ctx.log.warn({ err }, 'mail A record'));

    const senderPassword = randomToken(SENDER_PASSWORD_BYTES);
    const address = `${input.sender}@${domain}`;
    const login = await attempt('account', async () => {
      const existing = await client.findAccount(input.sender, domainId);
      if (existing) await client.setAccountPassword(existing, senderPassword);
      else await client.createAccount(input.sender, domainId, senderPassword);
      // Stalwart takes the full address as login; older set-ups also the bare name.
      const tries = [address, input.sender];
      const works = await Promise.all(tries.map((user) => client.canLogin(user, senderPassword)));
      const name = tries.find((_, i) => works[i]) ?? null;
      if (!name) throw badRequest('stalwart_sender_login');
      steps.push({ key: 'account', state: 'ok', detail: `${address}${existing ? ' (neues Passwort)' : ''}` });
      return name;
    });

    const save: Stored = {
      url: input.url,
      username: input.username,
      passwordSealed: ctx.secrets.encrypt(password),
      domain,
      hostname,
      sender: input.sender,
      publicIp,
      dnsAutomatic,
    };
    ctx.settings.setValue(SETTINGS_KEY, save);
    ctx.audit.record(actor, 'mail.stalwart', null, { domain, hostname });
    if (!login) {
      await runChecks(save);
      return finish(false);
    }

    // SMTP: the mail server's real name for TLS; if the panel reaches Stalwart by IP (home network), dial that IP.
    const internalHost = net.isIP(url.hostname) ? url.hostname : '';
    const quick = await attempt('smtp', () =>
      mail.quick(
        {
          email: login,
          password: senderPassword,
          internalHost,
          host: hostname,
          from: `MorniHosting <${address}>`,
        },
        admin.email ?? address,
        admin.locale,
        { name: admin.name },
      ),
    );
    if (quick) {
      const found = quick.found;
      steps.push(
        found
          ? { key: 'smtp', state: 'ok', detail: `${found.host}:${found.port} (${found.security})` }
          : { key: 'smtp', state: 'failed', detail: quick.closest?.message ?? 'smtp' },
      );
      if (quick.test)
        steps.push({
          key: 'test',
          state: quick.test.ok ? 'ok' : 'failed',
          detail: quick.test.ok ? (admin.email ?? address) : quick.test.message,
        });
    }
    await runChecks(save);
    return finish(Boolean(quick?.found && quick.test?.ok));
  };

  return {
    view,
    connect,
    client: () => {
      const s = stored();
      return s ? clientOf(s) : null;
    },
    check: async () => {
      const s = stored();
      if (!s) return view();
      await loadRecords(s).catch((err: unknown) => ctx.log.warn({ err }, 'stalwart: records not loaded'));
      await runChecks(s);
      return view();
    },
    disconnect: async (actor) => {
      await dns.setMailHost(null, null).catch(() => undefined);
      ctx.settings.deleteValue(SETTINGS_KEY);
      state.records = [];
      state.checks = [];
      state.checkedAt = null;
      ctx.audit.record(actor, 'mail.stalwart_removed');
    },
  };
}
