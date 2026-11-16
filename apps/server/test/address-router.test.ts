/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import net from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import {
  bedrockAddress,
  cleanAddress,
  javaAddress,
  startRouter,
  type AddressRouter,
  type RouteTarget,
} from '../src/gateway/router.js';
import { forwardTargetProblem, singleIpv4 } from '../src/lib/net-guard.js';
import { backend, handshake, talk } from './router-wire.js';

describe('address router', () => {
  const opened: AddressRouter[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((r) => r.close()));
  });

  test('reads the typed address of Java and Bedrock players', () => {
    expect(javaAddress(handshake('reich.mornihosting.de'))).toBe('reich.mornihosting.de');
    // Half a packet: wait for the rest.
    expect(javaAddress(handshake('reich.mornihosting.de').subarray(0, 6))).toBe('wait');
    expect(javaAddress(Buffer.from([0xfe, 0x01]))).toBeNull();
    expect(bedrockAddress(Buffer.from('GET /ws HTTP/1.1\r\nHost: Reich.mornihosting.de:19132\r\n\r\n'))).toBe(
      'Reich.mornihosting.de:19132',
    );
    expect(bedrockAddress(Buffer.from('GET / HTTP/1.1\r\nHost: x'))).toBe('wait');
    expect(bedrockAddress(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toBeNull();
    // Forge adds "\0FML3\0", some clients a trailing dot; the port goes too.
    expect(cleanAddress('Reich.MorniHosting.de.\0FML3\0')).toBe('reich.mornihosting.de');
    expect(cleanAddress('reich.mornihosting.de:19132')).toBe('reich.mornihosting.de');
  });

  test('passes Java and Bedrock connections to the server named, closes unknown names', async () => {
    const target = await backend();
    try {
      const seen: string[] = [];
      const lookup = (address: string) => {
        seen.push(address);
        return address.startsWith('reich.') ? { host: '127.0.0.1', port: target.port } : null;
      };
      const java = await startRouter({ kind: 'java', host: '127.0.0.1', port: 0, lookup });
      const bedrock = await startRouter({ kind: 'bedrock', host: '127.0.0.1', port: 0, lookup });
      opened.push(java, bedrock);

      const login = Buffer.concat([handshake('reich.mornihosting.de'), Buffer.from('LOGIN')]);
      expect(await talk(java.port(), login)).toBe('hallo');
      // Every byte arrives unchanged, the handshake included.
      expect(target.got().equals(login)).toBe(true);

      const request = Buffer.from('POST /ws HTTP/1.1\r\nHost: reich.mornihosting.de\r\n\r\n{"offer":1}');
      expect(await talk(bedrock.port(), request)).toBe('hallo');
      expect(target.got().subarray(login.length).equals(request)).toBe(true);

      expect(await talk(java.port(), handshake('fremd.mornihosting.de'))).toBe('');
      expect(seen).toEqual(['reich.mornihosting.de', 'reich.mornihosting.de', 'fremd.mornihosting.de']);
    } finally {
      target.close();
    }
  });

  test('a lookup may take its time (another product: NetBird is asked); a failing one closes the connection', async () => {
    const target = await backend();
    try {
      const asked: RouteTarget[] = [];
      const errors: unknown[] = [];
      // Like another product's domain: the answer comes a moment later and names an address in the home network,
      // which the connect function of the test points at its own backend.
      const lookup = async (address: string): Promise<RouteTarget | null> => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (address === 'kaputt.example.org') throw new Error('NetBird antwortet nicht');
        return address === 'moinmorni.net' ? { host: '10.20.30.40', port: 25565 } : null;
      };
      const connect = (to: RouteTarget): net.Socket => {
        asked.push(to);
        return net.connect({ host: '127.0.0.1', port: target.port });
      };
      const java = await startRouter({
        kind: 'java',
        host: '127.0.0.1',
        port: 0,
        lookup,
        connect,
        onError: (err) => errors.push(err),
      });
      opened.push(java);

      const login = Buffer.concat([handshake('MoinMorni.net.\0FML3\0', 25565), Buffer.from('LOGIN')]);
      expect(await talk(java.port(), login)).toBe('hallo');
      expect(target.got().equals(login)).toBe(true);
      expect(asked).toEqual([{ host: '10.20.30.40', port: 25565 }]);

      expect(await talk(java.port(), handshake('kaputt.example.org'))).toBe('');
      expect(errors).toHaveLength(1);
      expect(asked).toHaveLength(1);
    } finally {
      target.close();
    }
  });

  test('the router only forwards into the home network or to NetBird machines, never to its own networks', () => {
    const docker = ['172.18.0.3/16', '172.19.0.2/16'];
    expect(forwardTargetProblem('10.20.30.40', docker)).toBeNull();
    expect(forwardTargetProblem('192.168.1.30', docker)).toBeNull();
    expect(forwardTargetProblem('172.31.0.9', docker)).toBeNull();
    // NetBird machines (CGNAT range 100.64.0.0/10).
    expect(forwardTargetProblem('100.92.14.9', docker)).toBeNull();
    // Never into the internet, never to the panel's own machine or link-local addresses.
    expect(forwardTargetProblem('203.0.113.50', docker)).toBe('not_private');
    expect(forwardTargetProblem('100.128.0.1', docker)).toBe('not_private');
    expect(forwardTargetProblem('127.0.0.1', docker)).toBe('not_private');
    expect(forwardTargetProblem('169.254.169.254', docker)).toBe('not_private');
    expect(forwardTargetProblem('fd00::5', docker)).toBe('not_private');
    expect(forwardTargetProblem('moinmorni.net', docker)).toBe('not_private');
    // The panel's own (Docker) networks: the Docker API proxy lives there.
    expect(forwardTargetProblem('172.18.0.2', docker)).toBe('own_network');
    expect(forwardTargetProblem('172.19.200.1', docker)).toBe('own_network');

    expect(singleIpv4('10.20.30.40')).toBe('10.20.30.40');
    expect(singleIpv4(' 10.20.30.40/32 ')).toBe('10.20.30.40');
    expect(singleIpv4('10.20.30.0/24')).toBeNull();
    expect(singleIpv4('nas.example.org')).toBeNull();
    expect(singleIpv4(null)).toBeNull();
  });
});
