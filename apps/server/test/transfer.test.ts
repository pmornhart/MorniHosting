import { afterEach, describe, expect, test } from 'vitest';
import { authHeaders, createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

describe('move code (settings to another panel)', () => {
  const apps: TestApp[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.cleanup()));
  });
  const panel = async (secret: string): Promise<{ t: TestApp; s: Session }> => {
    const t = await createTestApp({ MH_SECRET: secret });
    apps.push(t);
    return { t, s: await setupAdmin(t) };
  };
  const call = (p: { t: TestApp; s: Session }, method: 'POST' | 'PUT', url: string, payload: object) =>
    p.t.app.inject({ method, url, headers: authHeaders(p.s), payload });

  test('settings and their secrets move to a panel with another MH_SECRET', async () => {
    const old = await panel('alter-panel-schluessel-0123456789abcdef');
    const fresh = await panel('neuer-panel-schluessel-0123456789abcdef');
    await call(old, 'PUT', '/api/settings', {
      panelDomain: 'mornihosting.de',
      curseforgeApiKey: 'cf-geheim-123',
    });

    const made = (await call(old, 'POST', '/api/transfer/export', { password: 'umzug-passwort' })).json<{
      code: string;
      parts: string[];
    }>();
    expect(made.code.startsWith('MH1-')).toBe(true);
    expect(made.code).not.toContain('cf-geheim');
    expect(made.parts).toContain('panel');

    expect(
      (
        await call(fresh, 'POST', '/api/transfer/import', { code: made.code, password: 'falsches-pw' })
      ).json(),
    ).toMatchObject({ error: 'transfer_password_wrong' });

    const wrapped = made.code.replace(/(.{60})/gu, '$1\n');
    const done = await call(fresh, 'POST', '/api/transfer/import', {
      code: wrapped,
      password: 'umzug-passwort',
    });
    expect(done.json()).toMatchObject({ from: 'mornihosting.de', restarting: false });
    expect(fresh.t.ctx.settings.get().panelDomain).toBe('mornihosting.de');
    expect(fresh.t.ctx.settings.curseforgeKey()).toBe('cf-geheim-123');
  });

  test('only admins may make or redeem a code', async () => {
    const p = await panel('noch-ein-schluessel-0123456789abcdef');
    const anon = await p.t.app.inject({
      method: 'POST',
      url: '/api/transfer/export',
      payload: { password: 'umzug-passwort' },
    });
    expect(anon.statusCode).toBeGreaterThanOrEqual(400);
  });
});
