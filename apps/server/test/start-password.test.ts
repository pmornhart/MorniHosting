/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { MeResponse, UserListEntry } from '@mornihosting/shared';
import { authHeaders, createTestApp, login, setupAdmin, type Session, type TestApp } from './helpers.js';

describe('start password', () => {
  let t: TestApp;
  let admin: Session;
  const as = (session: Session, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(session) });

  beforeEach(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('a password chosen by an admin must be replaced after signing in', async () => {
    expect((await as(admin, 'GET', '/api/auth/me')).json<MeResponse>().user.mustChangePassword).toBe(false);
    const created = await as(admin, 'POST', '/api/users', { username: 'lea', password: 'start-pass-123' });
    expect(created.json<UserListEntry>().mustChangePassword).toBe(true);

    const lea = await login(t, 'lea', 'start-pass-123');
    expect((await as(lea, 'GET', '/api/auth/me')).json<MeResponse>().user.mustChangePassword).toBe(true);
    const changed = await as(lea, 'POST', '/api/account/password', {
      current: 'start-pass-123',
      next: 'leas-eigenes-passwort',
    });
    expect(changed.statusCode).toBe(204);
    expect((await as(lea, 'GET', '/api/auth/me')).json<MeResponse>().user.mustChangePassword).toBe(false);

    // A reset by the admin asks again.
    const id = created.json<UserListEntry>().id;
    await as(admin, 'POST', `/api/users/${id}/reset-password`, { removeSecondFactors: false });
    const users = (await as(admin, 'GET', '/api/users')).json<UserListEntry[]>();
    expect(users.find((u) => u.id === id)?.mustChangePassword).toBe(true);
  });
});
