/* eslint-disable ts-patterns/no-magic-numbers -- Minecraft's wire format: VarInt bits, protocol and port numbers */
import net from 'node:net';

/** What the address router tests send and receive over real TCP connections. */

export const varInt = (value: number): Buffer => {
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
export function handshake(address: string, port = 25565): Buffer {
  const text = Buffer.from(address, 'utf8');
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  const body = Buffer.concat([varInt(0), varInt(774), varInt(text.length), text, portBytes, varInt(2)]);
  return Buffer.concat([varInt(body.length), body]);
}

/** A backend that remembers what it got and answers "hallo". */
export function backend(): Promise<{ port: number; got: () => Buffer; close: () => void }> {
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

/** Sends `data` to the router and gives back the first answer ("" when the router closed the connection). */
export function talk(port: number, data: Buffer): Promise<string> {
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
