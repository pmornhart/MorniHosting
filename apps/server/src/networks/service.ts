import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import {
  NETWORK_MEMBER_SOFTWARE,
  SOFTWARE,
  type NetworkCreateInput,
  type NetworkMemberInput,
  type NetworkUpdateInput,
  type NetworkView,
  type ServerNetworkInfo,
} from '@mornihosting/shared';
import { SYSTEM_ACTOR, type Actor } from '../audit/service.js';
import type { AppContext } from '../context.js';
import { networkMembers, networks } from '../db/schema.js';
import type { ContainerSpec } from '../docker/driver.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { MarketService } from '../market/service.js';
import { writePropertiesFile } from '../servers/properties-file.js';
import type { ServerService } from '../servers/service.js';
import { containerName } from '../servers/spec.js';
import {
  paperGlobalWithoutProxy,
  paperGlobalYaml,
  setYaml,
  velocityBind,
  velocityToml,
} from './config-files.js';

const SECRET_BYTES = 24;
const TMP_SUFFIX_BYTES = 4;
const VELOCITY_CONFIG = 'velocity.toml';
const SECRET_FILE = 'forwarding.secret';
const PAPER_GLOBAL = path.join('config', 'paper-global.yml');
const FLOODGATE_DIR = path.join('plugins', 'floodgate');
const FLOODGATE_KEY = path.join(FLOODGATE_DIR, 'key.pem');
const FLOODGATE_CONFIG = path.join(FLOODGATE_DIR, 'config.yml');
const VIA_CONFIG = path.join('plugins', 'viaversion', 'config.yml');
/** ViaVersion on the proxy learns the servers' versions by pinging them; the default (60 s) leaves new players out. */
const VIA_PING_SECONDS = 5;
const RELOAD_COMMAND = 'velocity reload';
const FLOODGATE_PROJECT = 'floodgate:spigot';
const PLUGINS_DIR = 'plugins';
const JAR = '.jar';
const FLOODGATE_JAR_PREFIX = 'floodgate';

type NetworkRow = typeof networks.$inferSelect;
type MemberRow = typeof networkMembers.$inferSelect;

export interface NetworkService {
  readonly list: () => NetworkView[];
  readonly get: (id: string) => NetworkView;
  readonly create: (input: NetworkCreateInput, actor: Actor) => NetworkView;
  readonly update: (id: string, input: NetworkUpdateInput, actor: Actor) => Promise<NetworkView>;
  readonly remove: (id: string, actor: Actor) => Promise<void>;
  readonly addMember: (id: string, input: NetworkMemberInput, actor: Actor) => Promise<NetworkView>;
  readonly removeMember: (id: string, serverId: string, actor: Actor) => Promise<NetworkView>;
  /** What a server is in a network (null = in none). */
  readonly ofServer: (serverId: string) => ServerNetworkInfo | null;
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(TMP_SUFFIX_BYTES).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readOrNull(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export function createNetworkService(
  ctx: AppContext,
  servers: ServerService,
  market: MarketService,
): NetworkService {
  const { db } = ctx;
  /** Members that joined or left while running: their files change on the next start. */
  const restartPending = new Set<string>();

  const networkRow = (id: string): NetworkRow => {
    const row = db.select().from(networks).where(eq(networks.id, id)).get();
    if (!row) throw notFound('network_not_found');
    return row;
  };
  const membersOf = (networkId: string): MemberRow[] =>
    db
      .select()
      .from(networkMembers)
      .where(eq(networkMembers.networkId, networkId))
      .orderBy(asc(networkMembers.position))
      .all();
  const byProxy = (serverId: string): NetworkRow | undefined =>
    db.select().from(networks).where(eq(networks.proxyServerId, serverId)).get();
  const memberRow = (serverId: string): MemberRow | undefined =>
    db.select().from(networkMembers).where(eq(networkMembers.serverId, serverId)).get();
  const secretOf = (n: NetworkRow): string => ctx.secrets.decrypt(n.secret);
  const exists = (serverId: string): boolean => {
    try {
      servers.row(serverId);
      return true;
    } catch {
      return false;
    }
  };

  const tryOrder = (n: NetworkRow, members: readonly MemberRow[]): string[] => {
    const names = members.map((m) => m.name);
    const first = n.defaultMember && names.includes(n.defaultMember) ? n.defaultMember : names[0];
    return first ? [first, ...names.filter((name) => name !== first)] : [];
  };

  const view = (n: NetworkRow): NetworkView => {
    const members = membersOf(n.id).filter((m) => exists(m.serverId));
    const order = tryOrder(n, members);
    const proxy = servers.summary(n.proxyServerId);
    return {
      id: n.id,
      name: n.name,
      proxy: {
        serverId: proxy.id,
        serverName: proxy.name,
        state: proxy.live.state,
        players: proxy.live.playersOnline,
        address: proxy.address,
      },
      members: members.map((m) => {
        const s = servers.summary(m.serverId);
        return {
          serverId: m.serverId,
          name: m.name,
          serverName: s.name,
          software: s.software,
          version: s.version,
          state: s.live.state,
          players: s.live.playersOnline,
          isDefault: order[0] === m.name,
          restartRequired: restartPending.has(m.serverId),
        };
      }),
      defaultMember: order[0] ?? null,
      onlineMode: n.onlineMode,
      createdAt: n.createdAt,
    };
  };

  /** velocity.toml + forwarding.secret of the proxy, Floodgate and ViaVersion settings. */
  const writeProxyFiles = (n: NetworkRow): void => {
    const dir = servers.dir(n.proxyServerId);
    const members = membersOf(n.id).filter((m) => exists(m.serverId));
    const toml = velocityToml(readOrNull(path.join(dir, VELOCITY_CONFIG)), {
      port: SOFTWARE.velocity.defaultPort,
      onlineMode: n.onlineMode,
      servers: members.map((m) => {
        const row = servers.row(m.serverId);
        return {
          name: m.name,
          address: `${containerName(m.serverId)}:${SOFTWARE[row.software].defaultPort}`,
        };
      }),
      tryOrder: tryOrder(n, members),
    });
    writeAtomic(path.join(dir, VELOCITY_CONFIG), toml);
    writeAtomic(path.join(dir, SECRET_FILE), secretOf(n));
    const floodgate = readOrNull(path.join(dir, FLOODGATE_CONFIG));
    if (floodgate !== null)
      writeAtomic(path.join(dir, FLOODGATE_CONFIG), setYaml(floodgate, ['send-floodgate-data'], true));
    const via = readOrNull(path.join(dir, VIA_CONFIG));
    if (via !== null)
      writeAtomic(path.join(dir, VIA_CONFIG), setYaml(via, ['velocity-ping-interval'], VIA_PING_SECONDS));
  };

  /** Paper behind the proxy: forwarding on, own sign-in off (the proxy checks accounts), Floodgate's key. */
  const writeMemberFiles = (n: NetworkRow, serverId: string): void => {
    const dir = servers.dir(serverId);
    writeAtomic(
      path.join(dir, PAPER_GLOBAL),
      paperGlobalYaml(readOrNull(path.join(dir, PAPER_GLOBAL)), secretOf(n), n.onlineMode),
    );
    writePropertiesFile(dir, { 'online-mode': 'false' });
    const key = path.join(servers.dir(n.proxyServerId), FLOODGATE_KEY);
    if (fs.existsSync(key)) {
      fs.mkdirSync(path.join(dir, FLOODGATE_DIR), { recursive: true });
      fs.copyFileSync(key, path.join(dir, FLOODGATE_KEY));
    }
  };

  /** A server leaves its network: it signs players in itself again (it gets its own ports back). */
  const releaseMember = (serverId: string): void => {
    if (!exists(serverId)) return;
    const dir = servers.dir(serverId);
    const global = readOrNull(path.join(dir, PAPER_GLOBAL));
    if (global !== null) writeAtomic(path.join(dir, PAPER_GLOBAL), paperGlobalWithoutProxy(global));
    writePropertiesFile(dir, { 'online-mode': 'true' });
    if (servers.isRunning(serverId)) restartPending.add(serverId);
  };

  /** Running proxy: new server list right away (Velocity reloads velocity.toml). */
  const refreshProxy = async (n: NetworkRow): Promise<void> => {
    try {
      writeProxyFiles(n);
      if (servers.isRunning(n.proxyServerId)) await servers.quietCommand(n.proxyServerId, RELOAD_COMMAND);
    } catch (err) {
      ctx.log.warn({ err, serverId: n.proxyServerId }, 'proxy not refreshed');
    }
  };

  const assertFree = (serverId: string): void => {
    if (byProxy(serverId) || memberRow(serverId)) throw conflict('network_server_taken');
  };

  const hasFloodgate = (serverId: string): boolean => {
    const dir = path.join(servers.dir(serverId), PLUGINS_DIR);
    return (
      fs.existsSync(dir) &&
      fs.readdirSync(dir).some((f) => f.toLowerCase().startsWith(FLOODGATE_JAR_PREFIX) && f.endsWith(JAR))
    );
  };

  // Before every start: the network's files (and, for any Velocity server, the port the panel publishes).
  servers.onBeforeStart((serverId) => {
    try {
      const asProxy = byProxy(serverId);
      if (asProxy) return writeProxyFiles(asProxy);
      const member = memberRow(serverId);
      if (member) {
        writeMemberFiles(networkRow(member.networkId), serverId);
        restartPending.delete(serverId);
        return;
      }
      if (servers.row(serverId).software === 'velocity') {
        const file = path.join(servers.dir(serverId), VELOCITY_CONFIG);
        writeAtomic(file, velocityBind(readOrNull(file), SOFTWARE.velocity.defaultPort));
      }
    } catch (err) {
      ctx.log.warn({ err, serverId }, 'network files not written');
    }
  });

  // Bedrock players come in through Geyser on the proxy; the servers behind it need Floodgate with the same key.
  servers.onStartEnv(async (serverId) => {
    const member = memberRow(serverId);
    if (!member) return {};
    const n = networkRow(member.networkId);
    if (servers.row(n.proxyServerId).geyser && !hasFloodgate(serverId)) {
      await market.installFrom(serverId, 'geysermc', FLOODGATE_PROJECT, SYSTEM_ACTOR);
      servers.note(serverId, 'Floodgate für Bedrock-Spieler im Netzwerk installiert.');
    }
    return {};
  });

  // Servers behind a proxy are only reachable on the Minecraft network; a proxy with voice chat also takes UDP.
  servers.onContainerSpec((serverId, spec): ContainerSpec => {
    if (memberRow(serverId)) return { ...spec, ports: [] };
    const row = servers.row(serverId);
    if (row.software !== 'velocity' || !row.voiceChat) return spec;
    const main = spec.ports[0];
    if (!main || spec.ports.some((p) => p.protocol === 'udp' && p.hostPort === main.hostPort)) return spec;
    return { ...spec, ports: [...spec.ports, { ...main, protocol: 'udp' }] };
  });

  // Players reach a server behind the proxy through the proxy's address.
  servers.onAddressStandIn((row) => {
    const member = memberRow(row.id);
    if (!member) return null;
    const proxyId = db
      .select({ id: networks.proxyServerId })
      .from(networks)
      .where(eq(networks.id, member.networkId))
      .get()?.id;
    return proxyId && exists(proxyId) ? servers.row(proxyId) : null;
  });

  ctx.events.on('server.deleted', ({ serverId }) => {
    const asProxy = byProxy(serverId);
    if (asProxy) {
      membersOf(asProxy.id).forEach((m) => releaseMember(m.serverId));
      db.delete(networks).where(eq(networks.id, asProxy.id)).run();
      return;
    }
    const member = memberRow(serverId);
    if (!member) return;
    db.delete(networkMembers).where(eq(networkMembers.serverId, serverId)).run();
    void refreshProxy(networkRow(member.networkId));
  });

  return {
    list: () =>
      db
        .select()
        .from(networks)
        .orderBy(asc(networks.createdAt))
        .all()
        .filter((n) => exists(n.proxyServerId))
        .map(view),
    get: (id) => view(networkRow(id)),
    create: (input, actor) => {
      const proxy = servers.row(input.proxyServerId);
      if (proxy.software !== 'velocity') throw badRequest('network_proxy_not_velocity');
      assertFree(proxy.id);
      const id = crypto.randomUUID();
      const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
      db.insert(networks)
        .values({ id, name: input.name, proxyServerId: proxy.id, secret: ctx.secrets.encrypt(secret) })
        .run();
      ctx.audit.record(actor, 'network.create', proxy.id, { name: input.name });
      return view(networkRow(id));
    },
    update: async (id, input, actor) => {
      const n = networkRow(id);
      if (input.defaultMember && !membersOf(id).some((m) => m.name === input.defaultMember))
        throw badRequest('network_member_unknown');
      db.update(networks)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.defaultMember !== undefined ? { defaultMember: input.defaultMember } : {}),
          ...(input.onlineMode !== undefined ? { onlineMode: input.onlineMode } : {}),
        })
        .where(eq(networks.id, id))
        .run();
      const fresh = networkRow(id);
      await refreshProxy(fresh);
      if (input.onlineMode !== undefined && input.onlineMode !== n.onlineMode)
        membersOf(id)
          .filter((m) => servers.isRunning(m.serverId))
          .forEach((m) => restartPending.add(m.serverId));
      ctx.audit.record(actor, 'network.update', n.proxyServerId, { name: fresh.name });
      return view(fresh);
    },
    remove: async (id, actor) => {
      const n = networkRow(id);
      membersOf(id).forEach((m) => releaseMember(m.serverId));
      db.delete(networks).where(eq(networks.id, id)).run();
      ctx.audit.record(actor, 'network.delete', n.proxyServerId, { name: n.name });
    },
    addMember: async (id, input, actor) => {
      const n = networkRow(id);
      const row = servers.row(input.serverId);
      if (!NETWORK_MEMBER_SOFTWARE.some((sw) => sw === row.software))
        throw badRequest('network_member_software');
      assertFree(row.id);
      const members = membersOf(id);
      if (members.some((m) => m.name === input.name)) throw conflict('network_member_name_taken');
      db.insert(networkMembers)
        .values({ serverId: row.id, networkId: id, name: input.name, position: members.length })
        .run();
      if (servers.isRunning(row.id)) restartPending.add(row.id);
      await refreshProxy(n);
      ctx.audit.record(actor, 'network.member_add', row.id, { network: n.name, name: input.name });
      return view(networkRow(id));
    },
    removeMember: async (id, serverId, actor) => {
      const n = networkRow(id);
      const member = memberRow(serverId);
      if (!member || member.networkId !== id) throw notFound('network_member_unknown');
      db.delete(networkMembers).where(eq(networkMembers.serverId, serverId)).run();
      if (n.defaultMember === member.name)
        db.update(networks).set({ defaultMember: null }).where(eq(networks.id, id)).run();
      releaseMember(serverId);
      await refreshProxy(networkRow(id));
      ctx.audit.record(actor, 'network.member_remove', serverId, { network: n.name, name: member.name });
      return view(networkRow(id));
    },
    ofServer: (serverId) => {
      const asProxy = byProxy(serverId);
      if (asProxy)
        return { networkId: asProxy.id, networkName: asProxy.name, role: 'proxy', memberName: null };
      const member = memberRow(serverId);
      if (!member) return null;
      const n = networkRow(member.networkId);
      return { networkId: n.id, networkName: n.name, role: 'member', memberName: member.name };
    },
  };
}
