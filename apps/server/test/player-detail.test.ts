/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { KnownPlayer, PlayerDetail, ServerSummary } from '@mornihosting/shared';
import { authHeaders, createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

/* A tiny NBT writer for fixtures: just the tags a player file needs. */
type Tag =
  | { t: 'byte' | 'short' | 'int'; v: number }
  | { t: 'float' | 'double'; v: number }
  | { t: 'string'; v: string }
  | { t: 'list'; of: number; v: Tag[] }
  | { t: 'compound'; v: Record<string, Tag> };
const TYPE = { byte: 1, short: 2, int: 3, float: 5, double: 6, string: 8, list: 9, compound: 10 } as const;
function payload(tag: Tag): Buffer {
  const b = (n: number, write: (buf: Buffer) => void): Buffer => {
    const buf = Buffer.alloc(n);
    write(buf);
    return buf;
  };
  if (tag.t === 'byte') return b(1, (x) => x.writeInt8(tag.v));
  if (tag.t === 'short') return b(2, (x) => x.writeInt16BE(tag.v));
  if (tag.t === 'int') return b(4, (x) => x.writeInt32BE(tag.v));
  if (tag.t === 'float') return b(4, (x) => x.writeFloatBE(tag.v));
  if (tag.t === 'double') return b(8, (x) => x.writeDoubleBE(tag.v));
  if (tag.t === 'string') {
    const s = Buffer.from(tag.v, 'utf8');
    return Buffer.concat([b(2, (x) => x.writeUInt16BE(s.length)), s]);
  }
  if (tag.t === 'list')
    return Buffer.concat([
      b(1, (x) => x.writeInt8(tag.of)),
      b(4, (x) => x.writeInt32BE(tag.v.length)),
      ...tag.v.map(payload),
    ]);
  return Buffer.concat([
    ...Object.entries(tag.v as Record<string, Tag>).map(([k, v]: [string, Tag]) =>
      Buffer.concat([b(1, (x) => x.writeInt8(TYPE[v.t])), payload({ t: 'string', v: k }), payload(v)]),
    ),
    Buffer.from([0]),
  ]);
}
const nbtFile = (root: Record<string, Tag>): Buffer =>
  zlib.gzipSync(
    Buffer.concat([
      Buffer.from([TYPE.compound]),
      payload({ t: 'string', v: '' }),
      payload({ t: 'compound', v: root }),
    ]),
  );
const item = (slot: number, id: string, count: number, name?: string): Tag => ({
  t: 'compound',
  v: {
    Slot: { t: 'byte', v: slot },
    id: { t: 'string', v: id },
    count: { t: 'int', v: count },
    ...(name
      ? { components: { t: 'compound', v: { 'minecraft:custom_name': { t: 'string', v: name } } } }
      : {}),
  },
});

const UUID = '548b0931-31bf-4476-9a32-01e2e690a62e';

describe('player details', () => {
  let t: TestApp;
  let admin: Session;
  let id: string;
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(admin) });

  beforeEach(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
    id = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(admin),
        payload: {
          name: 'Reich',
          edition: 'java',
          software: 'paper',
          version: '1.21.4',
          memoryMb: 2048,
          port: 25565,
          eula: true,
          startNow: false,
        },
      })
    ).json<ServerSummary>().id;
    const dir = path.join(t.dataDir, 'servers', id);
    fs.mkdirSync(path.join(dir, 'world', 'playerdata'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'world', 'stats'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'usercache.json'),
      JSON.stringify([{ name: 'MoinMornhart', uuid: UUID, expiresOn: 'x' }]),
    );
    fs.writeFileSync(
      path.join(dir, 'ops.json'),
      JSON.stringify([{ name: 'MoinMornhart', uuid: UUID, level: 4 }]),
    );
    fs.writeFileSync(
      path.join(dir, 'world', 'playerdata', `${UUID}.dat`),
      nbtFile({
        Health: { t: 'float', v: 17 },
        foodLevel: { t: 'int', v: 20 },
        XpLevel: { t: 'int', v: 2 },
        XpP: { t: 'float', v: 0.45 },
        playerGameType: { t: 'int', v: 0 },
        Dimension: { t: 'string', v: 'minecraft:overworld' },
        Pos: { t: 'list', of: TYPE.double, v: [57.7, 55, 7].map((v) => ({ t: 'double' as const, v })) },
        Inventory: {
          t: 'list',
          of: TYPE.compound,
          v: [
            item(0, 'minecraft:golden_pickaxe', 1),
            item(9, 'minecraft:bone', 2),
            item(103, 'stinkendreich:smoking', 1, '"Bond Sonnenbrille"'),
          ],
        },
        EnderItems: { t: 'list', of: TYPE.compound, v: [item(0, 'minecraft:diamond', 5)] },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'world', 'stats', `${UUID}.json`),
      JSON.stringify({
        stats: {
          'minecraft:custom': {
            'minecraft:play_time': 94220,
            'minecraft:deaths': 1,
            'minecraft:time_since_death': 50400,
            'minecraft:walk_one_cm': 42200,
            'minecraft:fly_one_cm': 275900,
          },
          'minecraft:killed': { 'minecraft:sheep': 5, 'minecraft:zombie': 2 },
          'minecraft:picked_up': { 'minecraft:leaf_litter': 286 },
        },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'logs', '2026-11-02-1.log.gz'),
      zlib.gzipSync('[10:00:00] [Server thread/INFO]: <MoinMornhart> alter Gruß\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'logs', 'latest.log'),
      [
        '[12:00:01 INFO]: MoinMornhart joined the game',
        '[12:00:05 INFO]: <MoinMornhart> Hallo zusammen',
        '[12:00:09 INFO]: MoinMornhart issued server command: /home',
        '[12:00:10 INFO]: <Lena> nicht von ihm',
      ].join('\n'),
    );
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('lists known players and reads inventory, stats and chat while offline', async () => {
    const known = (await get(`/api/servers/${id}/players/known`)).json<KnownPlayer[]>();
    expect(known).toMatchObject([{ name: 'MoinMornhart', uuid: UUID, online: false, op: true }]);

    const detail = (await get(`/api/servers/${id}/players/known/${UUID}`)).json<PlayerDetail>();
    expect(detail).toMatchObject({
      health: 17,
      food: 20,
      level: 2,
      gamemode: 'survival',
      world: 'overworld',
      position: { x: 57.7, y: 55, z: 7 },
      playTimeSeconds: 4711,
      deaths: 1,
      sinceDeathSeconds: 2520,
      travel: { walk: 422, fly: 2759 },
    });
    expect(detail.levelProgress).toBeCloseTo(0.45);
    expect(detail.inventory.map((i) => i.id)).toEqual(['minecraft:golden_pickaxe', 'minecraft:bone']);
    expect(detail.armor.head).toMatchObject({ id: 'stinkendreich:smoking', customName: 'Bond Sonnenbrille' });
    expect(detail.enderChest).toMatchObject([{ id: 'minecraft:diamond', count: 5 }]);
    expect(detail.killed[0]).toEqual({ id: 'minecraft:sheep', count: 5 });
    expect(detail.chat).toEqual([
      { at: expect.stringContaining('T12:00:09Z'), kind: 'command', text: '/home' },
      { at: expect.stringContaining('T12:00:05Z'), kind: 'chat', text: 'Hallo zusammen' },
      { at: '2026-11-02T10:00:00Z', kind: 'chat', text: 'alter Gruß' },
    ]);
  });

  test('unknown players and changes while offline are refused', async () => {
    expect(
      (await get(`/api/servers/${id}/players/known/00000000-0000-0000-0000-000000000000`)).statusCode,
    ).toBe(404);
    expect((await get(`/api/servers/${id}/players/known/..%2F..%2Fx`)).statusCode).toBe(404);
    const adjust = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${id}/players/known/${UUID}/adjust`,
      headers: authHeaders(admin),
      payload: { kind: 'level', direction: 'up' },
    });
    expect(adjust.statusCode).toBe(409);
  });
});
