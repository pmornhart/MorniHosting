import { z } from 'zod';

/**
 * Areas an API key may be limited to. A key without areas may do everything its owner may (as before); a key
 * with areas only reaches the requests listed for them – e.g. a website that shows server status gets
 * `servers:read` and nothing else.
 */
export const TOKEN_SCOPES = [
  'servers:read',
  'servers:control',
  'servers:files',
  'servers:config',
  'servers:manage',
  'networks',
  'users',
  'events',
  'admin',
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * Service accounts (`service-token` in the CLI) start with this name. They cannot sign in and do not count as
 * people – the setup wizard stays open until the first real person has an account.
 */
export const SERVICE_ACCOUNT_PREFIX = 'dienst-';

export const tokenScopesSchema = z.array(z.enum(TOKEN_SCOPES)).min(1).max(TOKEN_SCOPES.length);

const READ = 'GET';
const SEPARATOR = '/';
const API = 'api';
const SERVERS = 'servers';
/** Index of the part after /api/servers/:id/ in "/api/servers/<id>/<part>". */
const SERVER_PART = 3;
const SERVER_ID = 2;
/** Requests on /api/servers/<this> that create servers (not a server id). */
const CREATE_PARTS: ReadonlySet<string> = new Set(['import']);

/** Server sub-paths that change files (writes); reading them is `servers:read`. */
const FILE_PARTS: ReadonlySet<string> = new Set(['files', 'trash', 'worlds', 'icon', 'backups']);
/** Server sub-paths that run the server (start, stop, commands). */
const CONTROL_PARTS: ReadonlySet<string> = new Set(['actions', 'command', 'console', 'crash']);
/** Other areas: first path part after /api → area for every method. */
const AREA_OF_PART: Readonly<Record<string, TokenScope>> = {
  networks: 'networks',
  users: 'users',
  roles: 'users',
  ws: 'events',
};
/** Read-only helpers every key with `servers:read` may use. */
const READ_PARTS: ReadonlySet<string> = new Set([
  'auth',
  'versions',
  'content',
  'heads',
  'item-icons',
  'game-art',
  'host',
  'system',
]);

/** Which area a request needs, e.g. ("POST", "/api/servers/abc/actions/start") → "servers:control". */
export function scopeFor(method: string, pathname: string): TokenScope {
  const parts = pathname.split(SEPARATOR).filter(Boolean);
  if (parts[0] !== API) return 'admin';
  const first = parts[1] ?? '';
  const read = method.toUpperCase() === READ;
  const area = AREA_OF_PART[first];
  if (area) return area;
  if (first !== SERVERS) return read && READ_PARTS.has(first) ? 'servers:read' : 'admin';
  if (read) return 'servers:read';
  if (CREATE_PARTS.has(parts[SERVER_ID] ?? '')) return 'servers:manage';
  if (parts[SERVER_ID] === undefined || parts[SERVER_PART] === undefined) {
    return parts[SERVER_ID] === undefined || method.toUpperCase() === 'DELETE'
      ? 'servers:manage'
      : 'servers:config';
  }
  const part = parts[SERVER_PART];
  if (CONTROL_PARTS.has(part)) return 'servers:control';
  return FILE_PARTS.has(part) ? 'servers:files' : 'servers:config';
}
