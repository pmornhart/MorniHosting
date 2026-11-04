import { eq } from 'drizzle-orm';
import { SOFTWARE } from '@mornihosting/shared';
import type { AppContext } from '../context.js';
import { servers as serverTable } from '../db/schema.js';
import { containerName } from '../servers/spec.js';
import { startRouter, type AddressRouter, type RouteLookup, type RouterKind } from './router.js';

/**
 * Starts the address router (see router.ts) for Java and Bedrock and tells it where each name lives: the first
 * part of the typed address is the server's name ("reich" of "reich.mornihosting.de"; "reich-bedrock" works too),
 * the connection goes to that server's container inside the Docker network.
 */

/** Geyser's Bedrock port inside a Java server's container (TCP for signaling, UDP for the game). */
const GEYSER_INSIDE_PORT = 19132;
const BEDROCK_ALIAS = '-bedrock';

export interface AddressGateway {
  readonly lookup: RouteLookup;
  /** Opens the router ports (only the real panel; tests use their own). */
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function createAddressGateway(ctx: AppContext): AddressGateway {
  const open: AddressRouter[] = [];

  const lookup: RouteLookup = (address, kind) => {
    const first = address.split('.')[0] ?? '';
    const name = first.endsWith(BEDROCK_ALIAS) ? first.slice(0, -BEDROCK_ALIAS.length) : first;
    if (!name) return null;
    const row = ctx.db.select().from(serverTable).where(eq(serverTable.netbirdName, name)).get();
    if (!row || row.template || row.edition !== 'java') return null;
    if (kind === 'java') return { host: containerName(row.id), port: SOFTWARE[row.software].defaultPort };
    return row.geyser ? { host: containerName(row.id), port: GEYSER_INSIDE_PORT } : null;
  };

  const startOne = async (kind: RouterKind): Promise<void> => {
    const port = ctx.config.routerPorts[kind];
    if (port === 0) return;
    try {
      open.push(
        await startRouter({
          kind,
          host: ctx.config.host,
          port,
          lookup,
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
    start: async () => {
      await Promise.all((['java', 'bedrock'] as const).map(startOne));
    },
    stop: async () => {
      await Promise.all(open.splice(0).map((r) => r.close()));
    },
  };
}
