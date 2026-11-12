/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { describe, expect, test } from 'vitest';
import {
  isPanelNoise,
  isStartFinished,
  parseListAnswer,
  parseTps,
  playerEventOf,
} from '../src/servers/log-parse.js';

describe('log parsing', () => {
  test.each([
    { line: '[12:00:01] [Server thread/INFO]: Done (3.512s)! For help, type "help"', done: true },
    { line: '[23:48:02 INFO]: Done (34.779s)! For help, type "help"', done: true },
    { line: '[2026-10-27 12:00:00:123 INFO] Server started.', done: true },
    { line: '[12:00:01] [Server thread/INFO]: Preparing level "world"', done: false },
  ])('start finished: $line', ({ line, done }) => {
    expect(isStartFinished(line)).toBe(done);
  });

  test.each([
    {
      line: '[12:00:01] [Server thread/INFO]: Lena_Baut joined the game',
      event: { kind: 'join', player: 'Lena_Baut' },
    },
    { line: '[23:48:02 INFO]: Juna left the game', event: { kind: 'leave', player: 'Juna' } },
    {
      line: '[12:00:01] [Server thread/INFO]: §eMia.Builds joined the game',
      event: { kind: 'join', player: 'Mia.Builds' },
    },
    { line: 'Player connected: Finn 2015, xuid: 2535', event: { kind: 'join', player: 'Finn 2015' } },
    { line: 'Player disconnected: Ella, xuid: 2535', event: { kind: 'leave', player: 'Ella' } },
    { line: '[12:00:01] [Server thread/INFO]: <Lena> I joined the game', event: null },
  ])('player event: $line', ({ line, event }) => {
    expect(playerEventOf(line)).toEqual(event);
  });

  test('list answer', () => {
    expect(parseListAnswer('There are 2 of a max of 20 players online: Juna, Ella')).toEqual({
      online: 2,
      max: 20,
      players: ['Juna', 'Ella'],
    });
    expect(parseListAnswer('There are 0 of a max of 20 players online: ')?.players).toEqual([]);
    expect(parseListAnswer('Unknown command')).toBeNull();
  });

  test.each([
    { answer: '§6TPS from last 1m, 5m, 15m: §a20.0§r, §a20.0§r, §a20.0', tps: 20 },
    { answer: 'TPS from last 1m, 5m, 15m: *20.0, *20.0, *20.0', tps: 20 },
    { answer: 'TPS from last 1m, 5m, 15m: 17.5, 19.0, 20.0', tps: 17.5 },
    { answer: 'Average time per tick: 100.0ms (Target: 50.0ms)', tps: 10 },
    { answer: 'Unknown command', tps: null },
  ])('tps from "$answer"', ({ answer, tps }) => {
    expect(parseTps(answer)).toBe(tps);
  });

  test('rcon polling noise is hidden', () => {
    expect(isPanelNoise('[23:48:05 INFO]: Thread RCON Client /172.19.0.2 started')).toBe(true);
    expect(isPanelNoise('[10:48:55 INFO]: [Essentials] Rcon issued server command: /list')).toBe(true);
    expect(isPanelNoise('[10:48:55 INFO]: [Essentials] Rcon issued server command: /say hi')).toBe(false);
    expect(isPanelNoise('[23:48:05 INFO]: Thread RCON Listener started')).toBe(false);
  });
});
