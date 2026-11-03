import zlib from 'node:zlib';

/**
 * A small reader for Minecraft's NBT format (player .dat files): gzip, big-endian, named tags.
 * Only reads; numbers become JS numbers (longs as Number, precise enough for what the panel shows).
 */

export type NbtValue = number | string | NbtValue[] | NbtCompound | number[];
export interface NbtCompound {
  [key: string]: NbtValue;
}

const TAG = {
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12,
} as const;
const SIZE = { byte: 1, short: 2, int: 4, long: 8, float: 4, double: 8 } as const;
/** Guards against hostile files: nesting and element counts a real player file never reaches. */
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 1_000_000;

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  private take(n: number): number {
    const at = this.offset;
    if (at + n > this.buf.length) throw new Error('nbt: unexpected end');
    this.offset += n;
    return at;
  }
  byte(): number {
    return this.buf.readInt8(this.take(SIZE.byte));
  }
  short(): number {
    return this.buf.readInt16BE(this.take(SIZE.short));
  }
  ushort(): number {
    return this.buf.readUInt16BE(this.take(SIZE.short));
  }
  int(): number {
    return this.buf.readInt32BE(this.take(SIZE.int));
  }
  long(): number {
    return Number(this.buf.readBigInt64BE(this.take(SIZE.long)));
  }
  float(): number {
    return this.buf.readFloatBE(this.take(SIZE.float));
  }
  double(): number {
    return this.buf.readDoubleBE(this.take(SIZE.double));
  }
  string(): string {
    const length = this.ushort();
    const at = this.take(length);
    // Java's "modified UTF-8" equals UTF-8 for everything a player name or item id contains.
    return this.buf.toString('utf8', at, at + length);
  }
  count(): number {
    const n = this.int();
    if (n < 0 || n > MAX_ELEMENTS) throw new Error('nbt: bad length');
    return n;
  }

  payload(type: number, depth: number): NbtValue {
    if (depth > MAX_DEPTH) throw new Error('nbt: too deep');
    const readers: Readonly<Record<number, () => NbtValue>> = {
      [TAG.byte]: () => this.byte(),
      [TAG.short]: () => this.short(),
      [TAG.int]: () => this.int(),
      [TAG.long]: () => this.long(),
      [TAG.float]: () => this.float(),
      [TAG.double]: () => this.double(),
      [TAG.byteArray]: () => Array.from({ length: this.count() }, () => this.byte()),
      [TAG.string]: () => this.string(),
      [TAG.list]: () => {
        const inner = this.byte();
        return Array.from({ length: this.count() }, () => this.payload(inner, depth + 1));
      },
      [TAG.compound]: () => this.compound(depth + 1),
      [TAG.intArray]: () => Array.from({ length: this.count() }, () => this.int()),
      [TAG.longArray]: () => Array.from({ length: this.count() }, () => this.long()),
    };
    const read = readers[type];
    if (!read) throw new Error(`nbt: unknown tag ${type}`);
    return read();
  }

  compound(depth: number): NbtCompound {
    const out: NbtCompound = {};
    const next = (): NbtCompound => {
      const type = this.byte();
      if (type === TAG.end) return out;
      out[this.string()] = this.payload(type, depth);
      return next();
    };
    return next();
  }
}

/** Reads a (usually gzipped) NBT file into plain objects. */
export function readNbt(data: Buffer): NbtCompound {
  const GZIP_MAGIC = 0x1f;
  const raw = data[0] === GZIP_MAGIC ? zlib.gunzipSync(data) : data;
  const reader = new Reader(raw);
  if (reader.byte() !== TAG.compound) throw new Error('nbt: root is not a compound');
  reader.string();
  return reader.compound(0);
}

export const isCompound = (v: NbtValue | undefined): v is NbtCompound =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const num = (v: NbtValue | undefined): number | null => (typeof v === 'number' ? v : null);
export const str = (v: NbtValue | undefined): string | null => (typeof v === 'string' ? v : null);
export const list = (v: NbtValue | undefined): NbtValue[] => (Array.isArray(v) ? (v as NbtValue[]) : []);
