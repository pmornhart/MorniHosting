/* eslint-disable ts-patterns/no-magic-numbers -- demo timings, made-up live values and HTTP status codes */
import {
  GAMES,
  demoBootLines,
  demoGameCommand,
  demoJoinLine,
  demoLeaveLine,
  gameOf,
  isGameId,
  NETBIRD_DEFAULT_API,
  PORT_VOICE_CHAT,
  type Changelog,
  type ConfirmResult,
  type MailSettingsView,
  type ApprovalsView,
  type DiscordSettingsView,
  type MailQuickResult,
  type NotifyPrefsInput,
  type NotifySettingsView,
  type MailTestResult,
  type ConnectionInfo,
  type DdosHostStatus,
  type DdosStatus,
  type InstalledContent,
  type NetbirdServiceInfo,
  type DnsStatus,
  type HttpsStatus,
  type NetbirdStatus,
  type MeResponse,
  type PanelSettings,
  type PasskeyEntry,
  type RoleEntry,
  type ServerDetail,
  type ServerLive,
  type ServerPermission,
  type SystemStatus,
  type UpdateInfo,
  type UserListEntry,
  type VoiceChatResult,
  type WsClientMessage,
  type WsServerMessage,
} from '@mornihosting/shared';
import { VOICE_CHAT_SOFTWARE } from '@/features/servers/settings/VoiceChatCard';
import recordingText from './fixtures.json?raw';

/**
 * A pretend MorniHosting server that lives in the browser, so the real interface can be clicked
 * through without installing anything. Pages answer from a recording of a real demo panel; signing
 * in and out, passkeys, starting and stopping servers, the console, the admin area and updates
 * behave for real until the page is reloaded. Nothing leaves the browser.
 */

interface Fixture {
  readonly status: number;
  readonly body: unknown;
}
interface Recording {
  readonly recordedAt: string;
  readonly ids: Readonly<Record<'survival' | 'create' | 'bedrock', string>>;
  readonly fixtures: Readonly<Record<string, Fixture>>;
  readonly consoles: Readonly<Record<string, readonly string[]>>;
}
interface Reply {
  readonly status: number;
  readonly body?: unknown;
}
interface Request {
  readonly method: string;
  readonly path: string;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}
type Handler = (request: Request) => Reply | Promise<Reply>;

export const DEMO_USER = 'philip';
export const DEMO_PASSWORD = 'minecraft1';
const LATEST_VERSION = 'b886c33';
const CSRF = 'demo';

const recording = JSON.parse(recordingText) as Recording;
const SHIFT_MS = Date.now() - Date.parse(recording.recordedAt);

// A timestamp from the recording: "2026-10-28T05:39:43.575Z" and "2026-10-20T13:10:11.847288+00:00"
// match; "1.21.4" and "05:39" do not.
// https://regex101.com/?flavor=javascript&regex=%5E%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7DT%5Cd%7B2%7D%3A%5Cd%7B2%7D%3A%5Cd%7B2%7D(%5C.%5Cd%2B)%3F(Z%7C%5B%2B-%5D%5Cd%7B2%7D%3A%5Cd%7B2%7D)%24&testString=2026-10-28T05%3A39%3A43.575Z%0A2026-10-20T13%3A10%3A11.847288%2B00%3A00%0A1.21.4
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// The clock at the start of a console line: "[05:39:43] [Server thread/INFO]: Done" gives "[05:39:43]".
// https://regex101.com/?flavor=javascript&regex=%5E%5C%5B%5Cd%7B2%7D%3A%5Cd%7B2%7D%3A%5Cd%7B2%7D%5C%5D&testString=%5B05%3A39%3A43%5D%20%5BServer%20thread%2FINFO%5D%3A%20Done%0A%5Binit%5D%20Starting
const LINE_CLOCK = /^\[\d{2}:\d{2}:\d{2}\]/;

/** Moves every recorded time forward, so "two hours ago" stays two hours ago today. */
function shifted<TValue>(value: TValue): TValue {
  if (typeof value === 'string' && ISO_TIME.test(value))
    return new Date(Date.parse(value) + SHIFT_MS).toISOString() as TValue;
  if (Array.isArray(value)) return value.map(shifted) as TValue;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shifted(v)])) as TValue;
  return value;
}

const store = new Map<string, unknown>(
  Object.entries(recording.fixtures).map(([key, fixture]) => [key, shifted(fixture.body)]),
);
// The recording was made before public ports and voice chat existed.
Array.from(store)
  .filter(([key]) => key.endsWith('/connection'))
  .forEach(([key, value]) => {
    const info = value as { port: number; sharePort?: number };
    store.set(key, { sharePort: info.port, ...info });
  });
const NEW_SERVER_FIELDS = {
  publicPort: null,
  geyserPublicPort: null,
  netbird: null,
  voiceChat: false,
  voicePort: null,
  voicePublicPort: null,
  voiceHost: null,
  gameSettings: null,
  gamePorts: [],
} as const;
const failing = new Map(
  Object.entries(recording.fixtures)
    .filter(([, fixture]) => fixture.status >= 400)
    .map(([key, fixture]) => [key, fixture]),
);
const read = <TValue>(key: string): TValue => store.get(key) as TValue;

const nowIso = (): string => new Date().toISOString();
const clock = (): string => new Date().toTimeString().slice(0, 8);
const pick = <TItem>(items: readonly TItem[]): TItem | undefined =>
  items[Math.floor(Math.random() * items.length)];
const randomText = (length: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) =>
    'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.charAt(b % 56),
  ).join('');

/* ---------- State that changes while clicking around ---------- */

const adminMe = read<MeResponse>('/api/auth/me');
const roles = read<RoleEntry[]>('/api/roles');
const state = {
  userId: null as number | null,
  users: read<UserListEntry[]>('/api/users').map((u) => ({
    ...u,
    email: u.email ?? null,
    approvalPending: false,
  })),
  approvals: {
    users: [
      {
        id: 41,
        username: 'kevin',
        email: 'kevin@example.de',
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ], // eslint-disable-line ts-patterns/no-magic-numbers -- an hour ago
    requests: [
      {
        id: 'req1',
        user: { id: 7, username: 'lena', displayName: 'Lena' },
        input: {
          name: 'Lenas Insel',
          edition: 'java',
          software: 'paper',
          version: '1.21.10',
          memoryMb: 4096,
          port: 25566,
          autoStart: true,
          startNow: true,
        }, // eslint-disable-line ts-patterns/no-magic-numbers -- demo order
        status: 'pending',
        note: '',
        serverId: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: new Date(Date.now() - 600_000).toISOString(), // eslint-disable-line ts-patterns/no-magic-numbers -- ten minutes ago
      },
    ],
  } as ApprovalsView,
  discord: {
    configured: false,
    botName: null,
    appId: null,
    installUrl: null,
    online: false,
    error: null,
  } as DiscordSettingsView,
  notify: {
    prefs: { approvals: true, crashes: true, decisions: true, email: true, discord: true },
    discord: { available: false, linked: false, name: null, installUrl: null },
    emailSet: true,
  } as NotifySettingsView,
  mail: {
    configured: true,
    passwordSet: true,
    linksPossible: true,
    host: 'mail.pmornhart.de',
    internalHost: '',
    port: 587,
    security: 'starttls',
    user: 'noreply@mornihosting.de',
    from: 'MorniHosting <noreply@mornihosting.de>',
    registration: true,
    registrationOrders: true,
    crashMails: false,
  } as MailSettingsView,
  passwords: new Map<string, string>([
    [DEMO_USER, DEMO_PASSWORD],
    ['lena', 'lena-passwort-1'],
    ['finn', 'finn-passwort-1'],
  ]),
  // The demo follows the light or dark mode of the app it is shown in.
  theme: 'system' as MeResponse['user']['theme'],
  passkeys: new Map<number, PasskeyEntry[]>([
    [
      adminMe.user.id,
      [{ id: 'demo-passkey', name: 'Dieses Gerät (Demo)', createdAt: nowIso(), lastUsedAt: null }],
    ],
  ]),
  settings: read<PanelSettings>('/api/settings'),
  update: {
    current: 'a1b2c3d',
    latest: LATEST_VERSION,
    latestDate: nowIso(),
    available: true,
    behind: 4,
    changes: [
      { sha: 'd2f2b38', title: 'Joinen mit name.mornihosting.de, Doku zur eigenen Domain', date: nowIso() },
      {
        sha: '739bf54',
        title: 'Server bestellen wie bei einem Hoster: Pakete, Name, Add-ons',
        date: nowIso(),
      },
      { sha: '5c1e0aa', title: 'HTTPS für die eigene Domain: jede Adresse führt zum Panel', date: nowIso() },
      { sha: '3f9d210', title: 'INWX als DNS-Anbieter', date: nowIso() },
    ],
    url: 'https://github.com/pmornhart/MorniHosting/commits/main',
    checkedAt: nowIso(),
    checkFailed: false,
    canSelfUpdate: true,
    updating: false,
    run: null,
  } satisfies UpdateInfo as UpdateInfo,
  servers: new Map<string, ServerDetail>(
    read<ServerDetail[]>('/api/servers').map((s) => [
      s.id,
      { ...NEW_SERVER_FIELDS, ...(read<ServerDetail>(`/api/servers/${s.id}`) ?? s) },
    ]),
  ),
  consoles: new Map<string, string[]>(
    Object.entries(recording.consoles).map(([id, lines]) => [id, [...lines]]),
  ),
  /** Demo servers made with the wizard borrow pages from a recorded server of the same kind. */
  templates: new Map<string, string>(),
  ddos: { enabled: false, state: 'off', hostInstalled: true, host: null, rateLimit: null } as DdosStatus,
};

/** The host script of the DDoS protection, played back: what it reports in status.json. */
const DEMO_DDOS_HOST: DdosHostStatus = {
  active: true,
  ipv4: true,
  ipv6: true,
  docker: true,
  sysctl: true,
  tcpPorts: ['25565', '25566', '443', '80', '8080'],
  udpPorts: ['19132', '24454'],
  limits: {
    tcpNewPerMinute: 120,
    tcpBurst: 60,
    tcpConnections: 64,
    udpPacketsPerSecond: 4000,
    udpBurst: 8000,
  },
  dropped: { tcpRate: 0, tcpConnections: 0, udpRate: 0, invalid: 0 },
  error: null,
  at: nowIso(),
};

/** While the protection is on, a few made-up attackers keep it busy. */
function ddosNow(): DdosStatus {
  const host = state.ddos.host;
  if (state.ddos.state !== 'active' || !host) return state.ddos;
  const grow = (n: number, by: number): number => n + Math.round(Math.random() * by);
  state.ddos = {
    ...state.ddos,
    host: {
      ...host,
      at: nowIso(),
      dropped: {
        tcpRate: grow(host.dropped.tcpRate, 40),
        tcpConnections: grow(host.dropped.tcpConnections, 6),
        udpRate: grow(host.dropped.udpRate, 2500),
        invalid: grow(host.dropped.invalid, 12),
      },
    },
  };
  return state.ddos;
}

function setDdos(body: Readonly<Record<string, unknown>>): Reply {
  if (typeof body['rateLimit'] === 'number') state.ddos = { ...state.ddos, rateLimit: body['rateLimit'] };
  const enabled = body['enabled'];
  if (typeof enabled === 'boolean' && enabled !== state.ddos.enabled) {
    state.ddos = { ...state.ddos, enabled, state: 'waiting' };
    // The systemd unit on the host picks the wish up within seconds.
    window.setTimeout(() => {
      state.ddos = enabled
        ? {
            ...state.ddos,
            state: 'active',
            host: {
              ...DEMO_DDOS_HOST,
              at: nowIso(),
              dropped: { tcpRate: 18, tcpConnections: 2, udpRate: 3120, invalid: 7 },
            },
          }
        : {
            ...state.ddos,
            state: 'off',
            host: state.ddos.host && { ...state.ddos.host, active: false, at: nowIso() },
          };
    }, 2500);
  }
  return ok(state.ddos);
}

const userById = (id: number | null): UserListEntry | undefined => state.users.find((u) => u.id === id);

function permissionsOf(user: UserListEntry): Record<string, readonly ServerPermission[]> {
  if (user.isAdmin) return adminMe.access;
  return Object.fromEntries(
    user.access.map((a) => [a.serverId, roles.find((r) => r.id === a.roleId)?.permissions ?? []]),
  );
}

function meNow(): MeResponse | null {
  const user = userById(state.userId);
  if (!user) return null;
  const { access: _access, ...info } = user;
  return { user: { ...info, theme: state.theme }, csrfToken: CSRF, access: permissionsOf(user) };
}

/* ---------- Live updates (the WebSocket) ---------- */

class DemoSocket extends EventTarget {
  readyState = 0;
  servers = false;
  readonly consoles = new Set<string>();

  constructor() {
    super();
    sockets.add(this);
    window.setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }, 60);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as WsClientMessage;
    if (message.type === 'subscribe' && message.channel === 'servers') this.servers = true;
    if (message.type === 'subscribe' && message.channel === 'console') {
      this.consoles.add(message.serverId);
      this.emit({
        type: 'console-history',
        serverId: message.serverId,
        lines: state.consoles.get(message.serverId) ?? [],
      });
    }
    if (message.type === 'unsubscribe') this.consoles.delete(message.serverId);
    if (message.type === 'ping') this.emit({ type: 'pong' });
  }

  close(): void {
    this.readyState = 3;
    sockets.delete(this);
    this.dispatchEvent(new Event('close'));
  }

  emit(message: WsServerMessage): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}
const sockets = new Set<DemoSocket>();

function log(serverId: string, line: string): void {
  const lines = [...(state.consoles.get(serverId) ?? []), line].slice(-500);
  state.consoles.set(serverId, lines);
  sockets.forEach((s) =>
    s.consoles.has(serverId) ? s.emit({ type: 'console', serverId, line }) : undefined,
  );
}
const info = (text: string): string => `[${clock()}] [Server thread/INFO]: ${text}`;

function setLive(serverId: string, patch: Partial<ServerLive>): void {
  const server = state.servers.get(serverId);
  if (!server) return;
  const live = { ...server.live, ...patch };
  state.servers.set(serverId, { ...server, live });
  sockets.forEach((s) => (s.servers ? s.emit({ type: 'live', serverId, live }) : undefined));
}

const PLAYERS = [
  'Lena_Baut',
  'Papa_M',
  'Finn2015',
  'Mia.Builds',
  'KaiKocht',
  'Juna',
  'Tobi_04',
  'Pixelpaul',
  'Ella',
];

/** Every two seconds: a little CPU and RAM movement, and now and then someone joins or leaves. */
function tick(): void {
  state.servers.forEach((server, id) => {
    const live = server.live;
    if (live.state !== 'running') return;
    const roll = Math.random();
    const leaving = roll < 0.06 && live.players.length > 0 ? pick(live.players) : undefined;
    const joining =
      roll > 0.92 && live.players.length < 8
        ? pick(PLAYERS.filter((p) => !live.players.includes(p)))
        : undefined;
    const players = [...live.players.filter((p) => p !== leaving), ...(joining ? [joining] : [])];
    const game = gameOf(server.software);
    if (joining) log(id, game ? demoJoinLine(game, joining) : info(`${joining} joined the game`));
    if (leaving) log(id, game ? demoLeaveLine(game, leaving) : info(`${leaving} left the game`));
    const base = server.edition === 'bedrock' ? 5 : 9;
    setLive(id, {
      players,
      playersOnline: players.length,
      cpuPercent: base + players.length * 3 + Math.random() * 6,
      memoryMb: Math.min(
        server.memoryMb * 0.92,
        server.memoryMb * 0.45 + players.length * 160 + Math.random() * 90,
      ),
      tps:
        server.edition === 'java' ? Math.min(20, 19.5 + Math.random() * 0.6 - players.length * 0.04) : null,
      // Traffic grows with the players; the folder stays about the size of a small world.
      netRxBytes: (live.netRxBytes ?? 0) + 2_000 + players.length * 9_000 * Math.random(),
      netTxBytes: (live.netTxBytes ?? 0) + 2_000 + players.length * 60_000 * Math.random(),
      diskMb: live.diskMb ?? (server.edition === 'java' ? 418 : 126),
    });
  });
}

/* ---------- Starting and stopping ---------- */

const STEP_MS = 700;
const after = (ms: number, run: () => void): void => {
  window.setTimeout(run, ms);
};

function templateOf(serverId: string): string {
  return state.templates.get(serverId) ?? serverId;
}

function startServer(serverId: string): void {
  const server = state.servers.get(serverId);
  if (!server) return;
  setLive(serverId, { state: 'starting', progress: 0, startedAt: null });
  log(
    serverId,
    `\u001b[33m[MorniHosting]\u001b[0m Server wird gestartet (${gameOf(server.software)?.label ?? `${server.software} ${server.version}`}) …`,
  );
  const game = gameOf(server.software);
  const boot = game
    ? demoBootLines(game, { version: server.version, port: server.port }).slice(0, -1)
    : (recording.consoles[templateOf(serverId)] ?? [])
        .filter((line) => LINE_CLOCK.test(line))
        .slice(0, 12)
        .map((line) => `[${clock()}]${line.replace(LINE_CLOCK, '')}`);
  boot.forEach((line, i) => after((i + 1) * 260, () => log(serverId, line)));
  [25, 55, 80, 95].forEach((progress, i) => after((i + 1) * STEP_MS, () => setLive(serverId, { progress })));
  after(STEP_MS * 5, () => {
    log(
      serverId,
      game
        ? (demoBootLines(game, { version: server.version, port: server.port }).at(-1) ?? '')
        : info('Done (3.214s)! For help, type "help"'),
    );
    setLive(serverId, {
      state: 'running',
      progress: null,
      startedAt: nowIso(),
      players: [],
      playersOnline: 0,
      cpuPercent: 30,
      memoryMb: server.memoryMb * 0.4,
      tps: server.edition === 'java' ? 20 : null,
      playersMax: game?.maxPlayers ?? server.live.playersMax,
    });
  });
}

function stopServer(serverId: string, then?: () => void): void {
  setLive(serverId, { state: 'stopping', progress: null });
  const game = gameOf(state.servers.get(serverId)?.software ?? '');
  const lines = game
    ? [game.saveCommand, game.stopCommand].flatMap((c) => (c ? demoGameCommand(game, c, []).lines : []))
    : [info('Stopping the server'), info('Saving worlds')];
  lines.forEach((line) => log(serverId, line));
  after(STEP_MS * 2, () => {
    setLive(serverId, {
      state: 'stopped',
      players: [],
      playersOnline: 0,
      cpuPercent: null,
      memoryMb: null,
      tps: null,
      netRxBytes: null,
      netTxBytes: null,
      startedAt: null,
    });
    log(serverId, '\u001b[33m[MorniHosting]\u001b[0m Server ist gestoppt. Die Welt ist gespeichert.');
    then?.();
  });
}

const ACTIONS: Readonly<Record<string, (serverId: string) => void>> = {
  start: startServer,
  stop: (id) => stopServer(id),
  restart: (id) => stopServer(id, () => startServer(id)),
  kill: (id) => {
    setLive(id, {
      state: 'stopped',
      players: [],
      playersOnline: 0,
      cpuPercent: null,
      memoryMb: null,
      tps: null,
    });
    log(id, '\u001b[31m[MorniHosting]\u001b[0m Server wurde hart beendet.');
  },
};

function answerFor(serverId: string, command: string): string {
  const live = state.servers.get(serverId)?.live;
  const [verb = '', ...rest] = command.split(' ');
  const answers: Readonly<Record<string, () => string>> = {
    list: () =>
      `There are ${live?.playersOnline ?? 0} of a max of ${live?.playersMax ?? 20} players online: ${live?.players.join(', ') ?? ''}`,
    say: () => `[Server] ${rest.join(' ')}`,
    op: () => `Made ${rest[0] ?? '?'} a server operator`,
    deop: () => `Made ${rest[0] ?? '?'} no longer a server operator`,
    time: () => 'Set the time to 1000',
    weather: () => 'Set the weather to clear',
    tps: () => 'TPS from last 1m, 5m, 15m: 20.0, 20.0, 19.98',
    help: () => 'Demo: probiere list, say Hallo, op Lena_Baut, time set day oder weather clear',
  };
  return answers[verb]?.() ?? `Befehl ausgeführt: ${command} (Demo)`;
}

/* ---------- Server settings: public port, Geyser, voice chat ---------- */

const GEYSER_PORT = 19132;
const JAVA_PORT = 25565;
const VOICE_JAR = 'voicechat-bukkit-2.6.26.jar';

function changeServer(id: string, change: Partial<ServerDetail>): ServerDetail | undefined {
  const current = state.servers.get(id);
  if (!current) return undefined;
  const next = { ...current, ...change };
  state.servers.set(id, next);
  return next;
}

const publicName = (server: ServerDetail): string => server.domain || state.settings.publicAddress;

function addressWith(server: ServerDetail, publicPort: number | null): string {
  const name = publicName(server);
  if (!name) return server.address;
  const port = publicPort ?? server.port;
  return port === JAVA_PORT ? name : `${name}:${port}`;
}

function patchServer(id: string, body: Readonly<Record<string, unknown>>): Reply {
  const server = state.servers.get(id);
  if (!server) return error(404, 'not_found');
  const publicPort =
    'publicPort' in body ? ((body['publicPort'] as number | null) ?? null) : server.publicPort;
  return ok(changeServer(id, { ...body, publicPort, address: addressWith(server, publicPort) }));
}

/** The IP card: recorded IPs, but domain and ports of this very server (NetBird name, public port). */
function connectionOf(id: string): Reply {
  const server = state.servers.get(id);
  const recorded = read<ConnectionInfo | undefined>(`/api/servers/${templateOf(id)}/connection`);
  if (!server || !recorded) return error(404, 'not_found');
  const domain = server.domain ?? recorded.domain;
  return ok({
    ...recorded,
    domain,
    port: server.port,
    sharePort: domain && server.publicPort ? server.publicPort : server.port,
    srv: dns.configured && Boolean(server.netbird) && server.edition === 'java',
  } satisfies ConnectionInfo);
}

function setContent(id: string, fileName: string, entry: InstalledContent | null, enabled: boolean): void {
  const key = `/api/servers/${templateOf(id)}/content`;
  const list = read<InstalledContent[] | undefined>(key) ?? [];
  const known = list.some((c) => c.fileName === fileName);
  const next = known ? list.map((c) => (c.fileName === fileName ? { ...c, enabled } : c)) : list;
  store.set(key, !known && entry ? [...next, entry] : next);
}

function setGeyser(id: string, enabled: boolean): Reply {
  const server = changeServer(id, { geyser: enabled, geyserPort: enabled ? GEYSER_PORT : null });
  if (!server) return error(404, 'not_found');
  followNetbird(id);
  return ok({ enabled, port: server.geyserPort, restartRequired: server.live.state === 'running' });
}

function setVoiceChat(id: string, body: Readonly<Record<string, unknown>>): Reply {
  const server = state.servers.get(id);
  if (!server) return error(404, 'not_found');
  if (server.edition === 'bedrock') return error(400, 'voicechat_java_only');
  if (!VOICE_CHAT_SOFTWARE.includes(server.software)) return error(400, 'voicechat_unsupported');
  const enabled = body['enabled'] === true;
  const others = Array.from(state.servers.values()).filter((s) => s.id !== id && s.voicePort !== null).length;
  const port = enabled ? (server.voicePort ?? PORT_VOICE_CHAT + others) : null;
  const voicePublicPort = enabled ? ((body['publicPort'] as number | null | undefined) ?? null) : null;
  const name = publicName(server);
  const outside = String(voicePublicPort ?? port);
  const reachable = name ? `${name}:${outside}` : outside;
  const voiceHost = enabled ? reachable : null;
  changeServer(id, { voiceChat: enabled, voicePort: port, voicePublicPort, voiceHost });
  followNetbird(id);
  setContent(
    id,
    VOICE_JAR,
    {
      fileName: VOICE_JAR,
      enabled: true,
      size: 1_482_311,
      modifiedAt: nowIso(),
      source: 'modrinth',
      projectId: '9eGKb6K1',
      name: 'Simple Voice Chat',
      versionName: '2.6.26',
      iconUrl: null,
      url: 'https://modrinth.com/plugin/9eGKb6K1',
      dependencyOf: null,
      update: null,
    },
    enabled,
  );
  return ok({
    enabled,
    port,
    voiceHost,
    restartRequired: server.live.state === 'running',
  } satisfies VoiceChatResult);
}

/* ---------- Linked Minecraft account ---------- */

// A Java name as Mojang accepts it: "Philip_MC" matches; "ab" and "Finn 2015" do not.
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_%5D%7B3%2C16%7D%24&flags=gm&testString=Philip_MC%0Aab%0AFinn%202015
const JAVA_NAME = /^[A-Za-z0-9_]{3,16}$/;
const UUID_HEX = 32;
const HEX = 16;

/** Links (or with null unlinks) the demo user's Minecraft account; the uuid is made up from the name. */
function linkMinecraft(name: string | null): Reply {
  if (name !== null && !JAVA_NAME.test(name)) return error(404, 'player_unknown');
  const hex = Array.from(name ?? '', (c) => c.charCodeAt(0).toString(HEX))
    .join('')
    .padEnd(UUID_HEX, '0')
    .slice(0, UUID_HEX);
  const uuid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join(
    '-',
  );
  state.users = state.users.map((u) =>
    u.id === state.userId ? { ...u, minecraft: name ? { name, uuid } : null } : u,
  );
  return ok({ user: meNow()?.user });
}

/* ---------- NetBird automation (pretend account with one domain) ---------- */

const DEMO_DOMAIN = 'moinmornhart.de';
const DEMO_PEER = { id: 'peer-mh', name: 'mornihosting', ip: '100.92.14.7', connected: true };
const NOT_CONNECTED: NetbirdStatus = {
  configured: false,
  apiUrl: NETBIRD_DEFAULT_API,
  domain: null,
  peerId: null,
  peerName: null,
  panelAddress: null,
  customPorts: false,
  openPorts: [],
};
const netbird = { status: NOT_CONNECTED, nextPort: 31000 };

/* ---------- Own domain (mornihosting.de at INWX, with HTTPS) ---------- */

const OWN_DOMAIN = 'mornihosting.de';
const OWN_IP = '203.0.113.25';
const BEDROCK_STANDARD_PORT = 19132;
/** The recorded servers get names under the own domain, as Philip would pick them. */
const OWN_NAMES: Readonly<Record<string, string>> = {
  'Survival mit Freunden': 'survival',
  'Create-Modpack': 'create',
  'Bedrock für die Kids': 'kids',
};
const dns = { configured: true, https: true };

function dnsStatus(): DnsStatus {
  return {
    configured: dns.configured,
    provider: dns.configured ? 'inwx' : null,
    domain: dns.configured ? OWN_DOMAIN : null,
    ip: dns.configured ? OWN_IP : null,
    ipCheckedAt: dns.configured ? nowIso() : null,
    error: null,
    netbirdActive: netbird.status.configured,
  };
}

function httpsStatus(): HttpsStatus {
  return { enabled: dns.https, domain: dns.configured ? OWN_DOMAIN : null, running: dns.https, error: null };
}

/** With the own domain: name.mornihosting.de on the server's own port (A record, SRV for Java). */
function setDomainName(server: ServerDetail, name: string | null): ServerDetail | undefined {
  if (!name)
    return changeServer(server.id, { netbird: null, domain: null, publicPort: null, geyserPublicPort: null });
  const host = `${name}.${OWN_DOMAIN}`;
  const java = server.edition === 'java';
  return changeServer(server.id, {
    netbird: {
      name,
      services: [
        { purpose: 'main', domain: host, port: server.port },
        ...(server.geyser && server.geyserPort
          ? [{ purpose: 'geyser', domain: host, port: server.geyserPort } as const]
          : []),
        ...(server.voiceChat && server.voicePort
          ? [{ purpose: 'voice', domain: host, port: server.voicePort } as const]
          : []),
      ],
      error: null,
    },
    domain: host,
    publicPort: null,
    geyserPublicPort: null,
    voicePublicPort: null,
    address: java || server.port === BEDROCK_STANDARD_PORT ? host : `${host}:${server.port}`,
    voiceHost: server.voiceChat && server.voicePort ? `${host}:${server.voicePort}` : null,
  });
}

/** Gives a server its NetBird names; outside ports are handed out like NetBird Cloud does. */
function setNetbirdName(id: string, name: string | null): ServerDetail | undefined {
  const server = state.servers.get(id);
  const domain = netbird.status.domain;
  if (!server) return undefined;
  if (dns.configured) return setDomainName(server, name);
  if (!name || !domain) {
    return changeServer(id, { netbird: null, domain: null, publicPort: null, geyserPublicPort: null });
  }
  const known = (purpose: string): number | null =>
    server.netbird?.services.find((s) => s.purpose === purpose)?.port ?? null;
  const portFor = (purpose: string): number => known(purpose) ?? netbird.nextPort++;
  const services: NetbirdServiceInfo[] = [
    { purpose: 'main', domain: `${name}.${domain}`, port: portFor('main') },
    ...(server.geyser
      ? [{ purpose: 'geyser', domain: `${name}-bedrock.${domain}`, port: portFor('geyser') } as const]
      : []),
    ...(server.voiceChat
      ? [{ purpose: 'voice', domain: `${name}-voice.${domain}`, port: portFor('voice') } as const]
      : []),
  ];
  const port = (purpose: string): number | null => services.find((s) => s.purpose === purpose)?.port ?? null;
  return changeServer(id, {
    netbird: { name, services, error: null },
    domain: `${name}.${domain}`,
    publicPort: port('main'),
    address: `${name}.${domain}:${port('main')}`,
    geyserPublicPort: port('geyser'),
    voicePublicPort: port('voice'),
    voiceHost: server.voiceChat ? `${name}.${domain}:${port('voice')}` : null,
  });
}

/** Every recorded server gets its name under the own domain. */
function nameAll(): void {
  Array.from(state.servers.values()).forEach((server) =>
    setNetbirdName(server.id, OWN_NAMES[server.name] ?? null),
  );
}

/** After Geyser or voice chat changed, NetBird follows. */
function followNetbird(id: string): void {
  const name = state.servers.get(id)?.netbird?.name;
  if (name) setNetbirdName(id, name);
}

/* ---------- Routes ---------- */

const ok = (body?: unknown): Reply => ({ status: 200, body });
const noContent = (): Reply => ({ status: 204 });
const error = (status: number, code: string): Reply => ({ status, body: { error: code, params: {} } });
const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function summaries(): ServerDetail[] {
  const me = meNow();
  return Array.from(state.servers.values()).filter((s) => me?.user.isAdmin || Boolean(me?.access[s.id]));
}

function signIn(user: UserListEntry): Reply {
  state.userId = user.id;
  state.users = state.users.map((u) => (u.id === user.id ? { ...u, lastLoginAt: nowIso() } : u));
  return ok({ status: 'ok', me: meNow() });
}

/** Fields of another game's server in the demo: its settings (secrets only as "stored") and ports. */
function gameFields(
  game: string,
  body: Readonly<Record<string, unknown>>,
  port: number,
): Partial<ServerDetail> {
  if (!isGameId(game)) return {};
  const info = GAMES[game];
  const typed = (body['gameSettings'] ?? {}) as Record<string, string>;
  const secret = (key: string): boolean => info.fields.some((f) => f.key === key && f.kind === 'secret');
  const filled = Object.entries(typed).filter(([, value]) => value !== '');
  return {
    image: `${info.image}:${String(body['version'] ?? 'stable')}`,
    gameSettings: {
      values: Object.fromEntries(filled.filter(([key]) => !secret(key))),
      secretsSet: filled.filter(([key]) => secret(key)).map(([key]) => key),
    },
    gamePorts: info.ports.map((p, i) => ({
      key: p.key,
      port: i === 0 || p.sameAsMain ? port : p.defaultPort,
      protocol: p.protocol,
    })),
    hasIcon: false,
    address: `${state.settings.publicAddress || 'localhost'}:${port}`,
  };
}

function createServer(body: Readonly<Record<string, unknown>>): Reply {
  const requested = String(body['edition'] ?? '');
  const edition = requested === 'bedrock' || isGameId(requested) ? requested : 'java';
  const template = edition === 'bedrock' ? recording.ids.bedrock : recording.ids.survival;
  const base = state.servers.get(template);
  if (!base) return error(500, 'generic');
  const id = randomText(10).toLowerCase();
  const memoryMb = Number(body['memoryMb']) || base.memoryMb;
  const server: ServerDetail = {
    ...base,
    id,
    name: String(body['name'] ?? 'Neuer Server'),
    edition,
    software: (body['software'] as ServerDetail['software']) ?? base.software,
    version: String(body['version'] ?? base.version),
    memoryMb,
    port: Number(body['port']) || base.port,
    geyser: false,
    geyserPort: null,
    netbird: null,
    domain: null,
    publicPort: null,
    address: base.address,
    createdAt: nowIso(),
    live: {
      ...base.live,
      state: 'stopped',
      players: [],
      playersOnline: 0,
      cpuPercent: null,
      memoryMb: null,
      tps: null,
    },
    ...gameFields(edition, body, Number(body['port']) || base.port),
  };
  state.servers.set(id, server);
  state.templates.set(id, template);
  state.consoles.set(id, []);
  if (body['startNow'] !== false) after(300, () => startServer(id));
  const named = typeof body['netbirdName'] === 'string' ? setNetbirdName(id, body['netbirdName']) : undefined;
  return ok(named ?? server);
}

/** Specific behaviour; everything else answers from the recording or is accepted and forgotten. */
const ROUTES: readonly (readonly [string, string, Handler])[] = [
  [
    'GET',
    '/api/system/status',
    () =>
      ok({
        setupRequired: false,
        version: state.update.current,
        docker: { ok: true },
        demo: true,
        defaultLocale: 'de',
        passkeys: 'ok',
        panelDomain: state.settings.panelDomain || null,
        mail: {
          registration: state.mail.registration,
          passwordReset: state.mail.configured,
        },
      } satisfies SystemStatus),
  ],
  ['GET', '/api/auth/me', () => ok(meNow())],
  [
    'POST',
    '/api/auth/login',
    ({ body }) => {
      const name = String(body['username'] ?? '').toLowerCase();
      const user = state.users.find((u) => u.username.toLowerCase() === name);
      const valid = user && !user.disabled && state.passwords.get(user.username) === body['password'];
      return valid ? signIn(user) : error(401, 'invalid_credentials');
    },
  ],
  [
    'POST',
    '/api/auth/logout',
    () => {
      state.userId = null;
      return noContent();
    },
  ],
  [
    'POST',
    '/api/auth/passkey/options',
    () => ok({ challenge: randomText(32), rpId: location.hostname, userVerification: 'preferred' }),
  ],
  [
    'POST',
    '/api/auth/passkey/login',
    ({ body }) => {
      const id = String((body['response'] as { id?: string } | undefined)?.id ?? '');
      const owner = Array.from(state.passkeys).find(([, keys]) => keys.some((k) => k.id === id));
      const user = userById(owner?.[0] ?? null);
      if (!owner || !user) return error(401, 'passkey_unknown');
      state.passkeys.set(
        owner[0],
        owner[1].map((k) => (k.id === id ? { ...k, lastUsedAt: nowIso() } : k)),
      );
      return signIn(user);
    },
  ],
  ['GET', '/api/account/passkeys', () => ok(state.passkeys.get(state.userId ?? -1) ?? [])],
  ['GET', '/api/approvals', () => ok(state.approvals)],
  [
    'POST',
    '/api/approvals/users/:id/:decision',
    ({ params }) => {
      const user = state.approvals.users.find((u) => String(u.id) === params['id']);
      state.approvals = { ...state.approvals, users: state.approvals.users.filter((u) => u !== user) };
      return ok(
        params['decision'] === 'approve'
          ? { title: '✅ Freigegeben', text: `${user?.username ?? ''} kann sich jetzt anmelden.` }
          : { title: '❌ Abgelehnt', text: `Die Registrierung von ${user?.username ?? ''} wurde gelöscht.` },
      );
    },
  ],
  [
    'POST',
    '/api/server-requests/:id/:decision',
    ({ params }) => {
      const approved = params['decision'] === 'approve';
      state.approvals = {
        ...state.approvals,
        requests: state.approvals.requests.map((r) =>
          r.id === params['id']
            ? {
                ...r,
                status: approved ? 'approved' : 'rejected',
                decidedBy: 'philip',
                decidedAt: new Date().toISOString(),
              }
            : r,
        ),
      };
      return ok(
        approved
          ? { title: '✅ Angenommen', text: 'Der Server wird angelegt.' }
          : { title: '❌ Abgelehnt', text: 'Die Anfrage wurde abgelehnt.' },
      );
    },
  ],
  ['POST', '/api/server-requests', () => ok({})],
  ['GET', '/api/server-requests/mine', () => ok([])],
  ['GET', '/api/discord', () => ok(state.discord)],
  [
    'PUT',
    '/api/discord',
    () => {
      state.discord = {
        configured: true,
        botName: 'MorniBot',
        appId: '1300000000000000000',
        installUrl:
          'https://discord.com/oauth2/authorize?client_id=1300000000000000000&integration_type=1&scope=applications.commands',
        online: true,
        error: null,
      };
      return ok(state.discord);
    },
  ],
  [
    'DELETE',
    '/api/discord',
    () => {
      state.discord = { ...state.discord, configured: false, online: false, botName: null, installUrl: null };
      return noContent();
    },
  ],
  [
    'GET',
    '/api/account/notifications',
    () =>
      ok({
        ...state.notify,
        discord: {
          ...state.notify.discord,
          available: state.discord.configured,
          installUrl: state.discord.installUrl,
        },
      }),
  ],
  [
    'PUT',
    '/api/account/notifications',
    ({ body }) => {
      state.notify = { ...state.notify, prefs: body as unknown as NotifyPrefsInput };
      return ok({
        ...state.notify,
        discord: {
          ...state.notify.discord,
          available: state.discord.configured,
          installUrl: state.discord.installUrl,
        },
      });
    },
  ],
  [
    'POST',
    '/api/account/discord/code',
    () => {
      // The demo pretends /verbinden arrives a few seconds later.
      setTimeout(() => {
        state.notify = {
          ...state.notify,
          discord: { ...state.notify.discord, linked: true, name: 'philip' },
        };
      }, 4000); // eslint-disable-line ts-patterns/no-magic-numbers -- a few seconds, like typing the command
      return ok({ code: '482913', expiresAt: new Date(Date.now() + 600_000).toISOString() }); // eslint-disable-line ts-patterns/no-magic-numbers -- ten minutes
    },
  ],
  [
    'POST',
    '/api/account/discord/test',
    () => (state.notify.discord.linked ? noContent() : error(400, 'discord_not_linked')),
  ],
  [
    'DELETE',
    '/api/account/discord',
    () => {
      state.notify = { ...state.notify, discord: { ...state.notify.discord, linked: false, name: null } };
      return noContent();
    },
  ],
  ['GET', '/api/mail', () => ok(state.mail)],
  [
    'PUT',
    '/api/mail',
    ({ body }) => {
      state.mail = {
        ...(body as unknown as MailSettingsView),
        configured: true,
        passwordSet: state.mail.passwordSet || Boolean(body['password']),
        linksPossible: true,
      };
      return ok(state.mail);
    },
  ],
  [
    'DELETE',
    '/api/mail',
    () => {
      state.mail = { ...state.mail, configured: false, passwordSet: false, registration: false };
      return noContent();
    },
  ],
  [
    'POST',
    '/api/mail/test',
    ({ body }) => {
      const to = String(body['to'] ?? '') || meNow()?.user.email || 'philip@mornihosting.de';
      // Like a mail server that only listens on 465: the saved 587 gets no answer, 465 with TLS is found and kept.
      const silent = state.mail.port !== 465; // eslint-disable-line ts-patterns/no-magic-numbers -- SMTP with implicit TLS
      const tried = { port: state.mail.port, security: state.mail.security, problem: 'timeout' as const };
      if (silent) state.mail = { ...state.mail, port: 465, security: 'tls' }; // eslint-disable-line ts-patterns/no-magic-numbers -- SMTP with implicit TLS
      const target = state.mail.internalHost || state.mail.host;
      return ok({
        ok: true,
        sentTo: to,
        steps: [
          { step: 'dns', state: 'ok', detail: state.mail.internalHost || `${target} → 192.168.178.116` },
          { step: 'connect', state: 'ok', detail: `${state.mail.internalHost || '192.168.178.116'}:465` },
          { step: 'tls', state: 'ok', detail: state.mail.host },
          { step: 'login', state: 'ok', detail: state.mail.user },
          { step: 'send', state: 'ok' },
        ],
        problem: null,
        message: '',
        attempts: silent ? [tried, { port: 465, security: 'tls', problem: null }] : [], // eslint-disable-line ts-patterns/no-magic-numbers -- SMTP with implicit TLS
        switchedTo: silent ? { port: 465, security: 'tls' } : null, // eslint-disable-line ts-patterns/no-magic-numbers -- SMTP with implicit TLS
      } satisfies MailTestResult);
    },
  ],
  [
    'POST',
    '/api/mail/quick',
    ({ body }) => {
      const email = String(body['email'] ?? 'noreply@mornihosting.de');
      const domain = email.split('@')[1] ?? 'mornihosting.de';
      const internalHost = String(body['internalHost'] ?? '');
      const host = `mail.${domain}`;
      state.mail = {
        ...state.mail,
        configured: true,
        passwordSet: true,
        host,
        internalHost,
        port: 465,
        security: 'tls',
        user: email,
      }; // eslint-disable-line ts-patterns/no-magic-numbers -- SMTP with implicit TLS
      const at = internalHost || '192.168.178.116';
      return ok({
        found: { host, port: 465, security: 'tls' }, // eslint-disable-line ts-patterns/no-magic-numbers -- SMTP with implicit TLS
        tried: [],
        closest: null,
        test: {
          ok: true,
          sentTo: meNow()?.user.email || email,
          steps: [
            { step: 'dns', state: 'ok', detail: at },
            { step: 'connect', state: 'ok', detail: `${at}:465` },
            { step: 'tls', state: 'ok', detail: host },
            { step: 'login', state: 'ok', detail: email },
            { step: 'send', state: 'ok' },
          ],
          problem: null,
          message: '',
          attempts: [],
          switchedTo: null,
        },
      } satisfies MailQuickResult);
    },
  ],
  ['POST', '/api/auth/register', () => ok({ next: 'wait_approval' })],
  ['GET', '/api/signup', () => ok({ enabled: state.mail.registration })],
  [
    'PUT',
    '/api/signup',
    ({ body }) => {
      state.mail = { ...state.mail, registration: Boolean(body['enabled']) };
      return ok({ enabled: state.mail.registration });
    },
  ],
  ['POST', '/api/auth/confirm', () => ok({ kind: 'register' } satisfies ConfirmResult)],
  ['POST', '/api/auth/forgot', () => noContent()],
  ['POST', '/api/auth/reset', () => noContent()],
  [
    'PUT',
    '/api/account/email',
    ({ body }) => {
      const email = String(body['email'] ?? '');
      state.users = state.users.map((u) => (u.id === state.userId ? { ...u, email } : u));
      return noContent();
    },
  ],
  [
    'DELETE',
    '/api/account/email',
    () => {
      state.users = state.users.map((u) => (u.id === state.userId ? { ...u, email: null } : u));
      return noContent();
    },
  ],
  ['PUT', '/api/account/minecraft', ({ body }) => linkMinecraft(String(body['name'] ?? ''))],
  ['DELETE', '/api/account/minecraft', () => linkMinecraft(null)],
  ['POST', '/api/account/passkeys/options', () => ok({ challenge: randomText(32) })],
  [
    'POST',
    '/api/account/passkeys',
    ({ body }) => {
      const id = String((body['response'] as { id?: string } | undefined)?.id ?? randomText(16));
      const list = [
        ...(state.passkeys.get(state.userId ?? -1) ?? []),
        { id, name: String(body['name'] ?? 'Passkey'), createdAt: nowIso(), lastUsedAt: null },
      ];
      state.passkeys.set(state.userId ?? -1, list);
      return ok(list);
    },
  ],
  [
    'DELETE',
    '/api/account/passkeys/:id',
    ({ params }) => {
      const list = (state.passkeys.get(state.userId ?? -1) ?? []).filter((k) => k.id !== params['id']);
      state.passkeys.set(state.userId ?? -1, list);
      return noContent();
    },
  ],
  [
    'PATCH',
    '/api/account',
    ({ body }) => {
      if (typeof body['theme'] === 'string') state.theme = body['theme'] as MeResponse['user']['theme'];
      if (typeof body['displayName'] === 'string')
        state.users = state.users.map((u) =>
          u.id === state.userId ? { ...u, displayName: String(body['displayName']) } : u,
        );
      return ok(meNow());
    },
  ],
  [
    'POST',
    '/api/account/password',
    ({ body }) => {
      const user = userById(state.userId);
      if (!user || state.passwords.get(user.username) !== body['current'])
        return error(400, 'wrong_password');
      state.passwords.set(user.username, String(body['next']));
      return noContent();
    },
  ],
  ['GET', '/api/settings', () => ok(state.settings)],
  [
    'PUT',
    '/api/settings',
    ({ body }) => {
      const { curseforgeApiKey, ...rest } = body;
      state.settings = {
        ...state.settings,
        ...rest,
        curseforgeConfigured: state.settings.curseforgeConfigured || Boolean(curseforgeApiKey),
      } as PanelSettings;
      return ok(state.settings);
    },
  ],
  ['GET', '/api/system/update', () => ok(state.update)],
  ['GET', '/api/ddos', () => ok(ddosNow())],
  ['PUT', '/api/ddos', ({ body }) => setDdos(body)],
  [
    'GET',
    '/api/system/changelog',
    () =>
      ok({
        release: '1.0.0',
        commit: state.update.current,
        url: 'https://github.com/pmornhart/MorniHosting/commits/main',
        failed: false,
        changes: [
          ['ce95d5c', 'Server-Panel im neuen Design', 0.2],
          ['a8a2fea', 'Heller Modus in der Claude-App, fester Server-Kopf, neues Icon, INWX-Meldung', 1],
          ['95e46a2', 'Echte Software-Logos, Vanilla zuerst, Bestellseite ohne Vorauswahl', 2],
          ['092c7d1', 'Echte Minecraft-Bilder bei der Spielauswahl, Schrift in der Demo lesbar', 3],
          ['ffa4635', 'Pakete als Minecraft-Erze, schwarze Schrift auf dem iPhone behoben', 4],
          ['e937dbc', 'Spielauswahl mit großen Bildkarten, gleich große Symbole, Karten bündig', 5],
          ['16331a3', 'Minecraft-Blöcke als Server-Icons, Logos von Paper und Geyser', 6],
        ].map(([sha, title, hours]) => ({
          sha: String(sha),
          title: String(title),
          date: new Date(Date.now() - Number(hours) * 3_600_000).toISOString(),
        })),
      } satisfies Changelog),
  ],
  [
    'POST',
    '/api/system/update',
    () => {
      // The host updater, played back: fetch code, build, restart – with its output in the log.
      const log: string[] = [];
      const step = (
        state_: 'requested' | 'running' | 'done',
        at: 'pull' | 'build' | 'restart' | null,
        line?: string,
      ) => {
        if (line) log.push(line);
        state.update = {
          ...state.update,
          updating: state_ !== 'done',
          run: { state: state_, step: at, at: nowIso(), log: [...log] },
        };
      };
      step('requested', null);
      after(1500, () => step('running', 'pull', ' … Neuer Code wird geholt'));
      after(3000, () => step('running', 'build', ` ✔ Code aktuell (${LATEST_VERSION})`));
      after(3200, () => step('running', 'build', ' … Neues Panel wird gebaut (dauert ein paar Minuten)'));
      after(7000, () => step('running', 'restart', ' ✔ Panel gebaut'));
      after(7200, () => step('running', 'restart', ' … Panel wird neu gestartet'));
      after(9000, () => {
        step('done', null, ' ✔ Fertig. Deine Minecraft-Server sind die ganze Zeit weitergelaufen.');
        state.update = { ...state.update, current: LATEST_VERSION, available: false, behind: 0, changes: [] };
      });
      return ok(state.update);
    },
  ],
  ['POST', '/api/system/update/check', () => ok({ ...state.update, checkedAt: nowIso() })],
  ['GET', '/api/users', () => ok(state.users)],
  [
    'POST',
    '/api/users',
    ({ body }) => {
      const username = String(body['username'] ?? '').trim();
      if (state.users.some((u) => u.username.toLowerCase() === username.toLowerCase()))
        return error(409, 'username_taken');
      const user: UserListEntry = {
        id: Math.max(...state.users.map((u) => u.id)) + 1,
        username,
        displayName: String(body['displayName'] ?? ''),
        isAdmin: body['isAdmin'] === true,
        canCreateServers: body['isAdmin'] === true || body['canCreateServers'] === true,
        minecraft: null,
        email: String(body['email'] ?? '') || null,
        locale: 'de',
        theme: 'dark',
        totpEnabled: false,
        createdAt: nowIso(),
        lastLoginAt: null,
        disabled: false,
        approvalPending: false,
        access: [],
      };
      state.users = [...state.users, user];
      state.passwords.set(username, String(body['password'] ?? ''));
      return ok(user);
    },
  ],
  [
    'PATCH',
    '/api/users/:id',
    ({ params, body }) => {
      const { password, ...rest } = body;
      const target = state.users.find((u) => String(u.id) === params['id']);
      if (!target) return error(404, 'not_found');
      if (typeof password === 'string' && password) state.passwords.set(target.username, password);
      state.users = state.users.map((u) => (u.id === target.id ? ({ ...u, ...rest } as UserListEntry) : u));
      return ok(state.users.find((u) => u.id === target.id));
    },
  ],
  [
    'PUT',
    '/api/users/:id/access',
    ({ params, body }) => {
      state.users = state.users.map((u) =>
        String(u.id) === params['id']
          ? { ...u, access: (body['access'] as UserListEntry['access']) ?? [] }
          : u,
      );
      return ok(state.users.find((u) => String(u.id) === params['id']));
    },
  ],
  [
    'DELETE',
    '/api/users/:id',
    ({ params }) => {
      if (params['id'] === String(state.userId)) return error(400, 'cannot_delete_self');
      state.users = state.users.filter((u) => String(u.id) !== params['id']);
      return noContent();
    },
  ],
  [
    'POST',
    '/api/users/:id/reset-password',
    ({ params, body }) => {
      const target = state.users.find((u) => String(u.id) === params['id']);
      if (!target) return error(404, 'not_found');
      if (target.id === state.userId) return error(400, 'cannot_reset_self');
      const password = randomText(16);
      state.passwords.set(target.username, password);
      if (body['removeSecondFactors'] === true) {
        state.passkeys.delete(target.id);
        state.users = state.users.map((u) => (u.id === target.id ? { ...u, totpEnabled: false } : u));
      }
      return ok({ password });
    },
  ],
  ['GET', '/api/servers', () => ok(summaries())],
  ['POST', '/api/servers', ({ body }) => createServer(body)],
  [
    'GET',
    '/api/servers/:id',
    ({ params }) => {
      const server = state.servers.get(params['id'] ?? '');
      return server ? ok(server) : error(404, 'not_found');
    },
  ],
  ['PATCH', '/api/servers/:id', ({ params, body }) => patchServer(params['id'] ?? '', body)],
  ['GET', '/api/servers/:id/connection', ({ params }) => connectionOf(params['id'] ?? '')],
  [
    'PUT',
    '/api/servers/:id/geyser',
    ({ params, body }) => setGeyser(params['id'] ?? '', body['enabled'] === true),
  ],
  ['PUT', '/api/servers/:id/voicechat', ({ params, body }) => setVoiceChat(params['id'] ?? '', body)],
  [
    'PUT',
    '/api/servers/:id/netbird',
    ({ params, body }) => {
      const name = typeof body['name'] === 'string' ? body['name'] : null;
      const server = setNetbirdName(params['id'] ?? '', name);
      return server ? ok({ netbird: server.netbird }) : error(404, 'not_found');
    },
  ],
  ['GET', '/api/netbird', () => ok(netbird.status)],
  // The own domain is connected from the start (mornihosting.de at INWX); disconnect and connect again works.
  ['GET', '/api/dns', () => ok(dnsStatus())],
  ['POST', '/api/dns/discover', () => ok({ zones: [{ id: OWN_DOMAIN, name: OWN_DOMAIN }] })],
  [
    'PUT',
    '/api/dns',
    () => {
      if (netbird.status.configured) return error(409, 'dns_netbird_active');
      dns.configured = true;
      nameAll();
      return ok(dnsStatus());
    },
  ],
  [
    'DELETE',
    '/api/dns',
    () => {
      Array.from(state.servers.keys()).forEach((id) => setNetbirdName(id, null));
      dns.configured = false;
      dns.https = false;
      return ok(dnsStatus());
    },
  ],
  ['GET', '/api/https', () => ok(httpsStatus())],
  [
    'PUT',
    '/api/https',
    ({ body }) => {
      if (!dns.configured) return error(400, 'https_needs_domain');
      dns.https = body['enabled'] === true;
      if (dns.https) state.settings = { ...state.settings, panelDomain: OWN_DOMAIN };
      return ok(httpsStatus());
    },
  ],
  [
    'POST',
    '/api/netbird/discover',
    ({ body }) =>
      !body['token'] && !netbird.status.configured
        ? error(400, 'netbird_token_missing')
        : ok({
            domains: [{ domain: DEMO_DOMAIN, validated: true, custom: true }],
            peers: [DEMO_PEER],
            suggestedPeerId: DEMO_PEER.id,
          }),
  ],
  [
    'PUT',
    '/api/netbird',
    ({ body }) => {
      if (dns.configured) return error(409, 'netbird_dns_active');
      netbird.status = {
        ...netbird.status,
        configured: true,
        apiUrl: String(body['apiUrl'] ?? NETBIRD_DEFAULT_API),
        domain: String(body['domain'] ?? DEMO_DOMAIN),
        peerId: DEMO_PEER.id,
        peerName: DEMO_PEER.name,
      };
      return ok(netbird.status);
    },
  ],
  [
    'DELETE',
    '/api/netbird',
    () => {
      Array.from(state.servers.keys()).forEach((id) => setNetbirdName(id, null));
      netbird.status = { ...NOT_CONNECTED, panelAddress: netbird.status.panelAddress };
      return ok(netbird.status);
    },
  ],
  [
    'POST',
    '/api/netbird/panel',
    ({ body }) => {
      const address = `${String(body['name'] ?? 'panel')}.${netbird.status.domain ?? DEMO_DOMAIN}`;
      netbird.status = { ...netbird.status, panelAddress: address };
      state.settings = { ...state.settings, panelDomain: address };
      return ok(netbird.status);
    },
  ],
  [
    'DELETE',
    '/api/servers/:id',
    ({ params }) => {
      const id = params['id'] ?? '';
      state.servers.delete(id);
      sockets.forEach((s) => s.emit({ type: 'deleted', serverId: id }));
      return noContent();
    },
  ],
  [
    'POST',
    '/api/servers/:id/actions/:action',
    ({ params }) => {
      const id = params['id'] ?? '';
      ACTIONS[params['action'] ?? '']?.(id);
      return { status: 202, body: state.servers.get(id)?.live };
    },
  ],
  [
    'POST',
    '/api/servers/:id/command',
    ({ params, body }) => {
      const id = params['id'] ?? '';
      const command = String(body['command'] ?? '');
      const game = gameOf(state.servers.get(id)?.software ?? '');
      log(id, `> ${command}`);
      if (game) {
        const result = demoGameCommand(game, command, state.servers.get(id)?.live.players ?? []);
        result.answer
          .split('\n')
          .filter(Boolean)
          .forEach((line) => log(id, line));
        result.lines.forEach((line) => log(id, line));
        return ok({ answer: result.answer });
      }
      const answer = answerFor(id, command);
      log(id, info(answer));
      return ok({ answer });
    },
  ],
  [
    'POST',
    '/api/servers/:id/backups',
    ({ params }) => {
      const key = `/api/servers/${templateOf(params['id'] ?? '')}/backups`;
      const current = read<{ backups: { id: number }[] }>(key);
      if (!current) return { status: 202 };
      const id = Math.max(0, ...current.backups.map((b) => b.id)) + 1;
      const stamp = nowIso().replace('T', '_').replaceAll(':', '-').slice(0, 19);
      const backup = {
        id,
        fileName: `backup-${stamp}.zip`,
        sizeBytes: 61_000_000 + Math.round(Math.random() * 3_000_000),
        createdAt: nowIso(),
        kind: 'manual',
        status: 'done',
        error: null,
      };
      store.set(key, { ...current, backups: [backup, ...current.backups] });
      return { status: 202, body: backup };
    },
  ],
  [
    'POST',
    '/api/tokens',
    ({ body }) => {
      const list = read<{ id: number }[]>('/api/tokens') ?? [];
      const token = `mh_demo${randomText(30)}`;
      const entry = {
        id: Math.max(0, ...list.map((t) => t.id)) + 1,
        name: String(body['name'] ?? 'Schlüssel'),
        prefix: token.slice(0, 10),
        createdAt: nowIso(),
        lastUsedAt: null,
        expiresAt: null,
      };
      store.set('/api/tokens', [...list, entry]);
      return ok({ token, entry });
    },
  ],
];

function match(template: string, path: string): Record<string, string> | null {
  const want = template.split('/');
  const have = path.split('/');
  if (want.length !== have.length) return null;
  const pairs = want.map((segment, i) => [segment, have[i] ?? ''] as const);
  if (!pairs.every(([segment, part]) => segment.startsWith(':') || segment === part)) return null;
  return Object.fromEntries(
    pairs
      .filter(([segment]) => segment.startsWith(':'))
      .map(([segment, part]) => [segment.slice(1), decodeURIComponent(part)]),
  );
}

const PUBLIC_PATHS: readonly string[] = [
  '/api/system/status',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/passkey/options',
  '/api/auth/passkey/login',
  '/api/auth/register',
  '/api/auth/confirm',
  '/api/auth/forgot',
  '/api/auth/reset',
];
const SERVER_PREFIX = '/api/servers/';
// A numeric id at the end of a path: "12" matches, "files" and "12a" do not.
// https://regex101.com/?flavor=javascript&regex=%5E%5Cd%2B%24&testString=12%0Afiles%0A12a
const NUMERIC_ID = /^\d+$/;

/** For a server made in the demo, the recorded pages of a similar server. */
function recordedKey(url: URL): string {
  const key = url.pathname + url.search;
  if (!key.startsWith(SERVER_PREFIX)) return key;
  const id = key.slice(SERVER_PREFIX.length).split(/[/?]/)[0] ?? ''; // eslint-disable-line ts-patterns/require-regex-example -- splits after the id: "abc/files?x" → "abc"
  return key.replace(SERVER_PREFIX + id, SERVER_PREFIX + templateOf(id));
}

/** Lists in the recording that the demo can add to, change and delete from. */
function genericChange(request: Request): Reply {
  const parts = request.path.split('/');
  const tail = parts.at(-1) ?? '';
  const parent = parts.slice(0, -1).join('/');
  const collection = read<unknown>(request.path);
  if (request.method === 'POST' && Array.isArray(collection)) {
    const item = { id: collection.length + 1000, createdAt: nowIso(), ...request.body };
    store.set(request.path, [...collection, item]);
    return ok(item);
  }
  const siblings = read<unknown>(parent);
  if (Array.isArray(siblings) && NUMERIC_ID.test(tail)) {
    const rest = (siblings as { id: number }[]).filter((item) => String(item.id) !== tail);
    const current = (siblings as { id: number }[]).find((item) => String(item.id) === tail);
    if (request.method === 'DELETE') {
      store.set(parent, rest);
      return noContent();
    }
    const changed = { ...current, ...request.body };
    store.set(
      parent,
      siblings.map((item: { id: number }) => (String(item.id) === tail ? changed : item)),
    );
    return ok(changed);
  }
  return ok({});
}

async function handle(request: Request): Promise<Reply> {
  await delay(90 + Math.random() * 160);
  const signedIn = state.userId !== null;
  if (!signedIn && !PUBLIC_PATHS.includes(request.path)) return error(401, 'unauthorized');
  const route = ROUTES.map(([method, template, handler]) => ({
    handler,
    params: method === request.method ? match(template, request.path) : null,
  })).find((r) => r.params !== null);
  if (route?.params) return route.handler({ ...request, params: route.params });
  if (request.method !== 'GET') return genericChange(request);
  const key = recordedKey(request.url);
  const failed = failing.get(key);
  if (failed) return { status: failed.status, body: failed.body };
  if (store.has(key)) return ok(store.get(key));
  const withoutQuery = Array.from(store.keys()).find((k) => k.split('?')[0] === key.split('?')[0]);
  return withoutQuery ? ok(store.get(withoutQuery)) : error(404, 'not_found');
}

/* ---------- Wiring into the page ---------- */

/** File uploads (XMLHttpRequest) are not possible in the demo; they get a friendly answer. */
class DemoUpload extends EventTarget {
  readonly upload = new EventTarget();
  status = 0;
  responseText = '';
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    after(400, () => {
      this.status = 400;
      this.responseText = JSON.stringify({ error: 'demo_readonly', params: {} });
      this.dispatchEvent(new Event('load'));
    });
  }
}

export function installDemoBackend(): void {
  // Start like Philip's panel: mornihosting.de connected, HTTPS on, every server with its name.
  nameAll();
  state.settings = { ...state.settings, panelDomain: OWN_DOMAIN };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    const reply = await handle({ method: init?.method ?? 'GET', path: url.pathname, url, params: {}, body });
    if (reply.status === 204 || reply.body === undefined)
      return new Response(null, { status: reply.status === 200 ? 204 : reply.status });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  window.WebSocket = DemoSocket as unknown as typeof WebSocket;
  window.XMLHttpRequest = DemoUpload as unknown as typeof XMLHttpRequest;
  window.setInterval(tick, 2000);
}

/** Who has passkeys in the demo, for the pretend passkey dialog. */
export function demoPasskeyAccounts(): { readonly id: string; readonly label: string }[] {
  return Array.from(state.passkeys).flatMap(([userId, keys]) => {
    const user = userById(userId);
    return keys.map((k) => ({
      id: k.id,
      label: `${user?.displayName || user?.username || '?'} · ${k.name}`,
    }));
  });
}
