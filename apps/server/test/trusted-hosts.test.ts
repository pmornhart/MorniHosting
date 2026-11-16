import { expect, test } from 'vitest';
import { trustedHosts } from '../src/lib/trusted-hosts.js';
import { waitFor } from './helpers.js';

test('nur die genannten Hosts gelten als Weiterleiter (auch als ::ffff:-Adresse)', async () => {
  const hosts = trustedHosts(['localhost', '10.1.2.3']);
  await waitFor(async () => hosts.has('127.0.0.1'));
  expect(hosts.has('::ffff:127.0.0.1')).toBe(true);
  expect(hosts.has('10.1.2.3')).toBe(true);
  expect(hosts.has('10.1.2.4')).toBe(false);
  expect(hosts.has(undefined)).toBe(false);
  expect(trustedHosts([]).has('127.0.0.1')).toBe(false);
});
