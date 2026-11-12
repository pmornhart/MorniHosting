/** Reads facts out of Minecraft console lines: start finished, players joining and leaving, TPS. */

// Section-sign colour codes and ANSI escapes are noise for parsing: "§aHi\u001b[0m" → "Hi".
// https://regex101.com/?flavor=javascript&regex=%C2%A7%5B0-9a-fk-orx%5D%7C%5Cu001b%5C%5B%5B0-9%3B%5D*m&flags=gi&testString=%C2%A7aHi%1B%5B0m%0Aplain
// eslint-disable-next-line no-control-regex -- ANSI escapes start with the ESC control character
const COLOUR_CODES = /§[0-9a-fk-orx]|\u001b\[[0-9;]*m/gi;

// Java start finished: matches 'Done (3.512s)! For help, type "help"'; rejects 'Done preparing level'.
// https://regex101.com/?flavor=javascript&regex=Done%20%5C(%5B%5Cd.%2C%5D%2Bs%5C)!&flags=gm&testString=Done%20(3.512s)!%20For%20help%2C%20type%20%22help%22%0ADone%20preparing%20level
const JAVA_DONE = /Done \([\d.,]+s\)!/;
// Bedrock start finished: matches "[2026-10-27 12:00:00:123 INFO] Server started."; rejects "Server starting".
// https://regex101.com/?flavor=javascript&regex=Server%20started%5C.&flags=gm&testString=%5B2026-10-27%2012%3A00%3A00%3A123%20INFO%5D%20Server%20started.%0AServer%20starting
const BEDROCK_DONE = /Server started\./;

// Java join: captures the player name. "[12:00:01] [Server thread/INFO]: Lena_Baut joined the game" → "Lena_Baut".
// Rejects "<Lena> I joined the game" (chat starts with "<").
// https://regex101.com/?flavor=javascript&regex=%5D%3A%20(%5B%5E%5Cs%3C%3E%5B%5C%5D%3A%5D%2B)%20joined%20the%20game%24&flags=gm&testString=%5B12%3A00%3A01%5D%20%5BServer%20thread%2FINFO%5D%3A%20Lena_Baut%20joined%20the%20game%0A%5B12%3A00%3A01%5D%20%5BServer%20thread%2FINFO%5D%3A%20%3CLena%3E%20I%20joined%20the%20game
const JAVA_JOIN = /\]: ([^\s<>[\]:]+) joined the game$/;
// Java leave: captures the player name. "[12:30:00] [Server thread/INFO]: Juna left the game" → "Juna".
// https://regex101.com/?flavor=javascript&regex=%5D%3A%20(%5B%5E%5Cs%3C%3E%5B%5C%5D%3A%5D%2B)%20left%20the%20game%24&flags=gm&testString=%5B12%3A30%3A00%5D%20%5BServer%20thread%2FINFO%5D%3A%20Juna%20left%20the%20game%0A%3CJuna%3E%20left%20the%20game
const JAVA_LEAVE = /\]: ([^\s<>[\]:]+) left the game$/;
// Bedrock join: captures the gamertag. "Player connected: Finn 2015, xuid: 2535" → "Finn 2015".
// https://regex101.com/?flavor=javascript&regex=Player%20connected%3A%20(.%2B%3F)%2C%20xuid&flags=gm&testString=Player%20connected%3A%20Finn%202015%2C%20xuid%3A%202535%0APlayer%20connected
const BEDROCK_JOIN = /Player connected: (.+?), xuid/;
// Bedrock leave: captures the gamertag. "Player disconnected: Ella, xuid: 2535" → "Ella".
// https://regex101.com/?flavor=javascript&regex=Player%20disconnected%3A%20(.%2B%3F)%2C%20xuid&flags=gm&testString=Player%20disconnected%3A%20Ella%2C%20xuid%3A%202535%0APlayer%20disconnected
const BEDROCK_LEAVE = /Player disconnected: (.+?), xuid/;

// Answer to "list": captures count, max and names. "There are 2 of a max of 20 players online: Juna, Ella" → ("2", "20", "Juna, Ella").
// https://regex101.com/?flavor=javascript&regex=There%20are%20(%5Cd%2B)%20of%20a%20max(%3F%3A%20of)%3F%20(%5Cd%2B)%20players%20online%3A%3F%20%3F(.*)&flags=gm&testString=There%20are%202%20of%20a%20max%20of%2020%20players%20online%3A%20Juna%2C%20Ella%0AThere%20are%200%20of%20a%20max%2020%20players%20online%3A
const LIST_ANSWER = /There are (\d+) of a max(?: of)? (\d+) players online:? ?(.*)/;
// Paper's "tps": captures the 1-minute value. "TPS from last 1m, 5m, 15m: 19.98, 20.0, 20.0" → "19.98"; also "*20.0".
// https://regex101.com/?flavor=javascript&regex=TPS%20from%20last%201m%2C%205m%2C%2015m%3A%20%5C*%3F(%5B%5Cd.%5D%2B)&flags=gm&testString=TPS%20from%20last%201m%2C%205m%2C%2015m%3A%2019.98%2C%2020.0%2C%2020.0%0ATPS%20from%20last%201m%2C%205m%2C%2015m%3A%20*20.0%2C%20*20.0%2C%20*20.0
const PAPER_TPS = /TPS from last 1m, 5m, 15m: \*?([\d.]+)/;
// Vanilla "tick query": captures milliseconds per tick. "Average time per tick: 12.4ms" → "12.4".
// https://regex101.com/?flavor=javascript&regex=Average%20time%20per%20tick%3A%20(%5B%5Cd.%5D%2B)%20%3Fms&flags=gm&testString=Average%20time%20per%20tick%3A%2012.4ms%20(Target%3A%2050.0ms)%0AAverage%20time
const VANILLA_MSPT = /Average time per tick: ([\d.]+) ?ms/;

// RCON connections the panel opens for status polling log two lines each; they are noise in the console.
// Matches "[23:48:05 INFO]: Thread RCON Client /172.19.0.2 started" and "... shutting down"; rejects "Thread RCON Listener started".
// https://regex101.com/?flavor=javascript&regex=Thread%20RCON%20Client%20%5CS%2B%20(%3F%3Astarted%7Cshutting%20down)&flags=gm&testString=%5B23%3A48%3A05%20INFO%5D%3A%20Thread%20RCON%20Client%20%2F172.19.0.2%20started%0A%5B23%3A48%3A05%20INFO%5D%3A%20Thread%20RCON%20Client%20%2F172.19.0.2%20shutting%20down%0AThread%20RCON%20Listener%20started
const RCON_NOISE = /Thread RCON Client \S+ (?:started|shutting down)/;

// EssentialsX logs every RCON command; the panel's own status polls (/list, /tps …) are noise, typed ones are not.
// Matches "[10:48:55 INFO]: [Essentials] Rcon issued server command: /list"; rejects "… command: /say hi".
// https://regex101.com/?flavor=javascript&regex=Rcon%20issued%20server%20command%3A%20%5C%2F(%3F%3Alist%7Ctps%7Cmspt%7C(%3F%3Aneo)%3Fforge%20tps%7Ctick%20query)%5Cs*%24&flags=gm&testString=%5B10%3A48%3A55%20INFO%5D%3A%20%5BEssentials%5D%20Rcon%20issued%20server%20command%3A%20%2Flist%0A%5B10%3A48%3A55%20INFO%5D%3A%20%5BEssentials%5D%20Rcon%20issued%20server%20command%3A%20%2Fsay%20hi
const RCON_POLL_ECHO = /Rcon issued server command: \/(?:list|tps|mspt|(?:neo)?forge tps|tick query)\s*$/;

const MS_PER_SECOND = 1000;
const MAX_TPS = 20;

export type PlayerEvent = { readonly kind: 'join' | 'leave'; readonly player: string };

export function stripColours(text: string): string {
  return text.replace(COLOUR_CODES, '');
}

export function isPanelNoise(line: string): boolean {
  return RCON_NOISE.test(line) || RCON_POLL_ECHO.test(line);
}

export function isStartFinished(line: string): boolean {
  return JAVA_DONE.test(line) || BEDROCK_DONE.test(line);
}

const PLAYER_PATTERNS: readonly (readonly [RegExp, PlayerEvent['kind']])[] = [
  [JAVA_JOIN, 'join'],
  [JAVA_LEAVE, 'leave'],
  [BEDROCK_JOIN, 'join'],
  [BEDROCK_LEAVE, 'leave'],
];

export function playerEventOf(rawLine: string): PlayerEvent | null {
  const line = stripColours(rawLine).trimEnd();
  const hit = PLAYER_PATTERNS.map(([pattern, kind]) => [line.match(pattern), kind] as const).find(
    ([m]) => m?.[1],
  );
  return hit?.[0]?.[1] ? { kind: hit[1], player: hit[0][1] } : null;
}

export interface ListAnswer {
  readonly online: number;
  readonly max: number;
  readonly players: readonly string[];
}

export function parseListAnswer(answer: string): ListAnswer | null {
  const m = stripColours(answer).match(LIST_ANSWER);
  if (!m) return null;
  const names = (m[3] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return { online: Number(m[1]), max: Number(m[2]), players: names };
}

export function parseTps(answer: string): number | null {
  const clean = stripColours(answer);
  const paper = clean.match(PAPER_TPS);
  if (paper?.[1]) return Math.min(MAX_TPS, Number(paper[1]));
  const vanilla = clean.match(VANILLA_MSPT);
  if (vanilla?.[1]) {
    const mspt = Number(vanilla[1]);
    return mspt > 0 ? Math.min(MAX_TPS, MS_PER_SECOND / mspt) : MAX_TPS;
  }
  return null;
}
