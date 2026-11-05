/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ServerSummary } from '@mornihosting/shared';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

let t: TestApp;
let s: Session;
beforeEach(async () => {
  t = await createTestApp();
  s = await setupAdmin(t);
});
afterEach(async () => {
  await t.cleanup();
});

test('deleting a big server answers at once; the files go away in the background', async () => {
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: authHeaders(s),
    payload: {
      edition: 'java',
      software: 'paper',
      version: '1.21.4',
      memoryMb: 2048,
      port: 25565,
      eula: true,
      startNow: false,
      name: 'Gross',
    },
  });
  const server = created.json<ServerSummary>();
  const dir = path.join(t.dataDir, 'servers', server.id);
  fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true });
  Array.from({ length: 200 }, (_, i) =>
    fs.writeFileSync(path.join(dir, 'world', 'region', `r.${i}.mca`), 'x'.repeat(1024)),
  );

  const gone = await t.app.inject({
    method: 'DELETE',
    url: `/api/servers/${server.id}?deleteFiles=true`,
    headers: authHeaders(s),
  });
  expect(gone.statusCode).toBe(204);
  // The server folder is gone right away; the copy set aside disappears shortly after.
  expect(fs.existsSync(dir)).toBe(false);
  const aside = path.join(t.dataDir, '.deleting');
  await waitFor(() => !fs.existsSync(aside) || fs.readdirSync(aside).length === 0);
});
