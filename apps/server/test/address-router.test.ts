/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import net from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import {
  bedrockAddress,
  cleanAddress,
  javaAddress,
  startRouter,
  type AddressRouter,
} from '../src/gateway/router.js';

const varInt = (value: number): Buffer => {
  const bytes: number[] = [];
  const write = (v: number): void => {
    const low = v & 0x7f;
    const rest = v >>> 7;
    bytes.push(rest ? low | 0x80 : low);
    if (rest) write(rest);
  };
  write(value);
  return Buffer.from(bytes);
};

/** A Java handshake packet as the client sends it (protocol 774, next state 2 = login). */
function handshake(address: string, port = 25565): Buffer {
  const text = Buffer.from(address, 'utf8');
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  const body = Buffer.concat([varInt(0), varInt(774), varInt(text.length), text, portBytes, varInt(2)]);
  return Buffer.concat([varInt(body.length), body]);
}

/** A backend that remembers what it got and answers "hallo". */
function backend(): Promise<{ port: number; got: () => Buffer; close: () => void }> {
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (c) => {
      chunks.push(c);
      socket.write('hallo');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        got: () => Buffer.concat(chunks),
        close: () => server.close(),
      });
    });
  });
}

function talk(port: number, data: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(data));
    const answer: Buffer[] = [];
    socket.on('data', (c) => {
      answer.push(c);
      socket.end();
    });
    socket.on('close', () => resolve(Buffer.concat(answer).toString()));
    socket.on('error', () => resolve(''));
  });
}

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
});
