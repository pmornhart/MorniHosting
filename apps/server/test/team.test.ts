/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerSummary, TeamView } from '@mornihosting/shared';
import { authHeaders, createTestApp, login, setupAdmin, type Session, type TestApp } from './helpers.js';

const paper = {
  name: 'Survival',
  edition: 'java',
  software: 'paper',
  version: '1.21.4',
  memoryMb: 2048,
  port: 25565,
  eula: true,
  startNow: false,
};

describe('server team (Mitarbeiter)', () => {
  let t: TestApp;
  let admin: Session;
  let serverId: string;
  let roleId: (builtIn: string) => number;

  const as = (session: Session, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(session) });

  beforeEach(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
    serverId = (await as(admin, 'POST', '/api/servers', paper)).json<ServerSummary>().id;
    await as(admin, 'POST', '/api/users', {
      username: 'lena',
      password: 'lena-passwort-1',
      email: 'lena@example.de',
    });
    await as(admin, 'POST', '/api/users', {
      username: 'max',
      password: 'max-passwort-12',
      email: 'max@example.de',
    });
    const { roles } = (await as(admin, 'GET', `/api/servers/${serverId}/team`)).json<TeamView>();
    roleId = (builtIn) => roles.find((r) => r.builtIn === builtIn)?.id ?? 0;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('an owner adds people by name or e-mail with a role; only admins hand out the owner role', async () => {
    // The admin makes Lena owner of the server (by user name).
    const byAdmin = await as(admin, 'POST', `/api/servers/${serverId}/team`, {
      who: 'Lena',
      roleId: roleId('owner'),
    });
    expect(byAdmin.json()).toMatchObject({ canManage: true });
    const lena = await login(t, 'lena', 'lena-passwort-1');

    // Lena adds Max by e-mail as moderator.
    const added = await as(lena, 'POST', `/api/servers/${serverId}/team`, {
      who: 'MAX@example.de',
      roleId: roleId('moderator'),
    });
    expect(added.statusCode).toBe(200);
    const team = added.json<TeamView>();
    expect(team.canManage).toBe(true);
    expect(team.members.map((m) => `${m.username}:${m.builtIn}`)).toEqual(['lena:owner', 'max:moderator']);
    expect(team.roles.find((r) => r.builtIn === 'owner')?.assignable).toBe(false);

    // Max sees the server now, may not manage the team.
    const max = await login(t, 'max', 'max-passwort-12');
    const visible = (await as(max, 'GET', '/api/servers')).json<ServerSummary[]>();
    expect(visible.map((s) => s.id)).toEqual([serverId]);
    const maxView = (await as(max, 'GET', `/api/servers/${serverId}/team`)).json<TeamView>();
    expect(maxView).toMatchObject({ canManage: false, roles: [] });
    expect(
      (
        await as(max, 'POST', `/api/servers/${serverId}/team`, { who: 'lena', roleId: roleId('viewer') })
      ).json(),
    ).toMatchObject({ error: 'team_no_permission' });

    // Owners cannot make others owner, and the last owner stays.
    expect(
      (
        await as(lena, 'PUT', `/api/servers/${serverId}/team/${maxView.members[1]?.userId}`, {
          roleId: roleId('owner'),
        })
      ).json(),
    ).toMatchObject({ error: 'team_owner_admin_only' });
    const lenaId = team.members[0]?.userId;
    expect((await as(lena, 'DELETE', `/api/servers/${serverId}/team/${lenaId}`)).json()).toMatchObject({
      error: 'team_last_owner',
    });

    // Unknown people get a clear answer; removing Max takes the server away from him.
    expect(
      (
        await as(lena, 'POST', `/api/servers/${serverId}/team`, {
          who: 'niemand@example.de',
          roleId: roleId('viewer'),
        })
      ).json(),
    ).toMatchObject({ error: 'team_user_unknown' });
    const maxId = maxView.members.find((m) => m.username === 'max')?.userId;
    expect((await as(lena, 'DELETE', `/api/servers/${serverId}/team/${maxId}`)).statusCode).toBe(204);
    expect((await as(max, 'GET', '/api/servers')).json<ServerSummary[]>()).toEqual([]);
  });
});
