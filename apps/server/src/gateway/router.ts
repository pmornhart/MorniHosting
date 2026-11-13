import net from 'node:net';

/**
 * The address router: every server answers on the usual ports under its own name, without a port to type –
 * "reich.mornihosting.de" instead of "reich.mornihosting.de:25567".
 *
 * Java: the client names the address it typed in its very first packet (the handshake). Bedrock (since 26.60,
 * NetherNet): players first reach the server over TCP with plain HTTP ("signaling") and name it in the Host header;
 * the game itself then runs over UDP on the port Geyser hands out (each server keeps its own one). So one TCP port
 * per edition is enough: the router reads the name, opens a connection to that server and from then on only passes
 * bytes through both ways. Nothing is changed, nothing decrypted.
 */

export type RouterKind = 'java' | 'bedrock';

export interface RouteTarget {
  readonly host: string;
  readonly port: number;
}

/** Finds the server for a typed address ("reich.mornihosting.de"); null = unknown, the connection is closed. */
export type RouteLookup = (address: string, kind: RouterKind) => RouteTarget | null;

/** How long a client may take for its first packet, and how much the router reads before giving up. */
const FIRST_PACKET_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 8192;
const VARINT_MAX_BYTES = 5;
const VARINT_DATA_BITS = 0x7f;
const VARINT_MORE = 0x80;
const VARINT_SHIFT = 7;
/** Java's ancient "server list ping" (before 1.7) starts with this byte; it carries no address. */
const LEGACY_PING = 0xfe;
const HANDSHAKE_PACKET = 0;
const HEADER_END = '\r\n\r\n';
// The Host header of an HTTP request, e.g. "Host: reich.mornihosting.de:19132" → "reich.mornihosting.de:19132".
// https://regex101.com/?flavor=javascript&regex=%5Ehost%3A%5B%20%5Ct%5D*(%5B%5E%5Cr%5Cn%5D%2B)&flags=im&testString=GET%20%2F%20HTTP%2F1.1%0D%0AHost%3A%20reich.mornihosting.de%3A19132%0D%0A%0D%0A
const HOST_HEADER = /^host:[ \t]*([^\r\n]+)/im;
// A trailing port or dot of an address: "reich.mornihosting.de:19132" / "reich.mornihosting.de." → "reich.mornihosting.de".
// https://regex101.com/?flavor=javascript&regex=(%3A%5Cd%2B)%3F%5C.%3F%24&testString=reich.mornihosting.de%3A19132
const PORT_OR_DOT = /(:\d+)?\.?$/;

/** Cleans a typed address: lower case, no port, no trailing dot, no Forge/Bungee extras after a zero byte. */
export function cleanAddress(raw: string): string {
  return (raw.split('\0')[0] ?? '').trim().toLowerCase().replace(PORT_OR_DOT, '');
}

interface VarInt {
  readonly value: number;
  readonly size: number;
}

/** A Minecraft VarInt at `offset`; null when the buffer ends first (more bytes needed) or it is too long. */
function readVarInt(buf: Buffer, offset: number, index = 0, value = 0): VarInt | null | 'bad' {
  if (index >= VARINT_MAX_BYTES) return 'bad';
  const byte = buf[offset + index];
  if (byte === undefined) return null;
  const next = value | ((byte & VARINT_DATA_BITS) << (VARINT_SHIFT * index));
  return byte & VARINT_MORE ? readVarInt(buf, offset, index + 1, next) : { value: next, size: index + 1 };
}

/**
 * The address from a Java handshake: string (the address), 'wait' when the packet is not complete yet, null when
 * it is not a handshake.
 */
export function javaAddress(buf: Buffer): string | 'wait' | null {
  if (buf[0] === LEGACY_PING) return null;
  const length = readVarInt(buf, 0);
  if (length === 'bad') return null;
  if (length === null || buf.length < length.size + length.value) return 'wait';
  const start = length.size;
  const id = readVarInt(buf, start);
  if (id === null || id === 'bad' || id.value !== HANDSHAKE_PACKET) return null;
  const protocol = readVarInt(buf, start + id.size);
  if (protocol === null || protocol === 'bad') return null;
  const textAt = start + id.size + protocol.size;
  const textLength = readVarInt(buf, textAt);
  if (textLength === null || textLength === 'bad') return null;
  const from = textAt + textLength.size;
  if (from + textLength.value > start + length.value) return null;
  return buf.subarray(from, from + textLength.value).toString('utf8');
}

/** The Host of a Bedrock signaling request: string, 'wait' (header not complete), null (no HTTP/no Host). */
export function bedrockAddress(buf: Buffer): string | 'wait' | null {
  const text = buf.toString('latin1');
  const end = text.indexOf(HEADER_END);
  if (end < 0) return 'wait';
  return HOST_HEADER.exec(text.slice(0, end))?.[1] ?? null;
}

const READERS: Readonly<Record<RouterKind, (buf: Buffer) => string | 'wait' | null>> = {
  java: javaAddress,
  bedrock: bedrockAddress,
};

export interface AddressRouter {
  readonly port: () => number;
  readonly close: () => Promise<void>;
}

/** Listens on one TCP port and routes every connection by the address the client typed. */
export function startRouter(options: {
  readonly kind: RouterKind;
  readonly host: string;
  readonly port: number;
  readonly lookup: RouteLookup;
  readonly onError?: (err: unknown) => void;
}): Promise<AddressRouter> {
  const { kind, lookup } = options;
  const handle = (client: net.Socket): void => {
    client.setNoDelay(true);
    client.setTimeout(FIRST_PACKET_TIMEOUT_MS, () => client.destroy());
    client.on('error', () => client.destroy());
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const found = READERS[kind](buf);
      if (found === 'wait' && buf.length < MAX_HEADER_BYTES) return;
      client.off('data', onData);
      client.pause();
      // Bedrock without a Host header still gets a lookup (the gateway may know the only fitting server).
      const address = typeof found === 'string' ? found : kind === 'bedrock' && buf.length > 0 ? '' : null;
      const target = address === null ? null : lookup(cleanAddress(address), kind);
      if (!target) {
        client.destroy();
        return;
      }
      const upstream = net.connect({ host: target.host, port: target.port });
      upstream.setNoDelay(true);
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        client.setTimeout(0);
        upstream.write(buf);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  };
  const server = net.createServer(handle);
  server.on('error', (err) => options.onError?.(err));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve({
        port: () => {
          const address = server.address();
          return typeof address === 'object' && address ? address.port : options.port;
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
