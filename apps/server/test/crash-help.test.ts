/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { CrashHelp, CrashInfo, ServerDetail, ServerSummary } from '@mornihosting/shared';
import { authHeaders, createTestApp, login, setupAdmin, type Session, type TestApp } from './helpers.js';

const order = {
  name: 'Kaputt',
  edition: 'java',
  software: 'paper',
  version: '1.21.4',
  memoryMb: 2048,
  port: 25565,
  eula: true,
  startNow: false,
};

describe('crash helper', () => {
  let t: TestApp;
  let admin: Session;
  let id: string;
  let dir: string;
  const as = (s: Session, method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(s) });
  const crash = (ruleId: string, params: Record<string, string> = {}): void => {
    const info: CrashInfo = { at: new Date().toISOString(), ruleId, params, excerpt: ['line a', 'line b'] };
    t.ctx.db.run(sql`UPDATE servers SET crash = ${JSON.stringify(info)} WHERE id = ${id}`);
    t.ctx.events.emit('server.crashed', { serverId: id, crash: info });
  };
  const help = async (): Promise<CrashHelp | null> =>
    (await as(admin, 'GET', `/api/servers/${id}/crash`)).json<{ help: CrashHelp | null }>().help;

  beforeEach(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
    id = (await as(admin, 'POST', '/api/servers', order)).json<ServerSummary>().id;
    dir = path.join(t.dataDir, 'servers', id);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('out of memory: one click gives more memory, clears the crash and explains it in the console', async () => {
    const consoleLines: string[] = [];
    t.ctx.events.on('server.log', ({ line }) => consoleLines.push(line));
    crash('out-of-memory', { memoryMb: '2048' });
    const offered = await help();
    expect(offered?.fixes.map((f) => f.id)).toEqual(['raise-memory', 'retry']);
    expect(offered?.fixes[0]?.params).toMatchObject({ toMb: '3072', toGb: '3' });

    expect(consoleLines.join('\n')).toContain('Absturz erkannt: Zu wenig Arbeitsspeicher');

    const done = await as(admin, 'POST', `/api/servers/${id}/crash/fix`, {
      fix: 'raise-memory',
      start: false,
    });
    expect(done.statusCode).toBe(200);
    const detail = (await as(admin, 'GET', `/api/servers/${id}`)).json<ServerDetail>();
    expect(detail.memoryMb).toBe(3072);
    expect(detail.crash).toBeNull();
    expect(await help()).toBeNull();
  });

  test('a broken plugin is switched off; a broken world is backed up and removed', async () => {
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'EssentialsX-2.21.0.jar'), 'jar');
    crash('plugin-error', { plugin: 'EssentialsX' });
    expect((await help())?.fixes[0]).toMatchObject({
      id: 'disable-plugin',
      params: { file: 'EssentialsX-2.21.0.jar' },
    });
    await as(admin, 'POST', `/api/servers/${id}/crash/fix`, { fix: 'disable-plugin', start: false });
    expect(fs.existsSync(path.join(dir, 'plugins', 'EssentialsX-2.21.0.jar.disabled'))).toBe(true);

    fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'broken');
    crash('world-broken');
    const fixes = (await help())?.fixes ?? [];
    expect(fixes.find((f) => f.id === 'reset-world')?.danger).toBe(true);
    await as(admin, 'POST', `/api/servers/${id}/crash/fix`, { fix: 'reset-world', start: false });
    expect(fs.existsSync(path.join(dir, 'world'))).toBe(false);
    const { backups } = (await as(admin, 'GET', `/api/servers/${id}/backups`)).json<{ backups: unknown[] }>();
    expect(backups.length).toBeGreaterThan(0);
  });

  test('only people with the rights may repair; fixes not on offer are refused', async () => {
    await as(admin, 'POST', '/api/users', { username: 'gast', password: 'gast-passwort-1' });
    const guest = await login(t, 'gast', 'gast-passwort-1');
    crash('port-in-use');
    expect((await as(guest, 'POST', `/api/servers/${id}/crash/fix`, { fix: 'free-port' })).statusCode).toBe(
      403,
    );
    expect((await as(admin, 'POST', `/api/servers/${id}/crash/fix`, { fix: 'reset-world' })).statusCode).toBe(
      404,
    );
    expect((await help())?.fixes[0]).toMatchObject({ id: 'free-port', params: { port: '25566' } });
  });
});
