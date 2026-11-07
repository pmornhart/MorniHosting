/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import type { PublicStats, ServerSummary } from '@mornihosting/shared';
import {
  SPAWN_Y,
  islandRadius,
  plazaCommands,
  spawnElytraConfig,
  spawnPackFiles,
} from '../src/craftattack/spawn.js';
import { deathOf, deathsOf } from '../src/craftattack/stats.js';
import { authHeaders, createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

const FILL_LIMIT = 32768;
// "fill ~-16 ~ ~-16 ~16 ~14 ~16 air" → the six numbers (an empty "~" is 0).
const FILL = /^fill ~(-?\d*) ~(-?\d*) ~(-?\d*) ~(-?\d*) ~(-?\d*) ~(-?\d*) /;

describe('Craft Attack spawn', () => {
  it('builds with known commands only, each fill within the block limit, and sets the world spawn', () => {
    const commands = plazaCommands();
    expect(commands.every((c) => /^(fill|setblock|setworldspawn) /.test(c))).toBe(true);
    commands
      .map((c) => FILL.exec(c))
      .filter((m): m is RegExpExecArray => m !== null)
      .forEach((m) => {
        const [x1, y1, z1, x2, y2, z2] = m.slice(1).map((v) => Number(v || 0));
        const volume =
          (Math.abs((x2 ?? 0) - (x1 ?? 0)) + 1) *
          (Math.abs((y2 ?? 0) - (y1 ?? 0)) + 1) *
          (Math.abs((z2 ?? 0) - (z1 ?? 0)) + 1);
        expect(volume).toBeLessThanOrEqual(FILL_LIMIT);
      });
    expect(commands.at(-1)).toMatch(/^setworldspawn /);
    expect(commands.join('\n')).toContain('oak_leaves[persistent=true]');
  });

  it('has a pack for old and new folder names and runs once', () => {
    const files = spawnPackFiles();
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'pack.mcmeta',
        'data/minecraft/tags/function/load.json',
        'data/craftattack/function/build.mcfunction',
        'data/craftattack/functions/island.mcfunction',
        'data/craftattack/function/top.mcfunction',
      ]),
    );
    expect(files['data/craftattack/function/load.mcfunction']).toContain('unless score #built');
    // High in the sky, not on the ground: a floating island.
    expect(files['data/craftattack/function/build.mcfunction']).toContain(`positioned 0 ${SPAWN_Y} 0`);
    // The renamed game rule: each name in its own optional function, so an unknown one cannot break the build.
    expect(files['data/craftattack/tags/function/rules.json']).toContain('"required":false');
    expect(files['data/craftattack/function/rules_new.mcfunction']).toBe('gamerule respawn_radius 0\n');
  });

  it('is a floating island: rock below the grass narrowing to a point, a beacon, launch decks over the edge', () => {
    expect(islandRadius(0)).toBeGreaterThan(islandRadius(10));
    expect(islandRadius(10)).toBeGreaterThan(islandRadius(28));
    const all = plazaCommands().join('\n');
    expect(all).toContain('beacon');
    expect(all).toContain('spruce_planks');
    expect(all).toContain('pointed_dripstone[vertical_direction=down');
    expect(spawnElytraConfig('world')).toContain('ignoreYInSpawnRadius: true');
  });
});

describe('death messages', () => {
  const players = new Set(['lena', 'tom']);
  it('says in words what happened and who the killer was', () => {
    expect(deathOf('was slain by Zombie', players)).toEqual({
      how: 'wurde von Zombie getötet',
      byPlayer: null,
    });
    expect(deathOf('was slain by Tom using Diamond Sword', players)).toEqual({
      how: 'wurde von Tom getötet',
      byPlayer: 'Tom',
    });
    expect(deathOf('tried to swim in lava', players)?.how).toBe('wollte in Lava schwimmen');
    expect(deathOf('joined the game', players)).toBeNull();
  });
});

describe('public statistics page', () => {
  let t: TestApp;
  let admin: Session;
  beforeEach(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('off by default, on with a switch, then anyone sees players and deaths without logging in', async () => {
    const server = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(admin),
        payload: {
          name: 'Craft Attack',
          edition: 'java',
          software: 'paper',
          version: '1.21.4',
          memoryMb: 2048,
          port: 25565,
          eula: true,
          startNow: false,
        },
      })
    ).json<ServerSummary>();
    const dir = path.join(t.dataDir, 'servers', server.id);
    const uuid = '6b1d4f2a-1111-4222-8333-944455556666';
    fs.mkdirSync(path.join(dir, 'world', 'stats'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'usercache.json'), JSON.stringify([{ name: 'Lena', uuid }]));
    fs.writeFileSync(
      path.join(dir, 'world', 'stats', `${uuid}.json`),
      JSON.stringify({
        stats: {
          'minecraft:custom': {
            'minecraft:play_time': 72000,
            'minecraft:deaths': 2,
            'minecraft:mob_kills': 9,
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'logs', 'latest.log'),
      '[18:03:12 INFO]: Lena was blown up by Creeper\n[18:05:00 INFO]: Lena joined the game\n',
    );

    expect((await t.app.inject({ method: 'GET', url: '/api/public/stats/craft-attack' })).statusCode).toBe(
      404,
    );
    const on = await t.app.inject({
      method: 'PUT',
      url: `/api/servers/${server.id}/public-stats`,
      headers: authHeaders(admin),
      payload: { enabled: true },
    });
    expect(on.json()).toMatchObject({ enabled: true, slug: 'craft-attack' });

    const page = await t.app.inject({ method: 'GET', url: '/api/public/stats/craft-attack' });
    expect(page.statusCode).toBe(200);
    const stats = page.json<PublicStats>();
    expect(stats.name).toBe('Craft Attack');
    expect(stats.players[0]).toMatchObject({ name: 'Lena', playTimeSeconds: 3600, deaths: 2, mobKills: 9 });
    expect(stats.deaths[0]).toMatchObject({ player: 'Lena', how: 'wurde von Creeper in die Luft gesprengt' });
    expect(deathsOf(dir, ['Lena'])).toHaveLength(1);
  });
});

describe('log times', () => {
  it('reads them in the server time zone', async () => {
    const { logMoment } = await import('../src/craftattack/stats.js');
    expect(logMoment('2024-06-01', '18:00:00', 'Europe/Berlin')).toBe('2024-06-01T16:00:00.000Z');
    expect(logMoment('2024-01-15', '18:00:00', 'Europe/Berlin')).toBe('2024-01-15T17:00:00.000Z');
  });
});
