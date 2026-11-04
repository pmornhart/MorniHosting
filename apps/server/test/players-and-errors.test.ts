import { describe, expect, it } from 'vitest';
import { GAMES } from '@mornihosting/shared';
import { parseGamePlayers } from '../src/games/settings.js';
import { errorMessage } from '../src/lib/errors.js';

describe('player lists of other games', () => {
  it('reads Garry’s Mod "status" and skips bots', () => {
    const answer = [
      'hostname: Garry’s Mod',
      'players : 2 (16 max)',
      '',
      '# userid name                uniqueid            connected ping loss state  adr',
      '#      2 "Lena"              STEAM_0:1:12345     00:12       50    0 active 10.0.0.2:27005',
      '#      3 "Bot01"             BOT                                     active',
    ].join('\n');
    expect(parseGamePlayers(GAMES.gmod, answer)).toEqual(['Lena']);
  });

  it('reads CS2 "status"', () => {
    const answer = [
      '---------players--------',
      '  id     time ping loss      state   rate adr name',
      "65535 [NoChan]    0    0 challenging      0unknown ''",
      "    2    01:23   17    0     active 786432 203.0.113.5:27005 'Lena Baut'",
      '#end',
    ].join('\n');
    expect(parseGamePlayers(GAMES.cs2, answer)).toEqual(['Lena Baut']);
  });

  it('keeps the names from join lines when the answer is no player list', () => {
    expect(parseGamePlayers(GAMES.cs2, 'Unknown command')).toBeNull();
  });
});

describe('error messages', () => {
  it('explains "fetch failed" from its cause', () => {
    const err = new Error('fetch failed', { cause: { code: 'ENOTFOUND', hostname: 'discord.com' } });
    expect(errorMessage(err)).toContain('discord.com wurde nicht gefunden');
  });

  it('names a NetBird exit node that is not connected', () => {
    const err = new Error('lookup registry-1.docker.io on 9.9.9.9:53: write: required key not available');
    expect(errorMessage(err)).toContain('Exit-Node');
  });
});
