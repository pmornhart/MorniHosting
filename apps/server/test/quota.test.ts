/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { QuotaView, ServerSummary } from '@mornihosting/shared';
import { buildContainerSpec } from '../src/servers/spec.js';
import { authHeaders, createTestApp, login, setupAdmin, type Session, type TestApp } from './helpers.js';

describe('quotas: how much each person may have', () => {
  let t: TestApp;
  let admin: Session;
  let lena: Session;
  const as = (session: Session, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: authHeaders(session), ...(payload ? { payload } : {}) });
  const order = (memoryMb: number, port: number) =>
    as(lena, 'POST', '/api/servers', {
      name: `Server ${port}`,
      edition: 'java',
      software: 'paper',
      version: '1.21.4',
      memoryMb,
      port,
      eula: true,
      startNow: false,
    });

  beforeEach(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
    await as(admin, 'POST', '/api/users', {
      username: 'lena',
      password: 'lena-passwort-1',
      canCreateServers: true,
    });
    lena = await login(t, 'lena', 'lena-passwort-1');
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('defaults limit servers, RAM, CPU and disk; a new server gets what is left', async () => {
    await as(admin, 'PUT', '/api/quotas/defaults', { servers: 1, memoryMb: 4096, cpus: 2, diskMb: 10240 });
    const first = (await order(2048, 25565)).json<ServerSummary>();
    expect(first).toMatchObject({ cpuLimit: 2, diskLimitMb: 10240 });
    expect((await order(1024, 25566)).json()).toMatchObject({ error: 'quota_servers' });

    // Owners cannot make a server bigger than the quota, nor touch its limits; admins can.
    expect((await as(lena, 'PATCH', `/api/servers/${first.id}`, { memoryMb: 8192 })).json()).toMatchObject({
      error: 'quota_memory',
    });
    expect((await as(lena, 'PATCH', `/api/servers/${first.id}`, { cpuLimit: 4 })).statusCode).toBe(403);
    expect(
      (await as(admin, 'PATCH', `/api/servers/${first.id}`, { cpuLimit: 1, memoryMb: 8192 })).json(),
    ).toMatchObject({ cpuLimit: 1, memoryMb: 8192 });

    // Own limits for Lena: more servers, but the disk is used up.
    const view = (await as(admin, 'GET', '/api/quotas')).json<QuotaView>();
    const lenaId = view.users.find((u) => u.username === 'lena')?.id ?? 0;
    expect(view.users.find((u) => u.username === 'lena')?.usage).toMatchObject({
      servers: 1,
      memoryMb: 8192,
      cpus: 1,
      diskMb: 10240,
    });
    await as(admin, 'PUT', `/api/quotas/users/${lenaId}`, {
      quota: { servers: 3, memoryMb: null, cpus: 2, diskMb: 10240 },
    });
    expect((await order(1024, 25567)).json()).toMatchObject({ error: 'quota_disk' });
    await as(admin, 'PUT', `/api/quotas/users/${lenaId}`, {
      quota: { servers: 3, memoryMb: null, cpus: 2, diskMb: 20480 },
    });
    // Two server slots left: the rest (1 core, 10 GB) is split between them.
    expect((await order(1024, 25567)).json<ServerSummary>()).toMatchObject({
      cpuLimit: 0.5,
      diskLimitMb: 5120,
    });
  });

  test('admins have no limits, and only admins see the quota page', async () => {
    await as(admin, 'PUT', '/api/quotas/defaults', { servers: 0, memoryMb: 0, cpus: null, diskMb: null });
    const own = await as(admin, 'POST', '/api/servers', {
      name: 'Admin',
      edition: 'java',
      software: 'paper',
      version: '1.21.4',
      memoryMb: 4096,
      port: 25565,
      eula: true,
      startNow: false,
      cpuLimit: 1.5,
    });
    expect(own.json()).toMatchObject({ cpuLimit: 1.5, diskLimitMb: null });
    expect((await as(lena, 'GET', '/api/quotas')).statusCode).toBe(403);
  });

  test('the CPU limit reaches Docker', () => {
    const spec = buildContainerSpec(
      t.ctx.config,
      {
        id: 'abc',
        name: 'x',
        edition: 'java',
        software: 'paper',
        version: '1.21.4',
        memoryMb: 2048,
        cpuLimit: 1.5,
        diskLimitMb: null,
        port: 25565,
        rconPassword: 'x',
        javaTag: null,
        image: 'itzg/minecraft-server:latest',
        containerId: null,
        domain: null,
        autoStart: true,
        extraPorts: [],
        extraEnv: {},
        gameSettings: {},
        geyser: false,
        publicPort: null,
        voiceChat: false,
        voicePublicPort: null,
        geyserPublicPort: null,
        netbirdName: null,
        backupSettings: { keep: 5, exclude: [] },
        crash: null,
        desiredRunning: false,
        createdAt: '',
        updatedAt: null,
      } as never,
      'Europe/Berlin',
    );
    expect(spec.cpus).toBe(1.5);
  });

  test('several servers share the quota fairly instead of the first taking everything', async () => {
    await as(admin, 'PUT', '/api/quotas/defaults', { servers: 2, memoryMb: 8192, cpus: 2, diskMb: 20480 });
    expect((await order(4096, 25565)).json()).toMatchObject({ cpuLimit: 1, diskLimitMb: 10240 });
    expect((await order(4096, 25566)).json()).toMatchObject({ cpuLimit: 1, diskLimitMb: 10240 });
    // Without a server limit: in proportion to RAM (a quarter of the RAM, a quarter of the CPU).
    await as(admin, 'PUT', '/api/quotas/defaults', { servers: null, memoryMb: 32768, cpus: 8, diskMb: null });
    expect((await order(8192, 25567)).json()).toMatchObject({ cpuLimit: 2, diskLimitMb: null });
  });
});
