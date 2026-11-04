/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { PreloadItem, ServerSummary } from '@mornihosting/shared';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

describe('preloading games in the admin area', () => {
  let t: TestApp;
  let s: Session;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(s) });
  const item = async (software: string): Promise<PreloadItem | undefined> =>
    (await call('GET', '/api/preload')).json<PreloadItem[]>().find((i) => i.software === software);

  beforeEach(async () => {
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('a game is downloaded once without a server; the next server of it copies from there', async () => {
    expect((await item('gmod'))?.state).toBe('none');
    expect((await call('POST', '/api/preload/gmod')).statusCode).toBe(202);
    await waitFor(async () => (await item('gmod'))?.state === 'ready', 20_000);
    // The template is hidden: no server shows up anywhere.
    expect((await call('GET', '/api/servers')).json<ServerSummary[]>()).toEqual([]);

    const made = (
      await call('POST', '/api/servers', {
        edition: 'gmod',
        software: 'gmod',
        version: 'steam',
        memoryMb: 4096,
        port: 27015,
        eula: true,
        startNow: true,
        name: 'Sandbox',
      })
    ).json<ServerSummary>();
    await waitFor(async () =>
      ((await call('GET', `/api/servers/${made.id}/console`)).json<{ lines: string[] }>().lines ?? []).some(
        (l) => l.includes('Kopiere die Spieldateien von „Vorlage'),
      ),
    );
    expect((await call('GET', '/api/servers')).json<ServerSummary[]>().map((x) => x.name)).toEqual([
      'Sandbox',
    ]);
    const state = async (): Promise<string> =>
      (await call('GET', `/api/servers/${made.id}`)).json<ServerSummary>().live.state;
    await waitFor(async () => (await state()) === 'running', 20_000);
    await call('POST', `/api/servers/${made.id}/actions/stop`);
    await waitFor(async () => (await state()) === 'stopped', 20_000);
    // The simulated start keeps going a few seconds after "running" (log replay); let it end before closing.
    await new Promise((resolve) => setTimeout(resolve, 6000));
  });

  test('games that come complete in their image only pull it; removing forgets the download', async () => {
    await call('POST', '/api/preload/factorio');
    await waitFor(async () => (await item('factorio'))?.state === 'ready');
    expect((await item('factorio'))?.mode).toBe('image');
    expect((await call('DELETE', '/api/preload/factorio')).statusCode).toBe(204);
    expect((await item('factorio'))?.state).toBe('none');
  });

  test('"download all" queues every game; they load one after another', async () => {
    const queued = (await call('POST', '/api/preload')).json<PreloadItem[]>();
    const busy = queued.filter((i) => i.state === 'loading' || i.state === 'queued');
    expect(busy.length).toBeGreaterThan(5);
    // One at a time: never two loading together.
    expect(queued.filter((i) => i.state === 'loading').length).toBeLessThanOrEqual(1);
    await waitFor(
      async () => (await call('GET', '/api/preload')).json<PreloadItem[]>().some((i) => i.state === 'ready'),
      20_000,
    );
  });

  test('only admins may preload', async () => {
    const other = await t.app.inject({ method: 'GET', url: '/api/preload' });
    expect(other.statusCode).toBe(401);
  });
});
