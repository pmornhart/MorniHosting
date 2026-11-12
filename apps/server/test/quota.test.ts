/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  ImportDetectionResult,
  MyQuota,
  QuotaView,
  ServerRequestView,
  ServerSummary,
} from '@mornihosting/shared';
import { buildContainerSpec } from '../src/servers/spec.js';
import {
  authHeaders,
  createTestApp,
  login,
  multipartBody,
  setupAdmin,
  type Session,
  type TestApp,
} from './helpers.js';
import { storedZip } from './zip-fixture.js';

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

  describe('RAM per server: at most 16 GB unless an admin allows more', () => {
    const GB16 = 16384;
    const lenaId = async (): Promise<number> =>
      (await as(admin, 'GET', '/api/quotas')).json<QuotaView>().users.find((u) => u.username === 'lena')
        ?.id ?? 0;

    test('16 GB is fine, more is refused; the limit shows up for the person and in the admin view', async () => {
      expect((await as(lena, 'GET', '/api/quotas/mine')).json<MyQuota>()).toEqual({ serverMemoryMb: GB16 });
      expect((await as(admin, 'GET', '/api/quotas/mine')).json<MyQuota>()).toEqual({ serverMemoryMb: null });
      expect((await as(admin, 'GET', '/api/quotas')).json<QuotaView>().defaults.serverMemoryMb).toBe(GB16);
      const over = await order(GB16 + 1024, 25565);
      expect(over.statusCode).toBe(409);
      expect(over.json()).toMatchObject({ error: 'quota_server_memory', params: { limit: GB16 } });
      expect((await order(GB16, 25565)).json<ServerSummary>()).toMatchObject({ memoryMb: GB16 });
    });

    test('an own, higher limit for a person allows more; null means no limit', async () => {
      const id = await lenaId();
      await as(admin, 'PUT', `/api/quotas/users/${id}`, {
        quota: { servers: null, memoryMb: null, diskMb: null, cpus: null, serverMemoryMb: 32768 },
      });
      expect((await as(lena, 'GET', '/api/quotas/mine')).json<MyQuota>()).toEqual({ serverMemoryMb: 32768 });
      expect((await order(32768, 25565)).statusCode).toBe(200);
      expect((await order(32768 + 1024, 25566)).json()).toMatchObject({ error: 'quota_server_memory' });
      await as(admin, 'PUT', `/api/quotas/users/${id}`, {
        quota: { servers: null, memoryMb: null, diskMb: null, cpus: null, serverMemoryMb: null },
      });
      expect((await order(65536, 25566)).statusCode).toBe(200);
    });

    test('older stored limits without the field get the 16 GB default', async () => {
      // Saved like before the field existed: defaults and a person's own limits.
      t.ctx.settings.setValue('quota', { servers: null, memoryMb: null, diskMb: null, cpus: null });
      expect((await as(admin, 'GET', '/api/quotas')).json<QuotaView>().defaults.serverMemoryMb).toBe(GB16);
      await as(admin, 'PUT', `/api/quotas/users/${await lenaId()}`, {
        quota: { servers: 5, memoryMb: null, diskMb: null, cpus: null },
      });
      expect((await order(GB16 + 1024, 25565)).json()).toMatchObject({ error: 'quota_server_memory' });
      // An admin can lift it for everyone.
      await as(admin, 'PUT', '/api/quotas/defaults', {
        servers: null,
        memoryMb: null,
        diskMb: null,
        cpus: null,
        serverMemoryMb: 24576,
      });
      await as(admin, 'PUT', `/api/quotas/users/${await lenaId()}`, { quota: null });
      expect((await order(24576, 25565)).statusCode).toBe(200);
    });

    test('admins are not limited', async () => {
      const own = await as(admin, 'POST', '/api/servers', {
        name: 'Gross',
        edition: 'java',
        software: 'paper',
        version: '1.21.4',
        memoryMb: 65536,
        port: 25565,
        eula: true,
        startNow: false,
      });
      expect(own.json<ServerSummary>()).toMatchObject({ memoryMb: 65536 });
    });

    test('settings: raising above the limit is refused, lowering always works, admins may raise', async () => {
      const server = (await order(8192, 25565)).json<ServerSummary>();
      const patch = (who: Session, memoryMb: number) =>
        as(who, 'PATCH', `/api/servers/${server.id}`, { memoryMb });
      expect((await patch(lena, 20480)).json()).toMatchObject({ error: 'quota_server_memory' });
      expect((await patch(lena, GB16)).json()).toMatchObject({ memoryMb: GB16 });
      // The admin gives 24 GB: Lena keeps it, may make it smaller, but not bigger again.
      expect((await patch(admin, 24576)).json()).toMatchObject({ memoryMb: 24576 });
      expect((await patch(lena, 32768)).json()).toMatchObject({ error: 'quota_server_memory' });
      expect((await patch(lena, 20480)).json()).toMatchObject({ memoryMb: 20480 });
      // Other changes on a server above the limit still work.
      expect((await as(lena, 'PATCH', `/api/servers/${server.id}`, { name: 'Neu' })).json()).toMatchObject({
        name: 'Neu',
        memoryMb: 20480,
      });
      expect((await patch(lena, 4096)).json()).toMatchObject({ memoryMb: 4096 });
    });

    test("server request: refused when asked, and on approval the asker's limit counts, not the admin's", async () => {
      await as(admin, 'POST', '/api/users', { username: 'mia', password: 'mia-passwort-1' });
      const mia = await login(t, 'mia', 'mia-passwort-1');
      const body = (memoryMb: number) => ({
        name: 'Mias Welt',
        edition: 'java',
        software: 'paper',
        version: '1.21.4',
        memoryMb,
        port: 25565,
        eula: true,
        startNow: false,
      });
      expect((await as(mia, 'POST', '/api/server-requests', body(32768))).json()).toMatchObject({
        error: 'quota_server_memory',
      });
      const asked = (await as(mia, 'POST', '/api/server-requests', body(20480))).statusCode;
      expect(asked).toBe(409);
      const req = (await as(mia, 'POST', '/api/server-requests', body(12288))).json<ServerRequestView>();
      // The limit drops after the request was made: the admin cannot approve it past Mia's limit.
      await as(admin, 'PUT', '/api/quotas/defaults', {
        servers: null,
        memoryMb: null,
        diskMb: null,
        cpus: null,
        serverMemoryMb: 8192,
      });
      const approved = await as(admin, 'POST', `/api/server-requests/${req.id}/approve`);
      expect(approved.json()).toMatchObject({ error: 'quota_server_memory', params: { limit: 8192 } });
      await as(admin, 'PUT', '/api/quotas/defaults', {
        servers: null,
        memoryMb: null,
        diskMb: null,
        cpus: null,
        serverMemoryMb: GB16,
      });
      expect((await as(admin, 'POST', `/api/server-requests/${req.id}/approve`)).statusCode).toBe(200);
      const mine = (await as(mia, 'GET', '/api/servers')).json<ServerSummary[]>();
      expect(mine.map((x) => x.memoryMb)).toEqual([12288]);
    });

    test('import: more than the limit is refused', async () => {
      const upload = multipartBody([
        {
          name: 'Alt.zip',
          data: storedZip({ 'paper-1.21.4-232.jar': 'jar', 'server.properties': 'motd=Alt\n' }),
          type: 'application/zip',
        },
      ]);
      const staged = await t.app.inject({
        method: 'POST',
        url: '/api/servers/import/upload',
        payload: upload.payload,
        headers: { ...authHeaders(lena), ...upload.headers },
      });
      const { stagingId } = staged.json<ImportDetectionResult>();
      const confirm = (memoryMb: number) =>
        as(lena, 'POST', '/api/servers/import/confirm', {
          stagingId,
          name: 'Alt',
          software: 'paper',
          version: '1.21.4',
          memoryMb,
          port: 25570,
          eula: true,
        });
      expect((await confirm(GB16 * 2)).json()).toMatchObject({ error: 'quota_server_memory' });
      expect((await confirm(GB16)).statusCode).toBe(200);
    });
  });
});
