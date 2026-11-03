/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ConnectionInfo, ServerSummary } from '@mornihosting/shared';
import { isHomeNetworkAddress } from '../src/lib/net-guard.js';
import { authHeaders, createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

describe('home network addresses', () => {
  test.each([
    ['192.168.178.20', true],
    ['::ffff:10.0.0.5', true],
    ['172.20.1.4', true],
    ['fd12:3456::1', true],
    ['100.92.14.7', false], // NetBird / CGNAT
    ['127.0.0.1', false],
    ['198.51.100.7', false],
    ['2003:e0::1', false],
    ['kein-ip', false],
  ])('%s', (address, home) => {
    expect(isHomeNetworkAddress(address)).toBe(home);
  });
});

describe('address for friends', () => {
  let t: TestApp;
  let s: Session;
  beforeEach(async () => {
    t = await createTestApp({ MH_LAN_IP: '192.168.178.114' });
    s = await setupAdmin(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  test('someone at home is told to use the LAN address, someone outside is not', async () => {
    const server = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: authHeaders(s),
        payload: {
          name: 'Reich',
          edition: 'java',
          software: 'paper',
          version: '1.21.4',
          memoryMb: 2048,
          port: 25565,
          eula: true,
          startNow: false,
        },
      })
    ).json<ServerSummary>();
    const from = async (remoteAddress: string) =>
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/servers/${server.id}/connection`,
          headers: authHeaders(s),
          remoteAddress,
        })
      ).json<ConnectionInfo>();
    expect(await from('192.168.178.20')).toMatchObject({ lanIp: '192.168.178.114', viewerAtHome: true });
    expect((await from('93.223.190.1')).viewerAtHome).toBe(false);
  });
});
