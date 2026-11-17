import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { HTTP_MOVED_PERMANENTLY } from '../lib/http-status.js';

/** The name in front of the panel's domain that NetBird also sends here (see `syncWww` in service.ts). */
const WWW_PREFIX = 'www.';

/**
 * Visitors of www.<panel domain> land on the panel domain itself – same path, same query, permanently (301). Only for
 * exactly that name: every other name is left alone. The panel domain comes from the settings, never from the
 * request, so the redirect cannot lead anywhere else.
 */
export function createWwwRedirect(ctx: AppContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const domain = ctx.settings.get().panelDomain.trim().toLowerCase();
    if (!domain || request.hostname.toLowerCase() !== `${WWW_PREFIX}${domain}`) return undefined;
    return reply.code(HTTP_MOVED_PERMANENTLY).header('location', `https://${domain}${request.url}`).send();
  };
}
