/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createAlertService } from '../src/alerts/service.js';
import type { Notice, NotifyService } from '../src/notify/service.js';
import { createTestApp, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
const sent: Notice[] = [];
const notify = {
  admins: () => [{ id: 1, locale: 'de' }],
  tell: (_people: unknown, _topic: unknown, build: (p: { locale: string }) => Notice) => {
    sent.push(build({ locale: 'de' }));
  },
} as unknown as NotifyService;

beforeEach(async () => {
  t = await createTestApp();
  await setupAdmin(t);
  sent.length = 0;
});
afterEach(async () => {
  await t.cleanup();
});

test('watchdog events reach Discord and mail once, with what to do; the all-clear follows', () => {
  const alerts = createAlertService(t.ctx, notify);
  const file = path.join(t.dataDir, 'guard', 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (o: object): string => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(
    file,
    line({
      source: 'container',
      key: 'netbird-exit',
      status: 'action',
      title: 'Hausanschluss nicht mehr versteckt',
      what: 'Ausgang antwortet nicht',
      action: 'Befehl auf dem NetBird-Server einfügen',
      command: 'bash -c "$(curl -fsSL https://example.org/x.sh)"',
    }) + line({ source: 'host', key: 'netbird-exit', status: 'action', title: 'nochmal', what: 'gleich' }),
  );
  alerts.readEvents();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.discord.text).toContain('Du musst');
  expect(sent[0]?.discord.text).toContain('curl -fsSL https://example.org/x.sh');
  expect(sent[0]?.mail?.vars['command']).toContain('example.org');

  // Already read lines are not sent again; a new "ok" line sends the all-clear.
  alerts.readEvents();
  expect(sent).toHaveLength(1);
  fs.appendFileSync(
    file,
    line({ key: 'netbird-exit', status: 'ok', title: 'Wieder versteckt', what: 'geht wieder' }),
  );
  alerts.readEvents();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.discord.title).toContain('Wieder versteckt');

  // A self-repairing problem says so.
  fs.appendFileSync(
    file,
    line({ key: 'dns', status: 'fixed', title: 'DNS repariert', what: 'feste DNS-Server' }),
  );
  alerts.readEvents();
  expect(sent[2]?.discord.text).toContain('schon behoben');
});
