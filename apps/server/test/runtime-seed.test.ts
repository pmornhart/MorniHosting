/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { needsRuntime, seedRuntime } from '../src/servers/game-seed.js';

const made: string[] = [];
const dir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-seed-'));
  made.push(d);
  return d;
};
const put = (root: string, file: string, text = 'x'): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

afterEach(() => made.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('a new Minecraft server takes the server program of a finished one', () => {
  test('program files come along, world, plugins, settings and player lists stay behind', async () => {
    const from = dir();
    const to = dir();
    [
      'paper-1.21.4-232.jar',
      '.paper-manifest.json',
      'libraries/com/a.jar',
      'cache/mojang_1.21.4.jar',
      'versions/1.21.4/paper.jar',
      'plugins/.paper-remapped/remap-classpath/ABC.jar',
      'plugins/.paper-remapped/mappings/reversed/ABC.tiny',
      'plugins/Geyser-Spigot.jar',
      'plugins/.paper-remapped/index.json',
      'world/level.dat',
      'server.properties',
      'ops.json',
      '.rcon-cli.env',
    ].forEach((f) => put(from, f));
    expect(needsRuntime(to)).toBe(true);
    expect(await seedRuntime(from, to)).toBeGreaterThan(0);
    const has = (f: string): boolean => fs.existsSync(path.join(to, f));
    expect(
      [
        'paper-1.21.4-232.jar',
        '.paper-manifest.json',
        'libraries/com/a.jar',
        'cache/mojang_1.21.4.jar',
      ].every(has),
    ).toBe(true);
    expect(has('plugins/.paper-remapped/remap-classpath/ABC.jar')).toBe(true);
    expect(
      [
        'plugins/Geyser-Spigot.jar',
        'plugins/.paper-remapped/index.json',
        'world/level.dat',
        'server.properties',
        'ops.json',
        '.rcon-cli.env',
      ].some(has),
    ).toBe(false);
    expect(needsRuntime(to)).toBe(false);
  });
});
