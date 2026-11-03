import type { GameId, GameInfo } from './games.js';

/**
 * Made-up console output for the other games, used by the panel's pretend Docker (tests, demo mode) and the
 * demo website. The lines look like the real servers print them, so the panel's log patterns match.
 */

const TIME_LENGTH = 19;
const PERCENT = 100;
/** About the size of the CS2 server files. */
const CS2_BYTES = 61_203_284_377;
const DEMO_DOWNLOAD_STEPS = [0.02, 0.09, 0.18, 0.31, 0.47, 0.62, 0.78, 0.91, 1];

export function demoClock(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, TIME_LENGTH);
}

/** Factorio counts seconds since start in front of every line ("   1.234 Info …"). */
function uptime(step: number): string {
  // eslint-disable-next-line ts-patterns/no-magic-numbers -- Factorio pads the uptime to 8 characters with 3 decimals
  return (step * 0.731).toFixed(3).padStart(8);
}

interface DemoBootInput {
  readonly version: string;
  readonly port: number;
}

const BOOT: Readonly<Record<GameId, (input: DemoBootInput) => readonly string[]>> = {
  factorio: ({ version, port }) => [
    `${uptime(0)} 2026-10-30 Factorio ${version === 'latest' ? '2.1.4' : '2.0.72'} (build 83000, linux64, headless)`,
    `${uptime(1)} Mods to be loaded: base, elevated-rails, quality, space-age`,
    `${uptime(2)} Loading map /factorio/saves/world.zip: 1843222 bytes.`,
    `${uptime(3)} Info ServerMultiplayerManager.cpp:983: Hosting game at IP ADDR:({0.0.0.0:${port}})`,
    `${uptime(4)} Info RemoteCommandProcessor.cpp:131: Starting RCON interface at IP ADDR:({0.0.0.0:27015})`,
    `${uptime(5)} Info ServerMultiplayerManager.cpp:808: updateTick(0) changing state from(CreatingGame) to(InGame)`,
  ],
  cs2: ({ port }) => [
    'Redirecting stderr to /home/steam/cs2-dedicated/steamcmd.log',
    // steamcmd reports the download like this; the panel turns it into progress, speed and time left.
    ...DEMO_DOWNLOAD_STEPS.map(
      (share) =>
        ` Update state (0x61) downloading, progress: ${(share * PERCENT).toFixed(2)} (${Math.round(share * CS2_BYTES)} / ${CS2_BYTES})`,
    ),
    "Success! App '730' fully installed.",
    `Starting CS2 Dedicated Server on port ${port}`,
    'Network: IP 0.0.0.0, mode MP, dedicated Yes, ports 27015 SV / 27005 CL',
    'SV:  Connection to Steam servers successful.',
    'Host activate: Loading (de_inferno)',
  ],
  gmod: ({ port }) => [
    'Using default binary: ./srcds_run',
    `Server will auto-restart if there is a crash.`,
    `Network: IP 0.0.0.0, mode MP, dedicated Yes, ports ${port} SV / 27005 CL`,
    'Initializing Steam libraries for secure Internet server',
    'Logging into anonymous gameserver account.',
    'Connection to Steam servers successful.',
    'VAC secure mode is activated.',
  ],
  satisfactory: ({ port }) => [
    'Checking available memory: 12GB detected',
    'Downloading the latest version of the game...',
    "Success! App '1690800' fully installed.",
    'Launching game server',
    'LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()',
    `LogServer: Display: Server API listening on '0.0.0.0:${port}' (Standalone)`,
  ],
  ets2: () => [
    '[ .... ] Starting ets2server: Euro Truck Simulator 2',
    '00:00:00.000 : [MP] Dedicated server starting',
    '00:00:01.204 : [MP] Loading server_packages.sii',
    '00:00:03.517 : [MP] Session created',
    '[  OK  ] Starting ets2server: Euro Truck Simulator 2',
  ],
  hytale: ({ port }) => [
    '[MorniHosting] Lade die Hytale-Server-Dateien. Beim ersten Mal: Link unten öffnen und mit deinem Hytale-Konto anmelden.',
    'Please visit https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=DEMO-1234 to authorize',
    'Downloaded Server/HytaleServer.jar and Assets.zip',
    `[MorniHosting] Starte Hytale auf UDP-Port ${port} mit 6144M Arbeitsspeicher.`,
    '[HytaleServer] Loading assets from Assets.zip',
    `[HytaleServer] Listening on 0.0.0.0:${port} (QUIC)`,
    '[HytaleServer] Hytale Server Booted! [Multiplayer]',
  ],
};

/** Source games log like "L 10/30/2026 - 12:00:01: …". */
function sourceStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `L ${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()} - ${now.toTimeString().slice(0, 8)}:`;
}

const JOIN: Readonly<Record<GameId, (name: string) => string>> = {
  factorio: (name) => `${demoClock()} [JOIN] ${name} joined the game`,
  cs2: (name) =>
    `${sourceStamp()} "${name}<2><[U:1:${name.length * 7919}]><>" connected, address "10.0.0.2:27005"`,
  gmod: (name) => `Client "${name}" connected (10.0.0.2:27005).`,
  satisfactory: (name) => `LogNet: Join succeeded: ${name}`,
  ets2: (name) => `00:12:41.090 : [MP] ${name} connected, client_id = 1`,
  hytale: (name) => `[HytaleServer] ${name} joined the world`,
};

const LEAVE: Readonly<Record<GameId, (name: string) => string>> = {
  factorio: (name) => `${demoClock()} [LEAVE] ${name} left the game`,
  cs2: (name) =>
    `${sourceStamp()} "${name}<2><[U:1:${name.length * 7919}]><CT>" disconnected (reason "Disconnect")`,
  gmod: (name) => `Dropped ${name} from server (Disconnect by user.)`,
  satisfactory: (name) => `LogNet: UChannel::Close: ${name} left`,
  ets2: (name) => `00:48:02.311 : [MP] ${name} disconnected, client_id = 1`,
  hytale: (name) => `[HytaleServer] ${name} left the world`,
};

/** Anything else typed into the console: Factorio treats it as chat, Source games run it as a command. */
const CHAT: Readonly<Record<GameId, (text: string) => string>> = {
  factorio: (text) => `${demoClock()} [CHAT] <server>: ${text}`,
  cs2: (text) => `${sourceStamp()} rcon from "172.18.0.2": command "${text}"`,
  gmod: (text) => `] ${text}`,
  satisfactory: (text) => text,
  ets2: (text) => text,
  hytale: (text) => `[HytaleServer] Command: ${text}`,
};

/** Files a fresh server of the game has, so the file manager is not empty. */
export const DEMO_GAME_FILES: Readonly<Record<GameId, readonly string[]>> = {
  factorio: ['saves/world.zip', 'config/server-settings.json', 'mods/mod-list.json'],
  cs2: ['game/csgo/cfg/server.cfg', 'game/csgo/gameinfo.gi', 'steamcmd.log'],
  gmod: ['data/sv.db', 'addons/.keep'],
  satisfactory: ['saved/server/MorniFabrik.sav', 'gamefiles/FactoryServer.sh', 'logs/FactoryGame.log'],
  ets2: ['serverfiles/bin/linux_x64/eurotrucks2_server', 'log/console/ets2server-console.log'],
  hytale: ['Server/HytaleServer.jar', 'Assets.zip', 'universe/worlds/default/config.json'],
};

export function demoBootLines(game: GameInfo, input: DemoBootInput): readonly string[] {
  return BOOT[game.id](input);
}

export function demoJoinLine(game: GameInfo, name: string): string {
  return JOIN[game.id](name);
}

export function demoLeaveLine(game: GameInfo, name: string): string {
  return LEAVE[game.id](name);
}

export interface DemoCommandResult {
  readonly answer: string;
  /** Lines the server prints to its console. */
  readonly lines: readonly string[];
  readonly quits: boolean;
}

/** What the game answers; unknown text is chat (that is what Factorio and the Source games do with "say"). */
export function demoGameCommand(
  game: GameInfo,
  command: string,
  players: readonly string[],
): DemoCommandResult {
  const trimmed = command.trim();
  if (game.listCommand && trimmed === game.listCommand) {
    const answer = [`Online players (${players.length}):`, ...players.map((n) => `  ${n} (online)`)].join(
      '\n',
    );
    return { answer, lines: [], quits: false };
  }
  if (game.id === 'cs2' && trimmed === 'status')
    return {
      answer: [`hostname: MorniHosting CS2`, `players : ${players.length} humans, 0 bots (10 max)`].join(
        '\n',
      ),
      lines: [],
      quits: false,
    };
  if (game.saveCommand && trimmed === game.saveCommand)
    return { answer: 'Saving map', lines: [`${demoClock()} [SAVE] Saving map as world`], quits: false };
  if (game.stopCommand && trimmed === game.stopCommand)
    return { answer: '', lines: [`${demoClock()} Quitting: remote-quit.`], quits: true };
  return { answer: '', lines: [CHAT[game.id](trimmed)], quits: false };
}
