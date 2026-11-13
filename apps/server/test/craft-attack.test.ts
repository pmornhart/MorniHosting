import crypto from 'node:crypto';
/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import type { PublicStats, ServerSummary, TeamBoardView } from '@mornihosting/shared';
import {
  SPAWN_Y,
  fixWaterCommands,
  islandRadius,
  extrasCommands,
  topCommands,
  plazaCommands,
  hasNewGameRules,
  spawnPackFiles,
  fountainCommands,
  removeRainbowCommands,
  removeBenchesCommands,
  flagCommands,
  reedCommands,
  renewCommands,
  SPAWN_ZONES,
} from '../src/craftattack/spawn.js';
import {
  homesOf,
  installMorniCraft,
  morniCraftConfig,
  morniCraftSettingsSchema,
  personalLink,
  retireReplacedPlugins,
  withDefaults,
} from '../src/craftattack/mornicraft.js';
import { badgePack, badgePicture, pngOf } from '../src/craftattack/badges.js';
import { deathOf, deathsOf } from '../src/craftattack/stats.js';
import { DEFAULT_RANKS } from '@mornihosting/shared';
import { users } from '../src/db/schema.js';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

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

  it('is a floating island: rock below the grass narrowing to a point, a fountain, launch decks over the edge', () => {
    expect(islandRadius(0)).toBeGreaterThan(islandRadius(10));
    expect(islandRadius(10)).toBeGreaterThan(islandRadius(28));
    const all = plazaCommands().join('\n');
    expect(all).not.toContain('beacon');
    expect(all).toContain('quartz_pillar');
    expect(all).toContain('spruce_planks');
    expect(all).toContain('pointed_dripstone[vertical_direction=down');
  });

  it('keeps all water in the fountain and repairs islands of the first version once', () => {
    const top = topCommands();
    // No light blocks at the fountain: they can take on water and let it run over the plaza.
    expect(top.some((c) => c.includes('light[level=15]') && c.startsWith('setblock ~4 ~ ~4 '))).toBe(false);
    // Nothing next to the fountain's water can hold water itself (stairs, slabs, walls, lanterns).
    const fountain = fountainCommands().join('\n');
    expect(fountain).not.toMatch(/_(stairs|slab|wall)\b|lantern\[/); // eslint-disable-line ts-patterns/require-regex-example -- "oak_stairs", "lantern[hanging=true]"
    expect(fountain).toContain('water');
    const files = spawnPackFiles();
    expect(files['data/craftattack/function/load.mcfunction']).toContain('unless score #water');
    expect(files['data/craftattack/function/build.mcfunction']).toContain('#water mh_craftattack 1');
    expect(fixWaterCommands()[0]).toContain('replace light');
  });
});

describe('game rule names by version (Philip: Paper 26.3 logged an error for spawnRadius)', () => {
  it('writes only the rule this version knows', () => {
    expect(hasNewGameRules('1.21.10')).toBe(false);
    expect(hasNewGameRules('1.20.4')).toBe(false);
    expect(hasNewGameRules('1.21.11')).toBe(true);
    expect(hasNewGameRules('26.3')).toBe(true);
    expect(hasNewGameRules('latest')).toBe(true);
    const fresh = spawnPackFiles(undefined, 'de', '26.3');
    expect(fresh['data/craftattack/function/rules_old.mcfunction']).toBeUndefined();
    expect(fresh['data/craftattack/function/rules_new.mcfunction']).toContain('respawn_radius');
    expect(fresh['data/craftattack/tags/function/rules.json']).not.toContain('rules_old');
    const old = spawnPackFiles(undefined, 'de', '1.20.4');
    expect(old['data/craftattack/function/rules_old.mcfunction']).toContain('spawnRadius');
    expect(old['data/craftattack/function/rules_new.mcfunction']).toBeUndefined();
  });
});

describe('MorniCraft spawn, plugin and settings', () => {
  it('builds where the panel says, repairs at the island and releases old adventure-mode players', () => {
    const files = spawnPackFiles({ x: 1200, z: -340 });
    expect(files['data/minecraft/tags/function/tick.json']).toContain('craftattack:tick');
    expect(files['data/craftattack/function/tick.mcfunction']).toContain('gamemode survival @a[tag=mh_spawn');
    const build = files['data/craftattack/function/build.mcfunction'] ?? '';
    expect(build).toContain('function craftattack:island');
    expect(build).toContain('function craftattack:extras');
    expect(build).toContain('summon marker ~ ~ ~9 {Tags:["mh_spawn_center"]}');
    // Nothing is built by itself on load: the panel picks the place over an ocean.
    const load = files['data/craftattack/function/load.mcfunction'] ?? '';
    expect(load).not.toContain('function craftattack:build');
    // Repairs run where this island really stands.
    expect(load).toContain('forceload add 1136 -404 1264 -276');
    expect(files['data/craftattack/function/fix_fountain.mcfunction']).toContain('positioned 1200 170 -340');
    expect(extrasCommands().some((c) => c.includes('stained_glass'))).toBe(false);
    expect(
      removeRainbowCommands().every((c) => c.includes(' air replace ') && c.includes('stained_glass')),
    ).toBe(true);
    // No more benches on the plaza; older islands lose theirs once (only oak stairs, nothing else).
    expect(topCommands().some((c) => c.includes('oak_stairs'))).toBe(false);
    expect(removeBenchesCommands().every((c) => c.endsWith(' air replace oak_stairs'))).toBe(true);
    expect(files['data/craftattack/function/fix_benches.mcfunction']).toContain(
      'function craftattack:benches',
    );
    // The brighter spawn: older islands are cleared above the ground and built anew once, the first balloon goes.
    expect(renewCommands()).toEqual(
      expect.arrayContaining(['function craftattack:top', 'function craftattack:extras']),
    );
    expect(files['data/craftattack/function/fix_renew.mcfunction']).toContain('function craftattack:renew');
    const top = topCommands().join('\n');
    // A white tower with a red roof and the flag (emerald with a white M – no lozenges any more) …
    expect(top).toContain('bricks');
    expect(top).not.toContain('lime_wool');
    const flag = flagCommands(0, 0, 0).join('\n');
    expect(flag).toContain('emerald_block');
    expect(flag).toContain('white_wool');
    expect(flag).not.toContain('light_blue_wool');
    // Older towers lose the lozenges (and the ladder gets a closed wall to hold on to).
    expect(files['data/craftattack/function/flag.mcfunction']).toContain('air');
    expect(files['data/craftattack/function/ladder.mcfunction']).toContain('ladder[facing=south]');
    // … a maypole, tulips, and each way out named in the paving in its own colour (O for Ost, E in English).
    expect(top).toContain('light_blue_wall_banner[facing=south]');
    expect(top).toContain('yellow_concrete');
    expect(topCommands('en').join('\n')).not.toEqual(top);
    // Sugar cane stands on earth with water right beside it (else it falls off); older islands get it planted again.
    expect(reedCommands()).toEqual(
      expect.arrayContaining(['setblock ~17 ~-1 ~12 water', 'setblock ~18 ~-1 ~12 grass_block']),
    );
    expect(files['data/craftattack/function/fix_reeds.mcfunction']).toContain('function craftattack:reeds');
    // Five balloons; they and the small islands are protected like the island itself.
    expect(extrasCommands().some((c) => c.includes('magenta_wool'))).toBe(true);
    expect(SPAWN_ZONES).toHaveLength(10);
    expect(SPAWN_ZONES.every((zone) => zone.r >= 8)).toBe(true);
  });

  it('installs the plugin, switches off what it replaces and writes its settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-mc-'));
    const jar = path.join(dir, 'MorniCraft-build.jar');
    fs.writeFileSync(jar, 'plugin v1');
    process.env['MH_MORNICRAFT_JAR'] = jar;
    const server = path.join(dir, 'server');
    fs.mkdirSync(path.join(server, 'plugins'), { recursive: true });
    [
      'EssentialsX-2.21.2.jar',
      'EssentialsXSpawn-2.21.2.jar',
      'SpawnElytra-1.4.jar',
      'EssentialsXChat-2.21.2.jar',
    ].forEach((f) => fs.writeFileSync(path.join(server, 'plugins', f), 'x'));
    expect(installMorniCraft(server)).toBe(true);
    expect(installMorniCraft(server)).toBe(false);
    fs.writeFileSync(jar, 'plugin v2');
    expect(installMorniCraft(server)).toBe(true);
    expect(retireReplacedPlugins(server).sort()).toEqual([
      'EssentialsX-2.21.2.jar',
      'EssentialsXSpawn-2.21.2.jar',
      'SpawnElytra-1.4.jar',
    ]);
    expect(fs.existsSync(path.join(server, 'plugins', 'EssentialsXChat-2.21.2.jar'))).toBe(true);

    const config = morniCraftConfig(withDefaults({ tnt: false, sleepAtSpawn: true }), {
      language: 'de',
      serverName: 'Freunde "Craft"',
      timezone: 'Europe/Berlin',
      link: personalLink('mornihosting.de', 'freunde'),
    });
    // YAML is a superset of JSON: everything after the comment line is the config.
    const parsed = JSON.parse(config.slice(config.indexOf('\n') + 1)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      tnt: false,
      'sleep-at-spawn': true,
      'teleport-delay': 5,
      'server-name': 'Freunde "Craft"',
    });
    expect(parsed['link']).toBe('https://mornihosting.de/befehle/freunde/{name}');
    expect(JSON.stringify(parsed['groups'])).toContain('/leiste');
    expect(parsed['zones']).toEqual([]);

    // Ranks: every server starts with Owner … Spieler; switches become permission nodes, owners from the panel join
    // by UUID, a hand-added name that is also an owner is not listed twice.
    const ranked = morniCraftConfig(
      withDefaults({
        ranks: DEFAULT_RANKS.map((r) => (r.id === 'owner' ? { ...r, players: ['morni', 'Lena'] } : r)),
      }),
      {
        language: 'de',
        serverName: 'Freunde',
        timezone: 'Europe/Berlin',
        link: '',
        members: {
          owner: [{ uuid: '0b1c-uuid', name: 'Morni' }],
          moderator: [{ uuid: 'mod-uuid', name: 'Tom' }],
        },
      },
    );
    const ranks = (JSON.parse(ranked.slice(ranked.indexOf('\n') + 1)) as { ranks: Record<string, unknown>[] })
      .ranks;
    expect(ranks.map((r) => r['id'])).toEqual(DEFAULT_RANKS.map((r) => r.id));
    expect(ranks[0]).toMatchObject({
      id: 'owner',
      symbol: '♛',
      players: [{ uuid: '0b1c-uuid', name: 'Morni' }, { name: 'Lena' }],
    });
    expect(ranks[0]?.['permissions']).toEqual(
      expect.arrayContaining(['mornicraft.build', 'minecraft.command.kick']),
    );
    expect(ranks.find((r) => r['id'] === 'moderator')?.['players']).toEqual([
      { uuid: 'mod-uuid', name: 'Tom' },
    ]);
    expect(ranks.find((r) => r['id'] === 'player')).toMatchObject({ default: true, permissions: [] });

    // The dashboard can't save broken ranks: two with the same id, two defaults, a name with spaces.
    const base = withDefaults(undefined);
    const owner = DEFAULT_RANKS[0]!;
    expect(morniCraftSettingsSchema.safeParse(base).success).toBe(true);
    expect(morniCraftSettingsSchema.safeParse({ ...base, ranks: [owner, owner] }).success).toBe(false);
    expect(
      morniCraftSettingsSchema.safeParse({
        ...base,
        ranks: [
          { ...owner, isDefault: true },
          { ...owner, id: 'b', isDefault: true },
        ],
      }).success,
    ).toBe(false);
    expect(
      morniCraftSettingsSchema.safeParse({ ...base, ranks: [{ ...owner, players: ['nicht gültig'] }] })
        .success,
    ).toBe(false);

    // Homes: MorniCraft's own file, else EssentialsX's (before the plugin took them over).
    fs.mkdirSync(path.join(server, 'plugins', 'Essentials', 'userdata'), { recursive: true });
    fs.writeFileSync(
      path.join(server, 'plugins', 'Essentials', 'userdata', 'abc.yml'),
      'money: 0\nhomes:\n  base:\n    world: world\n    x: 1\n  farm:\n    world: world\nlogoutlocation:\n  x: 2\n',
    );
    expect(homesOf(server, 'abc')).toEqual(['base', 'farm']);
    fs.mkdirSync(path.join(server, 'plugins', 'MorniCraft', 'players'), { recursive: true });
    fs.writeFileSync(
      path.join(server, 'plugins', 'MorniCraft', 'players', 'abc.yml'),
      'name: Lena\nhomes:\n  burg:\n    x: 1\n',
    );
    expect(homesOf(server, 'abc')).toEqual(['burg']);
    delete process.env['MH_MORNICRAFT_JAR'];
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

    // Dashboard settings: saved, written into the plugin's config.
    const mcUrl = `/api/servers/${server.id}/mornicraft`;
    const state = (await t.app.inject({ method: 'GET', url: mcUrl, headers: authHeaders(admin) })).json<{
      active: boolean;
      settings: Record<string, unknown>;
    }>();
    expect(state).toMatchObject({ active: true, settings: { teleportDelay: 5, sleepAtSpawn: false } });
    const saved = await t.app.inject({
      method: 'PUT',
      url: mcUrl,
      headers: authHeaders(admin),
      payload: { ...state.settings, tnt: false, teleportDelay: 3 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ settings: { tnt: false, teleportDelay: 3 } });
    const written = fs.readFileSync(path.join(dir, 'plugins', 'MorniCraft', 'config.yml'), 'utf8');
    expect(written).toContain('"tnt": false');
    expect(written).toContain('"teleport-delay": 3');

    // "/vip Steve" in the game: the plugin notes it, the panel takes it into the dashboard and the config.
    fs.writeFileSync(
      path.join(dir, 'plugins', 'MorniCraft', 'rank-changes.json'),
      `${JSON.stringify({ uuid: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Steve', rank: 'vip' })}\nkaputt\n`,
    );
    // Read straight from the stored settings (polling the API would hit the rate limit).
    const ranksNow = async (): Promise<{ id: string; players: string[] }[]> =>
      Promise.resolve(
        t.ctx.settings.getValue<Record<string, { ranks?: { id: string; players: string[] }[] }>>(
          'mornicraft',
        )?.[server.id]?.ranks ?? [],
      );
    await waitFor(
      async () => (await ranksNow()).find((r) => r.id === 'vip')?.players.includes('Steve') ?? false,
      15_000,
    );
    expect(fs.existsSync(path.join(dir, 'plugins', 'MorniCraft', 'rank-changes.json'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'plugins', 'MorniCraft', 'config.yml'), 'utf8')).toContain(
      '"name": "Steve"',
    );
    expect(fs.readFileSync(path.join(dir, 'plugins', 'MorniCraft', 'config.yml'), 'utf8')).toContain(
      '"managed-by-panel": true',
    );
    // Moved on to Media: only one rank lists Steve; "" = back to everyone else's rank.
    fs.writeFileSync(
      path.join(dir, 'plugins', 'MorniCraft', 'rank-changes.json'),
      `${JSON.stringify({ uuid: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Steve', rank: 'media' })}\n`,
    );
    await waitFor(
      async () => (await ranksNow()).find((r) => r.id === 'media')?.players.includes('Steve') ?? false,
      15_000,
    );
    expect((await ranksNow()).filter((r) => r.players.includes('Steve')).map((r) => r.id)).toEqual(['media']);
    fs.writeFileSync(
      path.join(dir, 'plugins', 'MorniCraft', 'rank-changes.json'),
      `${JSON.stringify({ uuid: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Steve', rank: '' })}\n`,
    );
    await waitFor(async () => !(await ranksNow()).some((r) => r.players.includes('Steve')), 15_000);

    // A panel admin with a linked Minecraft account is an owner: the Owner rank lists them by itself, at once.
    t.ctx.db
      .update(users)
      .set({ minecraftName: 'Morni', minecraftUuid: '11111111-2222-3333-4444-555555555555' })
      .run();
    t.ctx.events.emit('minecraft.linked', { userId: 1 });
    const withOwner = (await t.app.inject({ method: 'GET', url: mcUrl, headers: authHeaders(admin) })).json<{
      panelMembers: { owner: string[]; moderator: string[] };
    }>();
    expect(withOwner.panelMembers).toEqual({ owner: ['Morni'], moderator: [] });
    const ranked = fs.readFileSync(path.join(dir, 'plugins', 'MorniCraft', 'config.yml'), 'utf8');
    expect(ranked).toContain('"uuid": "11111111-2222-3333-4444-555555555555"');
    // The plugin learns where the small islands and balloons are, and the server shows the MorniCraft icon.
    expect(ranked).toContain('"zones": [');
    expect(ranked).toContain('"r": 11');
    const icon = fs.readFileSync(path.join(dir, 'server-icon.png'));
    expect(icon.subarray(1, 4).toString()).toBe('PNG');

    // Badges: without a panel domain there is no address for the resource pack – the plugin keeps the symbols.
    expect(withOwner).toMatchObject({ badgePackUrl: null });
    expect(ranked).toContain('"badge": ""');
    // No panel domain entered (Philip: NetBird set up by hand) – the panel learns it from the admin's own use.
    // Browsers only send the page along when the panel allows it for its own pages.
    const listed = await t.app.inject({ method: 'GET', url: '/api/servers', headers: authHeaders(admin) });
    expect(listed.headers['referrer-policy']).toBe('same-origin');
    await t.app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { ...authHeaders(admin), referer: 'https://mornihosting.de/servers' },
    });
    // Philip: a deleted server still "had" this name – that silently meant no badges. Now it doesn't block anything.
    t.ctx.settings.setValue('public_stats', { gone0000: { enabled: false, slug: 'craft-attack' } });
    const withPack = await t.app.inject({
      method: 'PUT',
      url: mcUrl,
      headers: authHeaders(admin),
      payload: { ...state.settings, badges: true },
    });
    const packUrl = withPack.json<{ badgePackUrl: string }>().badgePackUrl;
    // Entering the panel domain later reaches the plugin at once (no restart needed).
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeaders(admin),
      payload: { panelDomain: 'panel.mornihosting.de' },
    });
    await waitFor(() =>
      fs
        .readFileSync(path.join(dir, 'plugins', 'MorniCraft', 'config.yml'), 'utf8')
        .includes('panel.mornihosting.de'),
    );
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeaders(admin),
      payload: { panelDomain: '' },
    });
    expect(packUrl).toMatch(
      /^https:\/\/mornihosting\.de\/api\/public\/packs\/craft-attack\.zip\?v=[0-9a-f]{10}$/,
    ); // eslint-disable-line ts-patterns/require-regex-example -- "https://mornihosting.de/api/public/packs/craft-attack.zip?v=0402fc9a41"
    const badged = fs.readFileSync(path.join(dir, 'plugins', 'MorniCraft', 'config.yml'), 'utf8');
    expect(badged).toContain(`"url": "${packUrl}"`);
    expect(badged).toContain('"badge": "\ue700"');
    // Anyone may load the pack (the game does, without logging in): a zip with the font and one picture per rank.
    const zip = await t.app.inject({ method: 'GET', url: '/api/public/packs/craft-attack.zip' });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(badged).toContain(`"sha1": "${crypto.createHash('sha1').update(zip.rawPayload).digest('hex')}"`);
    expect(zip.rawPayload.includes('assets/minecraft/font/default.json')).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: '/api/public/packs/gibts-nicht.zip' })).statusCode).toBe(
      404,
    );
    // Required (default): Minecraft itself sends the pack while connecting – it goes into server.properties at start.
    expect(badged).toContain('"server": true');
    const start = (): Promise<unknown> =>
      t.app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/actions/start`,
        headers: authHeaders(admin),
      });
    const stop = (): Promise<unknown> =>
      t.app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/actions/stop`,
        headers: authHeaders(admin),
      });
    await start();
    const props = (): string => fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    await waitFor(() => props().includes('require-resource-pack=true'));
    expect(props()).toContain('craft-attack.zip');
    expect(props()).toContain(
      `resource-pack-sha1=${crypto.createHash('sha1').update(zip.rawPayload).digest('hex')}`,
    );
    await stop();
    // Switched off: no pack in the config any more, and our entry leaves server.properties at the next start.
    await t.app.inject({
      method: 'PUT',
      url: mcUrl,
      headers: authHeaders(admin),
      payload: { ...state.settings, badges: false },
    });
    await waitFor(async () => {
      await start();
      return props().includes('require-resource-pack=false');
    });
    expect(props()).not.toContain('craft-attack.zip');
    expect(fs.readFileSync(path.join(dir, 'plugins', 'MorniCraft', 'config.yml'), 'utf8')).toContain(
      '"url": ""',
    );
  });
});

describe('rank badges', () => {
  it('draws a tag per rank and packs them as a resource pack that stays the same for the same ranks', () => {
    const owner = badgePicture({ name: 'Owner', symbol: '♛', color: '#ff5555' });
    // 2 + icon 7 + 2 + "OWNER" (3 + 5 + 4 + 3 + 3 pixels and 4 gaps) + 2; as tall as a line of chat.
    expect([owner.width, owner.height]).toEqual([35, 9]);
    // The top row stays free (tags of two chat lines don't touch); the tag is the rank's colour, darkened.
    expect(owner.pixels[7]).toBe(0);
    const tagStart = (owner.width + 1) * 4;
    expect([...owner.pixels.subarray(tagStart, tagStart + 4)]).toEqual([128, 43, 43, 255]);
    expect(pngOf(owner).subarray(1, 4).toString()).toBe('PNG');
    // Letters the font does not know are left out; without a symbol there is no icon …
    expect(badgePicture({ name: 'V.I.P★', symbol: '', color: '#ffd23f' }).width).toBe(2 + 11 + 2);
    // … except for the rank everyone else has: plain players get the little player.
    const plain = badgePicture({ name: 'Spieler', symbol: '', color: '#aaaaaa', isDefault: true });
    expect(plain.width).toBe(2 + 7 + 2 + 27 + 2);
    const pack = badgePack(DEFAULT_RANKS);
    expect(Object.keys(pack.chars)).toEqual(DEFAULT_RANKS.map((r) => r.id));
    expect(pack.chars['owner']).toBe('\ue700');
    expect(badgePack(DEFAULT_RANKS).sha1).toBe(pack.sha1);
    expect(pack.sha1).toMatch(/^[0-9a-f]{40}$/); // eslint-disable-line ts-patterns/require-regex-example -- "0402fc9a41332c12c2f987ecee454125040c3732"
  });
});

describe('log times', () => {
  it('reads them in the server time zone', async () => {
    const { logMoment } = await import('../src/craftattack/stats.js');
    expect(logMoment('2024-06-01', '18:00:00', 'Europe/Berlin')).toBe('2024-06-01T16:00:00.000Z');
    expect(logMoment('2024-01-15', '18:00:00', 'Europe/Berlin')).toBe('2024-01-15T17:00:00.000Z');
  });
});

describe('team dashboard (/teamdashboard)', () => {
  let t: TestApp;
  let admin: Session;
  beforeEach(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('shows each team member what their rank allows, writes buttons for the game and changes the rules', async () => {
    const server = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(admin),
        payload: {
          name: 'Team Welt',
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
    fs.mkdirSync(path.join(dir, 'world', 'datapacks', 'mornihosting-craftattack'), { recursive: true });
    await t.app.inject({
      method: 'PUT',
      url: `/api/servers/${server.id}/public-stats`,
      headers: authHeaders(admin),
      payload: { enabled: true },
    });
    const team = path.join(dir, 'plugins', 'MorniCraft', 'team');
    fs.mkdirSync(path.join(team, 'links'), { recursive: true });
    const link = (key: string, name: string, abilities: string[], until = Date.now() + 3_600_000): void =>
      fs.writeFileSync(
        path.join(team, 'links', `${crypto.createHash('sha256').update(key).digest('hex')}.json`),
        JSON.stringify({
          uuid: crypto.randomUUID(),
          name,
          rank: name,
          rankColor: '#55ff99',
          op: false,
          abilities,
          until,
        }),
      );
    const ownerKey = 'a'.repeat(48);
    const supporterKey = 'b'.repeat(48);
    const oldKey = 'c'.repeat(48);
    link(ownerKey, 'Owner', ['moderate', 'kick', 'ban', 'locate', 'ranks', 'rules']);
    link(supporterKey, 'Supporter', ['moderate']);
    link(oldKey, 'Alt', ['moderate'], Date.now() - 1000);
    const player = {
      uuid: crypto.randomUUID(),
      name: 'Steve',
      rank: 'VIP',
      rankId: 'vip',
      rankColor: '#ffd24d',
      rankOrder: 5,
      team: false,
      ping: 20,
      world: 'world',
      x: 10,
      y: 64,
      z: -5,
      health: 20,
      food: 20,
      gamemode: 'survival',
      afk: false,
      live: false,
      combat: false,
      frozen: false,
      jailedUntil: Date.now() + 600_000,
      jailReason: 'Griefing',
      mutedUntil: 0,
      bedrock: false,
      playMinutes: 90,
      inventory: [{ slot: 0, id: 'diamond_sword', count: 1, enchanted: true }],
      ender: [],
    };
    fs.writeFileSync(
      path.join(team, 'state.json'),
      JSON.stringify({
        at: Date.now(),
        server: 'Team Welt',
        max: 20,
        online: [player],
        jailedOffline: [],
        mutedOffline: [
          { uuid: crypto.randomUUID(), name: 'Tom', until: Date.now() + 60_000, reason: 'Spam' },
        ],
        ranks: [{ id: 'vip', name: 'VIP', color: '#ffd24d', symbol: '', default: false }],
        bans: [
          { name: 'Hacker', reason: 'Fly', by: 'Owner', since: Date.now(), until: 0 },
          { name: 'Weg', reason: 'alt', by: 'Owner', since: 0, until: Date.now() - 1000 },
        ],
        history: [
          { at: Date.now(), type: 'jail', target: 'Steve', by: 'Owner', reason: 'Griefing', minutes: 10 },
        ],
      }),
    );
    const url = '/api/public/team/team-welt';
    const as = (key: string) => ({ 'x-team-key': key });

    // No key, a wrong one, a run-out one: nothing.
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url, headers: as('d'.repeat(48)) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url, headers: as(oldKey) })).statusCode).toBe(404);

    const owner = (await t.app.inject({ method: 'GET', url, headers: as(ownerKey) })).json<TeamBoardView>();
    expect(owner).toMatchObject({ live: true, max: 20, me: { name: 'Owner' } });
    expect(owner.online[0]?.where).toEqual({ world: 'world', x: 10, y: 64, z: -5 });
    expect(owner.online[0]?.inventory).toHaveLength(1);
    expect(owner.jailed.map((e) => e.name)).toEqual(['Steve']);
    expect(owner.muted.map((e) => e.name)).toEqual(['Tom']);
    expect(owner.bans.map((b) => b.name)).toEqual(['Hacker']);
    expect(owner.ranks).toHaveLength(1);
    expect(owner.history).toHaveLength(1);

    // A supporter sees the players but not where they are, and gets no rank list.
    const supporter = (
      await t.app.inject({ method: 'GET', url, headers: as(supporterKey) })
    ).json<TeamBoardView>();
    expect(supporter.online[0]?.where).toBeUndefined();
    expect(supporter.ranks).toEqual([]);

    // Buttons: a supporter may jail, not ban; the plugin finds the action as a file.
    const act = (key: string, payload: object) =>
      t.app.inject({ method: 'POST', url: `${url}/action`, headers: as(key), payload });
    expect(
      (await act(supporterKey, { action: 'ban', target: 'Steve', minutes: 0, reason: 'x' })).statusCode,
    ).toBe(403);
    expect(
      (await act(supporterKey, { action: 'mute', target: 'Steve', minutes: 10, reason: 'Spam' })).statusCode,
    ).toBe(200);
    expect((await act(ownerKey, { action: 'target; rm', target: 'Steve' })).statusCode).toBe(400);
    expect((await act(ownerKey, { action: 'jail', target: '../x' })).statusCode).toBe(400);
    const actions = fs.readdirSync(path.join(team, 'actions')).filter((f) => f.endsWith('.json'));
    expect(actions).toHaveLength(1);
    const written = JSON.parse(
      fs.readFileSync(path.join(team, 'actions', actions[0] ?? ''), 'utf8'),
    ) as Record<string, unknown>;
    expect(written).toMatchObject({
      action: 'mute',
      target: 'Steve',
      minutes: 10,
      reason: 'Spam',
      by: 'Supporter',
    });

    // Rules: only owners and admins; they land in the dashboard settings and the plugin's config.
    const rules = (key: string) =>
      t.app.inject({
        method: 'PUT',
        url: `${url}/rules`,
        headers: as(key),
        payload: { rules: ['Sei nett', 'Kein Griefing'] },
      });
    expect((await rules(supporterKey)).statusCode).toBe(403);
    expect((await rules(ownerKey)).statusCode).toBe(200);
    const after = (await t.app.inject({ method: 'GET', url, headers: as(ownerKey) })).json<TeamBoardView>();
    expect(after.rules).toEqual(['Sei nett', 'Kein Griefing']);
    expect(fs.readFileSync(path.join(dir, 'plugins', 'MorniCraft', 'config.yml'), 'utf8')).toContain(
      'Kein Griefing',
    );
  });
});
