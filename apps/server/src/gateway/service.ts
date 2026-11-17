import { eq } from 'drizzle-orm';
import { SOFTWARE } from '@mornihosting/shared';
import type { AppContext } from '../context.js';
import { servers as serverTable } from '../db/schema.js';
import type { NetbirdAutomation } from '../netbird/service.js';
import { containerName, type ServerRow } from '../servers/spec.js';
import { createRouterForwards, type RouterForwards } from './forwards.js';
import { startRouter, type AddressRouter, type RouteTarget, type RouterKind } from './router.js';

/**
 * Starts the address router (see router.ts) for Java and Bedrock and tells it where each name lives: the first
 * part of the typed address is the server's name ("reich" of "reich.mornihosting.de"; "reich-bedrock" works too),
 * the connection goes to that server's container inside the Docker network. The panel's own servers come first;
 * then the domains of other products on the same NetBird server (see forwards.ts).
 */

/** Geyser's Bedrock port inside a Java server's container (TCP for signaling, UDP for the game). */
const GEYSER_INSIDE_PORT = 19132;
const BEDROCK_ALIAS = '-bedrock';
/** The NetBird setup: its domain and the server players reach on the domain itself. */
const NETBIRD_KEY = 'netbird';
interface NetbirdDomain {
  readonly domain?: string;
  readonly domainServerId?: string | null;
}

export interface AddressGateway {
  /** The panel's own server for a typed address (and the only Bedrock-ready one for Bedrock without a name). */
  readonly lookup: (address: string, kind: RouterKind) => RouteTarget | null;
  /** What the router asks: own servers first, then other products' domains (NetBird says where they live). */
  readonly route: (address: string, kind: RouterKind) => Promise<RouteTarget | null>;
  readonly forwards: RouterForwards;
  /** Opens the router ports (only the real panel; tests use their own). */
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function createAddressGateway(ctx: AppContext, netbird: NetbirdAutomation): AddressGateway {
  const open: AddressRouter[] = [];

  /** The server a typed address names: the domain itself (its chosen server) or a server's name in front. */
  const ownRow = (address: string): ServerRow | undefined => {
    const first = address.split('.')[0] ?? '';
    const name = first.endsWith(BEDROCK_ALIAS) ? first.slice(0, -BEDROCK_ALIAS.length) : first;
    // The domain itself ("mornihosting.de") belongs to the server chosen for it.
    const netbirdSetup = ctx.settings.getValue<NetbirdDomain>(NETBIRD_KEY);
    const onDomain =
      netbirdSetup?.domainServerId && address === netbirdSetup.domain
        ? ctx.db.select().from(serverTable).where(eq(serverTable.id, netbirdSetup.domainServerId)).get()
        : undefined;
    return onDomain ?? ctx.db.select().from(serverTable).where(eq(serverTable.netbirdName, name)).get();
  };
  const forwards = createRouterForwards(ctx, netbird, (domain) => ownRow(domain)?.name ?? null);

  const lookup: AddressGateway['lookup'] = (address, kind) => {
    // Bedrock without a usable name (no Host header): with just one Bedrock-ready server, that one – unless the
    // name is another product's domain, whose players must never land here.
    const onlyGeyser = (): ServerRow | undefined => {
      const geyser = ctx.db
        .select()
        .from(serverTable)
        .all()
        .filter((r) => r.geyser && !r.template && r.edition === 'java');
      return geyser.length === 1 && !forwards.owns(address) ? geyser[0] : undefined;
    };
    const row = ownRow(address) ?? (kind === 'bedrock' ? onlyGeyser() : undefined);
    if (!row || row.template || row.edition !== 'java') return null;
    if (kind === 'java') return { host: containerName(row.id), port: SOFTWARE[row.software].defaultPort };
    return row.geyser ? { host: containerName(row.id), port: GEYSER_INSIDE_PORT } : null;
  };

  // The panel's own servers keep priority; another product's domain only when none of them answers to the name.
  const route: AddressGateway['route'] = async (address, kind) =>
    ownRow(address) || !forwards.owns(address) ? lookup(address, kind) : forwards.resolve(address, kind);

  const startOne = async (kind: RouterKind): Promise<void> => {
    const port = ctx.config.routerPorts[kind];
    if (port === 0) return;
    try {
      open.push(
        await startRouter({
          kind,
          host: ctx.config.host,
          port,
          lookup: route,
          onError: (err) => ctx.log.warn({ err, kind }, 'address router error'),
        }),
      );
      ctx.log.info({ kind, port }, 'address router listening');
    } catch (err) {
      // A taken port must not keep the panel from starting; servers stay reachable on their own ports.
      ctx.log.warn({ err, kind, port }, 'address router could not start');
    }
  };

  return {
    lookup,
    route,
    forwards,
    start: async () => {
      await Promise.all((['java', 'bedrock'] as const).map(startOne));
    },
    stop: async () => {
      await Promise.all(open.splice(0).map((r) => r.close()));
    },
  };
}
