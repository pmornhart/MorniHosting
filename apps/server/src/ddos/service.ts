import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  SOFTWARE,
  type DdosHostStatus,
  type DdosState,
  type DdosStatus,
  type DdosUpdate,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { servers as serverTable } from '../db/schema.js';
import { writePropertiesFile } from '../servers/properties-file.js';
import type { ServerService } from '../servers/service.js';
import { withSignalingPorts } from '../servers/spec.js';
import { MS_PER_MINUTE, nowIso } from '../lib/units.js';

/**
 * DDoS protection. The panel has no root and no access to the host's firewall (Docker only through the
 * socket proxy), so it only writes its wish (ddos/wish.json) and the ports of all servers (ddos/ports.txt)
 * into the data volume. On the host, scripts/ddos-guard.sh runs from a systemd path unit when they change
 * and from a timer every minute; it sets the iptables rules and answers in ddos/status.json. agent.json
 * says the host part is installed.
 *
 * Inside Minecraft the panel sets the spam limit itself: "rate-limit" in server.properties before each
 * start of a Java server.
 */

const SETTINGS_KEY = 'ddos';
/** The timer runs every minute; after a few minutes without an answer the host part is not running. */
const HOST_SILENT_MINUTES = 3;
const HOST_SILENT_MS = HOST_SILENT_MINUTES * MS_PER_MINUTE;
const RATE_LIMIT_KEY = 'rate-limit';
/** Velocity is a proxy without server.properties; Bedrock has no rate-limit. */
const NO_RATE_LIMIT = new Set(['velocity', 'bedrock']);

/** On/off lives in wish.json, because `ddos-guard.sh enable|disable` on the console writes it as well. */
interface Wish {
  readonly enabled: boolean;
  readonly at: string | null;
}

const wishSchema = z.object({ enabled: z.boolean(), at: z.string() });

const hostSchema = z.object({
  active: z.boolean(),
  ipv4: z.boolean(),
  ipv6: z.boolean(),
  docker: z.boolean(),
  sysctl: z.boolean(),
  tcpPorts: z.array(z.string()),
  udpPorts: z.array(z.string()),
  limits: z.object({
    tcpNewPerMinute: z.number(),
    tcpBurst: z.number(),
    tcpConnections: z.number(),
    udpPacketsPerSecond: z.number(),
    udpBurst: z.number(),
  }),
  dropped: z.object({
    tcpRate: z.number(),
    tcpConnections: z.number(),
    udpRate: z.number(),
    invalid: z.number(),
  }),
  error: z.enum(['iptables_missing', 'rules_failed']).nullable(),
  at: z.string(),
});

export interface DdosService {
  readonly status: () => DdosStatus;
  readonly update: (input: DdosUpdate, actor: Actor) => DdosStatus;
  /** Writes the port list once at start (servers may have changed while the panel was down). */
  readonly init: () => void;
}

export function createDdosService(ctx: AppContext, servers: ServerService): DdosService {
  const dir = path.join(ctx.config.dataDir, 'ddos');
  const files = {
    wish: path.join(dir, 'wish.json'),
    ports: path.join(dir, 'ports.txt'),
    status: path.join(dir, 'status.json'),
    agent: path.join(dir, 'agent.json'),
  };

  const rateLimit = (): number | null =>
    ctx.settings.getValue<{ rateLimit?: number }>(SETTINGS_KEY)?.rateLimit ?? null;

  const wish = (): Wish => {
    try {
      return wishSchema.parse(JSON.parse(fs.readFileSync(files.wish, 'utf8')));
    } catch {
      return { enabled: false, at: null };
    }
  };

  const readHost = (): DdosHostStatus | null => {
    try {
      return hostSchema.parse(JSON.parse(fs.readFileSync(files.status, 'utf8')));
    } catch {
      return null;
    }
  };

  /** Every published port of every server, one "tcp 25565" per line, so the host protects exactly those. */
  const portList = (): string => {
    const lines = ctx.db
      .select()
      .from(serverTable)
      .all()
      .flatMap((row) => [
        `${SOFTWARE[row.software].protocol} ${row.port}`,
        ...withSignalingPorts(row.extraPorts).map((p) => `${p.protocol} ${p.port}`),
      ]);
    return [...new Set(lines)].sort().join('\n') + '\n';
  };

  // Only when the list really changed: every write wakes the host script.
  const writePorts = (): void => {
    try {
      const text = portList();
      const before = fs.existsSync(files.ports) ? fs.readFileSync(files.ports, 'utf8') : null;
      if (before === text) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(files.ports, text);
    } catch (err) {
      ctx.log.warn({ err }, 'ddos port list not written');
    }
  };

  const writeWish = (enabled: boolean, at: string, by: string | null): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(files.wish, JSON.stringify({ enabled, at, by }));
  };

  const stateOf = (want: Wish, installed: boolean, host: DdosHostStatus | null): DdosState => {
    if (!installed) return 'no_host';
    // Never switched on: nothing to wait for.
    if (!want.at && !want.enabled && host === null) return 'off';
    const since = Math.max(Date.parse(want.at ?? '') || 0, Date.parse(host?.at ?? '') || 0);
    const silent = Date.now() - since > HOST_SILENT_MS;
    const answered = host !== null && (!want.at || Date.parse(host.at) >= Date.parse(want.at));
    if (!answered) return silent ? 'stuck' : 'waiting';
    if (want.enabled && host.error) return 'failed';
    if (host.active !== want.enabled) return silent ? 'stuck' : 'waiting';
    // The timer answers every minute; long silence means the host part stopped (counts are old).
    if (silent) return 'stuck';
    return host.active ? 'active' : 'off';
  };

  const status = (): DdosStatus => {
    const want = wish();
    const installed = fs.existsSync(files.agent);
    const host = readHost();
    return {
      enabled: want.enabled,
      state: stateOf(want, installed, host),
      hostInstalled: installed,
      host,
      rateLimit: rateLimit(),
    };
  };

  const applyRateLimit = (serverId: string): void => {
    const limit = rateLimit();
    if (limit === null) return;
    const row = servers.row(serverId);
    if (row.edition !== 'java' || NO_RATE_LIMIT.has(row.software)) return;
    writePropertiesFile(servers.dir(serverId), { [RATE_LIMIT_KEY]: String(limit) });
  };

  servers.onBeforeStart((serverId) => {
    try {
      applyRateLimit(serverId);
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'rate-limit not written');
    }
  });
  servers.onPortsChanged(() => writePorts());
  servers.onCreated(async () => writePorts());

  return {
    status,
    init: writePorts,
    update: (input, actor) => {
      if (input.rateLimit !== undefined) ctx.settings.setValue(SETTINGS_KEY, { rateLimit: input.rateLimit });
      if (input.enabled !== undefined && input.enabled !== wish().enabled) {
        writePorts();
        writeWish(input.enabled, nowIso(), actor.username);
      }
      ctx.audit.record(actor, 'ddos.update', null, {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.rateLimit === undefined ? {} : { rateLimit: input.rateLimit }),
      });
      return status();
    },
  };
}
