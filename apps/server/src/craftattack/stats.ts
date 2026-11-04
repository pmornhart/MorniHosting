import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PublicDeath, PublicPlayer } from '@mornihosting/shared';
import { logFiles, readLog, travelOf } from '../players/detail.js';

/**
 * What the public statistics page shows: per player play time, deaths, kills and distance (from the world's
 * stats/<uuid>.json, which the server keeps up to date), and a feed of deaths with what killed whom – read from
 * the log files, where Minecraft writes every death message.
 */

const TICKS_PER_SECOND = 20;
const DEATHS_MAX = 60;

const statsSchema = z.object({ stats: z.record(z.string(), z.record(z.string(), z.number())) }).loose();

// A death message after the log prefix: "[18:03:12] [Server thread/INFO]: Lena was slain by Zombie" (vanilla) or
// "[18:03:12 INFO]: Lena was slain by Zombie" (Paper) → ("18:03:12", "Lena", "was slain by Zombie").
// https://regex101.com/?flavor=javascript&regex=%5E%5C%5B(%5Cd%7B2%7D%3A%5Cd%7B2%7D%3A%5Cd%7B2%7D)%5B%5E%5C%5D%5D*%5C%5D(%3F%3A%20%5C%5B%5B%5E%5C%5D%5D*%5C%5D)%3F%3A%20(%5Cw%7B3%2C16%7D)%20(.%2B)%24&testString=%5B18%3A03%3A12%5D%20%5BServer%20thread%2FINFO%5D%3A%20Lena%20was%20slain%20by%20Zombie%0A%5B18%3A03%3A12%20INFO%5D%3A%20Lena%20was%20slain%20by%20Zombie
const LOG_LINE = /^\[(\d{2}:\d{2}:\d{2})[^\]]*\](?: \[[^\]]*\])?: (\w{3,16}) (.+)$/;

/**
 * Vanilla death messages (the ones with a killer carry "by <who>"), in German. First that matches wins.
 * Each pattern: "<rest of the message>" → group 1 = killer when there is one.
 */
const CAUSES: readonly (readonly [RegExp, (who: string) => string])[] = [
  // "was slain by Zombie" / "was slain by Lena using Diamond Sword" → "Zombie" / "Lena".
  // https://regex101.com/?flavor=javascript&regex=%5Ewas%20slain%20by%20(.%2B%3F)(%3F%3A%20using%20.*)%3F%24&testString=was%20slain%20by%20Zombie%0Awas%20slain%20by%20Lena%20using%20Diamond%20Sword
  [/^was slain by (.+?)(?: using .*)?$/, (who) => `wurde von ${who} getötet`],
  // "was shot by Skeleton" → "Skeleton".
  // https://regex101.com/?flavor=javascript&regex=%5Ewas%20shot%20by%20(.%2B%3F)(%3F%3A%20using%20.*)%3F%24&testString=was%20shot%20by%20Skeleton
  [/^was shot by (.+?)(?: using .*)?$/, (who) => `wurde von ${who} erschossen`],
  // "was blown up by Creeper" → "Creeper".
  // https://regex101.com/?flavor=javascript&regex=%5Ewas%20blown%20up%20by%20(.%2B%3F)(%3F%3A%20using%20.*)%3F%24&testString=was%20blown%20up%20by%20Creeper
  [/^was blown up by (.+?)(?: using .*)?$/, (who) => `wurde von ${who} in die Luft gesprengt`],
  // "was killed by Witch using magic" → "Witch".
  // https://regex101.com/?flavor=javascript&regex=%5Ewas%20killed%20by%20(.%2B%3F)(%3F%3A%20using%20.*)%3F%24&testString=was%20killed%20by%20Witch%20using%20magic
  [/^was killed by (.+?)(?: using .*)?$/, (who) => `wurde von ${who} getötet`],
  // "was fireballed by Ghast" → "Ghast".
  // https://regex101.com/?flavor=javascript&regex=%5Ewas%20fireballed%20by%20(.%2B%3F)(%3F%3A%20using%20.*)%3F%24&testString=was%20fireballed%20by%20Ghast
  [/^was fireballed by (.+?)(?: using .*)?$/, (who) => `wurde von ${who} mit einem Feuerball erwischt`],
  // "was impaled by Drowned" → "Drowned".
  // https://regex101.com/?flavor=javascript&regex=%5Ewas%20impaled%20by%20(.%2B%3F)(%3F%3A%20.*)%3F%24&testString=was%20impaled%20by%20Drowned
  [/^was impaled by (.+?)(?: with .*)?$/, (who) => `wurde von ${who} aufgespießt`],
  // "was stung to death by Bee" → "Bee".
  // https://regex101.com/?flavor=javascript&regex=%5Ewas%20stung%20to%20death%20by%20(.%2B)%24&testString=was%20stung%20to%20death%20by%20Bee
  [/^was stung to death by (.+)$/, (who) => `wurde von ${who} zu Tode gestochen`],
  // "drowned" / "drowned while trying to escape Zombie".
  // https://regex101.com/?flavor=javascript&regex=%5Edrowned&testString=drowned%0Adrowned%20while%20trying%20to%20escape%20Zombie
  [/^drowned/, () => 'ist ertrunken'],
  // "blew up" (TNT, bed in the nether …).
  // https://regex101.com/?flavor=javascript&regex=%5Eblew%20up&testString=blew%20up
  [/^blew up/, () => 'ist explodiert'],
  // "fell from a high place", "hit the ground too hard", "fell off a ladder".
  // https://regex101.com/?flavor=javascript&regex=%5E(fell%20(from%7Coff)%7Chit%20the%20ground)&testString=fell%20from%20a%20high%20place%0Ahit%20the%20ground%20too%20hard%0Afell%20off%20a%20ladder
  [/^(fell (from|off)|hit the ground)/, () => 'ist zu tief gefallen'],
  // "fell out of the world" / "didn't want to live in the same world as …".
  // https://regex101.com/?flavor=javascript&regex=%5Efell%20out%20of%20the%20world&testString=fell%20out%20of%20the%20world
  [/^fell out of the world/, () => 'ist aus der Welt gefallen'],
  // "tried to swim in lava".
  // https://regex101.com/?flavor=javascript&regex=%5Etried%20to%20swim%20in%20lava&testString=tried%20to%20swim%20in%20lava
  [/^tried to swim in lava/, () => 'wollte in Lava schwimmen'],
  // "burned to death", "went up in flames", "was burned to a crisp", "walked into fire".
  // https://regex101.com/?flavor=javascript&regex=%5E(burned%7Cwent%20up%20in%20flames%7Cwas%20burned%7Cwalked%20into%20fire)&testString=burned%20to%20death%0Awent%20up%20in%20flames
  [/^(burned|went up in flames|was burned|walked into fire)/, () => 'ist verbrannt'],
  // "starved to death".
  // https://regex101.com/?flavor=javascript&regex=%5Estarved&testString=starved%20to%20death
  [/^starved/, () => 'ist verhungert'],
  // "suffocated in a wall", "was squished too much".
  // https://regex101.com/?flavor=javascript&regex=%5E(suffocated%7Cwas%20squish)&testString=suffocated%20in%20a%20wall
  [/^(suffocated|was squish)/, () => 'ist erstickt'],
  // "froze to death".
  // https://regex101.com/?flavor=javascript&regex=%5Efroze&testString=froze%20to%20death
  [/^froze/, () => 'ist erfroren'],
  // "withered away".
  // https://regex101.com/?flavor=javascript&regex=%5Ewithered&testString=withered%20away
  [/^withered/, () => 'ist verdorrt'],
  // "was struck by lightning".
  // https://regex101.com/?flavor=javascript&regex=%5Ewas%20struck%20by%20lightning&testString=was%20struck%20by%20lightning
  [/^was struck by lightning/, () => 'wurde vom Blitz getroffen'],
  // "was pricked to death", "walked into a cactus".
  // https://regex101.com/?flavor=javascript&regex=%5E(was%20pricked%7Cwalked%20into%20a%20cactus)&testString=was%20pricked%20to%20death
  [/^(was pricked|walked into a cactus)/, () => 'hat einen Kaktus umarmt'],
  // "experienced kinetic energy" (elytra).
  // https://regex101.com/?flavor=javascript&regex=%5Eexperienced%20kinetic%20energy&testString=experienced%20kinetic%20energy
  [/^experienced kinetic energy/, () => 'ist mit den Elytren gegen eine Wand geflogen'],
  // "was killed by magic", "died".
  // https://regex101.com/?flavor=javascript&regex=%5E(died%7Cwas%20killed)%24&testString=died
  [/^(died|was killed)$/, () => 'ist gestorben'],
];

/** "Zombie" stays, "a Zombie" (some versions) loses the article. */
const ARTICLE = /^(an?|the) /i; // eslint-disable-line ts-patterns/require-regex-example -- "a Zombie" → "Zombie", "Lena" stays

/** A death message (the part after the name) in words; null when it is no death message. */
export function deathOf(
  rest: string,
  players: ReadonlySet<string>,
): { how: string; byPlayer: string | null } | null {
  const hit = CAUSES.map(([pattern, words]) => [rest.match(pattern), words] as const).find(
    ([m]) => m !== null,
  );
  if (!hit) return null;
  const [match, words] = hit;
  const who = (match?.[1] ?? '').replace(ARTICLE, '').trim();
  return { how: words(who), byPlayer: who && players.has(who.toLowerCase()) ? who : null };
}

/**
 * A log time ("2026-11-04", "18:03:12") is local time of the server's time zone; as an exact moment (ISO, UTC).
 * Never later than now (a log line cannot come from the future).
 */
export function logMoment(date: string, time: string, timeZone: string): string {
  const [y = 0, mo = 1, d = 1] = date.split('-').map(Number);
  const [h = 0, mi = 0, se = 0] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(asUtc))
      .map((p) => [p.type, Number(p.value)]),
  );
  const shown = Date.UTC(
    parts['year'] ?? y,
    (parts['month'] ?? mo) - 1,
    parts['day'] ?? d,
    parts['hour'] ?? h,
    parts['minute'] ?? mi,
    parts['second'] ?? se,
  );
  return new Date(Math.min(asUtc - (shown - asUtc), Date.now())).toISOString();
}

/** Deaths of the known players, newest first. */
export function deathsOf(serverDir: string, names: readonly string[], timeZone = 'UTC'): PublicDeath[] {
  const players = new Set(names.map((n) => n.toLowerCase()));
  return logFiles(path.join(serverDir, 'logs')).reduce<PublicDeath[]>((found, { file, date }) => {
    if (found.length >= DEATHS_MAX) return found;
    const fromFile = readLog(file)
      .split('\n')
      .map((line): PublicDeath | null => {
        const m = LOG_LINE.exec(line.trimEnd());
        const player = m?.[2];
        if (!m || !player || !players.has(player.toLowerCase())) return null;
        const death = deathOf(m[3] ?? '', players);
        return death ? { at: logMoment(date, m[1] ?? '00:00:00', timeZone), player, ...death } : null;
      })
      .filter((d): d is PublicDeath => d !== null)
      .reverse();
    return [...found, ...fromFile].slice(0, DEATHS_MAX);
  }, []);
}

/** Numbers for one player from world/stats/<uuid>.json. */
export function playerNumbers(
  worldDir: string,
  uuid: string,
): Pick<PublicPlayer, 'playTimeSeconds' | 'deaths' | 'playerKills' | 'mobKills' | 'distanceBlocks'> {
  const raw = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(worldDir, 'stats', `${uuid}.json`), 'utf8')) as unknown;
    } catch {
      return null;
    }
  })();
  const parsed = statsSchema.safeParse(raw);
  const custom = parsed.success ? (parsed.data.stats['minecraft:custom'] ?? {}) : {};
  const stat = (key: string): number => custom[`minecraft:${key}`] ?? 0;
  return {
    playTimeSeconds: Math.round((stat('play_time') || stat('play_one_minute')) / TICKS_PER_SECOND),
    deaths: stat('deaths'),
    playerKills: stat('player_kills'),
    mobKills: stat('mob_kills'),
    distanceBlocks: travelOf(custom).total,
  };
}
