/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ServerSummary } from '@mornihosting/shared';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Session;

beforeEach(async () => {
  t = await createTestApp();
  admin = await setupAdmin(t);
});
afterEach(async () => {
  await t.cleanup();
});

const state = (id: string): string => t.servers.live(id).state;

test('always-on: a server that dies by itself starts again; one stopped by a person stays off', async () => {
  const lines: string[] = [];
  t.ctx.events.on('server.log', ({ line }) => lines.push(line));
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: authHeaders(admin),
    payload: {
      name: 'Immer an',
      edition: 'java',
      software: 'paper',
      version: '1.21.4',
      memoryMb: 1024,
      port: 25565,
      eula: true,
      startNow: true,
    },
  });
  const id = created.json<ServerSummary>().id;
  if (!id) throw new Error(created.body);
  await waitFor(() => state(id) === 'running', 15_000);

  // The container dies without anyone asking (like a crash or the machine killing it).
  const containerId = t.servers.row(id).containerId ?? '';
  await t.ctx.docker.kill(containerId);
  await waitFor(() => state(id) === 'crashed', 10_000);
  await waitFor(() => state(id) === 'running', 30_000);
  expect(lines.join('\n')).toContain('Dauerbetrieb');

  // Stopped in the panel: stays off.
  await t.app.inject({ method: 'POST', url: `/api/servers/${id}/actions/stop`, headers: authHeaders(admin) });
  await waitFor(() => state(id) === 'stopped', 10_000);
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  expect(state(id)).toBe('stopped');
}, 90_000);
