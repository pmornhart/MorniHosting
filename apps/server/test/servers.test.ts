/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerDetail, ServerSummary } from '@mornihosting/shared';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

const paper = {
  name: 'Survival',
  edition: 'java',
  software: 'paper',
  version: '1.21.4',
  memoryMb: 3072,
  port: 25565,
  eula: true,
};

describe('server lifecycle with the fake driver', () => {
  let t: TestApp;
  let s: Session;
  beforeEach(async () => {
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const state = async (id: string): Promise<string> =>
    (await t.app.inject({ url: `/api/servers/${id}`, headers: authHeaders(s) })).json<ServerDetail>().live
      .state;

  test('a restart is not mistaken for a crash', async () => {
    const created = (
      await t.app.inject({ method: 'POST', url: '/api/servers', headers: authHeaders(s), payload: paper })
    ).json<ServerSummary>();
    await waitFor(async () => (await state(created.id)) === 'running');
    await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/actions/restart`,
      headers: authHeaders(s),
    });
    await waitFor(async () => (await state(created.id)) === 'running');
    // The old container's exit arrives late (after a short settle delay); it must not touch the new one.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await state(created.id)).toBe('running');
  });

  test('create, start, command, stop', async () => {
    const created = (
      await t.app.inject({ method: 'POST', url: '/api/servers', headers: authHeaders(s), payload: paper })
    ).json<ServerSummary>();
    await waitFor(async () => (await state(created.id)) === 'running');
    const answer = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/command`,
      headers: authHeaders(s),
      payload: { command: 'op Juna' },
    });
    expect(answer.json()).toEqual({ answer: 'Made Juna a server operator' });
    const ops = JSON.parse(
      fs.readFileSync(path.join(t.dataDir, 'servers', created.id, 'ops.json'), 'utf8'),
    ) as { name: string }[];
    expect(ops.map((o) => o.name)).toEqual(['Juna']);
    await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/actions/stop`,
      headers: authHeaders(s),
    });
    await waitFor(async () => (await state(created.id)) === 'stopped');
  });

  test('a stopped Java server can switch its software', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload: { ...paper, startNow: false },
      })
    ).json<ServerSummary>();
    const patch = async (
      payload: object,
    ): Promise<{ status: number; body: { error?: string; software?: string } }> => {
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/api/servers/${created.id}`,
        headers: authHeaders(s),
        payload,
      });
      return { status: res.statusCode, body: res.json() };
    };
    expect((await patch({ software: 'fabric' })).body.error).toBe('software_switch_version');
    expect((await patch({ software: 'velocity', version: '3.4.0' })).body.error).toBe(
      'software_not_switchable',
    );
    const switched = await patch({ software: 'fabric', version: '1.21.4' });
    expect(switched.status).toBe(200);
    expect(switched.body.software).toBe('fabric');
    await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/actions/start`,
      headers: authHeaders(s),
    });
    await waitFor(async () => (await state(created.id)) === 'running');
    expect((await patch({ software: 'paper', version: '1.21.4' })).body.error).toBe(
      'software_switch_running',
    );
  });

  test('a taken port is never an error when creating: the next free one is used', async () => {
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: authHeaders(s),
      payload: { ...paper, startNow: false },
    });
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: authHeaders(s),
      payload: { ...paper, name: 'Zwei', startNow: false },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ port: number }>().port).toBe(first.json<{ port: number }>().port + 1);
  });

  test('a modpack with too little memory crashes and the crash helper names the cause', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload: { ...paper, software: 'neoforge', version: '1.21.1', memoryMb: 2048 },
      })
    ).json<ServerSummary>();
    await waitFor(async () => (await state(created.id)) === 'crashed');
    const detail = (
      await t.app.inject({ url: `/api/servers/${created.id}`, headers: authHeaders(s) })
    ).json<ServerDetail>();
    expect(detail.crash?.ruleId).toBe('out-of-memory');
  });

  test('bedrock servers start and report their port as UDP', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload: {
          ...paper,
          name: 'Familie',
          edition: 'bedrock',
          software: 'bedrock',
          version: 'LATEST',
          port: 19132,
          memoryMb: 1024,
        },
      })
    ).json<ServerSummary>();
    await waitFor(async () => (await state(created.id)) === 'running');
    const connection = (
      await t.app.inject({ url: `/api/servers/${created.id}/connection`, headers: authHeaders(s) })
    ).json<{ protocol: string }>();
    expect(connection.protocol).toBe('udp');
  });

  test('deleting keeps the files in the archive unless asked to delete them', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload: { ...paper, startNow: false },
      })
    ).json<ServerSummary>();
    fs.writeFileSync(path.join(t.dataDir, 'servers', created.id, 'marker.txt'), 'keep me');
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/servers/${created.id}`,
      headers: authHeaders(s),
    });
    expect(res.statusCode).toBe(204);
    const archived = fs.readdirSync(path.join(t.dataDir, 'archive'));
    expect(archived).toHaveLength(1);
    expect(fs.readFileSync(path.join(t.dataDir, 'archive', archived[0] ?? '', 'marker.txt'), 'utf8')).toBe(
      'keep me',
    );
  });
});
