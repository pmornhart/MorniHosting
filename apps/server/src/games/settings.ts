import fs from 'node:fs';
import path from 'node:path';
import { gameOf, type GameField, type GameInfo, type GameSettingsView } from '@mornihosting/shared';
import type { SecretBox } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { gamePorts, type ServerRow } from '../servers/spec.js';

/** Owner-only read and write for the RCON password file (Factorio reads config/rconpw). */
const PASSWORD_FILE_MODE = 0o600;

// Values the image gets as variables: no line breaks, nothing a shell would trip over.
// Matches "Mein Server 2", "abc123-_.:/@"; rejects "a\nb" and "$(x)".
// https://regex101.com/?flavor=javascript&regex=%5E%5B%5Cp%7BL%7D%5Cp%7BN%7D%20_.%3A%2F%40%2C%2B%23!%3F%26%3D%5C-%5D*%24&flags=gmu&testString=Mein%20Server%202%0Aabc123-_.%3A%2F%40%0A%24(x)
const SAFE_VALUE = /^[\p{L}\p{N} _.:/@,+#!?&=-]*$/u;
const NUMBER_VALUE = /^\d{1,9}$/; // eslint-disable-line ts-patterns/require-regex-example -- only digits: "64" passes, "6.4" and "-1" fail
const WHITESPACE = /\s/; // eslint-disable-line ts-patterns/require-regex-example -- any blank: "a b" has one, "ab" none

/**
 * Checks settings for a game: only its own fields, booleans as "true"/"false", numbers as digits, text without
 * special characters. Empty strings clear a field.
 */
export function validateGameSettings(game: GameInfo, input: Readonly<Record<string, string>>): void {
  Object.entries(input).forEach(([key, value]) => {
    const field = game.fields.find((f) => f.key === key);
    if (!field) throw badRequest('game_setting_unknown', { key });
    if (value === '') return;
    const checks: Readonly<Record<GameField['kind'], () => boolean>> = {
      boolean: () => value === 'true' || value === 'false',
      number: () => NUMBER_VALUE.test(value),
      select: () => field.options?.includes(value) ?? false,
      text: () => SAFE_VALUE.test(value),
      secret: () => SAFE_VALUE.test(value),
    };
    // Start arguments are split at blanks: a blank would smuggle in another argument.
    const valid = checks[field.kind]() && !(field.arg && WHITESPACE.test(value));
    if (!valid) throw badRequest('game_setting_invalid', { key });
  });
}

/** Merges new values into the stored ones; secret fields are encrypted, empty values removed. */
export function mergeGameSettings(
  game: GameInfo,
  stored: Readonly<Record<string, string>>,
  input: Readonly<Record<string, string>>,
  secrets: SecretBox,
): Record<string, string> {
  const merged = Object.entries(input).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      const secret = game.fields.find((f) => f.key === key)?.kind === 'secret';
      if (value === '') return Object.fromEntries(Object.entries(acc).filter(([k]) => k !== key));
      return { ...acc, [key]: secret ? secrets.encrypt(value) : value };
    },
    { ...stored },
  );
  return merged;
}

/** Stored settings with secret fields decrypted, for building the container. */
export function decryptGameSettings(
  row: Pick<ServerRow, 'software' | 'gameSettings'>,
  secrets: SecretBox,
): Record<string, string> {
  const game = gameOf(row.software);
  if (!game) return {};
  return Object.fromEntries(
    Object.entries(row.gameSettings).map(([key, value]) => {
      const secret = game.fields.find((f) => f.key === key)?.kind === 'secret';
      return [key, secret ? secrets.decrypt(value) : value];
    }),
  );
}

/** What the settings page shows: plain values, and for secrets only whether one is stored. */
export function gameSettingsView(row: Pick<ServerRow, 'software' | 'gameSettings'>): GameSettingsView | null {
  const game = gameOf(row.software);
  if (!game) return null;
  const secretKeys = new Set(game.fields.filter((f) => f.kind === 'secret').map((f) => f.key));
  return {
    values: Object.fromEntries(Object.entries(row.gameSettings).filter(([key]) => !secretKeys.has(key))),
    secretsSet: Object.keys(row.gameSettings).filter((key) => secretKeys.has(key)),
  };
}

/** Files from `requiredFiles` that are not uploaded yet (relative paths). */
export function missingGameFiles(dir: string, software: string): string[] {
  return (gameOf(software)?.requiredFiles ?? []).filter((file) => !fs.existsSync(path.join(dir, file)));
}

/** A value as the sii format wants it: text in quotes, numbers and true/false bare. */
function siiValue(kind: GameField['kind'] | 'port', value: string): string {
  return kind === 'number' || kind === 'boolean' || kind === 'port' ? value : `"${value}"`;
}

/**
 * Keeps the game's sii config in step with the settings and ports: every known key line is replaced, the
 * rest of the file (changed by hand) stays. Values went through validateGameSettings (no quotes, no breaks).
 */
function writeConfigFile(
  dir: string,
  row: Pick<ServerRow, 'port' | 'extraPorts' | 'gameSettings'>,
  game: GameInfo,
): void {
  if (!game.configFile) return;
  const file = path.join(dir, game.configFile.path);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : game.configFile.template;
  const ports = gamePorts(row, game);
  const values = new Map<string, string>([
    ...game.ports.flatMap((p): [string, string][] => {
      const bound = ports.find((b) => b.key === p.key);
      return p.configKey && bound ? [[p.configKey, siiValue('port', String(bound.hostPort))]] : [];
    }),
    ...game.fields.flatMap((f): [string, string][] => {
      const value = row.gameSettings[f.key] || f.fallback;
      return f.configKey && value !== undefined ? [[f.configKey, siiValue(f.kind, value)]] : [];
    }),
  ]);
  const lines = current.split('\n').map((line) => {
    const key = line.trim().split(':')[0] ?? '';
    const value = values.get(key);
    return value === undefined ? line : ` ${key}: ${value}`;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
}

/** Writes files the image expects before it starts (RCON password for Factorio, ETS2's server config). */
export function prepareGameFiles(
  dir: string,
  row: Pick<ServerRow, 'software' | 'rconPassword' | 'port' | 'extraPorts' | 'gameSettings'>,
): void {
  const game = gameOf(row.software);
  // Mounted folders must exist, otherwise Docker creates them owned by root.
  game?.mounts.forEach((m) => fs.mkdirSync(path.join(dir, m.subdir), { recursive: true }));
  if (game) writeConfigFile(dir, row, game);
  if (!game?.rconPasswordFile) return;
  const file = path.join(dir, game.rconPasswordFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, row.rconPassword, { mode: PASSWORD_FILE_MODE });
}

/** Player names out of the answer to the game's list command. */
export function parseGamePlayers(game: GameInfo, answer: string): string[] | null {
  const entry = game.logPatterns.listEntry;
  if (!entry) return null;
  const header = game.logPatterns.listHeader;
  if (header && !header.test(answer)) return null;
  return answer
    .split('\n')
    .map((line) => line.match(entry)?.[1])
    .filter((name): name is string => Boolean(name));
}
