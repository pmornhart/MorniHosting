/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CrashHelp, CrashInfo, ServerSummary } from '@mornihosting/shared';
import { analyseCrash, type CrashContext } from '../src/servers/crash.js';
import { foreignJars, missingDependencies } from '../src/servers/mod-deps.js';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

/**
 * Philip's crash: a mod needed another mod that was not installed, and the helper said "switch it off".
 * A missing plugin/mod must be called a missing plugin/mod, with "install it" as the fix.
 */

const base: Omit<CrashContext, 'lines'> = { oomKilled: false, exitCode: 1, memoryMb: 4096, javaTag: null };

/** A real jar (ZIP) with the given files inside. */
async function jar(file: string, entries: Readonly<Record<string, string | Buffer>>): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const archive = archiver('zip');
  const out = fs.createWriteStream(file);
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    archive.on('error', reject);
  });
  archive.pipe(out);
  Object.entries(entries).forEach(([name, content]) => archive.append(content, { name }));
  await archive.finalize();
  await done;
}

describe('jars made for several platforms (Philip: Paper server offered "install ViaFabric")', () => {
  test('ViaVersion on Paper needs nothing – its fabric.mod.json only counts on Fabric', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-via-'));
    const via = {
      'plugin.yml':
        'name: ViaVersion\nmain: com.viaversion.ViaVersionPlugin\nsoftdepend: [ProtocolSupport]\n',
      'velocity-plugin.json': JSON.stringify({ id: 'viaversion', name: 'ViaVersion' }),
      'fabric.mod.json': JSON.stringify({
        id: 'viaversion',
        name: 'ViaVersion',
        depends: { viafabric: '>=0.4.14' },
      }),
    };
    await jar(path.join(dir, 'plugins', 'ViaVersion.jar'), via);
    expect(await missingDependencies(dir, 'paper')).toEqual([]);
    expect(await missingDependencies(dir, 'velocity')).toEqual([]);
    const fabric = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-via-'));
    await jar(path.join(fabric, 'mods', 'ViaVersion.jar'), via);
    expect((await missingDependencies(fabric, 'fabric')).map((m) => m.dependency)).toEqual(['viafabric']);
  });

  test('ViaFabric on Fabric: the part of Fabric API its inner jar needs counts as "Fabric API missing"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-viafabric-'));
    const innerFile = path.join(dir, 'inner.jar');
    await jar(innerFile, {
      'fabric.mod.json': JSON.stringify({
        id: 'viafabric-mc26-2',
        depends: { 'fabric-resource-loader-v0': '*', minecraft: '26.3', viafabric: '*' },
      }),
    });
    const inner = fs.readFileSync(innerFile);
    fs.rmSync(innerFile);
    await jar(path.join(dir, 'mods', 'ViaFabric.jar'), {
      'fabric.mod.json': JSON.stringify({ id: 'viafabric', name: 'ViaFabric', depends: { minecraft: '*' } }),
      'META-INF/jars/viafabric-mc26-2.jar': inner,
    });
    expect((await missingDependencies(dir, 'fabric')).map((m) => m.dependency)).toEqual(['fabric-api']);
    await jar(path.join(dir, 'mods', 'fabric-api.jar'), {
      'fabric.mod.json': JSON.stringify({ id: 'fabric-api', name: 'Fabric API' }),
    });
    expect(await missingDependencies(dir, 'fabric')).toEqual([]);
  });

  test("a Fabric mod in a Paper server's plugins folder is found (it can never load there)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-foreign-'));
    await jar(path.join(dir, 'plugins', 'ViaFabric.jar'), {
      'fabric.mod.json': JSON.stringify({ id: 'viafabric', depends: { 'fabric-api': '*' } }),
    });
    await jar(path.join(dir, 'plugins', 'ViaVersion.jar'), {
      'plugin.yml': 'name: ViaVersion\nmain: x.Y\n',
      'fabric.mod.json': JSON.stringify({ id: 'viaversion' }),
    });
    expect(await foreignJars(dir, 'paper')).toEqual(['plugins/ViaFabric.jar']);
    // Nothing missing on Paper: the Fabric mod's needs don't count there either.
    expect(await missingDependencies(dir, 'paper')).toEqual([]);
  });
});

describe('missing plugins and mods in the log', () => {
  test('new Fabric wording names the missing mod (not "mods for another version")', () => {
    const crash = analyseCrash({
      ...base,
      lines: [
        '[main/ERROR]: Incompatible mods found!',
        'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
        'A potential solution has been determined, this may resolve your problem:',
        "\t - Mod 'Xaero's Minimap' (xaerominimap) 24.6.1 requires version 0.92.0 or later of mod 'Fabric API' (fabric-api), which is missing!",
      ],
    });
    expect(crash.ruleId).toBe('missing-dependency');
    expect(crash.params).toMatchObject({
      plugin: "Xaero's Minimap",
      dependency: 'Fabric API',
      dependencyIds: 'fabric-api',
    });
  });

  test('old Fabric wording still works', () => {
    const crash = analyseCrash({
      ...base,
      lines: ["Mod 'Sodium Extra' (sodium-extra) 0.5.4 requires any version of sodium, which is missing!"],
    });
    expect(crash.params).toMatchObject({ plugin: 'Sodium Extra', dependencyIds: 'sodium' });
  });

  test('Forge/NeoForge list every missing mod', () => {
    const crash = analyseCrash({
      ...base,
      lines: [
        'Missing or unsupported mandatory dependencies:',
        "\tMod ID: 'architectury', Requested by: 'roughlyenoughitems', Expected range: '[13.0.6,)', Actual version: '[MISSING]'",
        "\tMod ID: 'cloth_config', Requested by: 'roughlyenoughitems', Expected range: '[15,)', Actual version: '[MISSING]'",
        "\tMod ID: 'minecraft', Requested by: 'roughlyenoughitems', Expected range: '[1.21,)', Actual version: '1.21.1'",
      ],
    });
    expect(crash.ruleId).toBe('missing-dependency');
    expect(crash.params).toMatchObject({
      plugin: 'roughlyenoughitems',
      dependencyIds: 'architectury,cloth_config',
    });
  });

  test('Paper names the missing plugin', () => {
    const crash = analyseCrash({
      ...base,
      lines: [
        "[ERROR]: Could not load 'plugins/ChestShop.jar' in folder 'plugins'",
        "org.bukkit.plugin.UnknownDependencyException: Unknown/missing dependency plugins: [Vault]. Please download and install these plugins to run 'ChestShop'.",
      ],
    });
    expect(crash.params).toMatchObject({ plugin: 'ChestShop.jar', dependencyIds: 'Vault' });
  });

  test('a class of another plugin is missing: install that one, do not switch off the one that needs it', () => {
    const crash = analyseCrash({
      ...base,
      packages: { 'com.acrobot.chestshop': { name: 'ChestShop', file: 'plugins/ChestShop.jar' } },
      lines: [
        '[ERROR]: Error occurred while enabling ChestShop v3.12 (Is it up to date?)',
        'java.lang.NoClassDefFoundError: net/milkbowl/vault/economy/Economy',
        '\tat com.acrobot.chestshop.ChestShop.onEnable(ChestShop.java:120)',
        'Caused by: java.lang.ClassNotFoundException: net.milkbowl.vault.economy.Economy',
      ],
    });
    expect(crash.ruleId).toBe('missing-dependency');
    expect(crash.params).toMatchObject({ plugin: 'ChestShop', dependencyIds: 'vault' });
  });

  test('a missing class of the game itself is still "built for another version"', () => {
    const crash = analyseCrash({
      ...base,
      packages: { 'com.acrobot.chestshop': { name: 'ChestShop', file: 'plugins/ChestShop.jar' } },
      lines: [
        'java.lang.NoClassDefFoundError: net/minecraft/server/v1_20_R1/MinecraftServer',
        '\tat com.acrobot.chestshop.ChestShop.onEnable(ChestShop.java:120)',
      ],
    });
    expect(crash.ruleId).toBe('plugin-incompatible');
  });

  test('when the log only says "incompatible", the mod files tell what is missing', () => {
    const crash = analyseCrash({
      ...base,
      missing: [
        {
          by: 'Iris',
          byFile: 'mods/iris.jar',
          dependency: 'sodium',
          disabledFile: 'mods/sodium.jar.disabled',
        },
      ],
      lines: ['[main/ERROR]: Incompatible mods found!'],
    });
    expect(crash.ruleId).toBe('missing-dependency');
    expect(crash.params).toMatchObject({
      plugin: 'Iris',
      dependencyIds: 'sodium',
      disabledFiles: 'mods/sodium.jar.disabled',
    });
  });
});

describe('dependencies read from the mod files', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-deps-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Fabric, Forge and Bukkit: only what is really missing, bundled jars and built-ins count as there', async () => {
    const inner = path.join(dir, 'inner.jar');
    await jar(inner, { 'fabric.mod.json': JSON.stringify({ id: 'cloth-config', name: 'Cloth Config' }) });
    await jar(path.join(dir, 'mods', 'xaero.jar'), {
      'fabric.mod.json': JSON.stringify({
        id: 'xaerominimap',
        name: "Xaero's Minimap",
        depends: { fabricloader: '*', minecraft: '1.21.1', 'fabric-api': '*', 'cloth-config': '*' },
        jars: [{ file: 'META-INF/jars/cloth.jar' }],
      }),
      'META-INF/jars/cloth.jar': fs.readFileSync(inner),
    });
    await jar(path.join(dir, 'mods', 'rei.jar'), {
      'META-INF/neoforge.mods.toml': [
        '[[mods]]',
        'modId="roughlyenoughitems"',
        'displayName="Roughly Enough Items"',
        '[[dependencies.roughlyenoughitems]]',
        'modId="neoforge"',
        'type="required"',
        '[[dependencies.roughlyenoughitems]]',
        'modId="architectury"',
        'type="required"',
        '[[dependencies.roughlyenoughitems]]',
        'modId="jei"',
        'type="optional"',
      ].join('\n'),
    });
    await jar(path.join(dir, 'mods', 'architectury.jar.disabled'), {
      'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="architectury"\n',
    });
    await jar(path.join(dir, 'plugins', 'ChestShop.jar'), {
      'plugin.yml':
        'name: ChestShop\nmain: com.acrobot.chestshop.ChestShop\ndepend: [Vault]\nsoftdepend:\n  - WorldGuard\n',
    });
    const missing = await missingDependencies(dir);
    expect(missing).toEqual(
      expect.arrayContaining([
        { by: "Xaero's Minimap", byFile: 'mods/xaero.jar', dependency: 'fabric-api', disabledFile: null },
        {
          by: 'Roughly Enough Items',
          byFile: 'mods/rei.jar',
          dependency: 'architectury',
          disabledFile: 'mods/architectury.jar.disabled',
        },
        { by: 'ChestShop', byFile: 'plugins/ChestShop.jar', dependency: 'Vault', disabledFile: null },
      ]),
    );
    expect(missing).toHaveLength(3);
  });
});

const FABRIC_API_JAR = Buffer.from('PK fabric api');
const sha512 = crypto.createHash('sha512').update(FABRIC_API_JAR).digest('hex');

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Just enough of Modrinth: a search that finds Fabric API, its versions and the file. */
const fakeModrinth = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(urlOf(input));
  if (url.hostname === 'cdn.modrinth.com') return new Response(FABRIC_API_JAR);
  if (url.pathname.endsWith('/search')) {
    const q = url.searchParams.get('query') ?? '';
    return Response.json({
      total_hits: 2,
      hits: [
        { title: 'Fabric API Extras', slug: 'fabric-api-extras', project_id: 'X' },
        { title: 'Fabric API', slug: 'fabric-api', project_id: 'P7dR8mSH' },
      ]
        .filter(() => q === 'fabric-api')
        .map((h) => ({
          ...h,
          description: '',
          author: 'modmuss50',
          downloads: 1,
          versions: ['1.21.1'],
          categories: ['fabric'],
          project_type: 'mod',
        })),
    });
  }
  if (url.pathname.includes('/project/P7dR8mSH/version'))
    return Response.json([
      {
        id: 'v1',
        project_id: 'P7dR8mSH',
        name: '0.116.0',
        version_number: '0.116.0+1.21.1',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        date_published: '2026-10-01T00:00:00Z',
        version_type: 'release',
        files: [
          {
            url: 'https://cdn.modrinth.com/P7dR8mSH/fabric-api-0.116.0.jar',
            filename: 'fabric-api-0.116.0.jar',
            primary: true,
            hashes: { sha512 },
          },
        ],
        dependencies: [],
      },
    ]);
  if (url.pathname.includes('/project/'))
    return Response.json({ id: 'P7dR8mSH', slug: 'fabric-api', title: 'Fabric API', project_type: 'mod' });
  return new Response('not found', { status: 404 });
});

describe('the crash helper installs what is missing', () => {
  let t: TestApp;
  let admin: Session;
  let id: string;
  beforeEach(async () => {
    vi.stubGlobal('fetch', fakeModrinth);
    t = await createTestApp();
    admin = await setupAdmin(t);
    id = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(admin),
        payload: {
          name: 'Modded',
          edition: 'java',
          software: 'fabric',
          version: '1.21.1',
          memoryMb: 4096,
          port: 25565,
          eula: true,
          startNow: false,
        },
      })
    ).json<ServerSummary>().id;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.cleanup();
  });

  test('one click installs Fabric API (the right one, not "Fabric API Extras"), offered first', async () => {
    const info: CrashInfo = {
      at: new Date().toISOString(),
      ruleId: 'missing-dependency',
      params: { plugin: "Xaero's Minimap", dependency: 'Fabric API', dependencyIds: 'fabric-api' },
      excerpt: [],
    };
    t.ctx.db.run(sql`UPDATE servers SET crash = ${JSON.stringify(info)} WHERE id = ${id}`);
    t.ctx.events.emit('server.crashed', { serverId: id, crash: info });
    const help = async (): Promise<CrashHelp | null> =>
      (
        await t.app.inject({ method: 'GET', url: `/api/servers/${id}/crash`, headers: authHeaders(admin) })
      ).json<{ help: CrashHelp | null }>().help;
    await waitFor(async () => (await help())?.fixes[0]?.id === 'install-dependency');
    const offered = await help();
    expect(offered?.fixes[0]).toMatchObject({ id: 'install-dependency', params: { name: 'Fabric API' } });
    expect(offered?.fixes.map((f) => f.id)).not.toContain('disable-plugin');

    const done = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${id}/crash/fix`,
      headers: authHeaders(admin),
      payload: { fix: 'install-dependency', start: false },
    });
    expect(done.statusCode).toBe(200);
    expect(fs.existsSync(path.join(t.dataDir, 'servers', id, 'mods', 'fabric-api-0.116.0.jar'))).toBe(true);
    expect(await help()).toBeNull();
  });
});

describe('missing pieces are installed before the start (Philip: "von Anfang an")', () => {
  let t: TestApp;
  let admin: Session;
  let id: string;
  beforeEach(async () => {
    vi.stubGlobal('fetch', fakeModrinth);
    t = await createTestApp();
    admin = await setupAdmin(t);
    id = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(admin),
        payload: {
          name: 'Modded',
          edition: 'java',
          software: 'fabric',
          version: '1.21.1',
          memoryMb: 4096,
          port: 25565,
          eula: true,
          startNow: false,
        },
      })
    ).json<ServerSummary>().id;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.cleanup();
  });

  test('a mod that needs Fabric API gets it before the server starts – no crash first', async () => {
    const mods = path.join(t.dataDir, 'servers', id, 'mods');
    await jar(path.join(mods, 'minimap.jar'), {
      'fabric.mod.json': JSON.stringify({
        id: 'xaerominimap',
        name: "Xaero's Minimap",
        depends: { 'fabric-api': '*' },
      }),
    });
    expect((await missingDependencies(path.join(t.dataDir, 'servers', id))).map((m) => m.dependency)).toEqual(
      ['fabric-api'],
    );
    const started = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${id}/actions/start`,
      headers: authHeaders(admin),
    });
    expect(started.statusCode).toBeLessThan(300);
    // Installed before the container starts (the fake jar here has no fabric.mod.json, so only the file counts).
    await waitFor(() => fs.existsSync(path.join(mods, 'fabric-api-0.116.0.jar')));
  });
});
