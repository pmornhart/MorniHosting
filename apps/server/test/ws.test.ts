import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WsClientMessage, WsServerMessage } from '@mornihosting/shared';
import { createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

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
});
