/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  CREATABLE_SOFTWARE,
  GAME_IDS,
  GAMES,
  SOFTWARE,
  allowedGameImages,
  gameImage,
  type GameId,
  type ServerDetail,
  type ServerSummary,
} from '@mornihosting/shared';
import { buildContainerSpec, commandChannelFor } from '../src/servers/spec.js';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

const order = (game: GameId, extra: Record<string, unknown> = {}) => ({
  name: `Mein ${GAMES[game].label}`,
  edition: game,
  software: game,
  version: GAMES[game].versions[0]?.id ?? 'latest',
  memoryMb: GAMES[game].recommendedGb * 1024,
  port: GAMES[game].ports[0].defaultPort,
  eula: true,
  ...extra,
});

describe('game catalog', () => {
  test('every game is consistent', () => {
    GAME_IDS.forEach((id) => {
      const game = GAMES[id];
      expect(game.id).toBe(id);
      expect(game.packagesGb).toContain(game.recommendedGb);
      game.mounts.forEach((m) => expect(m.path.startsWith('/') && !m.subdir.includes('..')).toBe(true));
      expect(new Set(game.ports.map((p) => p.key)).size).toBe(game.ports.length);
      expect(new Set(game.fields.map((f) => f.key)).size).toBe(game.fields.length);
      if (game.console === 'rcon') expect(game.rconPort === 'main' || (game.rconPort ?? 0) > 0).toBe(true);
      game.fields.filter((f) => f.kind === 'select').forEach((f) => expect(f.options).toContain(f.fallback));
      expect(SOFTWARE[id].edition).toBe(id);
      expect(CREATABLE_SOFTWARE[id]).toEqual([id]);
    });
  });

  test('only listed images can be started', () => {
    const allowed = allowedGameImages();
    GAME_IDS.forEach((id) => {
      expect(allowed).toContain(gameImage(GAMES[id], GAMES[id].versions[0]?.id ?? ''));
      // An unknown "version" must not smuggle in another tag.
      expect(allowed).toContain(gameImage(GAMES[id], 'evil:tag'));
    });
  });
});

describe('Factorio with the fake driver', () => {
  let t: TestApp;
  let s: Session;
  beforeEach(async () => {
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const detail = async (id: string): Promise<ServerDetail> =>
    (await t.app.inject({ url: `/api/servers/${id}`, headers: authHeaders(s) })).json<ServerDetail>();

  const create = async (payload: object): Promise<ServerSummary> => {
    const res = await t.app.inject({ method: 'POST', url: '/api/servers', headers: authHeaders(s), payload });
    expect(res.statusCode).toBe(200);
    return res.json<ServerSummary>();
  };

  test('create, start, players, save, stop', async () => {
    const created = await create(
      order('factorio', { gameSettings: { spaceAge: 'false', token: 'geheim123' } }),
    );
    expect(created.edition).toBe('factorio');
    await waitFor(async () => (await detail(created.id)).live.state === 'running');

    const d = await detail(created.id);
    expect(d.image).toBe('factoriotools/factorio:stable');
    expect(d.gamePorts).toEqual([{ key: 'main', port: 34197, protocol: 'udp' }]);
    // Secrets never come back, only that one is stored.
    expect(d.gameSettings).toEqual({ values: { spaceAge: 'false' }, secretsSet: ['token'] });

    const dir = path.join(t.dataDir, 'servers', created.id);
    expect(fs.readFileSync(path.join(dir, 'config', 'rconpw'), 'utf8').length).toBeGreaterThan(10);
    expect(fs.existsSync(path.join(dir, 'saves', 'world.zip'))).toBe(true);

    const answer = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/command`,
      headers: authHeaders(s),
      payload: { command: '/players online' },
    });
    expect(answer.json<{ answer: string }>().answer).toContain('Online players (0)');

    const players = await t.app.inject({
      url: `/api/servers/${created.id}/players`,
      headers: authHeaders(s),
    });
    expect(players.json()).toMatchObject({ online: [], ops: [] });

    // Minecraft-only parts refuse.
    const world = await t.app.inject({ url: `/api/servers/${created.id}/worlds`, headers: authHeaders(s) });
    expect(world.statusCode).toBe(400);
    const geyser = await t.app.inject({
      method: 'PUT',
      url: `/api/servers/${created.id}/geyser`,
      headers: authHeaders(s),
      payload: { enabled: true },
    });
    expect(geyser.statusCode).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/actions/stop`,
      headers: authHeaders(s),
    });
    await waitFor(async () => (await detail(created.id)).live.state === 'stopped');
    const logs = t.servers.logs(created.id).join('\n');
    expect(logs).toContain('Saving map');
    expect(logs).toContain('remote-quit');
  });

  test('container gets the right folder, ports and variables', async () => {
    const created = await create(
      order('factorio', { port: 34200, startNow: false, gameSettings: { username: 'morni', token: 'abc' } }),
    );
    const row = t.servers.rowWithSecrets(created.id);
    const spec = buildContainerSpec(t.ctx.config, row, 'Europe/Berlin');
    expect(spec.mounts).toEqual([{ subdir: '', path: '/factorio' }]);
    expect(spec.ports).toEqual([{ containerPort: 34200, hostPort: 34200, protocol: 'udp' }]);
    expect(spec.env).toMatchObject({
      PORT: '34200',
      RCON_PORT: '27015',
      USERNAME: 'morni',
      TOKEN: 'abc',
      DLC_SPACE_AGE: 'true',
      PUID: '1000',
    });
    // The token is stored encrypted.
    expect(t.servers.row(created.id).gameSettings['token']).not.toBe('abc');
  });

  test('settings are checked and can be changed later', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: authHeaders(s),
      payload: order('factorio', { gameSettings: { evil: 'x' } }),
    });
    expect(bad.statusCode).toBe(400);
    const injection = await t.app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: authHeaders(s),
      payload: order('factorio', { gameSettings: { username: '$(rm -rf /)' } }),
    });
    expect(injection.statusCode).toBe(400);

    const created = await create(order('factorio', { startNow: false }));
    const put = await t.app.inject({
      method: 'PUT',
      url: `/api/servers/${created.id}/game-settings`,
      headers: authHeaders(s),
      payload: { values: { updateMods: 'true', token: 'neu' } },
    });
    expect(put.statusCode).toBe(204);
    expect((await detail(created.id)).gameSettings).toEqual({
      values: { updateMods: 'true' },
      secretsSet: ['token'],
    });
  });

  test('a second server on the same port gets the next free one', async () => {
    const first = await create(order('factorio', { startNow: false }));
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: authHeaders(s),
      payload: order('factorio', { startNow: false }),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<ServerSummary>().port).toBe(first.port + 1);
  });
});

describe.each(GAME_IDS.map((id) => [id]))('%s with the fake driver', (id) => {
  let t: TestApp;
  let s: Session;
  beforeEach(async () => {
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('create, start, stop', async () => {
    const game = GAMES[id];
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: authHeaders(s),
      payload: order(id, { startNow: false }),
    });
    expect(res.statusCode).toBe(200);
    const created = res.json<ServerSummary>();
    // Files the person uploads first (ETS2's server packages).
    (game.requiredFiles ?? []).forEach((file) => {
      const full = path.join(t.dataDir, 'servers', created.id, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'exported in game');
    });
    const start = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/actions/start`,
      headers: authHeaders(s),
    });
    expect(start.statusCode).toBeLessThan(300);
    const detail = async (): Promise<ServerDetail> =>
      (
        await t.app.inject({ url: `/api/servers/${created.id}`, headers: authHeaders(s) })
      ).json<ServerDetail>();
    await waitFor(async () => (await detail()).live.state === 'running');
    expect(allowedGameImages()).toContain((await detail()).image);
    expect((await detail()).gamePorts.map((p) => p.protocol)).toEqual(game.ports.map((p) => p.protocol));
    const command = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/command`,
      headers: authHeaders(s),
      payload: { command: 'status' },
    });
    expect(command.statusCode).toBe(game.console === 'none' ? 400 : 200);
    await t.app.inject({
      method: 'POST',
      url: `/api/servers/${created.id}/actions/stop`,
      headers: authHeaders(s),
    });
    await waitFor(async () => (await detail()).live.state === 'stopped');
  });
});

describe('Counter-Strike 2 container', () => {
  test('RCON on the game port, password and settings as variables', async () => {
    const t = await createTestApp();
    const s = await setupAdmin(t);
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload: order('cs2', {
          port: 27016,
          startNow: false,
          gameSettings: { gameMode: 'wingman', gslt: 'ABC' },
        }),
      });
      const row = t.servers.rowWithSecrets(res.json<ServerSummary>().id);
      const spec = buildContainerSpec(t.ctx.config, row, 'Europe/Berlin');
      expect(spec.ports).toEqual([{ containerPort: 27016, hostPort: 27016, protocol: 'udp' }]);
      expect(spec.env).toMatchObject({
        CS2_PORT: '27016',
        CS2_RCONPW: row.rconPassword,
        CS2_GAMEALIAS: 'wingman',
        SRCDS_TOKEN: 'ABC',
        CS2_STARTMAP: 'de_inferno',
      });
      expect(commandChannelFor(row)).toMatchObject({ kind: 'rcon', port: 27016 });
      const bad = await t.app.inject({
        method: 'PUT',
        url: `/api/servers/${row.id}/game-settings`,
        headers: authHeaders(s),
        payload: { values: { gameMode: 'battle-royale' } },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await t.cleanup();
    }
  });
});

describe("Garry's Mod container", () => {
  test('two folders, RCON password and workshop as start arguments', async () => {
    const t = await createTestApp();
    const s = await setupAdmin(t);
    try {
      const payload = order('gmod', {
        startNow: false,
        gameSettings: { workshopCollection: '123456', password: 'geheim' },
      });
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload,
      });
      const row = t.servers.rowWithSecrets(res.json<ServerSummary>().id);
      const spec = buildContainerSpec(t.ctx.config, row, 'Europe/Berlin');
      expect(spec.mounts?.map((m) => m.subdir)).toEqual(['data', 'addons']);
      expect(spec.env['ARGS']).toBe(
        `+rcon_password ${row.rconPassword} +host_workshop_collection 123456 +sv_password geheim`,
      );
      // A blank would add another start argument.
      const sneaky = await t.app.inject({
        method: 'PUT',
        url: `/api/servers/${row.id}/game-settings`,
        headers: authHeaders(s),
        payload: { values: { password: 'a +exec evil' } },
      });
      expect(sneaky.statusCode).toBe(400);
    } finally {
      await t.cleanup();
    }
  });
});

describe('Satisfactory ports', () => {
  test('UDP and TCP on the game port, messaging on its own free port', async () => {
    const t = await createTestApp();
    const s = await setupAdmin(t);
    try {
      const create = async (port: number): Promise<string> => {
        const payload = order('satisfactory', { port, startNow: false });
        const res = await t.app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: authHeaders(s),
          payload,
        });
        expect(res.statusCode).toBe(200);
        return res.json<ServerSummary>().id;
      };
      await create(7777);
      // The same game port is taken (UDP and TCP); the second server gets 7778 and the next messaging port.
      const second = await create(7778);
      const spec = buildContainerSpec(t.ctx.config, t.servers.rowWithSecrets(second), 'Europe/Berlin');
      expect(spec.ports).toEqual([
        { containerPort: 7778, hostPort: 7778, protocol: 'udp' },
        { containerPort: 7778, hostPort: 7778, protocol: 'tcp' },
        { containerPort: 8889, hostPort: 8889, protocol: 'tcp' },
      ]);
      expect(spec.env).toMatchObject({
        SERVERGAMEPORT: '7778',
        SERVERMESSAGINGPORT: '8889',
        MAXPLAYERS: '4',
      });
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload: order('satisfactory', { port: 7778, startNow: false }),
      });
      // 7778 is taken now: the third server moves on to the next port free on both UDP and TCP.
      expect(res.statusCode).toBe(200);
      expect(res.json<ServerSummary>().port).toBe(7779);
    } finally {
      await t.cleanup();
    }
  });
});

describe('Euro Truck Simulator 2', () => {
  test('needs the exported server packages and gets its config written', async () => {
    const t = await createTestApp();
    const s = await setupAdmin(t);
    try {
      const payload = order('ets2', {
        port: 27020,
        startNow: false,
        gameSettings: { lobbyName: 'Morni Trucker', password: 'geheim', maxPlayers: '6' },
      });
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload,
      });
      const id = res.json<ServerSummary>().id;
      const start = (): Promise<{ statusCode: number; json: () => unknown }> =>
        t.app.inject({ method: 'POST', url: `/api/servers/${id}/actions/start`, headers: authHeaders(s) });
      const refused = await start();
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: 'game_files_missing' });

      const home = path.join(t.dataDir, 'servers', id, '.local/share/Euro Truck Simulator 2');
      fs.mkdirSync(home, { recursive: true });
      ['server_packages.sii', 'server_packages.dat'].forEach((f) =>
        fs.writeFileSync(path.join(home, f), 'x'),
      );
      expect((await start()).statusCode).toBeLessThan(300);
      await waitFor(async () => t.servers.live(id).state === 'running');

      const config = fs.readFileSync(path.join(home, 'server_config.sii'), 'utf8');
      expect(config).toContain(' lobby_name: "Morni Trucker"');
      expect(config).toContain(' password: "geheim"');
      expect(config).toContain(' max_players: 6');
      expect(config).toContain(' connection_dedicated_port: 27020');
      expect(config).toContain(' query_dedicated_port: 27016');
      expect(config).toContain(' connection_virtual_port: 100');
      const spec = buildContainerSpec(t.ctx.config, t.servers.rowWithSecrets(id), 'Europe/Berlin');
      expect(spec.ports).toEqual([
        { containerPort: 27020, hostPort: 27020, protocol: 'udp' },
        { containerPort: 27016, hostPort: 27016, protocol: 'udp' },
      ]);
    } finally {
      await t.cleanup();
    }
  });
});

describe('Hytale container', () => {
  test('own image, Java memory and room beyond the heap', async () => {
    const t = await createTestApp();
    const s = await setupAdmin(t);
    try {
      const payload = order('hytale', { startNow: false, memoryMb: 6144 });
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload,
      });
      const row = t.servers.rowWithSecrets(res.json<ServerSummary>().id);
      const spec = buildContainerSpec(t.ctx.config, row, 'Europe/Berlin');
      expect(spec.image).toBe('ghcr.io/pmornhart/mornihosting-hytale:latest');
      expect(spec.env).toMatchObject({ MEMORY: '6144M', HYTALE_PORT: '5520', HYTALE_UPDATE: 'false' });
      expect(spec.memoryLimitBytes).toBeGreaterThan(6144 * 1024 * 1024);
      expect(commandChannelFor(row)).toEqual({ kind: 'stdin' });
    } finally {
      await t.cleanup();
    }
  });
});
