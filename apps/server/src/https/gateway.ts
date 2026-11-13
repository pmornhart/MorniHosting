import fs from 'node:fs';
import path from 'node:path';
import type { HttpsStatus } from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../lib/errors.js';
import { HTTP_BAD_GATEWAY } from '../lib/http-status.js';
import { BYTES_PER_MB } from '../lib/units.js';

/**
 * HTTPS for the own domain: the panel runs Caddy as a small helper container on ports 80 and 443. Caddy fetches
 * certificates by itself (Let's Encrypt, only for names this panel confirms) and hands everything to the panel:
 * example.de opens the panel, any name below it (survival.example.de) leads there too.
 * https://caddyserver.com/docs/automatic-https#on-demand-tls
 */

const SETTINGS_KEY = 'httpsGateway';
const IMAGE = 'caddy:2-alpine';
const CONTAINER = 'mornihosting-https';
const MEMORY_MB = 256;
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
/** The panel's name on the Minecraft network (container_name in docker-compose.yml). */
const PANEL_HOST = 'mornihosting';
const IPV4_MAPPED = '::ffff:';

interface Stored {
  readonly enabled: boolean;
  readonly containerId: string | null;
  readonly domain: string;
}

export interface HttpsGateway {
  readonly status: () => Promise<HttpsStatus>;
  readonly enable: (actor: Actor) => Promise<HttpsStatus>;
  readonly disable: (actor: Actor) => Promise<HttpsStatus>;
  /** Caddy asks before fetching a certificate: only the domain and single names right below it. */
  readonly allowed: (host: string) => boolean;
  /** The gateway's own address: only its X-Forwarded-For is trusted for the visitor's real IP. */
  readonly isGateway: (address: string) => boolean;
  readonly init: () => Promise<void>;
}

/** Caddy's whole configuration: the domain serves the panel, every other name below it redirects there. */
function caddyfile(domain: string, panelPort: number): string {
  const panel = `${PANEL_HOST}:${panelPort}`;
  return [
    '{',
    '\ton_demand_tls {',
    `\t\task http://${panel}/api/tls/allowed`,
    '\t}',
    '}',
    '',
    `${domain} {`,
    `\treverse_proxy ${panel}`,
    '}',
    '',
    'https:// {',
    '\ttls {',
    '\t\ton_demand',
    '\t}',
    `\tredir https://${domain}{uri}`,
    '}',
    '',
    'http:// {',
    '\tredir https://{host}{uri}',
    '}',
    '',
  ].join('\n');
}

export function createHttpsGateway(ctx: AppContext, domainOf: () => string | null): HttpsGateway {
  const dir = path.join(ctx.config.dataDir, 'https');
  const state: { ip: string | null; error: HttpsStatus['error'] } = { ip: null, error: null };
  const stored = (): Stored | null => ctx.settings.getValue<Stored>(SETTINGS_KEY) ?? null;

  const refresh = async (): Promise<boolean> => {
    const id = stored()?.containerId;
    const info = id ? await ctx.docker.inspect(id) : null;
    state.ip = info?.running ? info.ip : null;
    return info?.running ?? false;
  };

  const status = async (): Promise<HttpsStatus> => {
    const s = stored();
    return {
      enabled: s?.enabled ?? false,
      domain: s?.enabled ? s.domain : domainOf(),
      running: s?.enabled ? await refresh() : false,
      error: state.error,
    };
  };

  const removeOld = async (): Promise<void> => {
    const id = stored()?.containerId;
    if (id) await ctx.docker.removeContainer(id);
  };

  const launch = async (domain: string): Promise<void> => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Caddyfile'), caddyfile(domain, ctx.config.port));
    await ctx.docker.ensureImage(IMAGE);
    await removeOld();
    const id = await ctx.docker.createContainer({
      name: CONTAINER,
      image: IMAGE,
      env: {},
      ports: [
        { containerPort: HTTP_PORT, hostPort: HTTP_PORT, protocol: 'tcp' },
        { containerPort: HTTPS_PORT, hostPort: HTTPS_PORT, protocol: 'tcp' },
        { containerPort: HTTPS_PORT, hostPort: HTTPS_PORT, protocol: 'udp' },
      ],
      memoryLimitBytes: MEMORY_MB * BYTES_PER_MB,
      dataDir: dir,
      labels: { 'mornihosting.role': 'https' },
      command: ['caddy', 'run', '--config', '/data/Caddyfile', '--adapter', 'caddyfile'],
      restart: 'unless-stopped',
    });
    ctx.settings.setValue(SETTINGS_KEY, { enabled: true, containerId: id, domain } satisfies Stored);
    await ctx.docker.start(id);
    await refresh();
  };

  return {
    status,
    enable: async (actor) => {
      const domain = domainOf();
      if (!domain) throw badRequest('https_needs_domain');
      try {
        await launch(domain);
        state.error = null;
      } catch (err) {
        state.error = {
          code: 'https_failed',
          params: { message: err instanceof Error ? err.message : String(err) },
        };
        throw new AppError(HTTP_BAD_GATEWAY, 'https_failed', state.error.params, { cause: err });
      }
      // Passkeys and secure cookies belong to the domain the panel is reached at from now on.
      ctx.settings.update({ panelDomain: domain });
      ctx.events.emit('panel.host', { host: domain });
      ctx.audit.record(actor, 'https.enable', null, { domain });
      return status();
    },
    disable: async (actor) => {
      await removeOld();
      const s = stored();
      if (s)
        ctx.settings.setValue(SETTINGS_KEY, { ...s, enabled: false, containerId: null } satisfies Stored);
      state.ip = null;
      state.error = null;
      ctx.audit.record(actor, 'https.disable');
      return status();
    },
    allowed: (host) => {
      const domain = stored()?.enabled ? stored()?.domain : null;
      if (!domain) return false;
      const name = host.toLowerCase();
      if (name === domain) return true;
      const label = name.endsWith(`.${domain}`) ? name.slice(0, -(domain.length + 1)) : '';
      return label !== '' && !label.includes('.');
    },
    isGateway: (address) => {
      // Without a running gateway nothing is trusted; some sockets have no address at all (undefined).
      if (state.ip === null || typeof address !== 'string') return false;
      const plain = address.startsWith(IPV4_MAPPED) ? address.slice(IPV4_MAPPED.length) : address;
      return plain === state.ip;
    },
    init: async () => {
      const s = stored();
      if (!s?.enabled) return;
      const domain = domainOf() ?? s.domain;
      try {
        // A changed domain gets a fresh configuration; otherwise the container just has to run.
        if (domain !== s.domain || !(await refresh())) await launch(domain);
      } catch (err) {
        state.error = {
          code: 'https_failed',
          params: { message: err instanceof Error ? err.message : String(err) },
        };
        ctx.log.warn({ err }, 'HTTPS gateway could not start');
      }
    },
  };
}
