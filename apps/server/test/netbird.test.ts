/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  NetbirdDiscovery,
  NetbirdExitStatus,
  NetbirdServerInfo,
  NetbirdStatus,
  ServerDetail,
  ServerSummary,
} from '@mornihosting/shared';
import { loadConfig } from '../src/config.js';
import { netbirdServices, servers as serverTable, settings } from '../src/db/schema.js';
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
/** The home connection (must never show up) and the NetBird server used as exit. */
const HOME_IP = '198.51.100.7';
const EXIT_IP = '85.215.54.143';
const EXIT_PEER = { ...PEER, id: 'peer-exit', name: 'netbird-server', ip: '100.92.0.1', hostname: 'netbird' };
/** A second panel in the same NetBird account (an app running MorniHosting as its motor, MH_BRAND=MoinMorni). */
const SECOND_PEER = { ...PEER, id: 'peer-mn', name: 'moinmorni', ip: '100.92.14.9', hostname: 'moinmorni' };
const SECOND_DOMAIN = 'moinmorni.net';
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

/** A route as NetBird stores it (what the panel sent, plus the id). */
type FakeRoute = Record<string, unknown> & { id: string; groups?: string[]; peer?: string; network?: string };

/**
 * A tiny NetBird management API: domains, peers, groups, routes, networks and reverse-proxy services, with NetBird's
 * own rules (checked against its source, management/server/route.go, group.go and the service manager): one service
 * per name; one per outside port and protocol; NetBird Cloud hands out ports from 31000 up and refuses chosen ones,
 * with `customPorts` (a self-hosted proxy) it listens where it is asked to. Routes come back as NetBird answers them
 * (both "network" and "domains", "peer" always), a request with both of a pair is refused, a group in a route cannot be
 * deleted. NetBird accepts several 0.0.0.0/0 routes over one machine; `strictRoutes` plays a NetBird that does not.
 */
function createFakeNetbird(
  options: { customPorts?: boolean; delayMs?: number; strictRoutes?: boolean; secondPanel?: boolean } = {},
) {
  const services = new Map<string, FakeService>();
  const networks: { id: string; name: string }[] = [];
  const groups: { id: string; name: string; peers?: string[] }[] = [];
  /** The panel's machine; connected again in NetBird it gets a new id. */
  const machine = { id: PEER.id };
  const routes = new Map<string, FakeRoute>();
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
    const net = url.pathname.split('/');
    if (url.pathname === '/api/peers')
      return Response.json([
        { ...PEER, id: machine.id, connection_ip: HOME_IP },
        { ...PEER, id: 'peer-laptop', name: 'laptop' },
        { ...EXIT_PEER, connection_ip: EXIT_IP },
        ...(options.secondPanel ? [{ ...SECOND_PEER, connection_ip: HOME_IP }] : []),
      ]);
    // Exit routes: /api/routes(/<id>)
    if (net[2] === 'routes') {
      const routeId = net[3] ?? '';
      // Like NetBird's answer: "network" and "domains" both, "peer" always, "peer_groups" only when set.
      const answer = (r: FakeRoute) => ({
        ...r,
        network_type: 'IPv4',
        domains: [],
        peer: r.peer ?? '',
        groups: r.groups ?? [],
      });
      if (method === 'GET') return Response.json(routes.size ? [...routes.values()].map(answer) : null);
      const routeBody = body as unknown as FakeRoute | null;
      if ((method === 'POST' || method === 'PUT') && routeBody) {
        if (routeBody.network !== undefined && routeBody['domains'] !== undefined)
          return Response.json(
            { message: "only one of 'network' or 'domains' should be provided", code: 422 },
            { status: 422 },
          );
        if (routeBody.peer !== undefined && routeBody['peer_groups'] !== undefined)
          return Response.json(
            { message: "only one of 'peer' or 'peer_groups' should be provided", code: 422 },
            { status: 422 },
          );
        const unknownGroup = (routeBody.groups ?? []).find((g) => !groups.some((x) => x.id === g));
        if (!routeBody.groups?.length || unknownGroup)
          return Response.json(
            { message: `group ${String(unknownGroup)} not found`, code: 422 },
            { status: 422 },
          );
        const twin = [...routes.values()].find(
          (r) => r.id !== routeId && r.network === routeBody.network && r.peer === routeBody.peer,
        );
        if (options.strictRoutes && twin)
          return Response.json(
            {
              message: `failed to add route with prefix ${String(routeBody.network)} - peer ${String(routeBody.peer)} already has this route`,
              code: 409,
            },
            { status: 409 },
          );
      }
      if (method === 'POST' && routeBody) {
        const route = { ...routeBody, id: `route-${next.id++}` };
        routes.set(route.id, route);
        return Response.json(answer(route));
      }
      if (method === 'PUT' && routeBody && routes.has(routeId)) {
        routes.set(routeId, { ...routeBody, id: routeId });
        return Response.json(answer({ ...routeBody, id: routeId }));
      }
      if (method === 'DELETE') return new Response(null, { status: routes.delete(routeId) ? 200 : 404 });
    }
    const groupId = net[2] === 'groups' ? (net[3] ?? '') : '';
    if (groupId && method === 'PUT') {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return Response.json({ message: 'not found' }, { status: 404 });
      group.peers = (body as { peers?: string[] } | null)?.peers ?? [];
      return Response.json(group);
    }
    // Like NetBird: a group that a route still uses cannot be deleted.
    const usedBy = [...routes.values()].find((r) => (r.groups ?? []).includes(groupId));
    if (groupId && method === 'DELETE' && usedBy)
      return Response.json(
        { message: `group has been linked to route: ${String(usedBy['network_id'])}` },
        { status: 400 },
      );
    if (groupId && method === 'DELETE') {
      const at = groups.findIndex((g) => g.id === groupId);
      if (at >= 0) groups.splice(at, 1);
      return new Response(null, { status: at >= 0 ? 200 : 404 });
    }
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
        ...(options.secondPanel
          ? [
              {
                id: 'd3',
                domain: SECOND_DOMAIN,
                validated: true,
                type: 'custom',
                supports_custom_ports: options.customPorts,
              },
            ]
          : []),
      ]);
    }
    // Networks, groups, routing peers and resources: /api/networks/<net>/(routers|resources)/<id>
    if (url.pathname === '/api/groups' && method === 'GET') return Response.json(groups);
    if (url.pathname === '/api/groups' && method === 'POST') {
      const groupBody = body as { name?: string; peers?: string[] } | null;
      const group = { id: `grp-${next.id++}`, name: String(groupBody?.name), peers: groupBody?.peers };
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
      // Real NetBird (Go) answers an empty list with null.
      if (method === 'GET') return Response.json(resources.size ? [...resources.values()] : null);
      if (method === 'POST' && resourceBody) {
        const created = { ...resourceBody, id: `res-${next.id++}` };
        resources.set(created.id, created);
        return Response.json(created);
      }
      if (method === 'PUT' && resourceBody && resources.has(resourceId)) {
        resources.set(resourceId, { ...resourceBody, id: resourceId });
        return Response.json({ ...resourceBody, id: resourceId });
      }
      // Like NetBird: a resource that a service still points at cannot be deleted.
      const inUse = [...services.values()].some((s) =>
        (s.targets ?? []).some((target) => String(target.target_id) === resourceId),
      );
      if (method === 'DELETE' && inUse)
        return Response.json({ message: 'resource is in use by a reverse proxy service' }, { status: 422 });
      if (method === 'DELETE')
        return new Response(null, { status: resources.delete(resourceId) ? 200 : 404 });
    }
    if (url.pathname === '/api/reverse-proxies/services' && method === 'GET')
      return Response.json([...services.values()]);
    // Like NetBird: changing a service it does not know (deleted in the dashboard) answers 404 before anything else.
    if (method === 'PUT' && url.pathname.startsWith('/api/reverse-proxies/services/') && !services.has(id))
      return Response.json({ message: `service ${id} not found`, code: 404 }, { status: 404 });
    // Like NetBird: a service may only point at a resource that exists.
    const missing = (body?.targets ?? []).find(
      (target) => target.target_type === 'host' && !resources.has(String(target.target_id)),
    );
    if (missing && (method === 'POST' || method === 'PUT'))
      return Response.json(
        { message: `resource target "${String(missing.target_id)}" not found in account`, code: 422 },
        { status: 422 },
      );
    // Like NetBird Cloud: it hands out the outside port itself, a chosen one is refused (also changing it later).
    const chosen = body?.mode !== 'http' && Boolean(body?.listen_port);
    const changed = method === 'PUT' && chosen && services.get(id)?.listen_port !== body?.listen_port;
    if (!options.customPorts && ((method === 'POST' && chosen) || changed))
      return Response.json(
        { message: 'custom ports not supported on cluster eu.proxy.netbird.io' },
        { status: 422 },
      );
    // Like a self-hosted NetBird: one outside port per protocol.
    const clash =
      options.customPorts && body?.listen_port
        ? [...services.values()].find(
            (s) => s.id !== id && s.listen_port === body.listen_port && s.mode === body.mode,
          )
        : undefined;
    if (clash && (method === 'POST' || method === 'PUT'))
      return Response.json(
        {
          message: `${String(body?.mode)} port ${String(body?.listen_port)} is already in use by service ${String(clash.id)} on cluster netbird.example.org`,
        },
        { status: 409 },
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
    machine,
    services,
    routes,
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
    expect((await call('POST', '/api/netbird/discover', {})).json<NetbirdDiscovery>().peers).toHaveLength(3);
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
    // Creating does not wait for NetBird; the address follows a moment later.
    await waitFor(() => netbird.byDomain(`reich.${BASE}`) !== undefined);
    await waitFor(async () => (await detail(server.id)).publicPort === 25565);
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

  test("a taken outside port: a left-over of the panel is removed, someone else's makes the server move on", async () => {
    netbird = createFakeNetbird({ customPorts: true });
    await configure();
    // Left-over of the panel itself (its domain, but no longer in its list), e.g. after re-adding the machine.
    netbird.services.set('old-1', {
      id: 'old-1',
      domain: `alt.${BASE}`,
      mode: 'tcp',
      listen_port: 25565,
      pass_host_header: false,
      targets: [],
    });
    // Someone else's service on 25566.
    netbird.services.set('foreign', {
      id: 'foreign',
      domain: 'mail.other.example',
      mode: 'tcp',
      listen_port: 25566,
      pass_host_header: false,
      targets: [],
    });
    const first = await create({ netbirdName: 'eins' });
    await waitFor(async () => (await detail(first.id)).publicPort === 25565);
    expect(netbird.services.has('old-1')).toBe(false);
    const second = await call('POST', '/api/servers', {
      edition: 'java',
      software: 'paper',
      version: '1.21.4',
      memoryMb: 2048,
      port: 25566,
      eula: true,
      startNow: false,
      name: 'Zwei',
      netbirdName: 'zwei',
    });
    const id = second.json<{ id: string }>().id;
    await waitFor(async () => (await detail(id)).publicPort === 25567);
    expect(netbird.services.has('foreign')).toBe(true);
    expect((await detail(id)).netbird?.error ?? null).toBeNull();
  });

  test('a new server with a name gets its address in NetBird right after creating', async () => {
    await configure();
    const server = await create({ netbirdName: 'Survival' });
    // Creating answers at once; NetBird follows in the background.
    await waitFor(async () => (await detail(server.id)).address === `survival.${BASE}:31000`);
    const main = netbird.byDomain(`survival.${BASE}`);
    expect(main).toMatchObject({ mode: 'tcp', listen_port: 31000, pass_host_header: false });
    expect(main?.targets).toEqual([
      expect.objectContaining({ target_id: 'peer-mh', target_type: 'peer', protocol: 'tcp', port: 25565 }),
    ]);
    const shown = await detail(server.id);
    expect(shown.address).toBe(`survival.${BASE}:31000`);
    expect(shown.netbird).toEqual<NetbirdServerInfo>({
      name: 'survival',
      onDomain: false,
      services: [{ purpose: 'main', domain: `survival.${BASE}`, port: 31000, wanted: null, heldBy: null }],
      routed: { java: false, bedrock: false },
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
    await waitFor(async () => (await detail(server.id)).netbird?.services.length === 4);
    expect(netbird.byDomain(`survival-bedrock.${BASE}`)).toMatchObject({
      mode: 'udp',
      targets: [expect.objectContaining({ port: 19132 })],
    });
    // Bedrock 26.60+ (NetherNet) finds the server over TCP. NetBird Cloud hands out every port itself (a chosen one
    // is refused), so the TCP half gets its own; the same number for both needs a self-hosted proxy (test below).
    expect(netbird.byDomain(`survival-bedrock-tcp.${BASE}`)).toMatchObject({
      mode: 'tcp',
      targets: [expect.objectContaining({ port: 19132 })],
    });
    expect((await detail(server.id)).netbird?.error).toBeNull();
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
      'geyser-signal',
      'main',
    ]);
  });

  test('address router: 25565 and 19132 go to the panel, servers move aside, players use the name alone', async () => {
    netbird = createFakeNetbird({ customPorts: true });
    const routed = await createTestApp({ MH_ROUTER_JAVA_PORT: '24565', MH_ROUTER_BEDROCK_PORT: '19100' });
    try {
      const admin = await setupAdmin(routed);
      const rcall = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
        routed.app.inject({ method, url, payload, headers: authHeaders(admin) });
      await rcall('PUT', '/api/netbird', {
        apiUrl: 'https://api.netbird.io',
        token: TOKEN,
        domain: BASE,
        peerId: 'peer-mh',
      });
      expect(netbird.byDomain(`mh-router-java.${BASE}`)).toMatchObject({
        mode: 'tcp',
        listen_port: 25565,
        targets: [expect.objectContaining({ port: 24565 })],
      });
      expect(netbird.byDomain(`mh-router-bedrock.${BASE}`)).toMatchObject({
        mode: 'tcp',
        listen_port: 19132,
        targets: [expect.objectContaining({ port: 19100 })],
      });
      const server = (
        await rcall('POST', '/api/servers', {
          edition: 'java',
          software: 'paper',
          version: '1.21.4',
          memoryMb: 2048,
          port: 25565,
          eula: true,
          startNow: false,
          name: 'Reich',
          netbirdName: 'reich',
        })
      ).json<ServerSummary>();
      await rcall('PUT', `/api/servers/${server.id}/geyser`, { enabled: true });
      const shown = async () => (await rcall('GET', `/api/servers/${server.id}`)).json<ServerDetail>();
      await waitFor(async () => (await shown()).netbird?.services.length === 3);
      // The server's own address leaves 25565 to the router; Bedrock signaling needs no own TCP service.
      expect(netbird.byDomain(`reich.${BASE}`)?.listen_port).toBe(25566);
      // Bedrock keeps its own port (TCP + UDP, never the router's 19132), so joining with the port always works.
      const udp = netbird.byDomain(`reich-bedrock.${BASE}`);
      expect(udp).toMatchObject({ mode: 'udp' });
      expect(udp?.listen_port).not.toBe(19132);
      expect(netbird.byDomain(`reich-bedrock-tcp.${BASE}`)).toMatchObject({
        mode: 'tcp',
        listen_port: udp?.listen_port,
      });
      const detailNow = await shown();
      expect(detailNow.address).toBe(`reich.${BASE}`);
      expect(detailNow.netbird?.routed).toEqual({ java: true, bedrock: true });
      expect((await rcall('GET', '/api/netbird')).json<NetbirdStatus>().router).toEqual({
        java: true,
        bedrock: true,
      });
      // The router finds the container by the name typed (with or without "-bedrock", any case, with port).
      expect(routed.gateway.lookup(`reich.${BASE}`, 'java')).toEqual({
        host: `mh-${server.id}`,
        port: 25565,
      });
      expect(routed.gateway.lookup(`reich-bedrock.${BASE}`, 'bedrock')).toEqual({
        host: `mh-${server.id}`,
        port: 19132,
      });
      expect(routed.gateway.lookup(`fremd.${BASE}`, 'java')).toBeNull();
    } finally {
      await routed.cleanup();
    }
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

  test('hiding the home connection: all traffic leaves through the NetBird server, the home IP shows up nowhere', async () => {
    await t.cleanup();
    // The internet sees the home IP until the exit route exists, then the NetBird server's.
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(urlOf(input));
      if (url.hostname === 'api.ipify.org') return new Response(netbird.routes.size ? EXIT_IP : HOME_IP);
      return ['api.netbird.io', OWN_NETBIRD].includes(url.hostname)
        ? netbird.handle(url, init)
        : fakePluginSites(url);
    });
    // An old A record of one server still points at home.
    const dnsAnswers: Record<string, string[]> = { [BASE]: [EXIT_IP], [`survival.${BASE}`]: [HOME_IP] };
    t = await createTestApp({}, { resolver: async (name) => dnsAnswers[name] ?? [] });
    s = await setupAdmin(t);
    await configure();
    const server = await create();
    await call('PUT', `/api/servers/${server.id}/netbird`, { name: 'survival' });

    const before = (await call('GET', '/api/netbird/exit')).json<NetbirdExitStatus>();
    expect(before.enabled).toBe(false);
    expect(before.candidates.map((c) => c.id)).toEqual(['peer-laptop', 'peer-exit']);
    // The panel's own machine cannot be its own exit.
    expect(
      (await call('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-mh' })).statusCode,
    ).toBe(400);

    const on = await call('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-exit' });
    expect(on.statusCode).toBe(200);
    const route = [...netbird.routes.values()][0];
    const group = netbird.groups.find((g) => g.name === 'MorniHosting Ausgang');
    expect(group?.peers).toEqual(['peer-mh']);
    expect(route).toMatchObject({
      network: '0.0.0.0/0',
      peer: 'peer-exit',
      groups: [group?.id],
      masquerade: true,
      enabled: true,
      skip_auto_apply: false,
    });
    const status = on.json<NetbirdExitStatus>();
    expect(status).toMatchObject({
      enabled: true,
      exitPeerName: 'netbird-server',
      exitIp: EXIT_IP,
      hidden: true,
    });
    expect(status.leaks).toEqual([`survival.${BASE}`]);
    // The home IP itself is never sent to the browser.
    expect(JSON.stringify(status)).not.toContain(HOME_IP);

    // Switching on again keeps one route; switching off removes route and group.
    await call('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-exit' });
    expect(netbird.routes.size).toBe(1);
    await call('PUT', '/api/netbird/exit', { enabled: false });
    expect(netbird.routes.size).toBe(0);
    expect(netbird.groups.some((g) => g.name === 'MorniHosting Ausgang')).toBe(false);
  });
  test('the machine gets a new NetBird id: the panel moves over by itself and tidies leftovers', async () => {
    await configure();
    const server = await create({ netbirdName: 'survival' });
    await waitFor(() => netbird.byDomain(`survival.${BASE}`) !== undefined);
    netbird.machine.id = 'peer-mh-new';
    const healed = await t.netbird.heal();
    expect(healed?.peerMoved).toBe('mornihosting');
    // The server's address now points at the machine under its new id.
    expect(netbird.byDomain(`survival.${BASE}`)?.targets[0]?.target_id).toBe('peer-mh-new');
    // All fine now: nothing more to repair.
    expect(await t.netbird.heal()).toBeNull();
    expect(server.id).toBeTruthy();
  });
  test('leftovers of a deleted server go away for real, also when an old service still points at them', async () => {
    await t.cleanup();
    netbird = createFakeNetbird({ delayMs: 5 });
    t = await createTestApp({ MH_LAN_IP: '198.51.100.20' });
    s = await setupAdmin(t);
    await configure();
    await create({ netbirdName: 'survival' });
    await waitFor(() => netbird.byDomain(`survival.${BASE}`) !== undefined);
    // A leftover from a server deleted while the panel could not reach NetBird: resource plus its service.
    netbird.resources.set('res-old', {
      id: 'res-old',
      name: 'MorniHosting zelt',
      address: '198.51.100.20',
    } as never);
    netbird.services.set('svc-old', {
      id: 'svc-old',
      domain: `zelt.${BASE}`,
      mode: 'tcp',
      listen_port: 25570,
      targets: [{ target_id: 'res-old', target_type: 'host' }],
    } as never);
    const healed = await t.netbird.heal();
    expect(healed?.removed).toEqual(['MorniHosting zelt']);
    expect(healed?.stuck).toEqual([]);
    expect(netbird.resources.has('res-old')).toBe(false);
    expect(netbird.services.has('svc-old')).toBe(false);
    // The live server keeps its address; nothing left to report next time.
    expect(netbird.byDomain(`survival.${BASE}`)).toBeDefined();
    expect(await t.netbird.heal()).toBeNull();
  });
  /** A second panel (MH_BRAND=MoinMorni) in the same NetBird account, with its own machine and domain. */
  const secondPanel = async (env: Record<string, string> = {}) => {
    const app = await createTestApp({ MH_BRAND: 'MoinMorni', ...env });
    const admin = await setupAdmin(app);
    const send = (method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object) =>
      app.app.inject({ method, url, payload, headers: authHeaders(admin) });
    await send('PUT', '/api/netbird', {
      apiUrl: 'https://api.netbird.io',
      token: TOKEN,
      domain: SECOND_DOMAIN,
      peerId: SECOND_PEER.id,
    });
    return { app, send };
  };
  const exitGroup = (brand: string) => netbird.groups.find((g) => g.name === `${brand} Ausgang`);

  test('two panels in one NetBird account: own names, own exit route over the same machine, neither touches the other', async () => {
    await t.cleanup();
    netbird = createFakeNetbird({ secondPanel: true });
    t = await createTestApp({ MH_LAN_IP: '198.51.100.20' });
    s = await setupAdmin(t);
    await configure();
    const second = await secondPanel({ MH_LAN_IP: '198.51.100.30' });
    try {
      const status = (await second.send('GET', '/api/netbird')).json<NetbirdStatus>();
      expect(status).toMatchObject({ brand: 'MoinMorni', machineHint: 'moinmorni', domain: SECOND_DOMAIN });
      // The machine of the second panel is the one offered for it, not MorniHosting's.
      const found = (await second.send('POST', '/api/netbird/discover', {})).json<NetbirdDiscovery>();
      expect(found.suggestedPeerId).toBe(SECOND_PEER.id);
      // Website on the domain itself: network, group and resource carry the second panel's name.
      await second.send('POST', '/api/netbird/panel', { name: '', port: 8080 });
      expect(netbird.networks.map((n) => n.name)).toEqual(['MorniHosting', 'MoinMorni']);
      expect(netbird.groups.map((g) => g.name)).toEqual(['MorniHosting', 'MoinMorni']);
      expect([...netbird.resources.values()].map((r) => r.name)).toEqual(['MoinMorni Panel']);

      expect(
        (await call('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-exit' })).statusCode,
      ).toBe(200);
      const on = await second.send('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-exit' });
      expect(on.json<NetbirdExitStatus>()).toMatchObject({ enabled: true, sharedWith: null });
      // NetBird takes two routes for all traffic over the same exit machine, each for its own group.
      expect([...netbird.routes.values()].map((r) => [r['network_id'], r.peer, r.groups])).toEqual([
        ['MorniHosting Ausgang', 'peer-exit', [exitGroup('MorniHosting')?.id]],
        ['MoinMorni Ausgang', 'peer-exit', [exitGroup('MoinMorni')?.id]],
      ]);
      expect(exitGroup('MorniHosting')?.peers).toEqual(['peer-mh']);
      expect(exitGroup('MoinMorni')?.peers).toEqual([SECOND_PEER.id]);

      // Switching it off on one side leaves the other one alone.
      await second.send('PUT', '/api/netbird/exit', { enabled: false });
      expect([...netbird.routes.values()].map((r) => r['network_id'])).toEqual(['MorniHosting Ausgang']);
      expect(exitGroup('MoinMorni')).toBeUndefined();
      expect(exitGroup('MorniHosting')?.peers).toEqual(['peer-mh']);
    } finally {
      await second.app.cleanup();
    }
  });

  test('a NetBird that allows one exit route per machine: the second panel joins it, and only ever takes its own group out', async () => {
    netbird = createFakeNetbird({ secondPanel: true, strictRoutes: true });
    await configure();
    const second = await secondPanel();
    try {
      await call('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-exit' });
      const joined = await second.send('PUT', '/api/netbird/exit', {
        enabled: true,
        exitPeerId: 'peer-exit',
      });
      expect(joined.json<NetbirdExitStatus>()).toMatchObject({
        enabled: true,
        sharedWith: 'MorniHosting Ausgang',
      });
      const mh = exitGroup('MorniHosting')?.id;
      const mn = exitGroup('MoinMorni')?.id;
      const only = () => [...netbird.routes.values()];
      expect(only()).toHaveLength(1);
      expect(only()[0]).toMatchObject({
        network_id: 'MorniHosting Ausgang',
        peer: 'peer-exit',
        groups: [mh, mn],
        masquerade: true,
      });
      // MorniHosting repairs its route (e.g. after its machine got a new id): the other group stays in it.
      await call('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-exit' });
      expect(only()[0]?.groups).toEqual([mh, mn]);
      // The second panel switching on again stays in the shared route.
      await second.send('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-exit' });
      expect(only()).toHaveLength(1);
      expect(only()[0]?.groups).toEqual([mh, mn]);

      // MorniHosting switches off: its group goes, the route stays for the second panel.
      await call('PUT', '/api/netbird/exit', { enabled: false });
      expect(only()).toHaveLength(1);
      expect(only()[0]?.groups).toEqual([mn]);
      expect(exitGroup('MorniHosting')).toBeUndefined();
      // The last one out removes the route.
      await second.send('PUT', '/api/netbird/exit', { enabled: false });
      expect(only()).toHaveLength(0);
      expect(exitGroup('MoinMorni')).toBeUndefined();
    } finally {
      await second.app.cleanup();
    }
  });

  /** A Velocity proxy with Geyser and voice chat (set straight in the database: the plugins do not matter here). */
  type Send = (
    method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
  ) => ReturnType<typeof call>;
  const proxyWithEverything = async (send: Send = call): Promise<string> => {
    const created = await send('POST', '/api/servers', {
      edition: 'java',
      software: 'velocity',
      version: '3.4.0',
      memoryMb: 1024,
      port: 25565,
      eula: true,
      startNow: false,
      name: 'MoinMorni Proxy',
    });
    return created.json<{ id: string }>().id;
  };
  const switchOnGeyserAndVoice = (app: TestApp, id: string): void => {
    app.ctx.db
      .update(serverTable)
      .set({
        geyser: true,
        voiceChat: true,
        extraPorts: [{ port: 19132, containerPort: 19132, protocol: 'udp', purpose: 'geyser' }],
      })
      .where(eq(serverTable.id, id))
      .run();
  };

  test('the network proxy on the domain itself: website on moinmorni.net, players type only moinmorni.net (Java, Bedrock, voice)', async () => {
    netbird = createFakeNetbird({ secondPanel: true, customPorts: true });
    const second = await secondPanel({ MH_LAN_IP: '198.51.100.30' });
    try {
      const id = await proxyWithEverything(second.send);
      switchOnGeyserAndVoice(second.app, id);
      await second.send('POST', '/api/netbird/panel', { name: '', port: 8080 });
      const status = (
        await second.send('PUT', '/api/netbird/domain-server', { serverId: id })
      ).json<NetbirdStatus>();
      expect(status.domainServer).toEqual({ id, name: 'MoinMorni Proxy' });
      // NetBird keeps one service per name: the website has the domain, the game services their own names – on the
      // ports games use without one typed. NetBird forwards TCP and UDP by port, whatever name the player typed.
      expect(netbird.byDomain(SECOND_DOMAIN)).toMatchObject({ mode: 'http', pass_host_header: true });
      expect(netbird.byDomain(`moinmorni-proxy.${SECOND_DOMAIN}`)).toMatchObject({
        mode: 'tcp',
        listen_port: 25565,
      });
      expect(netbird.byDomain(`moinmorni-proxy-voice.${SECOND_DOMAIN}`)).toMatchObject({
        mode: 'udp',
        listen_port: 25565,
        targets: [expect.objectContaining({ port: 25565, protocol: 'udp' })],
      });
      expect(netbird.byDomain(`moinmorni-proxy-bedrock.${SECOND_DOMAIN}`)).toMatchObject({
        mode: 'udp',
        listen_port: 19132,
      });
      expect(netbird.byDomain(`moinmorni-proxy-bedrock-tcp.${SECOND_DOMAIN}`)).toMatchObject({
        mode: 'tcp',
        listen_port: 19132,
      });
      const shown = (await second.send('GET', `/api/servers/${id}`)).json<ServerDetail>();
      expect(shown).toMatchObject({
        address: SECOND_DOMAIN,
        geyserPublicPort: 19132,
        voicePublicPort: 25565,
      });
      expect(shown.voiceHost).toBe(`${SECOND_DOMAIN}:25565`);
      expect(shown.netbird).toMatchObject({ onDomain: true, error: null });
      expect(shown.netbird?.services.every((x) => x.wanted === null)).toBe(true);
      // The proxy's voice chat tells the players the UDP port NetBird has.
      const props = fs.readFileSync(
        path.join(second.app.dataDir, 'servers', id, 'plugins/voicechat/voicechat-proxy.properties'),
        'utf8',
      );
      expect(props).toMatch(/voice_host=25565/);

      // Off the domain again: back to the server's own name.
      await second.send('PUT', '/api/netbird/domain-server', { serverId: null });
      expect((await second.send('GET', `/api/servers/${id}`)).json<ServerDetail>()).toMatchObject({
        address: `moinmorni-proxy.${SECOND_DOMAIN}`,
        netbird: { onDomain: false },
      });
    } finally {
      await second.app.cleanup();
    }
  });

  test.each([
    ['a self-hosted NetBird: on its old port', true],
    ['NetBird Cloud: on a port NetBird picks', false],
  ])('a service deleted by hand in NetBird is made again instead of failing – %s', async (_, customPorts) => {
    netbird = createFakeNetbird({ secondPanel: true, customPorts });
    const second = await secondPanel({ MH_LAN_IP: '198.51.100.30' });
    try {
      const id = await proxyWithEverything(second.send);
      await second.send('PUT', '/api/netbird/domain-server', { serverId: id });
      const before = netbird.byDomain(`moinmorni-proxy.${SECOND_DOMAIN}`);
      expect(before).toMatchObject({ mode: 'tcp' });
      // Someone tidies up in the NetBird dashboard: NetBird now answers "service … not found" for it.
      netbird.services.delete(String(before?.id));

      const answer = await second.send('PUT', '/api/netbird/domain-server', { serverId: id });
      expect(answer.statusCode, answer.body).toBe(200);
      const again = netbird.byDomain(`moinmorni-proxy.${SECOND_DOMAIN}`);
      expect(again).toMatchObject({ mode: 'tcp' });
      expect(again?.id).not.toBe(before?.id);
      if (customPorts) expect(again?.listen_port).toBe(before?.listen_port);
      expect((await second.send('GET', `/api/servers/${id}`)).json<ServerDetail>()).toMatchObject({
        netbird: { onDomain: true, error: null },
      });
    } finally {
      await second.app.cleanup();
    }
  });

  test("the domain's ports belong to another panel: the next free pair, a note who has them, and the default port once free", async () => {
    netbird = createFakeNetbird({ secondPanel: true, customPorts: true });
    // MorniHosting's address router in the same account holds TCP 25565 and 19132 on the proxy.
    const foreign = (id: string, domain: string, port: number) =>
      netbird.services.set(id, {
        id,
        domain,
        mode: 'tcp',
        listen_port: port,
        pass_host_header: false,
        targets: [],
      });
    foreign('mh-java', `mh-router-java.${BASE}`, 25565);
    foreign('mh-bedrock', `mh-router-bedrock.${BASE}`, 19132);
    const second = await secondPanel();
    try {
      const id = await proxyWithEverything(second.send);
      switchOnGeyserAndVoice(second.app, id);
      await second.send('PUT', '/api/netbird/domain-server', { serverId: id });
      // Each pair moves together to the first number that is free in both protocols.
      expect(netbird.byDomain(`moinmorni-proxy.${SECOND_DOMAIN}`)?.listen_port).toBe(25566);
      expect(netbird.byDomain(`moinmorni-proxy-voice.${SECOND_DOMAIN}`)?.listen_port).toBe(25566);
      expect(netbird.byDomain(`moinmorni-proxy-bedrock.${SECOND_DOMAIN}`)?.listen_port).toBe(19133);
      expect(netbird.byDomain(`moinmorni-proxy-bedrock-tcp.${SECOND_DOMAIN}`)?.listen_port).toBe(19133);
      // The other panel's services are not touched.
      expect(netbird.services.get('mh-java')?.listen_port).toBe(25565);
      const shown = (await second.send('GET', `/api/servers/${id}`)).json<ServerDetail>();
      expect(shown.address).toBe(`${SECOND_DOMAIN}:25566`);
      expect(shown.netbird?.services.find((x) => x.purpose === 'main')).toMatchObject({
        port: 25566,
        wanted: 25565,
        heldBy: `mh-router-java.${BASE}`,
      });
      expect(shown.netbird?.services.find((x) => x.purpose === 'geyser')).toMatchObject({
        wanted: 19132,
        heldBy: `mh-router-bedrock.${BASE}`,
      });
      // Nothing changes in vain while the ports stay taken.
      const before = netbird.calls.filter((c) => c.method === 'PUT').length;
      await second.app.netbird.heal();
      expect(netbird.calls.filter((c) => c.method === 'PUT').length).toBe(before);

      // The other panel lets go (e.g. its router switched off): the next check takes the default ports.
      netbird.services.delete('mh-java');
      netbird.services.delete('mh-bedrock');
      await second.app.netbird.heal();
      expect(netbird.byDomain(`moinmorni-proxy.${SECOND_DOMAIN}`)?.listen_port).toBe(25565);
      expect(netbird.byDomain(`moinmorni-proxy-voice.${SECOND_DOMAIN}`)?.listen_port).toBe(25565);
      expect(netbird.byDomain(`moinmorni-proxy-bedrock-tcp.${SECOND_DOMAIN}`)?.listen_port).toBe(19132);
      const after = (await second.send('GET', `/api/servers/${id}`)).json<ServerDetail>();
      expect(after.address).toBe(SECOND_DOMAIN);
      expect(after.netbird?.services.every((x) => x.wanted === null)).toBe(true);
    } finally {
      await second.app.cleanup();
    }
  });

  test('on the domain with NetBird Cloud: NetBird picks the ports, the address names them', async () => {
    await configure();
    const server = await create({ netbirdName: 'survival' });
    await waitFor(() => netbird.byDomain(`survival.${BASE}`) !== undefined);
    const status = (
      await call('PUT', '/api/netbird/domain-server', { serverId: server.id })
    ).json<NetbirdStatus>();
    expect(status.domainServer?.id).toBe(server.id);
    const shown = await detail(server.id);
    expect(shown.address).toBe(`${BASE}:${netbird.byDomain(`survival.${BASE}`)?.listen_port}`);
    expect(shown.netbird).toMatchObject({ onDomain: true, error: null });
    // Deleting the server takes it off the domain.
    await call('DELETE', `/api/servers/${server.id}`);
    expect((await call('GET', '/api/netbird')).json<NetbirdStatus>().domainServer).toBeNull();
  });

  test('on the domain with the address router: the router sends the domain itself to that server', async () => {
    netbird = createFakeNetbird({ customPorts: true });
    const routed = await createTestApp({ MH_ROUTER_JAVA_PORT: '24565', MH_ROUTER_BEDROCK_PORT: '19100' });
    try {
      const admin = await setupAdmin(routed);
      const rcall = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
        routed.app.inject({ method, url, payload, headers: authHeaders(admin) });
      await rcall('PUT', '/api/netbird', {
        apiUrl: 'https://api.netbird.io',
        token: TOKEN,
        domain: BASE,
        peerId: 'peer-mh',
      });
      const server = (
        await rcall('POST', '/api/servers', {
          edition: 'java',
          software: 'paper',
          version: '1.21.4',
          memoryMb: 2048,
          port: 25570,
          eula: true,
          startNow: false,
          name: 'Reich',
        })
      ).json<ServerSummary>();
      // A server without a name gets one from its own name.
      await rcall('PUT', '/api/netbird/domain-server', { serverId: server.id });
      expect(netbird.byDomain(`reich.${BASE}`)).toBeDefined();
      expect(routed.gateway.lookup(BASE, 'java')).toEqual({ host: `mh-${server.id}`, port: 25565 });
      expect(netbird.byDomain(`mh-router-java.${BASE}`)?.listen_port).toBe(25565);
      expect((await rcall('GET', `/api/servers/${server.id}`)).json<ServerDetail>().address).toBe(BASE);
    } finally {
      await routed.cleanup();
    }
  });
  test('hiding the home connection: only the MorniHosting container goes out, not the chosen routing machine', async () => {
    // The addresses run over another machine (like the Proxmox host routing into the LAN).
    await call('PUT', '/api/netbird', {
      apiUrl: 'https://api.netbird.io',
      token: TOKEN,
      domain: BASE,
      peerId: 'peer-laptop',
    });
    const on = await call('PUT', '/api/netbird/exit', { enabled: true, exitPeerId: 'peer-exit' });
    expect(on.statusCode).toBe(200);
    expect(netbird.groups.find((g) => g.name === 'MorniHosting Ausgang')?.peers).toEqual(['peer-mh']);
  });
});
