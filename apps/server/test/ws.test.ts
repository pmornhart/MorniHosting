import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WsClientMessage, WsServerMessage } from '@mornihosting/shared';
import { createTestApp, login, setupAdmin, type Session, type TestApp } from './helpers.js';

const POLICY_VIOLATION = 1008;

const nextMessage = (socket: WebSocket): Promise<WsServerMessage> =>
  new Promise((resolve) => {
    socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8')) as WsServerMessage));
  });
const closeCode = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => {
    socket.once('close', (code: number) => resolve(code));
  });
const say = (socket: WebSocket, message: WsClientMessage): void => socket.send(JSON.stringify(message));

describe('live connection (WebSocket)', () => {
  let t: TestApp;
  let s: Session;
  // A real socket always has an address; the injected one gets one so the visitor's IP can be worked out.
  const socket = { remoteAddress: '127.0.0.1' };
  const open = (headers: Record<string, string>) =>
    t.app.injectWS('/api/ws', {
      headers: { cookie: s.cookie, ...headers },
      connection: socket,
      socket,
    } as never);

  beforeEach(async () => {
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('a socket from the panel page itself works right away', async () => {
    const socket = await open({ host: 'localhost', origin: 'http://localhost' });
    say(socket, { type: 'ping' });
    expect(await nextMessage(socket)).toEqual({ type: 'pong' });
    socket.terminate();
  });

  test('behind a proxy that rewrites the Host header, the socket first shows the CSRF token', async () => {
    const viaProxy = { host: '100.92.14.7:8080', origin: 'https://panel.example.de' };
    const proven = await open(viaProxy);
    say(proven, { type: 'hello', csrf: s.csrf });
    say(proven, { type: 'ping' });
    expect(await nextMessage(proven)).toEqual({ type: 'pong' });
    proven.terminate();

    const guessing = await open(viaProxy);
    const guessed = closeCode(guessing);
    say(guessing, { type: 'hello', csrf: 'not-the-token' });
    expect(await guessed).toBe(POLICY_VIOLATION);

    const silent = await open(viaProxy);
    const skipped = closeCode(silent);
    say(silent, { type: 'subscribe', channel: 'servers' });
    expect(await skipped).toBe(POLICY_VIOLATION);
  });

  test('a page from another site gets nothing, even with a guessed message order', async () => {
    const socket = await open({ host: 'localhost', origin: 'https://evil.example' });
    const closed = closeCode(socket);
    say(socket, { type: 'subscribe', channel: 'servers' });
    expect(await closed).toBe(POLICY_VIOLATION);
  });

  test('new sign-ups and decided requests reach the open panel right away', async () => {
    const socket = await open({ host: 'localhost', origin: 'http://localhost' });
    say(socket, { type: 'subscribe', channel: 'servers' });
    say(socket, { type: 'ping' });
    expect(await nextMessage(socket)).toEqual({ type: 'pong' });
    const signUp = nextMessage(socket);
    t.ctx.events.emit('user.awaiting_approval', { userId: 2 });
    expect(await signUp).toEqual({ type: 'approvals' });
    const decided = nextMessage(socket);
    t.ctx.events.emit('approvals.changed', { userId: 2 });
    expect(await decided).toEqual({ type: 'approvals' });
    socket.terminate();
  });

  test('another app on the machine connects with an API key that has the area "events"', async () => {
    const make = async (scopes: string[]): Promise<string> =>
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/tokens',
          headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
          payload: { name: scopes.join('+'), scopes },
        })
      ).json<{ token: string }>().token;
    const withKey = (token: string) =>
      t.app.injectWS('/api/ws', {
        headers: { authorization: `Bearer ${token}` },
        connection: socket,
        socket,
      } as never);
    const live = await withKey(await make(['events', 'servers:read']));
    say(live, { type: 'ping' });
    expect(await nextMessage(live)).toEqual({ type: 'pong' });
    live.terminate();
    await expect(withKey(await make(['servers:read']))).rejects.toThrow();
  });

  test('alerts go live to an app that runs the panel as its motor – with what it missed while it was away', async () => {
    const token = (
      await t.app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
        payload: { name: 'morni.net', scopes: ['events'] },
      })
    ).json<{ token: string }>().token;
    const withKey = () =>
      t.app.injectWS('/api/ws', {
        headers: { authorization: `Bearer ${token}` },
        connection: socket,
        socket,
      } as never);
    const alertOf = (message: WsServerMessage) => (message.type === 'alert' ? message.alert : null);
    // A game server that does not come back by itself – while the app is not connected.
    t.ctx.events.emit('server.revive', { serverId: 'abc', tries: 1, reason: 'Port belegt' });

    const first = await withKey();
    const backlog = nextMessage(first);
    say(first, { type: 'subscribe', channel: 'alerts', after: 'nie-gesehen' });
    const missed = alertOf(await backlog);
    expect(missed).toMatchObject({
      key: 'server:abc',
      kind: 'server-restart',
      status: 'fixing',
      source: 'panel',
      action: null,
    });
    expect(missed?.what).toContain('Port belegt');
    // From then on live, also the all-clear.
    const cleared = nextMessage(first);
    t.ctx.events.emit('server.revive', { serverId: 'abc', tries: 0, reason: null });
    expect(alertOf(await cleared)).toMatchObject({ key: 'server:abc', status: 'ok' });
    first.terminate();

    // Coming back with the last one seen: only what came after it.
    const again = await withKey();
    const next = nextMessage(again);
    say(again, { type: 'subscribe', channel: 'alerts', after: missed?.id ?? '' });
    expect(alertOf(await next)).toMatchObject({ key: 'server:abc', status: 'ok' });
    say(again, { type: 'ping' });
    expect(await nextMessage(again)).toEqual({ type: 'pong' });
    again.terminate();
  });

  test('only admins may listen for alerts', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { username: 'lena', password: 'lena-passwort-1', displayName: 'Lena' },
    });
    const lena = await login(t, 'lena', 'lena-passwort-1');
    const socket = await t.app.injectWS('/api/ws', {
      headers: { cookie: lena.cookie, host: 'localhost', origin: 'http://localhost' },
      connection: { remoteAddress: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    } as never);
    say(socket, { type: 'subscribe', channel: 'alerts' });
    expect(await nextMessage(socket)).toEqual({ type: 'error', code: 'forbidden' });
    socket.terminate();
  });
});
