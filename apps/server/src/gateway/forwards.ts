import type {
  RouterForward,
  RouterForwardCheck,
  RouterForwardsStatus,
  RouterForwardView,
} from '@mornihosting/shared';
import type { Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../lib/errors.js';
import { forwardTargetProblem, ownNetworks } from '../lib/net-guard.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../lib/units.js';
import type { NetbirdAutomation } from '../netbird/service.js';
import type { RouteTarget, RouterKind } from './router.js';

/**
 * "Weitere Domains über diesen Verteiler": a second product on the same NetBird server (e.g. MoinMorni on
 * moinmorni.net) gets no 25565/19132 of its own – NetBird forwards by port, and the address router holds them. The admin
 * enters that product's domain with the outside ports it has in NetBird (e.g. 25567 and 19134); the router then sends
 * players who typed that domain to where NetBird sends those ports (looked up in the same NetBird account, e.g. the
 * other product's container in the home network). Bytes pass through unchanged, like for the panel's own servers.
 */

const FORWARDS_KEY = 'router_forwards';
/** NetBird is asked at most once a minute per port: a port's target hardly ever moves. */
const CACHE_MS = MS_PER_MINUTE;
/** NetBird could not be asked: players try again after a few seconds, not a whole minute. */
const RETRY_AFTER_ERROR_SECONDS = 10;
/** A domain whose target cannot be found is written to the log at most once a minute. */
const LOG_EVERY_MS = MS_PER_MINUTE;
const PORT_OF: Readonly<Record<RouterKind, 'javaPort' | 'bedrockPort'>> = {
  java: 'javaPort',
  bedrock: 'bedrockPort',
};

interface Found {
  readonly check: RouterForwardCheck;
  /** Where the router connects; null when it must not or cannot. */
  readonly to: RouteTarget | null;
}

export interface RouterForwards {
  /** Is this (cleaned) address one of the entered domains? Then its players never land on the panel's own servers. */
  readonly owns: (address: string) => boolean;
  /** Where players of an entered domain go; null = nowhere (the router closes the connection). */
  readonly resolve: (address: string, kind: RouterKind) => Promise<RouteTarget | null>;
  /** The entered domains, each with what NetBird says about its ports (fresh: ask NetBird now). */
  readonly status: (fresh: boolean) => Promise<RouterForwardsStatus>;
  readonly save: (forwards: readonly RouterForward[], actor: Actor) => Promise<RouterForwardsStatus>;
}

export function createRouterForwards(
  ctx: AppContext,
  netbird: NetbirdAutomation,
  /** The panel's own server that would answer to this domain first (same name), if any. */
  ownServerFor: (domain: string) => string | null,
): RouterForwards {
  const cache = new Map<number, { readonly until: number; readonly found: Promise<Found> }>();
  const logged = new Map<string, number>();

  const stored = (): RouterForward[] => ctx.settings.getValue<RouterForward[]>(FORWARDS_KEY) ?? [];
  const entryFor = (address: string): RouterForward | undefined => stored().find((f) => f.domain === address);

  const ask = async (port: number): Promise<Found> => {
    try {
      const where = await netbird.portTarget(port);
      if (!where.found)
        return {
          check: { target: null, service: where.service, problem: where.problem, error: null },
          to: null,
        };
      const target = `${where.host}:${where.port}`;
      // Only into the home network or to NetBird machines: never an open relay into the internet.
      const problem = forwardTargetProblem(where.host, ownNetworks());
      return {
        check: { target, service: where.service, problem, error: null },
        to: problem ? null : { host: where.host, port: where.port },
      };
    } catch (err) {
      const error =
        err instanceof AppError
          ? { code: err.code, params: err.params }
          : { code: 'netbird_failed', params: {} };
      return { check: { target: null, service: null, problem: 'netbird_error', error }, to: null };
    }
  };

  const lookup = (port: number, fresh: boolean): Promise<Found> => {
    const hit = cache.get(port);
    if (hit && hit.until > Date.now() && !fresh) return hit.found;
    const found = ask(port);
    cache.set(port, { until: Date.now() + CACHE_MS, found });
    void found.then(({ check }) => {
      if (check.problem === 'netbird_error' && cache.get(port)?.found === found)
        cache.set(port, { until: Date.now() + RETRY_AFTER_ERROR_SECONDS * MS_PER_SECOND, found });
    });
    return found;
  };

  /** One line in the log when players of a domain cannot be sent on (once a minute per domain and kind). */
  const note = (domain: string, kind: RouterKind, port: number, check: RouterForwardCheck): void => {
    const key = `${domain} ${kind}`;
    if ((logged.get(key) ?? 0) > Date.now()) return;
    logged.set(key, Date.now() + LOG_EVERY_MS);
    ctx.log.warn(
      { domain, kind, port, problem: check.problem, target: check.target, service: check.service },
      'address router: no target for this domain, connection closed',
    );
  };

  const resolve: RouterForwards['resolve'] = async (address, kind) => {
    const entry = entryFor(address);
    const port = entry?.[PORT_OF[kind]] ?? null;
    if (!entry || port === null) return null;
    const { to, check } = await lookup(port, false);
    if (!to) note(address, kind, port, check);
    return to;
  };

  const checkOf = async (port: number | null, fresh: boolean): Promise<RouterForwardCheck | null> =>
    port === null ? null : (await lookup(port, fresh)).check;

  const status: RouterForwards['status'] = async (fresh) => ({
    router: netbird.status().router,
    forwards: await Promise.all(
      stored().map(async (f): Promise<RouterForwardView> => ({
        ...f,
        java: await checkOf(f.javaPort, fresh),
        bedrock: await checkOf(f.bedrockPort, fresh),
        shadowedBy: ownServerFor(f.domain),
      })),
    ),
  });

  return {
    owns: (address) => entryFor(address) !== undefined,
    resolve,
    status,
    save: async (forwards, actor) => {
      const domains = forwards.map((f) => f.domain);
      const twice = domains.find((d, i) => domains.indexOf(d) !== i);
      if (twice) throw badRequest('router_forward_twice', { domain: twice });
      // The panel's own domain belongs to its own servers.
      const own = netbird.status().domain;
      if (own && domains.includes(own)) throw badRequest('router_forward_own_domain', { domain: own });
      ctx.settings.setValue(FORWARDS_KEY, forwards);
      cache.clear();
      logged.clear();
      ctx.audit.record(actor, 'netbird.forwards', null, { domains: domains.join(', ') });
      return status(true);
    },
  };
}
