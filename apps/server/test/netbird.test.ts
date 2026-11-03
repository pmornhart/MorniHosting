/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  NetbirdDiscovery,
  NetbirdServerInfo,
  NetbirdStatus,
  ServerDetail,
  ServerSummary,
} from '@mornihosting/shared';
import { loadConfig } from '../src/config.js';
import { netbirdServices, settings } from '../src/db/schema.js';
import {
  authHeaders,
  createTestApp,
  login,
  setupAdmin,
  waitFor,
  type Session,
  type TestApp,
} from './helpers.js';

const TOKEN = 'nbp_test_token_1234';
/** A key from another (self-hosted) NetBird server. */
const OTHER_SERVER_TOKEN = 'nbp_from_my_own_netbird';
const PEER = {
  id: 'peer-mh',
  name: 'mornihosting',
  ip: '100.92.14.7',
  connected: true,
  hostname: 'mornihosting',
};
const BASE = 'moinmornhart.de';
/** A self-hosted NetBird that the panel's machine is connected to. */
const OWN_NETBIRD = 'netbird.moinmornhart.de';

interface FakeService {
  id: string;
  domain: string;
  mode: string;
  listen_port: number;
  pass_host_header: boolean;
  targets: { target_id: string; target_type: string; protocol: string; port: number; host?: string }[];
}

interface FakeResource {
  id: string;
  name: string;
  address: string;
  groups: string[];
}

/**
 * A tiny NetBird management API: domains, peers and reverse-proxy services. Like NetBird Cloud it hands out
 * ports from 31000 up; with `customPorts` (a self-hosted proxy) it listens where it is asked to.
 */
function createFakeNetbird(options: { customPorts?: boolean; delayMs?: number } = {}) {
  const services = new Map<string, FakeService>();
  const networks: { id: string; name: string }[] = [];
  const groups: { id: string; name: string }[] = [];
  const routers: { network: string; peer: string }[] = [];
  const resources = new Map<string, FakeResource>();
  const calls: { method: string; host: string; path: string; auth: string | null }[] = [];
  const next = { port: 31000, id: 1 };
  const handle = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    // Like the real API, answers take a moment, so calls running side by side really overlap.
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ method, host: url.host, path: url.pathname, auth });
    // Real NetBird: a key with a valid checksum that it does not know is a 404 naming the key's hash.
    if (auth === `Token ${OTHER_SERVER_TOKEN}`)
      return Response.json(
        { message: 'invalid token: pat: aq4ynzhuukow+vnasy= not found', code: 404 },
        { status: 404 },
      );
    if (auth !== `Token ${TOKEN}`) return Response.json({ message: 'token invalid' }, { status: 401 });
    const body = init?.body ? (JSON.parse(String(init.body)) as Omit<FakeService, 'id'>) : null;
    const id = url.pathname.split('/')[4] ?? '';
    if (url.pathname === '/api/peers')
      return Response.json([PEER, { ...PEER, id: 'peer-laptop', name: 'laptop' }]);
    if (url.pathname === '/api/reverse-proxies/domains') {
      return Response.json([
        {
          id: 'd1',
          domain: BASE,
          validated: true,
          type: 'custom',
          supports_custom_ports: options.customPorts,
        },
        { id: 'd2', domain: 'abc.netbird.app', validated: true, type: 'free' },
      ]);
    }
    // Networks, groups, routing peers and resources: /api/networks/<net>/(routers|resources)/<id>
    const net = url.pathname.split('/');
    if (url.pathname === '/api/groups' && method === 'GET') return Response.json(groups);
    if (url.pathname === '/api/groups' && method === 'POST') {
      const group = { id: `grp-${next.id++}`, name: String((body as { name?: string } | null)?.name) };
      groups.push(group);
      return Response.json(group);
    }
    if (url.pathname === '/api/networks' && method === 'GET') return Response.json(networks);
    if (url.pathname === '/api/networks' && method === 'POST') {
      const network = { id: `net-${next.id++}`, name: String((body as { name?: string } | null)?.name) };
      networks.push(network);
      return Response.json(network);
    }
    if (net[2] === 'networks' && net[4] === 'routers') {
      if (method === 'POST') {
        const peer = String((body as { peer?: string } | null)?.peer);
        routers.push({ network: net[3] ?? '', peer });
        return Response.json({ id: `rt-${next.id++}`, peer });
      }
      return Response.json(
        routers.filter((r) => r.network === net[3]).map((r) => ({ id: 'rt', peer: r.peer })),
      );
    }
    if (net[2] === 'networks' && net[4] === 'resources') {
      const resourceBody = body as unknown as Omit<FakeResource, 'id'> | null;
      const resourceId = net[5] ?? '';
      if (method === 'GET') return Response.json([...resources.values()]);
      if (method === 'POST' && resourceBody) {
        const created = { ...resourceBody, id: `res-${next.id++}` };
        resources.set(created.id, created);
        return Response.json(created);
      }
      if (method === 'PUT' && resourceBody && resources.has(resourceId)) {
        resources.set(resourceId, { ...resourceBody, id: resourceId });
        return Response.json({ ...resourceBody, id: resourceId });
      }
      if (method === 'DELETE')
        return new Response(null, { status: resources.delete(resourceId) ? 200 : 404 });
    }
    if (url.pathname === '/api/reverse-proxies/services' && method === 'GET')
      return Response.json([...services.values()]);
    // Like NetBird: a service may only point at a resource that exists.
    const missing = (body?.targets ?? []).find(
      (target) => target.target_type === 'host' && !resources.has(String(target.target_id)),
    );
    if (missing && (method === 'POST' || method === 'PUT'))
      return Response.json(
        { message: `resource target "${String(missing.target_id)}" not found in account`, code: 422 },
        { status: 422 },
      );
    if (method === 'POST' && body) {
      if ([...services.values()].some((s) => s.domain === body.domain))
        return Response.json({ message: 'domain already in use' }, { status: 409 });
      const created = {
        ...body,
        id: `svc-${next.id++}`,
        listen_port: body.mode === 'http' ? 0 : (options.customPorts && body.listen_port) || next.port++,
      };
      services.set(created.id, created);
      return Response.json(created);
    }
    if (method === 'PUT' && body && services.has(id)) {
      const updated = { ...body, id, listen_port: body.listen_port || (services.get(id)?.listen_port ?? 0) };
      services.set(id, updated);
      return Response.json(updated);
    }
    if (method === 'DELETE') {
      const known = services.delete(id);
      return new Response(null, { status: known ? 200 : 404 });
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  };
  return {
    services,
    networks,
    groups,
    routers,
    resources,
    calls,
    handle,
    byDomain: (domain: string) => [...services.values()].find((s) => s.domain === domain),
  };
}

// Modrinth and GeyserMC, just enough for the voice chat and Geyser switches.
const JARS: Readonly<Record<string, Buffer>> = {
  '9eGKb6K1': Buffer.from('PK voicechat plugin'),
  wKkoqHrH: Buffer.from('PK geyser plugin'),
  floodgate: Buffer.from('PK floodgate plugin'),
};
const FILES: Readonly<Record<string, string>> = {
  '9eGKb6K1': 'voicechat-bukkit-2.6.26.jar',
  wKkoqHrH: 'Geyser-Spigot.jar',
};
const hash = (algorithm: string, id: string): string =>
  crypto
    .createHash(algorithm)
    .update(JARS[id] ?? '')
    .digest('hex');

function fakePluginSites(url: URL): Response {
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
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('NetBird automation', () => {
  let t: TestApp;
  let s: Session;
  let netbird: ReturnType<typeof createFakeNetbird>;
  const call = (
    method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
    session = s,
  ) => t.app.inject({ method, url, payload, headers: authHeaders(session) });
  const configure = () =>
    call('PUT', '/api/netbird', {
      apiUrl: 'https://api.netbird.io',
      token: TOKEN,
      domain: BASE,
      peerId: 'peer-mh',
    });
  const create = async (body: object = {}): Promise<ServerSummary> =>
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
  const detail = async (id: string) => (await call('GET', `/api/servers/${id}`)).json<ServerDetail>();

  beforeEach(async () => {
    netbird = createFakeNetbird();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(urlOf(input));
      const isNetbird = ['api.netbird.io', OWN_NETBIRD].includes(url.hostname);
      return isNetbird ? netbird.handle(url, init) : fakePluginSites(url);
    });
    t = await createTestApp();
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.cleanup();
  });

  test('set up once: domains and machines are offered, the token never leaves the server', async () => {
    const wrong = await call('POST', '/api/netbird/discover', { token: 'nbp_wrong' });
    expect(wrong.json()).toMatchObject({ error: 'netbird_unauthorized' });
    const elsewhereMade = await call('POST', '/api/netbird/discover', { token: OTHER_SERVER_TOKEN });
    expect(elsewhereMade.json()).toMatchObject({
      error: 'netbird_token_unknown',
      params: { host: 'api.netbird.io' },
    });
    const found = (await call('POST', '/api/netbird/discover', { token: TOKEN })).json<NetbirdDiscovery>();
    expect(found.domains.map((d) => d.domain)).toEqual([BASE, 'abc.netbird.app']);
    expect(found.suggestedPeerId).toBe('peer-mh');

    const unknown = await call('PUT', '/api/netbird', {
      apiUrl: 'https://api.netbird.io',
      token: TOKEN,
      domain: 'fremd.de',
      peerId: 'peer-mh',
    });
    expect(unknown.json()).toMatchObject({ error: 'netbird_domain_unknown' });
    const status = (await configure()).json<NetbirdStatus>();
    expect(status).toMatchObject({ configured: true, domain: BASE, peerName: 'mornihosting' });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(t.ctx.db.select().from(settings).all())).not.toContain(TOKEN);
    expect(
      netbird.calls.every((c) =>
        [TOKEN, 'nbp_wrong', OTHER_SERVER_TOKEN].some((token) => c.auth === `Token ${token}`),
      ),
    ).toBe(true);
    // The stored token is never sent to another address: changing it needs the token again.
    const elsewhere = await call('POST', '/api/netbird/discover', { apiUrl: 'https://evil.example' });
    expect(elsewhere.json()).toMatchObject({ error: 'netbird_token_missing' });
    const moved = await call('PUT', '/api/netbird', {
      apiUrl: 'https://evil.example',
      domain: BASE,
      peerId: 'peer-mh',
    });
    expect(moved.json()).toMatchObject({ error: 'netbird_token_missing' });
    expect((await call('POST', '/api/netbird/discover', {})).json<NetbirdDiscovery>().peers).toHaveLength(2);
  });

  test('the NetBird server this machine is connected to is the default address', async () => {
    const own = await createTestApp({ MH_NETBIRD_API: `https://${OWN_NETBIRD}` });
    try {
      const admin = await setupAdmin(own);
      const ownCall = (method: 'GET' | 'POST', url: string, payload?: object) =>
        own.app.inject({ method, url, payload, headers: authHeaders(admin) });
      expect((await ownCall('GET', '/api/netbird')).json<NetbirdStatus>().apiUrl).toBe(
        `https://${OWN_NETBIRD}`,
      );
      const found = await ownCall('POST', '/api/netbird/discover', { token: TOKEN });
      expect(found.json<NetbirdDiscovery>().suggestedPeerId).toBe('peer-mh');
      expect(netbird.calls.map((c) => c.host)).toEqual([OWN_NETBIRD, OWN_NETBIRD]);
    } finally {
      await own.cleanup();
    }
    // Anything but an HTTPS address is ignored and NetBird Cloud stays the default.
    const plain = loadConfig({ MH_SECRET: 'x'.repeat(40), MH_NETBIRD_API: 'http://10.0.0.5' }, '0.0.0-test');
    expect(plain.netbirdApi).toBe('https://api.netbird.io');
  });

  test('a self-hosted proxy with its own ports gets the server port; older random ports move over', async () => {
    netbird = createFakeNetbird({ customPorts: true });
    await configure();
    const server = await create({ netbirdName: 'reich' });
    expect(netbird.byDomain(`reich.${BASE}`)).toMatchObject({ mode: 'tcp', listen_port: 25565 });
    expect((await detail(server.id)).publicPort).toBe(25565);
    const status = (await call('GET', '/api/netbird')).json<NetbirdStatus>();
    expect(status).toMatchObject({
      customPorts: true,
      openPorts: [{ port: 25565, protocol: 'tcp', domain: `reich.${BASE}` }],
    });

    // A setup from before: no port rule stored yet and a random port in NetBird, like reich…:23150.
    const stored = t.ctx.settings.getValue<Record<string, unknown>>('netbird') ?? {};
    t.ctx.settings.setValue('netbird', { ...stored, customPorts: undefined });
    const service = netbird.byDomain(`reich.${BASE}`);
    if (service) service.listen_port = 23150;
    t.ctx.db.update(netbirdServices).set({ listenPort: 23150 }).run();
    await call('PUT', `/api/servers/${server.id}/netbird`, { name: 'reich' });
    expect(netbird.byDomain(`reich.${BASE}`)?.listen_port).toBe(25565);
    expect((await detail(server.id)).publicPort).toBe(25565);
  });

  test('a new server with a name gets its address in NetBird right away', async () => {
    await configure();
    const server = await create({ netbirdName: 'Survival' });
    const main = netbird.byDomain(`survival.${BASE}`);
    expect(main).toMatchObject({ mode: 'tcp', listen_port: 31000, pass_host_header: false });
    expect(main?.targets).toEqual([
      expect.objectContaining({ target_id: 'peer-mh', target_type: 'peer', protocol: 'tcp', port: 25565 }),
    ]);
    const shown = await detail(server.id);
    expect(shown.address).toBe(`survival.${BASE}:31000`);
    expect(shown.netbird).toEqual<NetbirdServerInfo>({
      name: 'survival',
      services: [{ purpose: 'main', domain: `survival.${BASE}`, port: 31000 }],
      error: null,
    });
    const taken = await call('POST', '/api/servers', {
      edition: 'java',
      software: 'paper',
      version: '1.21.4',
      memoryMb: 2048,
      port: 25567,
      eula: true,
      startNow: false,
      name: 'Drei',
      netbirdName: 'survival',
    });
    expect(taken.json()).toMatchObject({ error: 'netbird_name_taken' });
  });

  test('Geyser and voice chat get their own addresses, port changes follow, the outside port stays', async () => {
    await configure();
    const server = await create({ netbirdName: 'survival' });
    await call('PUT', `/api/servers/${server.id}/geyser`, { enabled: true });
    await call('PUT', `/api/servers/${server.id}/voicechat`, { enabled: true });
    await waitFor(async () => (await detail(server.id)).netbird?.services.length === 3);
    expect(netbird.byDomain(`survival-bedrock.${BASE}`)).toMatchObject({
      mode: 'udp',
      targets: [expect.objectContaining({ port: 19132 })],
    });
    expect(netbird.byDomain(`survival-voice.${BASE}`)).toMatchObject({
      mode: 'udp',
      targets: [expect.objectContaining({ port: 24454 })],
    });
    const shown = await detail(server.id);
    expect(shown.geyserPublicPort).toBe(netbird.byDomain(`survival-bedrock.${BASE}`)?.listen_port);
    expect(shown.voiceHost).toBe(
      `survival.${BASE}:${netbird.byDomain(`survival-voice.${BASE}`)?.listen_port}`,
    );

    await call('PATCH', `/api/servers/${server.id}`, { port: 25570 });
    await waitFor(() => netbird.byDomain(`survival.${BASE}`)?.targets[0]?.port === 25570);
    expect(netbird.byDomain(`survival.${BASE}`)?.listen_port).toBe(31000);

    await call('PUT', `/api/servers/${server.id}/voicechat`, { enabled: false });
    await waitFor(() => !netbird.byDomain(`survival-voice.${BASE}`));
    expect((await detail(server.id)).netbird?.services.map((x) => x.purpose).sort()).toEqual([
      'geyser',
      'main',
    ]);
  });

  test('renaming moves the addresses, removing the name or the server cleans up NetBird', async () => {
    await configure();
    const server = await create({ netbirdName: 'survival' });
    const renamed = await call('PUT', `/api/servers/${server.id}/netbird`, { name: 'creative' });
    expect(renamed.json<{ netbird: NetbirdServerInfo }>().netbird.services[0]?.domain).toBe(
      `creative.${BASE}`,
    );
    expect(netbird.byDomain(`survival.${BASE}`)).toBeUndefined();
    expect((await detail(server.id)).address).toBe(`creative.${BASE}:31000`);

    await call('PUT', `/api/servers/${server.id}/netbird`, { name: null });
    expect(netbird.services.size).toBe(0);
    expect(await detail(server.id)).toMatchObject({ domain: null, publicPort: null, netbird: null });

    await call('PUT', `/api/servers/${server.id}/netbird`, { name: 'survival' });
    expect(netbird.services.size).toBe(1);
    await call('DELETE', `/api/servers/${server.id}`, { deleteFiles: true });
    await waitFor(() => netbird.services.size === 0);
  });

  test('the panel gets an HTTPS address with "Pass Host Header"; a hand-made service is taken over', async () => {
    await configure();
    netbird.services.set('svc-hand', {
      id: 'svc-hand',
      domain: `panel.${BASE}`,
      mode: 'http',
      listen_port: 0,
      pass_host_header: false,
      targets: [],
    });
    const status = (
      await call('POST', '/api/netbird/panel', { name: 'panel', port: 8080 })
    ).json<NetbirdStatus>();
    expect(status.panelAddress).toBe(`panel.${BASE}`);
    expect(netbird.services.get('svc-hand')).toMatchObject({
      pass_host_header: true,
      targets: [expect.objectContaining({ target_id: 'peer-mh', protocol: 'http', port: 8080 })],
    });
    const panel = (await call('GET', '/api/settings')).json<{ panelDomain: string }>();
    expect(panel.panelDomain).toBe(`panel.${BASE}`);

    await create({ netbirdName: 'survival' });
    expect((await call('DELETE', '/api/netbird')).statusCode).toBe(200);
    expect([...netbird.services.keys()]).toEqual(['svc-hand']);
    expect((await call('GET', '/api/netbird')).json<NetbirdStatus>().configured).toBe(false);
  });

  test('only admins may use NetBird; a name from another user is ignored', async () => {
    await configure();
    await call('POST', '/api/users', {
      username: 'lena',
      password: 'lena-passwort-1',
      displayName: 'Lena',
      canCreateServers: true,
    });
    const lena = await login(t, 'lena', 'lena-passwort-1');
    expect((await call('GET', '/api/netbird', undefined, lena)).statusCode).toBe(403);
    const hers = (
      await call(
        'POST',
        '/api/servers',
        {
          edition: 'java',
          software: 'paper',
          version: '1.21.4',
          memoryMb: 2048,
          port: 25570,
          eula: true,
          startNow: false,
          name: 'Lenas Welt',
          netbirdName: 'lena',
        },
        lena,
      )
    ).json<ServerSummary>();
    expect(netbird.services.size).toBe(0);
    expect((await call('PUT', `/api/servers/${hers.id}/netbird`, { name: 'lena' }, lena)).statusCode).toBe(
      403,
    );
  });

  test('with a home address every server gets its own network resource, the panel can sit on the domain itself', async () => {
    await t.cleanup();
    netbird = createFakeNetbird({ delayMs: 5 });
    t = await createTestApp({ MH_LAN_IP: '10.13.4.103' });
    s = await setupAdmin(t);
    await configure();
    const server = await create();
    const other = await create({ name: 'Creative', port: 25566 });
    // As after an update of an older setup: no network yet in NetBird.
    netbird.networks.length = 0;
    netbird.groups.length = 0;
    netbird.routers.length = 0;
    // Both at once: the network, its group and the routing peer still exist only once.
    await Promise.all([
      call('PUT', `/api/servers/${server.id}/netbird`, { name: 'survival' }),
      call('PUT', `/api/servers/${other.id}/netbird`, { name: 'creative' }),
    ]);
    await waitFor(() => netbird.byDomain(`survival.${BASE}`) !== undefined);
    await waitFor(() => netbird.byDomain(`creative.${BASE}`) !== undefined);
    expect(netbird.byDomain(`creative.${BASE}`)?.targets[0]).toMatchObject({
      target_type: 'host',
      port: 25566,
    });
    await call('DELETE', `/api/servers/${other.id}`);
    await waitFor(() => [...netbird.resources.values()].every((r) => r.name !== 'MorniHosting creative'));

    expect(netbird.networks.map((n) => n.name)).toEqual(['MorniHosting']);
    expect(netbird.groups.map((g) => g.name)).toEqual(['MorniHosting']);
    expect(netbird.routers).toEqual([{ network: netbird.networks[0]?.id, peer: 'peer-mh' }]);
    const resource = [...netbird.resources.values()].find((r) => r.name === 'MorniHosting survival');
    expect(resource).toMatchObject({ address: '10.13.4.103', groups: [netbird.groups[0]?.id] });
    expect(netbird.byDomain(`survival.${BASE}`)?.targets[0]).toMatchObject({
      target_type: 'host',
      target_id: resource?.id,
      host: '10.13.4.103',
      port: 25565,
    });

    // The panel on the domain itself (empty name), through its own resource.
    const panel = (await call('POST', '/api/netbird/panel', { name: '', port: 8080 })).json<NetbirdStatus>();
    expect(panel.panelAddress).toBe(BASE);
    expect(netbird.byDomain(BASE)?.targets[0]).toMatchObject({ target_type: 'host', port: 8080 });
    expect([...netbird.resources.values()].map((r) => r.name).sort()).toEqual([
      'MorniHosting Panel',
      'MorniHosting survival',
    ]);

    // Deleting the server removes its resource too; the panel's stays.
    await call('DELETE', `/api/servers/${server.id}`);
    await waitFor(() => !netbird.byDomain(`survival.${BASE}`));
    await waitFor(() => [...netbird.resources.values()].every((r) => r.name !== 'MorniHosting survival'));
    expect([...netbird.resources.values()].map((r) => r.name)).toEqual(['MorniHosting Panel']);
    expect(netbird.networks).toHaveLength(1);

    // Someone deletes the panel's resource in NetBird: setting the panel up again creates a new one.
    netbird.resources.clear();
    const again = await call('POST', '/api/netbird/panel', { name: '', port: 8080 });
    expect(again.statusCode).toBe(200);
    const fresh = [...netbird.resources.values()].find((r) => r.name === 'MorniHosting Panel');
    expect(fresh).toBeDefined();
    expect(netbird.byDomain(BASE)?.targets[0]).toMatchObject({ target_type: 'host', target_id: fresh?.id });
  });
});
