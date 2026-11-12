import crypto from 'node:crypto';
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
  spawnPackFiles,
  fountainCommands,
  removeRainbowCommands,
  removeBenchesCommands,
  flagCommands,
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
    // A white tower with a red roof and the flag (emerald with a white M, white-and-blue lozenges) …
    expect(top).toContain('bricks');
    expect(top).not.toContain('lime_wool');
    const flag = flagCommands(0, 0, 0).join('\n');
    expect(flag).toContain('emerald_block');
    expect(flag).toContain('light_blue_wool');
    // … a maypole, tulips, and each way out named in the paving in its own colour (O for Ost, E in English).
    expect(top).toContain('light_blue_wall_banner[facing=south]');
    expect(top).toContain('yellow_concrete');
    expect(topCommands('en').join('\n')).not.toEqual(top);
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
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeaders(admin),
      payload: { panelDomain: 'mornihosting.de' },
    });
    const withPack = await t.app.inject({
      method: 'PUT',
      url: mcUrl,
      headers: authHeaders(admin),
      payload: { ...state.settings, badges: true },
    });
    const packUrl = withPack.json<{ badgePackUrl: string }>().badgePackUrl;
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
    // Switched off: no pack in the config any more.
    await t.app.inject({
      method: 'PUT',
      url: mcUrl,
      headers: authHeaders(admin),
      payload: { ...state.settings, badges: false },
    });
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
