import fs from 'node:fs';
import path from 'node:path';
import { CRAFT_ATTACK_COMMANDS } from '@mornihosting/shared';

/**
 * In-game help for Craft Attack servers and the rights to use it.
 *
 * - /info, /motd and /rules (EssentialsX) show the command list, a welcome and friendly rules. Written only where
 *   the file is missing, still EssentialsX's sample or one of ours – a file the owner wrote stays untouched.
 * - Without a permissions plugin EssentialsX lets only operators use its commands. Its own fallback list
 *   ("player-commands": /home, /tpa, /spawn, /msg …) is switched on by `use-bukkit-permissions: false`.
 */

const MARKER = '# MorniHosting';
const ESSENTIALS = path.join('plugins', 'Essentials');
/** First lines of EssentialsX's sample files: those may be replaced. */
const STOCK_STARTS: Readonly<Record<string, string>> = {
  'info.txt': 'This is the info file.',
  'motd.txt': '&6Welcome, {PLAYER}',
  'rules.txt': '[1] Be respectful',
};
const BUKKIT_PERMISSIONS_ON = 'use-bukkit-permissions: true';
const BUKKIT_PERMISSIONS_OFF = `use-bukkit-permissions: false ${MARKER}: Spieler dürfen /home, /tpa, /spawn …`;

type Locale = 'de' | 'en';

const TEXTS: Readonly<
  Record<
    Locale,
    { readonly motd: string[]; readonly rules: string[]; readonly head: string; readonly link: string }
  >
> = {
  de: {
    head: '&a&lCraft Attack &7– alle Befehle',
    link: '&7Was du alles darfst, auf einer Seite: &b',
    motd: [
      '&aWillkommen, &f{PLAYER}&a!',
      '&7Auf der Spawn-Insel: &f2× Leertaste &7zum Gleiten, &fF &7für Schub.',
      '&7Alle Befehle: &f/info &7· Regeln: &f/rules',
    ],
    rules: [
      '&a1. &fSei nett zu allen.',
      '&a2. &fNichts kaputt machen, was anderen gehört.',
      '&a3. &fKeine Cheats, keine Hacks.',
      '&a4. &fDie Spawn-Insel bleibt, wie sie ist.',
      '&a5. &fViel Spaß!',
    ],
  },
  en: {
    head: '&a&lCraft Attack &7– all commands',
    link: '&7Everything you may use, on one page: &b',
    motd: [
      '&aWelcome, &f{PLAYER}&a!',
      '&7On the spawn island: &fspace twice &7to glide, &fF &7to boost.',
      '&7All commands: &f/info &7· Rules: &f/rules',
    ],
    rules: [
      '&a1. &fBe nice to everyone.',
      "&a2. &fDon't break what belongs to others.",
      '&a3. &fNo cheats, no hacks.',
      '&a4. &fThe spawn island stays as it is.',
      '&a5. &fHave fun!',
    ],
  },
};

/**
 * The personal command page of the reading player: EssentialsX fills in {USERNAME} (the real name, not a nickname),
 * the chat makes the address clickable.
 */
export const personalLink = (domain: string, slug: string): string =>
  `https://${domain}/befehle/${slug}/{USERNAME}`;

/** The command list as EssentialsX text (& colour codes), one line per command; admin commands stay off. */
export function infoText(locale: Locale, link?: string): string {
  const linkLine = link ? [`${TEXTS[locale].link}${link}`] : [];
  const everyone = CRAFT_ATTACK_COMMANDS.filter((group) => group.commands.some((c) => !c.opOnly));
  const groups = everyone.flatMap((group) => [
    `&2${group.title[locale]}`,
    ...group.commands.map((c) => ` &f${c.use[locale]} &7– ${c.text[locale]}`),
  ]);
  return [MARKER, TEXTS[locale].head, ...linkLine, ...groups, ''].join('\n');
}

const replaceable = (file: string, stockStart: string): boolean => {
  if (!fs.existsSync(file)) return true;
  const text = fs.readFileSync(file, 'utf8');
  return text.includes(MARKER) || text.trimStart().startsWith(stockStart);
};

/** Writes /info, /motd and /rules where that is safe (see above). */
export function writeHelpFiles(serverDir: string, locale: Locale, link?: string): void {
  const dir = path.join(serverDir, ESSENTIALS);
  fs.mkdirSync(dir, { recursive: true });
  const files: Readonly<Record<string, string>> = {
    'info.txt': infoText(locale, link),
    'motd.txt': [MARKER, ...TEXTS[locale].motd, ...(link ? [`${TEXTS[locale].link}${link}`] : []), ''].join(
      '\n',
    ),
    'rules.txt': [MARKER, ...TEXTS[locale].rules, ''].join('\n'),
  };
  Object.entries(files).forEach(([name, content]) => {
    const file = path.join(dir, name);
    if (replaceable(file, STOCK_STARTS[name] ?? '')) fs.writeFileSync(file, content);
  });
}

/**
 * Lets normal players use the everyday commands. Only EssentialsX's default setting is changed; true when the
 * file was changed (EssentialsX must reload it then).
 */
export function openPlayerCommands(serverDir: string): boolean {
  const file = path.join(serverDir, ESSENTIALS, 'config.yml');
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(BUKKIT_PERMISSIONS_ON)) return false;
  fs.writeFileSync(file, text.replace(BUKKIT_PERMISSIONS_ON, BUKKIT_PERMISSIONS_OFF));
  return true;
}

// A home's name in an EssentialsX user file: two spaces, the name, a colon ("  base:"); deeper lines don't match.
// https://regex101.com/?flavor=javascript&regex=%5E%20%20(%5B%5E%5Cs%3A%5D%5B%5E%3A%5D*)%3A%5Cs*%24&flags=m&testString=homes%3A%0A%20%20base%3A%0A%20%20%20%20world%3A%20world%0A%20%20farm%3A
const HOME_LINE = /^ {2}([^\s:][^:]*):\s*$/;
const TOP_LEVEL = /^\S/; // eslint-disable-line ts-patterns/require-regex-example -- "logoutlocation:" yes, "  base:" no

/** The names of a player's homes (EssentialsX userdata). */
export function homesOf(serverDir: string, uuid: string): string[] {
  const file = path.join(serverDir, ESSENTIALS, 'userdata', `${path.basename(uuid)}.yml`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === 'homes:');
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => TOP_LEVEL.test(line));
  return (end < 0 ? rest : rest.slice(0, end))
    .map((line) => line.match(HOME_LINE)?.[1])
    .filter((home): home is string => Boolean(home));
}
