import { and, eq, ne } from 'drizzle-orm';
import {
  type DnsConfigInput,
  type DnsProvider,
  type DnsStatus,
  type DnsZoneOption,
  type NetbirdServerInfo,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { dnsRecords, servers as serverTable } from '../db/schema.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { createKeyedLock } from '../lib/locks.js';
import { MS_PER_MINUTE } from '../lib/units.js';
import { freshPublicIp } from '../servers/connectivity.js';
import { GEYSER_PURPOSE, VOICE_PURPOSE, type ServerService, type TunnelAddress } from '../servers/service.js';
import type { ServerRow } from '../servers/spec.js';
import { createDnsClient, type DnsClient, type DnsClientFactory, type DnsRecordInput } from './providers.js';

/**
 * Own domain without NetBird: a server named "survival" gets survival.<domain> → the home connection's
 * public IP, plus `_minecraft._tcp.survival.<domain>` (SRV) for Java so players need no port. The panel asks
 * for the public IP every few minutes and moves the records along when it changes (like DynDNS). The router
 * still forwards the ports to this machine; the records only give the IP a name.
 */

const SETTINGS_KEY = 'dns';
const NETBIRD_KEY = 'netbird';
const CHECK_MINUTES = 5;
const SRV_PRIORITY = 0;
const SRV_WEIGHT = 5;
/** Records of the domain itself (example.de and *.example.de) are kept under this key instead of a server id. */
const DOMAIN_KEY = '_domain';
/** The A record of the mail server's own name (e.g. mail.example.de), set for the Stalwart connection. */
const MAIL_KEY = '_mail';

interface StoredConfig {
  readonly provider: DnsProvider;
  /** Sealed with the panel secret. */
  readonly token: string;
  readonly zoneId: string;
  readonly zone: string;
  readonly ip: string | null;
  readonly ipCheckedAt: string | null;
}

type Wanted = DnsRecordInput & { readonly content: string };
type RecordRow = typeof dnsRecords.$inferSelect;
type Failure = NonNullable<DnsStatus['error']>;

export interface DnsAutomation {
  readonly configured: () => boolean;
  readonly status: () => DnsStatus;
  readonly discover: (input: { provider: DnsProvider; token?: string }) => Promise<DnsZoneOption[]>;
  readonly configure: (input: DnsConfigInput, actor: Actor) => Promise<DnsStatus>;
  readonly disconnect: (actor: Actor) => Promise<DnsStatus>;
  readonly setServerName: (
    serverId: string,
    name: string | null,
    actor: Actor,
  ) => Promise<NetbirdServerInfo | null>;
  /** Asks for the public IP and moves all records if it changed; runs on its own every few minutes. */
  readonly refreshIp: () => Promise<void>;
  readonly shutdown: () => void;
  /** The provider, its access and the domain, to hand to a mail server that publishes its own records. */
  readonly access: () => { provider: DnsProvider; token: string; zone: string } | null;
  /** Points `host` (a name in the domain) at `ip`; null removes the record again. */
  readonly setMailHost: (host: string | null, ip: string | null) => Promise<void>;
}

const failureOf = (err: unknown): Failure =>
  err instanceof AppError ? { code: err.code, params: err.params } : { code: 'dns_failed', params: {} };

export function createDnsAutomation(
  ctx: AppContext,
  servers: ServerService,
  clientFactory: DnsClientFactory = createDnsClient,
): DnsAutomation {
  const lock = createKeyedLock();
  const failures = new Map<string, Failure>();
  const state: { lastError: Failure | null } = { lastError: null };

  const config = (): StoredConfig | null => ctx.settings.getValue<StoredConfig>(SETTINGS_KEY) ?? null;
  const save = (cfg: StoredConfig): void => ctx.settings.setValue(SETTINGS_KEY, cfg);
  const clientFor = (cfg: StoredConfig): DnsClient =>
    clientFactory(cfg.provider, ctx.secrets.decrypt(cfg.token));
  const recordsOf = (serverId: string): RecordRow[] =>
    ctx.db.select().from(dnsRecords).where(eq(dnsRecords.serverId, serverId)).all();
  const serverRow = (serverId: string): ServerRow | undefined =>
    ctx.db.select().from(serverTable).where(eq(serverTable.id, serverId)).get();
  const namedServers = (): ServerRow[] =>
    ctx.db
      .select()
      .from(serverTable)
      .all()
      .filter((r) => r.netbirdName !== null);

  const hostOf = (row: ServerRow, cfg: StoredConfig): string => `${row.netbirdName}.${cfg.zone}`;
  const wanted = (row: ServerRow, cfg: StoredConfig, ip: string): Wanted[] => {
    if (!row.netbirdName) return [];
    const host = hostOf(row, cfg);
    const a: Wanted = { type: 'A', name: host, ip, content: ip };
    // Only Minecraft Java looks up SRV records; every other game gets the name plus its port.
    if (row.edition !== 'java') return [a];
    const srv = { priority: SRV_PRIORITY, weight: SRV_WEIGHT, port: row.port, target: host };
    return [a, { type: 'SRV', name: `_minecraft._tcp.${host}`, srv, content: `${row.port} ${host}` }];
  };

  const remember = (serverId: string, want: Wanted, id: string): void => {
    const values = { id, serverId, type: want.type, name: want.name, content: want.content };
    ctx.db.insert(dnsRecords).values(values).onConflictDoUpdate({ target: dnsRecords.id, set: values }).run();
  };
  const forget = (id: string): void => {
    ctx.db.delete(dnsRecords).where(eq(dnsRecords.id, id)).run();
  };

  /** Creates, changes or keeps one record; a record made by hand under the same name is taken over. */
  const apply = async (
    client: DnsClient,
    cfg: StoredConfig,
    serverId: string,
    want: Wanted,
    existing: RecordRow | undefined,
  ): Promise<void> => {
    if (existing?.name === want.name && existing.content === want.content) return;
    if (existing?.name === want.name) {
      await client.update(cfg.zoneId, existing.id, want);
      remember(serverId, want, existing.id);
      return;
    }
    if (existing) {
      await client.remove(cfg.zoneId, existing.id);
      forget(existing.id);
    }
    const byHand = await client.find(cfg.zoneId, want.type, want.name);
    if (byHand) await client.update(cfg.zoneId, byHand, want);
    remember(serverId, want, byHand ?? (await client.create(cfg.zoneId, want)));
  };

  const currentIp = async (cfg: StoredConfig): Promise<string> => {
    const ip = cfg.ip ?? (await freshPublicIp());
    if (!ip) throw badRequest('dns_no_public_ip');
    if (ip !== cfg.ip) save({ ...cfg, ip, ipCheckedAt: new Date().toISOString() });
    return ip;
  };

  const sameSlot = (r: RecordRow, w: Wanted): boolean => r.type === w.type && r.name === w.name;
  /** Makes the records kept under one key (a server, or the domain itself) exactly the wanted ones. */
  const syncRecords = async (cfg: StoredConfig, key: string, wants: readonly Wanted[]): Promise<void> => {
    const existing = recordsOf(key);
    const client = clientFor(cfg);
    const stale = existing.filter((r) => !wants.some((w) => sameSlot(r, w)));
    await Promise.all(
      stale.map(async (r) => {
        await client.remove(cfg.zoneId, r.id);
        forget(r.id);
      }),
    );
    await Promise.all(
      wants.map((w) =>
        apply(
          client,
          cfg,
          key,
          w,
          existing.find((r) => sameSlot(r, w)),
        ),
      ),
    );
  };

  /**
   * The domain and every name below it point at this connection, so example.de and any server name open the
   * panel in the browser. New domains often come with the registrar's parking records; their IPv6 (AAAA)
   * entries would send browsers to the parking page, so they go.
   */
  const syncDomain = async (): Promise<void> => {
    const cfg = config();
    if (!cfg) return;
    const ip = await currentIp(cfg);
    const names = [cfg.zone, `*.${cfg.zone}`];
    await syncRecords(
      cfg,
      DOMAIN_KEY,
      names.map((name) => ({ type: 'A', name, ip, content: ip })),
    );
    const client = clientFor(cfg);
    const parking = await Promise.all(names.map((name) => client.find(cfg.zoneId, 'AAAA', name)));
    await Promise.all(parking.filter((id) => id !== null).map((id) => client.remove(cfg.zoneId, id)));
  };
  const syncDomainQuietly = async (): Promise<void> => {
    try {
      await lock(DOMAIN_KEY, syncDomain);
    } catch (err) {
      state.lastError = failureOf(err);
      ctx.log.warn({ err }, 'DNS sync of the domain failed');
    }
  };

  /** Brings the provider in line with one server; a deleted or unnamed server loses its records. */
  const syncNow = async (serverId: string): Promise<void> => {
    const cfg = config();
    if (!cfg) return;
    const row = serverRow(serverId);
    const wants = row?.netbirdName ? wanted(row, cfg, await currentIp(cfg)) : [];
    await syncRecords(cfg, serverId, wants);
    if (row?.netbirdName) {
      servers.setTunnelAddress(serverId, {
        domain: hostOf(row, cfg),
        publicPort: null,
        geyserPublicPort: null,
        voicePublicPort: null,
      });
    }
    failures.delete(serverId);
  };

  const sync = async (serverId: string): Promise<void> => {
    try {
      await lock(serverId, () => syncNow(serverId));
    } catch (err) {
      failures.set(serverId, failureOf(err));
      throw err;
    }
  };
  const syncQuietly = async (serverId: string): Promise<void> => {
    try {
      await sync(serverId);
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'DNS sync failed');
    }
  };
  const syncAll = async (): Promise<void> => {
    await Promise.allSettled(namedServers().map((r) => syncQuietly(r.id)));
  };

  const refreshIp = async (): Promise<void> => {
    const cfg = config();
    if (!cfg) return;
    const ip = await freshPublicIp();
    const checkedAt = new Date().toISOString();
    if (!ip) {
      state.lastError = { code: 'dns_no_public_ip', params: {} };
      return;
    }
    save({ ...cfg, ip, ipCheckedAt: checkedAt });
    state.lastError = null;
    if (ip !== cfg.ip) {
      ctx.log.info({ from: cfg.ip, to: ip }, 'public IP changed, moving DNS records');
      await syncDomainQuietly();
      await syncAll();
    }
  };
  const timer = setInterval(() => void refreshIp(), CHECK_MINUTES * MS_PER_MINUTE);
  timer.unref();

  const describe = (row: ServerRow): NetbirdServerInfo | null => {
    const cfg = config();
    if (!cfg || !row.netbirdName) return null;
    const domain = hostOf(row, cfg);
    const portOf = (purpose: string): number | undefined =>
      row.extraPorts.find((p) => p.purpose === purpose)?.port;
    const geyser = row.geyser ? portOf(GEYSER_PURPOSE) : undefined;
    const voice = row.voiceChat ? portOf(VOICE_PURPOSE) : undefined;
    return {
      name: row.netbirdName,
      services: [
        { purpose: 'main', domain, port: row.port },
        ...(geyser ? [{ purpose: 'geyser' as const, domain, port: geyser }] : []),
        ...(voice ? [{ purpose: 'voice' as const, domain, port: voice }] : []),
      ],
      error: failures.get(row.id) ?? null,
    };
  };
  servers.describeNetbird(describe);

  servers.onCreated((id) => (config() && serverRow(id)?.netbirdName ? syncQuietly(id) : Promise.resolve()));
  servers.onPortsChanged((id) => {
    if (config() && (serverRow(id)?.netbirdName || recordsOf(id).length)) void syncQuietly(id);
  });
  ctx.events.on('server.deleted', ({ serverId }) => {
    if (config() && recordsOf(serverId).length) void syncQuietly(serverId);
  });
  // After a restart the IP may have changed while the panel was down.
  if (config()) void refreshIp();

  const status = (): DnsStatus => {
    const cfg = config();
    return {
      configured: cfg !== null,
      provider: cfg?.provider ?? null,
      domain: cfg?.zone ?? null,
      ip: cfg?.ip ?? null,
      ipCheckedAt: cfg?.ipCheckedAt ?? null,
      error: state.lastError,
      netbirdActive: ctx.settings.getValue(NETBIRD_KEY) !== undefined,
    };
  };

  /** The stored key is only reused for the same provider. */
  const tokenFor = (input: { provider: DnsProvider; token?: string }): string => {
    const cfg = config();
    const token = input.token ?? (cfg?.provider === input.provider ? ctx.secrets.decrypt(cfg.token) : null);
    if (!token) throw badRequest('dns_token_missing');
    return token;
  };

  return {
    configured: () => config() !== null,
    status,
    discover: async (input) =>
      (await clientFactory(input.provider, tokenFor(input)).zones()).map((z) => ({ id: z.id, name: z.name })),
    configure: async (input, actor) => {
      if (ctx.settings.getValue(NETBIRD_KEY) !== undefined) throw conflict('dns_netbird_active');
      const token = tokenFor(input);
      const zone = (await clientFactory(input.provider, token).zones()).find((z) => z.id === input.zoneId);
      if (!zone) throw badRequest('dns_zone_unknown');
      const previous = config();
      const moved =
        previous !== null && (previous.zone !== zone.name || previous.provider !== input.provider);
      // Records at the old domain or provider are removed first, so nothing is left behind.
      if (moved)
        await Promise.allSettled([DOMAIN_KEY, MAIL_KEY, ...namedServers().map((r) => r.id)].map(clearServer));
      save({
        provider: input.provider,
        token: ctx.secrets.encrypt(token),
        zoneId: zone.id,
        zone: zone.name.toLowerCase(),
        ip: null,
        ipCheckedAt: null,
      });
      ctx.audit.record(actor, 'dns.configure', null, { provider: input.provider, domain: zone.name });
      const ip = await freshPublicIp();
      const cfg = config();
      if (cfg && ip) save({ ...cfg, ip, ipCheckedAt: new Date().toISOString() });
      state.lastError = ip ? null : { code: 'dns_no_public_ip', params: {} };
      await syncDomainQuietly();
      await syncAll();
      return status();
    },
    disconnect: async (actor) => {
      await Promise.allSettled([DOMAIN_KEY, MAIL_KEY, ...namedServers().map((r) => r.id)].map(clearServer));
      ctx.db.delete(dnsRecords).run();
      namedServers().forEach((r) =>
        servers.setTunnelAddress(r.id, {
          netbirdName: null,
          domain: null,
          publicPort: null,
          geyserPublicPort: null,
          voicePublicPort: null,
        }),
      );
      failures.clear();
      state.lastError = null;
      ctx.settings.deleteValue(SETTINGS_KEY);
      ctx.audit.record(actor, 'dns.disconnect');
      return status();
    },
    setServerName: async (serverId, name, actor) => {
      const row = servers.row(serverId);
      if (name !== null && !config()) throw badRequest('dns_not_configured');
      const taken =
        name !== null &&
        ctx.db
          .select()
          .from(serverTable)
          .where(and(eq(serverTable.netbirdName, name), ne(serverTable.id, serverId)))
          .get();
      if (taken) throw conflict('netbird_name_taken', { name });
      const cleared: TunnelAddress = {
        domain: null,
        publicPort: null,
        geyserPublicPort: null,
        voicePublicPort: null,
      };
      servers.setTunnelAddress(serverId, {
        netbirdName: name,
        ...(name === null && row.netbirdName ? cleared : {}),
      });
      ctx.audit.record(actor, 'dns.server', serverId, { name });
      await sync(serverId);
      return describe(servers.row(serverId));
    },
    refreshIp,
    shutdown: () => clearInterval(timer),
    access: () => {
      const cfg = config();
      return cfg ? { provider: cfg.provider, token: ctx.secrets.decrypt(cfg.token), zone: cfg.zone } : null;
    },
    setMailHost: async (host, ip) => {
      const cfg = config();
      if (!cfg) return;
      const inZone = host !== null && ip !== null && (host === cfg.zone || host.endsWith(`.${cfg.zone}`));
      const wants: Wanted[] = inZone ? [{ type: 'A', name: host, ip, content: ip }] : [];
      await lock(MAIL_KEY, () => syncRecords(cfg, MAIL_KEY, wants));
    },
  };

  /** Removes a server's records at the provider (used when the domain changes or DNS is turned off). */
  async function clearServer(serverId: string): Promise<void> {
    const cfg = config();
    if (!cfg) return;
    const client = clientFor(cfg);
    await Promise.allSettled(
      recordsOf(serverId).map(async (r) => {
        await client.remove(cfg.zoneId, r.id);
        forget(r.id);
      }),
    );
  }
}
