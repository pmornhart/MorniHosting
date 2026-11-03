/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GAMES, type ServerDetail, type ServerSummary } from '@mornihosting/shared';
import { INSTALLED_MARK } from '../src/servers/game-seed.js';
import { createDownloadMeter, readSteamProgress } from '../src/servers/steam-progress.js';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

describe('steamcmd progress', () => {
  test('reads percent and bytes and works out the speed', () => {
    expect(
      readSteamProgress('Update state (0x61) downloading, progress: 45.23 (27000000000 / 60000000000)'),
    ).toEqual({
      percent: 45.23,
      done: 27_000_000_000,
      total: 60_000_000_000,
    });
    expect(readSteamProgress("Success! App '730' fully installed.")).toBeNull();
    const meter = createDownloadMeter();
    meter('progress: 10.00 (6000000000 / 60000000000)', 0);
    const later = meter('progress: 11.00 (6600000000 / 60000000000)', 10_000);
    expect(later).toMatchObject({ percent: 11, doneBytes: 6_600_000_000, bytesPerSecond: 60_000_000 });
  });
});

describe('a second CS2 server copies the game from the first one', () => {
  let t: TestApp;
  let s: Session;
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(s) });
  const order = (name: string, port: number) => ({
    name,
    edition: 'cs2',
    software: 'cs2',
    version: GAMES.cs2.versions[0]?.id ?? 'steam',
    memoryMb: GAMES.cs2.recommendedGb * 1024,
    port,
    eula: true,
    startNow: false,
  });
  beforeEach(async () => {
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('copies the files and keeps logs out', async () => {
    const first = (await call('POST', '/api/servers', order('Erster', 27015))).json<ServerSummary>();
    const firstDir = path.join(t.dataDir, 'servers', first.id);
    fs.mkdirSync(path.join(firstDir, 'game', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(firstDir, 'game', 'bin', 'cs2'), 'binary');
    fs.mkdirSync(path.join(firstDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(firstDir, 'logs', 'old.log'), 'x');
    fs.writeFileSync(path.join(firstDir, INSTALLED_MARK), 'yes');

    const second = (await call('POST', '/api/servers', order('Zweiter', 27025))).json<ServerSummary>();
    await call('POST', `/api/servers/${second.id}/actions/start`);
    await waitFor(
      async () =>
        (await call('GET', `/api/servers/${second.id}`)).json<ServerDetail>().live.state === 'running',
    );
    const secondDir = path.join(t.dataDir, 'servers', second.id);
    expect(fs.readFileSync(path.join(secondDir, 'game', 'bin', 'cs2'), 'utf8')).toBe('binary');
    expect(fs.existsSync(path.join(secondDir, 'logs', 'old.log'))).toBe(false);
    expect(fs.existsSync(path.join(secondDir, INSTALLED_MARK))).toBe(true);
  });
});
