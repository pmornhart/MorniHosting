import { parseDocument } from 'yaml';

/**
 * The files a network needs, patched in place: everything the person changed by hand (and every comment) stays,
 * only the keys the network owns are set.
 *
 * - velocity.toml (proxy): bind, online-mode, modern forwarding, the server list, where players land.
 * - config/paper-global.yml (member): proxies.velocity enabled + secret.
 * - plugins/floodgate/config.yml (proxy): send-floodgate-data, so Bedrock players arrive with their data.
 * - plugins/viaversion/config.yml (proxy): ping the servers often, so new versions are known right away.
 */

const SECTION_START = '[';
const ARRAY_OF_TABLES = '[[';
const NEWLINE = '\n';
const KEY_VALUE = '=';
// A TOML key that needs no quotes: letters, digits, "_" and "-". Accepts "online-mode", "lobby_2"; rejects
// "lobby.example.com", "zwei wörter".
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_-%5D%2B%24&testString=online-mode
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
// Three or more line breaks in a row (empty lines piling up after a replaced section). Matches "\n\n\n",
// not "\n\n".
// https://regex101.com/?flavor=javascript&flags=g&regex=%5Cn%7B3%2C%7D&testString=a%0A%0A%0Ab
const MANY_NEWLINES = /\n{3,}/g;

export type TomlValue = string | number | boolean | readonly string[];

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function tomlValue(value: TomlValue): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `[${value.map(tomlString).join(', ')}]`;
}

/** A TOML key as it may appear on the left (bare or quoted). */
function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

function isSectionHeader(line: string): boolean {
  const t = line.trim();
  return t.startsWith(SECTION_START) && !t.startsWith(ARRAY_OF_TABLES);
}

function keyOf(line: string): string | null {
  const t = line.trim();
  if (!t || t.startsWith('#') || isSectionHeader(t) || !t.includes(KEY_VALUE)) return null;
  return t.slice(0, t.indexOf(KEY_VALUE)).trim().replaceAll('"', '');
}

/**
 * Sets top-level keys (before the first [section]) and replaces whole sections. Unknown keys and comments stay;
 * missing keys and sections are added.
 */
export function patchToml(
  text: string,
  top: Readonly<Record<string, TomlValue>>,
  sections: Readonly<Record<string, Readonly<Record<string, TomlValue>>>>,
): string {
  const lines = text.split(NEWLINE);
  const firstSection = lines.findIndex(isSectionHeader);
  const topEnd = firstSection === -1 ? lines.length : firstSection;
  const head = lines.slice(0, topEnd);
  const rest = lines.slice(topEnd);
  const setTop = head.map((line) => {
    const key = keyOf(line);
    return key !== null && key in top ? `${tomlKey(key)} = ${tomlValue(top[key] as TomlValue)}` : line;
  });
  const present = new Set(head.map(keyOf).filter((k): k is string => k !== null));
  const added = Object.entries(top)
    .filter(([key]) => !present.has(key))
    .map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`);
  const trimmedHead = [...setTop];
  const lastFilled = trimmedHead.reduce((idx, line, i) => (line.trim() ? i : idx), -1);
  const newHead = [...trimmedHead.slice(0, lastFilled + 1), ...added, ...(rest.length ? [''] : [])];
  const blocks = splitSections(rest);
  const replaced = blocks.map((block) => {
    const name = block.header.trim().slice(1, -1).trim();
    const wanted = sections[name];
    return wanted ? { header: block.header, body: sectionBody(wanted) } : block;
  });
  const missing = Object.entries(sections)
    .filter(([name]) => !blocks.some((b) => b.header.trim().slice(1, -1).trim() === name))
    .map(([name, body]) => ({ header: `[${name}]`, body: sectionBody(body) }));
  const out = [...replaced, ...missing].flatMap((b) => [b.header, ...b.body]);
  return [...newHead, ...out].join(NEWLINE).replace(MANY_NEWLINES, '\n\n').trimEnd() + NEWLINE;
}

/** Entfernt einen Schlüssel vor dem ersten [Abschnitt] (z. B. eine eingebettete Tabelle „x = {}“). */
function withoutTopKey(text: string, key: string): string {
  const lines = text.split(NEWLINE);
  const firstSection = lines.findIndex(isSectionHeader);
  const topEnd = firstSection === -1 ? lines.length : firstSection;
  return lines.filter((line, i) => i >= topEnd || keyOf(line) !== key).join(NEWLINE);
}

function sectionBody(entries: Readonly<Record<string, TomlValue>>): string[] {
  return [...Object.entries(entries).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`), ''];
}

function splitSections(lines: readonly string[]): Array<{ header: string; body: string[] }> {
  return lines.reduce<Array<{ header: string; body: string[] }>>((blocks, line) => {
    if (isSectionHeader(line)) return [...blocks, { header: line, body: [] }];
    const last = blocks[blocks.length - 1];
    if (last) last.body.push(line);
    return blocks;
  }, []);
}

export interface VelocityWiring {
  /** Port Velocity listens on inside the container. */
  readonly port: number;
  readonly onlineMode: boolean;
  /** Members in order: name → address on the Minecraft network ("mh-abc:25565"). */
  readonly servers: ReadonlyArray<{ readonly name: string; readonly address: string }>;
  /** Where players land first. */
  readonly tryOrder: readonly string[];
}

/** velocity.toml for a network proxy; also works on an empty file (Velocity fills in the rest on start). */
export function velocityToml(existing: string | null, w: VelocityWiring): string {
  const base =
    existing ??
    '# Von MorniHosting angelegt – Netzwerk-Einstellungen werden vor jedem Start gesetzt.\nconfig-version = "2.7"\n';
  const servers = Object.fromEntries(w.servers.map((s) => [s.name, s.address]));
  return patchToml(
    // Velocity schreibt eine leere Tabelle beim Speichern als „forced-hosts = {}“ nach oben; daneben stünde unser
    // [forced-hosts] – doppelt definiert (Velocity verzeiht das, die Gesundheitsprüfung des Containers nicht).
    withoutTopKey(base, 'forced-hosts'),
    {
      bind: `0.0.0.0:${w.port}`,
      'online-mode': w.onlineMode,
      'player-info-forwarding-mode': 'MODERN',
      'forwarding-secret-file': 'forwarding.secret',
    },
    { servers: { ...servers, try: w.tryOrder }, 'forced-hosts': {} },
  );
}

/** Only the bind line (for Velocity servers that are not in a network): the port the panel publishes. */
export function velocityBind(existing: string | null, port: number): string {
  return patchToml(existing ?? 'config-version = "2.7"\n', { bind: `0.0.0.0:${port}` }, {});
}

/** config/paper-global.yml of a member: Velocity forwarding on, with the network's secret. */
export function paperGlobalYaml(existing: string | null, secret: string, onlineMode: boolean): string {
  const doc = parseDocument(existing ?? '');
  doc.setIn(['proxies', 'velocity', 'enabled'], true);
  doc.setIn(['proxies', 'velocity', 'online-mode'], onlineMode);
  doc.setIn(['proxies', 'velocity', 'secret'], secret);
  return doc.toString();
}

/** Turns Velocity forwarding off again (server left the network). */
export function paperGlobalWithoutProxy(existing: string): string {
  const doc = parseDocument(existing);
  doc.setIn(['proxies', 'velocity', 'enabled'], false);
  doc.setIn(['proxies', 'velocity', 'secret'], '');
  return doc.toString();
}

/** Sets one key in a YAML file and keeps everything else. */
export function setYaml(existing: string, path: readonly string[], value: unknown): string {
  const doc = parseDocument(existing);
  doc.setIn(path, value);
  return doc.toString();
}
