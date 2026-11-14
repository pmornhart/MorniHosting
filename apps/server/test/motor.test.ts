/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { scopeFor } from '@mornihosting/shared';
import { runCommand } from '../src/admin-cli.js';
import { authHeaders, createTestApp, setupAdmin, type TestApp } from './helpers.js';

describe('scopeFor', () => {
  test.each([
    ['GET', '/api/servers', 'servers:read'],
    ['GET', '/api/servers/abc/files?path=/', 'servers:read'],
    ['POST', '/api/servers', 'servers:manage'],
    ['POST', '/api/servers/import', 'servers:manage'],
    ['DELETE', '/api/servers/abc', 'servers:manage'],
    ['PATCH', '/api/servers/abc', 'servers:config'],
    ['POST', '/api/servers/abc/actions/start', 'servers:control'],
    ['POST', '/api/servers/abc/command', 'servers:control'],
    ['PUT', '/api/servers/abc/files', 'servers:files'],
    ['POST', '/api/servers/abc/backups', 'servers:files'],
    ['PUT', '/api/servers/abc/properties', 'servers:config'],
    ['POST', '/api/networks/n1/members', 'networks'],
    ['GET', '/api/networks', 'networks'],
    ['POST', '/api/users', 'users'],
    ['GET', '/api/ws', 'events'],
    ['GET', '/api/auth/me', 'servers:read'],
    ['GET', '/api/settings', 'admin'],
    ['PUT', '/api/netbird', 'admin'],
  ])('%s %s → %s', (method, url, scope) => {
    expect(scopeFor(method, url.split('?')[0] ?? url)).toBe(scope);
  });
});

describe('limited API keys and the motor mode', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.cleanup();
  });

  test('a key limited to servers:read sees servers but changes nothing', async () => {
    t = await createTestApp();
    const s = await setupAdmin(t);
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: authHeaders(s),
      payload: { name: 'Statusseite', scopes: ['servers:read'] },
    });
    const { token, entry } = created.json<{ token: string; entry: { scopes: string[] } }>();
    expect(entry.scopes).toEqual(['servers:read']);
    const bearer = { authorization: `Bearer ${token}` };
    expect((await t.app.inject({ method: 'GET', url: '/api/servers', headers: bearer })).statusCode).toBe(
      200,
    );
    const create = await t.app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: bearer,
      payload: {
        name: 'X',
        edition: 'java',
        software: 'paper',
        version: '1.21.4',
        memoryMb: 1024,
        port: 25565,
        eula: true,
      },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ error: 'token_scope' });
    expect((await t.app.inject({ method: 'GET', url: '/api/settings', headers: bearer })).statusCode).toBe(
      403,
    );
  });

  test('service-token: an admin service account for another app, limited to its areas', async () => {
    t = await createTestApp();
    await setupAdmin(t);
    const result = await runCommand(t.ctx.db, 'service-token', ['moinmorni', 'servers:read', 'networks']);
    expect(result.ok).toBe(true);
    const bearer = { authorization: `Bearer ${result.message}` };
    expect((await t.app.inject({ method: 'GET', url: '/api/networks', headers: bearer })).statusCode).toBe(
      200,
    );
    expect((await t.app.inject({ method: 'GET', url: '/api/settings', headers: bearer })).statusCode).toBe(
      403,
    );
    // A second key for the same app reuses the account.
    const again = await runCommand(t.ctx.db, 'service-token', ['moinmorni']);
    const all = { authorization: `Bearer ${again.message}` };
    expect((await t.app.inject({ method: 'GET', url: '/api/settings', headers: all })).statusCode).toBe(200);
    expect((await runCommand(t.ctx.db, 'service-token', ['moinmorni', 'alles'])).ok).toBe(false);
    expect((await runCommand(t.ctx.db, 'list-users', [])).message).toContain('dienst-moinmorni');
  });

  test('a service account made before the first person keeps the setup wizard open', async () => {
    t = await createTestApp({ MH_HEADLESS: 'true' });
    expect((await runCommand(t.ctx.db, 'service-token', ['moinmorni'])).ok).toBe(true);
    const status = await t.app.inject({ method: 'GET', url: '/api/system/status' });
    expect(status.json()).toMatchObject({ setupRequired: true });
    const setup = await t.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'philip', password: 'Test-Passwort-12345', locale: 'de' },
    });
    expect(setup.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/system/status' })).json()).toMatchObject({
      setupRequired: false,
    });
  });

  test('motor mode serves no web interface, only the API', async () => {
    const web = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-web-'));
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Panel</title>');
    t = await createTestApp({ MH_WEB_DIR: web, MH_HEADLESS: 'true' });
    const page = await t.app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(404);
    expect(page.json()).toEqual({ error: 'not_found' });
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    await t.cleanup();
    t = await createTestApp({ MH_WEB_DIR: web });
    expect((await t.app.inject({ method: 'GET', url: '/' })).body).toContain('<title>Panel</title>');
    fs.rmSync(web, { recursive: true, force: true });
  });
});
