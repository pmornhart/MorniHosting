import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { fetchResponse, UpstreamError } from '../lib/http-client.js';
import { HTTP_BAD_GATEWAY, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED } from '../lib/http-status.js';

/**
 * The few calls of NetBird's management API the panel needs: domains and machines (peers) to choose from,
 * and reverse-proxy services to create, change and delete. Authenticated with a personal access token.
 * https://docs.netbird.io/api/resources/services
 */

const MESSAGE_MAX = 200;
const AUTH_FAILURES: readonly number[] = [HTTP_UNAUTHORIZED, HTTP_FORBIDDEN];
const UNKNOWN_TOKEN = 'invalid token';

const domainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  validated: z.boolean().catch(false),
  type: z.enum(['free', 'custom']).catch('custom'),
  /** Self-hosted proxies can listen on ports the panel picks; NetBird Cloud assigns them itself. */
  supports_custom_ports: z.boolean().catch(false),
});
const peerSchema = z.object({
  id: z.string(),
  name: z.string(),
  ip: z.string().catch(''),
  connected: z.boolean().catch(false),
  hostname: z.string().catch(''),
  /** The public address NetBird sees the machine connect from (its internet IP). */
  connection_ip: z.string().catch(''),
});
const serviceSchema = z.object({
  id: z.string(),
  domain: z.string(),
  listen_port: z.number().int().nullable().optional(),
});
const errorSchema = z.object({ message: z.string() });
const namedSchema = z.object({ id: z.string(), name: z.string().catch('') });
const resourceSchema = z.object({
  id: z.string(),
  name: z.string().catch(''),
  address: z.string().catch(''),
});
const routeSchema = z.object({
  id: z.string(),
  network_id: z.string().catch(''),
  network: z.string().catch(''),
  peer: z.string().nullable().catch(null),
  groups: z.array(z.string()).nullable().catch([]),
  enabled: z.boolean().catch(true),
});
const routerSchema = z.object({ id: z.string(), peer: z.string().nullable().catch(null) });
/** NetBird is written in Go and sends an empty list as `null`; both mean "nothing there". */
const listOf = <TItem extends z.ZodType>(item: TItem) =>
  z
    .array(item)
    .nullable()
    .transform((items) => items ?? []);

export type NetbirdDomain = z.infer<typeof domainSchema>;
export type NetbirdPeer = z.infer<typeof peerSchema>;
export type NetbirdService = z.infer<typeof serviceSchema>;

export type NetbirdNamed = z.infer<typeof namedSchema>;
export type NetbirdRoute = z.infer<typeof routeSchema>;

/** A route that sends all internet traffic of `groupId`'s machines out through `peerId` (an exit node). */
export interface NetbirdExitRouteRequest {
  readonly name: string;
  readonly peerId: string;
  readonly groupId: string;
}
export type NetbirdResource = z.infer<typeof resourceSchema>;

/** A network resource: one address in the home network that NetBird reaches through a routing peer. */
export interface NetbirdResourceRequest {
  readonly name: string;
  readonly address: string;
  readonly groupId: string;
}

export interface NetbirdServiceRequest {
  readonly domain: string;
  readonly mode: 'http' | 'tcp' | 'udp';
  readonly peerId: string;
  /** When set, the service goes to this network resource (at `resourceAddress`) instead of the peer. */
  readonly resourceId?: string | null;
  readonly resourceAddress?: string | null;
  /** Port on the peer that NetBird forwards to. */
  readonly port: number;
  /** Outside port to keep on an update; new L4 services get one assigned by NetBird. */
  readonly listenPort?: number | null;
  readonly passHostHeader?: boolean;
}

export interface NetbirdClient {
  readonly domains: () => Promise<NetbirdDomain[]>;
  readonly peers: () => Promise<NetbirdPeer[]>;
  readonly services: () => Promise<NetbirdService[]>;
  readonly createService: (request: NetbirdServiceRequest) => Promise<NetbirdService>;
  readonly updateService: (id: string, request: NetbirdServiceRequest) => Promise<NetbirdService>;
  /** Deleting a service that is already gone counts as done. */
  readonly deleteService: (id: string) => Promise<void>;
  readonly groups: () => Promise<NetbirdNamed[]>;
  readonly createGroup: (name: string, peers?: readonly string[]) => Promise<NetbirdNamed>;
  readonly updateGroup: (id: string, name: string, peers: readonly string[]) => Promise<NetbirdNamed>;
  readonly deleteGroup: (id: string) => Promise<void>;
  readonly routes: () => Promise<NetbirdRoute[]>;
  readonly createRoute: (request: NetbirdExitRouteRequest) => Promise<NetbirdRoute>;
  readonly updateRoute: (id: string, request: NetbirdExitRouteRequest) => Promise<NetbirdRoute>;
  /** Deleting a route that is already gone counts as done. */
  readonly deleteRoute: (id: string) => Promise<void>;
  readonly networks: () => Promise<NetbirdNamed[]>;
  readonly createNetwork: (name: string, description: string) => Promise<NetbirdNamed>;
  readonly routers: (networkId: string) => Promise<{ id: string; peer: string | null }[]>;
  readonly createRouter: (networkId: string, peerId: string) => Promise<void>;
  readonly resources: (networkId: string) => Promise<NetbirdResource[]>;
  readonly createResource: (networkId: string, request: NetbirdResourceRequest) => Promise<NetbirdResource>;
  readonly updateResource: (
    networkId: string,
    id: string,
    request: NetbirdResourceRequest,
  ) => Promise<NetbirdResource>;
  /** Deleting a resource that is already gone counts as done. */
  readonly deleteResource: (networkId: string, id: string) => Promise<void>;
}

export type NetbirdClientFactory = (apiUrl: string, token: string) => NetbirdClient;

/** NetBird's default priority for a route; only one router per network here, so the value hardly matters. */
const ROUTER_METRIC = 9999;

/** All IPv4 addresses: a route for it makes the routing peer an exit node. */
const EVERYTHING_V4 = '0.0.0.0/0';
/** Exit routes win against nothing else here; the lowest priority is fine. */
const EXIT_METRIC = 9999;

function exitRouteBody(request: NetbirdExitRouteRequest): Record<string, unknown> {
  return {
    description: 'Angelegt von MorniHosting: Internet über diesen Rechner',
    network_id: request.name,
    network: EVERYTHING_V4,
    peer: request.peerId,
    groups: [request.groupId],
    metric: EXIT_METRIC,
    masquerade: true,
    enabled: true,
    keep_route: true,
    // Exit nodes are otherwise only offered to the machine, not switched on.
    skip_auto_apply: false,
  };
}

function resourceBody(request: NetbirdResourceRequest): Record<string, unknown> {
  return {
    name: request.name,
    description: 'Angelegt von MorniHosting',
    address: request.address,
    enabled: true,
    groups: [request.groupId],
  };
}

function serviceBody(request: NetbirdServiceRequest): Record<string, unknown> {
  const layer4 = request.mode !== 'http';
  return {
    name: request.domain,
    domain: request.domain,
    mode: request.mode,
    ...(layer4 ? { listen_port: request.listenPort ?? 0 } : {}),
    targets: [
      {
        ...(request.resourceId
          ? { target_id: request.resourceId, target_type: 'host', host: request.resourceAddress ?? undefined }
          : { target_id: request.peerId, target_type: 'peer' }),
        protocol: request.mode,
        port: request.port,
        enabled: true,
      },
    ],
    enabled: true,
    pass_host_header: request.passHostHeader ?? false,
  };
}

/**
 * NetBird's own words when it refuses something (e.g. "domain already in use"), kept short.
 * A well-formed key that this NetBird does not know comes back as 404 "invalid token: pat: … not found":
 * it was made on another NetBird server (self-hosted) or has been deleted.
 */
async function rejection(response: Response, host: string): Promise<AppError> {
  if (AUTH_FAILURES.includes(response.status)) return new AppError(HTTP_BAD_GATEWAY, 'netbird_unauthorized');
  const parsed = errorSchema.safeParse(await response.json().catch(() => null));
  const message = parsed.success ? parsed.data.message.slice(0, MESSAGE_MAX) : `HTTP ${response.status}`;
  if (response.status === HTTP_NOT_FOUND && message.toLowerCase().startsWith(UNKNOWN_TOKEN))
    return new AppError(HTTP_BAD_GATEWAY, 'netbird_token_unknown', { host });
  return new AppError(HTTP_BAD_GATEWAY, 'netbird_rejected', { message });
}

export const createNetbirdClient: NetbirdClientFactory = (apiUrl, token) => {
  const { origin, host } = new URL(apiUrl);
  const base = `${origin}/api`;
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    try {
      return await fetchResponse(`${base}${path}`, {
        method,
        headers: { authorization: `Token ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const host = err instanceof UpstreamError ? new URL(err.url).host : 'netbird';
      throw new AppError(HTTP_BAD_GATEWAY, 'netbird_unreachable', { host }, { cause: err });
    }
  };
  const json = async <TValue>(schema: z.ZodType<TValue>, method: string, path: string, body?: unknown) => {
    const response = await call(method, path, body);
    if (!response.ok) throw await rejection(response, host);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success)
      throw new AppError(HTTP_BAD_GATEWAY, 'netbird_rejected', {
        message: `${method} ${path}: unerwartete Antwort`.slice(0, MESSAGE_MAX),
      });
    return parsed.data;
  };
  return {
    domains: () => json(listOf(domainSchema), 'GET', '/reverse-proxies/domains'),
    peers: () => json(listOf(peerSchema), 'GET', '/peers'),
    services: () => json(listOf(serviceSchema), 'GET', '/reverse-proxies/services'),
    createService: (request) =>
      json(serviceSchema, 'POST', '/reverse-proxies/services', serviceBody(request)),
    updateService: (id, request) =>
      json(serviceSchema, 'PUT', `/reverse-proxies/services/${encodeURIComponent(id)}`, serviceBody(request)),
    deleteService: async (id) => {
      const response = await call('DELETE', `/reverse-proxies/services/${encodeURIComponent(id)}`);
      if (!response.ok && response.status !== HTTP_NOT_FOUND) throw await rejection(response, host);
    },
    groups: () => json(listOf(namedSchema), 'GET', '/groups'),
    createGroup: (name, peers) =>
      json(namedSchema, 'POST', '/groups', { name, ...(peers ? { peers: [...peers] } : {}) }),
    updateGroup: (id, name, peers) =>
      json(namedSchema, 'PUT', `/groups/${encodeURIComponent(id)}`, { name, peers: [...peers] }),
    deleteGroup: async (id) => {
      const response = await call('DELETE', `/groups/${encodeURIComponent(id)}`);
      if (!response.ok && response.status !== HTTP_NOT_FOUND) throw await rejection(response, host);
    },
    routes: () => json(listOf(routeSchema), 'GET', '/routes'),
    createRoute: (request) => json(routeSchema, 'POST', '/routes', exitRouteBody(request)),
    updateRoute: (id, request) =>
      json(routeSchema, 'PUT', `/routes/${encodeURIComponent(id)}`, exitRouteBody(request)),
    deleteRoute: async (id) => {
      const response = await call('DELETE', `/routes/${encodeURIComponent(id)}`);
      if (!response.ok && response.status !== HTTP_NOT_FOUND) throw await rejection(response, host);
    },
    networks: () => json(listOf(namedSchema), 'GET', '/networks'),
    createNetwork: (name, description) => json(namedSchema, 'POST', '/networks', { name, description }),
    routers: (networkId) =>
      json(listOf(routerSchema), 'GET', `/networks/${encodeURIComponent(networkId)}/routers`),
    createRouter: async (networkId, peerId) => {
      await json(routerSchema, 'POST', `/networks/${encodeURIComponent(networkId)}/routers`, {
        peer: peerId,
        metric: ROUTER_METRIC,
        masquerade: true,
        enabled: true,
      });
    },
    resources: (networkId) =>
      json(listOf(resourceSchema), 'GET', `/networks/${encodeURIComponent(networkId)}/resources`),
    createResource: (networkId, request) =>
      json(
        resourceSchema,
        'POST',
        `/networks/${encodeURIComponent(networkId)}/resources`,
        resourceBody(request),
      ),
    updateResource: (networkId, id, request) =>
      json(
        resourceSchema,
        'PUT',
        `/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(id)}`,
        resourceBody(request),
      ),
    deleteResource: async (networkId, id) => {
      const response = await call(
        'DELETE',
        `/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(id)}`,
      );
      if (!response.ok && response.status !== HTTP_NOT_FOUND) throw await rejection(response, host);
    },
  };
};
