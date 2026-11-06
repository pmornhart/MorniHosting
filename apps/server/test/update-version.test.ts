/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { expect, test } from 'vitest';
import { changeItems, versionFromCount } from '../src/system/update.js';

test('version numbers have one digit per place: after 0.0.9 comes 0.1.0', () => {
  expect(versionFromCount(9)).toBe('0.0.9');
  expect(versionFromCount(10)).toBe('0.1.0');
  expect(versionFromCount(84)).toBe('0.8.4');
  expect(versionFromCount(99)).toBe('0.9.9');
  expect(versionFromCount(100)).toBe('1.0.0');
});

test('a commit message becomes new / fixed / improved / removed lines', () => {
  const message = [
    'Impressum und Bedrock',
    '',
    '- Neu: Impressum-Seite mit Bild',
    '- Behoben: Bedrock kam von außen nicht rein',
    '- Verbessert: Server starten schneller',
    '- Entfernt: alter Router-Hinweis',
    '- Server hing auf „Welt wird geladen“',
    '',
    'Verfasst mit Claude 🤖',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
  ].join('\n');
  expect(changeItems(message)).toEqual([
    { kind: 'new', text: 'Impressum-Seite mit Bild' },
    { kind: 'fixed', text: 'Bedrock kam von außen nicht rein' },
    { kind: 'improved', text: 'Server starten schneller' },
    { kind: 'removed', text: 'alter Router-Hinweis' },
    { kind: 'fixed', text: 'Server hing auf „Welt wird geladen“' },
  ]);
});
