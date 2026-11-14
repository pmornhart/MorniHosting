/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NetworkView, ServerSummary } from '@mornihosting/shared';
import type { ContainerSpec, DockerDriver } from '../src/docker/driver.js';
import { createFakeDriver, FAKE_STEP_MS_FAST } from '../src/docker/fake-driver.js';
import { paperGlobalYaml, patchToml, velocityToml } from '../src/networks/config-files.js';
import {
  authHeaders,
  createTestApp,
  login,
  setupAdmin,
  waitFor,
  type Session,
  type TestApp,
} from './helpers.js';

const VELOCITY_DEFAULT = `# Config version. Do not change this
config-version = "2.7"

# What port should the proxy be bound to? By default, we'll bind to all addresses on port 25565.
bind = "0.0.0.0:25565"
online-mode = true
player-info-forwarding-mode = "NONE"
forwarding-secret-file = "forwarding.secret"

[servers]
# Configure your servers here.
lobby = "127.0.0.1:30066"
factions = "127.0.0.1:30067"
try = [
    "lobby"
]

[forced-hosts]
"lobby.example.com" = [
    "lobby"
]

[advanced]
compression-threshold = 256
`;

const PAPER_GLOBAL_DEFAULT = `_version: 31
proxies:
  bungee-cord:
    online-mode: true
  proxy-protocol: false
  velocity:
    enabled: false
    online-mode: true
    secret: ''
scoreboards:
  save-empty-scoreboard-teams: true
`;

describe('network config files', () => {
  test('velocity.toml: forwarding, server list and landing server set, the rest (and comments) kept', () => {
    const out = velocityToml(VELOCITY_DEFAULT, {
      port: 25577,
      onlineMode: true,
      servers: [
        { name: 'lobby', address: 'mh-a:25565' },
        { name: 'duels', address: 'mh-b:25565' },
      ],
      tryOrder: ['lobby', 'duels'],
    });
    expect(out).toContain('bind = "0.0.0.0:25577"');
    expect(out).toContain('player-info-forwarding-mode = "MODERN"');
    expect(out).toContain('# What port should the proxy be bound to?');
    expect(out).toContain('lobby = "mh-a:25565"\nduels = "mh-b:25565"\ntry = ["lobby", "duels"]');
    expect(out).not.toContain('factions');
    expect(out).not.toContain('lobby.example.com');
    expect(out).toContain('[advanced]\ncompression-threshold = 256');
    // Running it twice changes nothing.
    expect(
      velocityToml(out, {
        port: 25577,
        onlineMode: true,
        servers: [
          { name: 'lobby', address: 'mh-a:25565' },
          { name: 'duels', address: 'mh-b:25565' },
        ],
        tryOrder: ['lobby', 'duels'],
      }),
    ).toBe(out);
  });

  test('velocity.toml from nothing has everything Velocity needs to start', () => {
    const out = velocityToml(null, { port: 25577, onlineMode: false, servers: [], tryOrder: [] });
    expect(out).toContain('config-version = "2.7"');
    expect(out).toContain('online-mode = false');
    expect(out).toContain('[servers]\ntry = []');
  });

  test('patchToml quotes keys that need it and adds missing ones', () => {
    const out = patchToml('a = 1\n', { b: 'x"y' }, { 'forced-hosts': { 'play.example.com': ['lobby'] } });
    expect(out).toBe('a = 1\nb = "x\\"y"\n[forced-hosts]\n"play.example.com" = ["lobby"]\n');
  });

  test('paper-global.yml: only proxies.velocity changes', () => {
    const out = paperGlobalYaml(PAPER_GLOBAL_DEFAULT, 'geheim123', true);
    expect(out).toContain("velocity:\n    enabled: true\n    online-mode: true\n    secret: 'geheim123'");
    expect(out).toContain('bungee-cord:\n    online-mode: true');
    expect(out).toContain('save-empty-scoreboard-teams: true');
    expect(paperGlobalYaml(null, 's', false)).toBe(
      'proxies:\n  velocity:\n    enabled: true\n    online-mode: false\n    secret: s\n',
    );
  });
});

describe('networks', () => {
  let t: TestApp;
  let s: Session;
  const specs = new Map<string, ContainerSpec>();
  const call = (method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(s) });
  const create = async (body: object): Promise<ServerSummary> =>
    (
      await call('POST', '/api/servers', {
        edition: 'java',
        software: 'paper',
        version: '26.3',
        memoryMb: 2048,
        port: 25565,
        eula: true,
        startNow: false,
        ...body,
      })
    ).json<ServerSummary>();
  const file = (id: string, rel: string): string =>
    fs.readFileSync(path.join(t.dataDir, 'servers', id, rel), 'utf8');
  const state = async (id: string): Promise<string> =>
    (await call('GET', `/api/servers/${id}`)).json<ServerSummary>().live.state;
  const startAndWait = async (id: string): Promise<void> => {
    await call('POST', `/api/servers/${id}/actions/start`);
    await waitFor(async () => (await state(id)) === 'running');
  };

  beforeEach(async () => {
    specs.clear();
    const fake = createFakeDriver({ stepMs: FAKE_STEP_MS_FAST, simulatePlayers: false });
    const docker: DockerDriver = {
      ...fake,
      createContainer: async (spec) => {
        specs.set(spec.labels['mornihosting.server'] ?? '', spec);
        return fake.createContainer(spec);
      },
    };
    t = await createTestApp({}, { docker });
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.cleanup();
  });

  test('voice chat on the proxy: plugin, its own port for the players, UDP next to TCP', async () => {
    const jar = Buffer.from('PK voicechat velocity');
    const sha512 = (await import('node:crypto')).createHash('sha512').update(jar).digest('hex');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.hostname === 'cdn.modrinth.com') return new Response(jar);
        if (url.pathname.endsWith('/version'))
          return Response.json([
            {
              id: 'v1',
              project_id: '9eGKb6K1',
              name: 'velocity-2.6.26',
              version_number: 'velocity-2.6.26',
              game_versions: ['26.3'],
              loaders: ['velocity'],
              date_published: '2026-10-24T00:00:00Z',
              version_type: 'release',
              files: [
                {
                  url: 'https://cdn.modrinth.com/9eGKb6K1/voicechat-velocity-2.6.26.jar',
                  filename: 'voicechat-velocity-2.6.26.jar',
                  primary: true,
                  hashes: { sha512 },
                },
              ],
              dependencies: [],
            },
          ]);
        return Response.json({
          id: '9eGKb6K1',
          slug: 'simple-voice-chat',
          title: 'Simple Voice Chat',
          icon_url: null,
          project_type: 'plugin',
        });
      }),
    );
    const proxy = await create({
      name: 'Proxy',
      software: 'velocity',
      version: '3.4.0',
      memoryMb: 1024,
      port: 25565,
    });
    const res = await call('PUT', `/api/servers/${proxy.id}/voicechat`, { enabled: true });
    expect(res.json()).toMatchObject({ enabled: true, port: 25565 });
    expect(file(proxy.id, 'plugins/voicechat/voicechat-proxy.properties')).toMatch(
      /port=-1[\s\S]*voice_host=25565/,
    );
    expect(
      fs.existsSync(path.join(t.dataDir, 'servers', proxy.id, 'plugins/voicechat-velocity-2.6.26.jar')),
    ).toBe(true);
    await startAndWait(proxy.id);
    expect(specs.get(proxy.id)?.ports.map((p) => `${p.containerPort}/${p.protocol}->${p.hostPort}`)).toEqual([
      '25577/tcp->25565',
      '25577/udp->25565',
    ]);
  });

  test('a proxy and two servers are wired up: forwarding, server list, no ports for the servers behind it', async () => {
    const proxy = await create({
      name: 'Proxy',
      software: 'velocity',
      version: '3.4.0',
      memoryMb: 1024,
      port: 25565,
    });
    const lobby = await create({ name: 'Lobby', port: 25570 });
    const duels = await create({ name: 'Duels', port: 25571 });
    const created = await call('POST', '/api/networks', { name: 'MoinMorni', proxyServerId: proxy.id });
    expect(created.statusCode).toBe(200);
    const net = created.json<NetworkView>();
    await call('POST', `/api/networks/${net.id}/members`, { serverId: lobby.id, name: 'lobby' });
    const withBoth = (
      await call('POST', `/api/networks/${net.id}/members`, { serverId: duels.id, name: 'duels' })
    ).json<NetworkView>();
    expect(withBoth.members.map((m) => [m.name, m.isDefault])).toEqual([
      ['lobby', true],
      ['duels', false],
    ]);

    await startAndWait(lobby.id);
    expect(file(lobby.id, 'config/paper-global.yml')).toContain('enabled: true');
    expect(file(lobby.id, 'server.properties')).toContain('online-mode=false');
    expect(specs.get(lobby.id)?.ports).toEqual([]);

    await startAndWait(proxy.id);
    const toml = file(proxy.id, 'velocity.toml');
    expect(toml).toContain(`lobby = "mh-${lobby.id}:25565"`);
    expect(toml).toContain(`duels = "mh-${duels.id}:25565"`);
    expect(toml).toContain('try = ["lobby", "duels"]');
    expect(toml).toContain('player-info-forwarding-mode = "MODERN"');
    expect(toml).toContain('bind = "0.0.0.0:25577"');
    const secret = file(proxy.id, 'forwarding.secret');
    expect(secret.length).toBeGreaterThan(20);
    expect(file(lobby.id, 'config/paper-global.yml')).toContain(`secret: ${secret}`);
    // Velocity's files are on the host now (itzg/mc-proxy works in /server).
    expect(specs.get(proxy.id)?.mounts).toEqual([{ subdir: '', path: '/server' }]);
    expect(specs.get(proxy.id)?.ports.map((p) => p.hostPort)).toEqual([25565]);

    const info = (await call('GET', `/api/servers/${lobby.id}/network`)).json<{
      network: { role: string; memberName: string };
    }>();
    expect(info.network).toMatchObject({ role: 'member', memberName: 'lobby' });
  });

  test('landing server, leaving the network, deleting the proxy', async () => {
    const proxy = await create({
      name: 'Proxy',
      software: 'velocity',
      version: '3.4.0',
      memoryMb: 1024,
      port: 25565,
    });
    const lobby = await create({ name: 'Lobby', port: 25570 });
    const duels = await create({ name: 'Duels', port: 25571 });
    const net = (
      await call('POST', '/api/networks', { name: 'Netz', proxyServerId: proxy.id })
    ).json<NetworkView>();
    await call('POST', `/api/networks/${net.id}/members`, { serverId: lobby.id, name: 'lobby' });
    await call('POST', `/api/networks/${net.id}/members`, { serverId: duels.id, name: 'duels' });
    const changed = (
      await call('PATCH', `/api/networks/${net.id}`, { defaultMember: 'duels' })
    ).json<NetworkView>();
    expect(changed.defaultMember).toBe('duels');
    expect(file(proxy.id, 'velocity.toml')).toContain('try = ["duels", "lobby"]');

    await startAndWait(lobby.id);
    const left = (await call('DELETE', `/api/networks/${net.id}/members/${lobby.id}`)).json<NetworkView>();
    expect(left.members.map((m) => m.name)).toEqual(['duels']);
    expect(file(lobby.id, 'server.properties')).toContain('online-mode=true');
    expect(file(lobby.id, 'config/paper-global.yml')).toContain('enabled: false');
    expect(file(proxy.id, 'velocity.toml')).not.toContain('lobby =');

    expect(
      (await call('POST', `/api/networks/${net.id}/members`, { serverId: duels.id, name: 'zwei' })).json(),
    ).toMatchObject({ error: 'network_server_taken' });
    expect(
      (await call('POST', `/api/networks/${net.id}/members`, { serverId: proxy.id, name: 'proxy' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('POST', `/api/networks/${net.id}/members`, { serverId: lobby.id, name: 'Lobby!' }))
        .statusCode,
    ).toBe(400);

    await call('DELETE', `/api/servers/${proxy.id}`, { deleteFiles: true });
    await waitFor(async () => (await call('GET', '/api/networks')).json<NetworkView[]>().length === 0);
    expect(file(duels.id, 'server.properties')).toContain('online-mode=true');
  });

  test('only admins manage networks; a proxy must be Velocity', async () => {
    const paper = await create({ name: 'Paper', port: 25570 });
    expect(
      (await call('POST', '/api/networks', { name: 'X', proxyServerId: paper.id })).json(),
    ).toMatchObject({ error: 'network_proxy_not_velocity' });
    await call('POST', '/api/users', { username: 'gast', password: 'gast-passwort-123', isAdmin: false });
    const guest = await login(t, 'gast', 'gast-passwort-123');
    const res = await t.app.inject({ method: 'GET', url: '/api/networks', headers: authHeaders(guest) });
    expect(res.statusCode).toBe(403);
  });
});
