import dgram from 'node:dgram';

/**
 * Asks a Bedrock server (or Geyser) whether it is there, the same way the game's server list does: one
 * "unconnected ping" over UDP (RakNet), answered with "MCPE;<motd>;<protocol>;<version>;<online>;<max>;…".
 */

const UNCONNECTED_PING = 0x01;
const UNCONNECTED_PONG = 0x1c;
/** RakNet's fixed "offline message" bytes. */
const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const LONG = 8;
const SHORT = 2;
/** Packet id, time, server GUID and magic come before the server's text. */
const PONG_TEXT_AT = 1 + LONG + LONG + MAGIC.length;
const DEFAULT_TIMEOUT_MS = 3000;
const CLIENT_GUID = 0x4d6f726e69n;

export interface BedrockPong {
  readonly motd: string;
  readonly version: string;
  readonly online: number;
  readonly max: number;
}

export function parsePong(packet: Buffer): BedrockPong | null {
  if (packet[0] !== UNCONNECTED_PONG || packet.length < PONG_TEXT_AT + SHORT) return null;
  const length = packet.readUInt16BE(PONG_TEXT_AT);
  const text = packet.toString('utf8', PONG_TEXT_AT + SHORT, PONG_TEXT_AT + SHORT + length);
  const [edition, motd = '', , version = '', online = '0', max = '0'] = text.split(';');
  if (edition !== 'MCPE' && edition !== 'MCEE') return null;
  return { motd, version, online: Number(online), max: Number(max) };
}

export function pingPacket(): Buffer {
  const time = Buffer.alloc(LONG);
  time.writeBigInt64BE(BigInt(Date.now()));
  const guid = Buffer.alloc(LONG);
  guid.writeBigInt64BE(CLIENT_GUID);
  return Buffer.concat([Buffer.from([UNCONNECTED_PING]), time, MAGIC, guid]);
}

/** Null when nothing answers within the time (wrong port, Geyser not running, UDP blocked). */
export function bedrockPing(
  host: string,
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BedrockPong | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (result: BedrockPong | null): void => {
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('error', () => done(null));
    socket.on('message', (message) => done(parsePong(message)));
    socket.send(pingPacket(), port, host, (err) => {
      if (err) done(null);
    });
  });
}
