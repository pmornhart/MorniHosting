/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import type { PublicStats, ServerSummary } from '@mornihosting/shared';
import {
  SPAWN_Y,
  fixWaterCommands,
  islandRadius,
  extrasCommands,
  topCommands,
  plazaCommands,
  spawnElytraConfig,
  spawnPackFiles,
} from '../src/craftattack/spawn.js';
import {
  homesOf,
  infoText,
  openPlayerCommands,
  personalLink,
  writeHelpFiles,
} from '../src/craftattack/help.js';
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
    // Repairs of older islands run once each, only where an island was built.
    expect(files['data/craftattack/function/load.mcfunction']).toContain('if score #built');
    // High in the sky, not on the ground: a floating island (built at SPAWN_Y by the panel).
    expect(SPAWN_Y).toBeGreaterThan(150);
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
  });

  it('keeps all water in the fountain and repairs islands of the first version once', () => {
    const top = topCommands();
    // No walls or light blocks at the fountain: both can take on water and let it run over the plaza.
    expect(top.filter((c) => c.endsWith(' chiseled_stone_bricks')).length).toBeGreaterThan(0);
    expect(top.some((c) => c.includes('light[level=15]') && c.startsWith('setblock ~4 ~ ~4 '))).toBe(false);
    const files = spawnPackFiles();
    expect(files['data/craftattack/function/load.mcfunction']).toContain('unless score #water');
    expect(files['data/craftattack/function/build.mcfunction']).toContain('#water mh_craftattack 1');
    expect(fixWaterCommands()[0]).toContain('replace light');
  });
});

describe('Craft Attack protection, build and help', () => {
  it('protects the spawn (adventure mode there), builds where the panel says and keeps the elytra at the spawn', () => {
    const files = spawnPackFiles();
    expect(files['data/minecraft/tags/function/tick.json']).toContain('craftattack:tick');
    expect(files['data/craftattack/function/tick.mcfunction']).toContain(
      'gamemode adventure @a[gamemode=survival',
    );
    const build = files['data/craftattack/function/build.mcfunction'] ?? '';
    expect(build).toContain('function craftattack:island');
    expect(build).toContain('function craftattack:extras');
    expect(build).toContain('summon marker ~ ~ ~9 {Tags:["mh_spawn_center"]}');
    // Nothing is built by itself on load: the panel picks the place over an ocean.
    expect(files['data/craftattack/function/load.mcfunction']).not.toContain('function craftattack:build');
    expect(extrasCommands().some((c) => c.includes('stained_glass'))).toBe(true);
    expect(spawnElytraConfig('world')).toContain('ignoreYInSpawnRadius: false');
  });

  it('writes /info with all commands, keeps a file the owner wrote, and lets players use the commands', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ca-'));
    const ess = path.join(dir, 'plugins', 'Essentials');
    fs.mkdirSync(ess, { recursive: true });
    fs.writeFileSync(path.join(ess, 'info.txt'), 'This is the info file.\nsample');
    fs.writeFileSync(path.join(ess, 'rules.txt'), 'Unsere eigenen Regeln');
    fs.writeFileSync(path.join(ess, 'config.yml'), 'a: 1\nuse-bukkit-permissions: true\nb: 2\n');
    writeHelpFiles(dir, 'de');
    expect(fs.readFileSync(path.join(ess, 'info.txt'), 'utf8')).toContain('/tpa <spieler>');
    expect(fs.readFileSync(path.join(ess, 'rules.txt'), 'utf8')).toBe('Unsere eigenen Regeln');
    expect(fs.readFileSync(path.join(ess, 'motd.txt'), 'utf8')).toContain('/info');
    expect(openPlayerCommands(dir)).toBe(true);
    expect(fs.readFileSync(path.join(ess, 'config.yml'), 'utf8')).toContain('use-bukkit-permissions: false');
    expect(openPlayerCommands(dir)).toBe(false);
    expect(infoText('en')).toContain('Homes');
    expect(infoText('de')).not.toContain('/ban');
    const link = personalLink('mornihosting.de', 'craft-attack');
    writeHelpFiles(dir, 'de', link);
    expect(fs.readFileSync(path.join(ess, 'info.txt'), 'utf8')).toContain(
      'https://mornihosting.de/befehle/craft-attack/{USERNAME}',
    );
    fs.mkdirSync(path.join(ess, 'userdata'));
    fs.writeFileSync(
      path.join(ess, 'userdata', 'abc.yml'),
      'money: 0\nhomes:\n  base:\n    world: world\n    x: 1\n  farm:\n    world: world\nlogoutlocation:\n  x: 2\n',
    );
    expect(homesOf(dir, 'abc')).toEqual(['base', 'farm']);
    fs.rmSync(dir, { recursive: true, force: true });
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

    // Personal command page: only for Craft Attack servers (the world carries the datapack).
    const url = '/api/public/commands/craft-attack/lena';
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    fs.mkdirSync(path.join(dir, 'world', 'datapacks', 'mornihosting-craftattack'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify([{ uuid, name: 'Lena', level: 4 }]));
    const mine = await t.app.inject({ method: 'GET', url });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ name: 'Lena', known: true, op: true, locked: false, bedrock: false });
    const stranger = await t.app.inject({ method: 'GET', url: '/api/public/commands/craft-attack/Tom' });
    expect(stranger.json()).toMatchObject({ name: 'Tom', known: false, op: false });
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/public/commands/craft-attack/a%2Fb' })).statusCode,
    ).toBe(400);
  });
});

describe('log times', () => {
  it('reads them in the server time zone', async () => {
    const { logMoment } = await import('../src/craftattack/stats.js');
    expect(logMoment('2024-06-01', '18:00:00', 'Europe/Berlin')).toBe('2024-06-01T16:00:00.000Z');
    expect(logMoment('2024-01-15', '18:00:00', 'Europe/Berlin')).toBe('2024-01-15T17:00:00.000Z');
  });
});
