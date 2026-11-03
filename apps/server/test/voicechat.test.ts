/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ConnectionInfo,
  InstalledContent,
  ServerDetail,
  ServerSummary,
  VoiceChatResult,
} from '@mornihosting/shared';
import { authHeaders, createTestApp, setupAdmin, waitFor, type Session, type TestApp } from './helpers.js';

const JARS: Readonly<Record<string, Buffer>> = {
  '9eGKb6K1': Buffer.from('PK voicechat plugin'),
  wKkoqHrH: Buffer.from('PK geyser plugin'),
  floodgate: Buffer.from('PK floodgate plugin'),
  P1OZGk5p: Buffer.from('PK viaversion'),
  NpvuJQoq: Buffer.from('PK viabackwards'),
};
const FILES: Readonly<Record<string, string>> = {
  '9eGKb6K1': 'voicechat-bukkit-2.6.26.jar',
  wKkoqHrH: 'Geyser-Spigot.jar',
  P1OZGk5p: 'ViaVersion-5.5.1.jar',
  NpvuJQoq: 'ViaBackwards-5.5.1.jar',
};
const hash = (algorithm: string, id: string): string =>
  crypto
    .createHash(algorithm)
    .update(JARS[id] ?? '')
    .digest('hex');

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Just enough of Modrinth and GeyserMC's download API for the one-click features. */
const fakeUpstreams = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(urlOf(input));
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'cdn.modrinth.com') return new Response(JARS[parts[0] ?? ''] ?? '');
  if (url.hostname === 'download.geysermc.org') {
    if (parts.includes('downloads')) return new Response(JARS['floodgate']);
    return Response.json({
      version: '2.2.5',
      build: 120,
      time: '2026-10-01T00:00:00Z',
      downloads: { spigot: { name: 'floodgate-spigot.jar', sha256: hash('sha256', 'floodgate') } },
    });
  }
  const id = parts[2] ?? '';
  if (!FILES[id]) return new Response('not found', { status: 404 });
  if (parts[3] === 'version') {
    return Response.json([
      {
        id: `v-${id}`,
        project_id: id,
        name: '2.6.26',
        version_number: '2.6.26',
        game_versions: ['1.21.4'],
        loaders: ['paper', 'bukkit'],
        date_published: '2026-10-01T00:00:00Z',
        version_type: 'release',
        files: [
          {
            url: `https://cdn.modrinth.com/${id}/${FILES[id]}`,
            filename: FILES[id],
            primary: true,
            hashes: { sha512: hash('sha512', id) },
          },
        ],
        dependencies: [],
      },
    ]);
  }
  return Response.json({ id, slug: id, title: id, icon_url: null, project_type: 'mod' });
});

describe('Simple Voice Chat and public ports', () => {
  let t: TestApp;
  let s: Session;
  const call = (method: 'GET' | 'PUT' | 'PATCH' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(s) });
  const create = async (body: object): Promise<ServerSummary> =>
    (
      await call('POST', '/api/servers', {
        edition: 'java',
        software: 'paper',
        version: '1.21.4',
        memoryMb: 2048,
        port: 25565,
        eula: true,
        startNow: false,
        name: 'Survival',
        ...body,
      })
    ).json<ServerSummary>();
  const configOf = (id: string): string =>
    fs.readFileSync(
      path.join(t.dataDir, 'servers', id, 'plugins/voicechat/voicechat-server.properties'),
      'utf8',
    );
  const detail = async (id: string) => (await call('GET', `/api/servers/${id}`)).json<ServerDetail>();

  beforeEach(async () => {
    vi.stubGlobal('fetch', fakeUpstreams);
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.cleanup();
  });

  test('ordering with Geyser and voice chat sets both up before the first start', async () => {
    const server = await create({ startNow: true, addOns: { geyser: true, voice: true, backups: true } });
    await waitFor(async () => (await detail(server.id)).live.state === 'running');
    const ready = await detail(server.id);
    expect(ready).toMatchObject({ geyser: true, geyserPort: 19132, voiceChat: true, voicePort: 24454 });
    const content = (await call('GET', `/api/servers/${server.id}/content`)).json<InstalledContent[]>();
    expect(content.map((c) => c.fileName).toSorted()).toEqual(
      expect.arrayContaining([
        'Geyser-Spigot.jar',
        'floodgate-spigot.jar',
        'voicechat-bukkit-2.6.26.jar',
        'ViaVersion-5.5.1.jar',
        'ViaBackwards-5.5.1.jar',
      ]),
    );
    const schedules = (await call('GET', `/api/servers/${server.id}/schedules`)).json<{ action: string }[]>();
    expect(schedules.map((x) => x.action)).toEqual(['backup']);
  });

  test('one switch installs the plugin, opens a UDP port and writes the settings', async () => {
    const server = await create({});
    const res = await call('PUT', `/api/servers/${server.id}/voicechat`, { enabled: true });
    expect(res.json<VoiceChatResult>()).toEqual({
      enabled: true,
      port: 24454,
      voiceHost: '24454',
      restartRequired: false,
    });
    const content = (await call('GET', `/api/servers/${server.id}/content`)).json<InstalledContent[]>();
    expect(content.map((c) => c.fileName)).toContain('voicechat-bukkit-2.6.26.jar');
    expect(configOf(server.id)).toContain('port=24454');
    expect(configOf(server.id)).toContain('voice_host=24454');
    expect(await detail(server.id)).toMatchObject({ voiceChat: true, voicePort: 24454, voiceHost: '24454' });

    const second = await create({ name: 'Creative', port: 25566 });
    const other = await call('PUT', `/api/servers/${second.id}/voicechat`, { enabled: true });
    expect(other.json<VoiceChatResult>().port).toBe(24455);
  });

  test('with a domain and a tunnel port the mods are told where to connect', async () => {
    const server = await create({});
    const dir = path.join(t.dataDir, 'servers', server.id, 'plugins/voicechat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'voicechat-server.properties'), 'max_voice_distance=64\nport=1234\n');
    await call('PUT', '/api/settings', { publicAddress: 'mc.example.de' });
    const res = await call('PUT', `/api/servers/${server.id}/voicechat`, {
      enabled: true,
      publicPort: 31337,
    });
    expect(res.json<VoiceChatResult>().voiceHost).toBe('mc.example.de:31337');
    expect(configOf(server.id)).toBe('max_voice_distance=64\nport=24454\nvoice_host=mc.example.de\\:31337\n');
  });

  test('the address is written again before every start', async () => {
    const server = await create({});
    await call('PUT', `/api/servers/${server.id}/voicechat`, { enabled: true });
    await call('PUT', '/api/settings', { publicAddress: 'play.example.de' });
    await call('POST', `/api/servers/${server.id}/actions/start`);
    await waitFor(() => configOf(server.id).includes('play.example.de'));
    expect(configOf(server.id)).toContain('voice_host=play.example.de\\:24454');
  });

  test('switching off disables the plugin and closes the port; Geyser keeps its own', async () => {
    const server = await create({});
    await call('PUT', `/api/servers/${server.id}/geyser`, { enabled: true });
    await call('PUT', `/api/servers/${server.id}/voicechat`, { enabled: true });
    expect(await detail(server.id)).toMatchObject({ geyserPort: 19132, voicePort: 24454 });
    const off = await call('PUT', `/api/servers/${server.id}/voicechat`, { enabled: false });
    expect(off.json<VoiceChatResult>()).toMatchObject({ enabled: false, port: null });
    const content = (await call('GET', `/api/servers/${server.id}/content`)).json<InstalledContent[]>();
    expect(content.find((c) => c.fileName.startsWith('voicechat-'))?.enabled).toBe(false);
    expect(await detail(server.id)).toMatchObject({ voiceChat: false, voicePort: null, geyserPort: 19132 });
    expect(content.map((c) => c.fileName)).toEqual(
      expect.arrayContaining(['Geyser-Spigot.jar', 'floodgate-spigot.jar']),
    );
  });

  test('voice chat is only offered where it can run', async () => {
    const bedrock = await create({ edition: 'bedrock', software: 'bedrock', version: 'latest', port: 19133 });
    const vanilla = await create({ software: 'vanilla', port: 25567 });
    expect(
      (await call('PUT', `/api/servers/${bedrock.id}/voicechat`, { enabled: true })).json(),
    ).toMatchObject({
      error: 'voicechat_java_only',
    });
    expect(
      (await call('PUT', `/api/servers/${vanilla.id}/voicechat`, { enabled: true })).json(),
    ).toMatchObject({
      error: 'voicechat_unsupported',
    });
  });

  test('a public port is shown with the domain, at home the server port stays', async () => {
    const server = await create({});
    await call('PATCH', `/api/servers/${server.id}`, { publicPort: 31000 });
    expect((await detail(server.id)).address).toBe('localhost');
    await call('PUT', '/api/settings', { publicAddress: 'mc.example.de' });
    expect(await detail(server.id)).toMatchObject({ address: 'mc.example.de:31000', publicPort: 31000 });
    const connection = (await call('GET', `/api/servers/${server.id}/connection`)).json<ConnectionInfo>();
    expect(connection).toMatchObject({ port: 25565, sharePort: 31000 });
    await call('PATCH', `/api/servers/${server.id}`, { publicPort: null });
    expect((await detail(server.id)).address).toBe('mc.example.de');
  });
});
