/* eslint-disable ts-patterns/no-magic-numbers -- tests compare against literal expected values */
import dgram from 'node:dgram';
import { afterEach, describe, expect, test } from 'vitest';
import { bedrockPing, parsePong, signalingAnswers } from '../src/lib/bedrock-ping.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { withSignalingPorts } from '../src/servers/spec.js';

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const pong = (text: string): Buffer => {
  const head = Buffer.alloc(17);
  head[0] = 0x1c;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(Buffer.byteLength(text));
  return Buffer.concat([head, MAGIC, len, Buffer.from(text)]);
};

describe('Bedrock ping', () => {
  let server: dgram.Socket | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  test('reads the answer of a Bedrock server or Geyser', () => {
    expect(parsePong(pong('MCPE;Lenas Welt;766;1.21.50;2;20;123;Geyser;Survival;1;19132;19133;'))).toEqual({
      motd: 'Lenas Welt',
      version: '1.21.50',
      online: 2,
      max: 20,
    });
    expect(parsePong(Buffer.from([0x05, 1, 2]))).toBeNull();
  });

  test('asks over UDP and gives up quietly when nothing answers', async () => {
    server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      if (msg[0] === 0x01) server?.send(pong('MCPE;Test;766;1.21.50;0;10;'), rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => server?.bind(0, '127.0.0.1', resolve));
    const port = server.address().port;
    expect(await bedrockPing('127.0.0.1', port)).toMatchObject({ version: '1.21.50', max: 10 });
    expect(await bedrockPing('127.0.0.1', port + 1, 300)).toBeNull();
  });
});

describe('NetherNet signaling (Bedrock 26.60+)', () => {
  test('any HTTP answer on the Bedrock port counts, nothing listening does not', async () => {
    const server = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    expect(await signalingAnswers('127.0.0.1', port, 2000)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await signalingAnswers('127.0.0.1', port, 2000)).toBe(false);
  });

  test('the Geyser port is published for TCP as well as UDP', () => {
    const ports = withSignalingPorts([
      { port: 19133, containerPort: 19132, protocol: 'udp', purpose: 'geyser' },
      { port: 24454, protocol: 'udp', purpose: 'voice' },
    ]);
    expect(ports.map((p) => `${p.protocol} ${p.port}`)).toEqual(['udp 19133', 'tcp 19133', 'udp 24454']);
  });
});
