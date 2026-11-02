import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { WsServerMessage } from '@mornihosting/shared';
import { getAuth } from './auth/context.js';
import { originAllowed } from './auth/hook.js';
import type { Api, AppContext } from './context.js';
import type { ServerService } from './servers/service.js';
import { safeEqual } from './lib/crypto.js';
import { MS_PER_SECOND } from './lib/units.js';

/**
 * One WebSocket per browser tab. The tab subscribes to the live status of its servers
 * and to the console of the server it shows; every message is checked against the user's rights.
 */

const CSRF_MAX = 200;
/** How long a socket from an unknown origin may take to prove itself before it is closed. */
const PROOF_SECONDS = 10;

const clientMessage = z.union([
  z.object({ type: z.literal('hello'), csrf: z.string().max(CSRF_MAX) }),
  z.object({ type: z.literal('subscribe'), channel: z.literal('servers') }),
  z.object({ type: z.literal('subscribe'), channel: z.literal('console'), serverId: z.string() }),
  z.object({ type: z.literal('unsubscribe'), channel: z.literal('console'), serverId: z.string() }),
  z.object({ type: z.literal('ping') }),
]);

const OPEN = 1;
const POLICY_VIOLATION = 1008;
const ACCESS_REFRESH_SECONDS = 30;
const MAX_MESSAGE_BYTES = 4096;

export function registerWebSocket(app: Api, ctx: AppContext, servers: ServerService): void {
  app.get('/api/ws', { websocket: true }, (socket: WebSocket, request) => {
    const auth = getAuth(request);
    if (!auth) {
      socket.close(POLICY_VIOLATION, 'unauthorized');
      return;
    }
    const user = auth.user;
    // Behind a proxy that rewrites the Host header (NetBird without "Pass Host Header") the Origin cannot
    // be checked, and browsers send no fetch metadata on WebSocket handshakes. Such a socket gets nothing
    // until its first message carries the session's CSRF token, which other pages cannot read.
    const proof = { ok: originAllowed(ctx, request) };
    const reject = (): void => socket.close(POLICY_VIOLATION, 'unauthorized');
    const proofTimer = proof.ok ? null : setTimeout(reject, PROOF_SECONDS * MS_PER_SECOND);
    const subscriptions = { servers: false, consoles: new Set<string>() };
    const cache = { access: ctx.access.accessMap(user), at: Date.now() };
    const rightsFor = (serverId: string): readonly string[] => {
      // A server created after the socket opened is unknown to the cache; look again right away.
      const stale = Date.now() - cache.at > ACCESS_REFRESH_SECONDS * MS_PER_SECOND;
      if (stale || !(serverId in cache.access)) {
        cache.access = ctx.access.accessMap(user);
        cache.at = Date.now();
      }
      return cache.access[serverId] ?? [];
    };

    const send = (message: WsServerMessage): void => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
    };

    const offs = [
      ctx.events.on('server.live', ({ serverId, live }) => {
        if (subscriptions.servers && rightsFor(serverId).length) send({ type: 'live', serverId, live });
      }),
      ctx.events.on('server.log', ({ serverId, line }) => {
        if (subscriptions.consoles.has(serverId)) send({ type: 'console', serverId, line });
      }),
      ctx.events.on('server.deleted', ({ serverId }) => {
        subscriptions.consoles.delete(serverId);
        if (subscriptions.servers) send({ type: 'deleted', serverId });
      }),
      // Admins see every sign-up and request at once; a person sees their own request being decided.
      ctx.events.on('user.awaiting_approval', () => {
        if (subscriptions.servers && user.isAdmin) send({ type: 'approvals' });
      }),
      ctx.events.on('approvals.changed', ({ userId }) => {
        if (subscriptions.servers && (user.isAdmin || userId === user.id)) send({ type: 'approvals' });
      }),
    ];

    socket.on('message', (raw: Buffer) => {
      if (raw.length > MAX_MESSAGE_BYTES) return;
      const parsed = (() => {
        try {
          return clientMessage.safeParse(JSON.parse(raw.toString('utf8')));
        } catch {
          return null;
        }
      })();
      if (!parsed?.success) {
        send({ type: 'error', code: 'bad_message' });
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'hello') {
        proof.ok = proof.ok || (auth.csrfToken !== null && safeEqual(msg.csrf, auth.csrfToken));
        if (proofTimer) clearTimeout(proofTimer);
        if (!proof.ok) reject();
        return;
      }
      if (!proof.ok) {
        reject();
        return;
      }
      if (msg.type === 'ping') {
        send({ type: 'pong' });
        return;
      }
      if (msg.type === 'unsubscribe') {
        subscriptions.consoles.delete(msg.serverId);
        return;
      }
      if (msg.channel === 'servers') {
        subscriptions.servers = true;
        servers.list(user).forEach((s) => send({ type: 'live', serverId: s.id, live: s.live }));
        return;
      }
      if (!rightsFor(msg.serverId).includes('console')) {
        send({ type: 'error', code: 'forbidden' });
        return;
      }
      subscriptions.consoles.add(msg.serverId);
      send({ type: 'console-history', serverId: msg.serverId, lines: servers.logs(msg.serverId) });
    });

    socket.on('close', () => {
      if (proofTimer) clearTimeout(proofTimer);
      offs.forEach((off) => off());
    });
  });
}
