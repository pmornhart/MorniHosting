/* eslint-disable ts-patterns/no-magic-numbers -- pixel art and file formats: offsets as PNG and ZIP define them */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { MorniCraftRank } from '@mornihosting/shared';

/**
 * Rank badges for the chat: a small coloured tag with an own pixel icon and the rank's name ("[♛ OWNER]"), like on
 * big servers. Minecraft can only show such pictures as letters of a font, so the panel makes a tiny resource pack
 * (one picture per rank, mapped to a private-use character) which the MorniCraft plugin offers to players when they
 * join. Who declines it – and Bedrock players – simply keep seeing the symbols.
 *
 * Everything is drawn here, pixel by pixel (own font, own icons); nothing is taken from Minecraft or anyone else.
 */

type Rgb = readonly [number, number, number];

/** Badges are as tall as a line of chat. */
const HEIGHT = 9;
const PAD = 2;
const ICON = 7;
const WHITE: Rgb = [255, 255, 255];
/** How dark the tag is compared with the rank's colour (the name stays readable in white). */
const SHADE = 0.5;
/** Longest name on a badge (a font picture may be at most 256 pixels wide). */
const MAX_TEXT = 16;
/** First of the private-use characters the badges live on. */
const FIRST_CHAR = 0xe700;

/** 5 × 7 letters (I and the blank are narrower). */
const FONT: Readonly<Record<string, readonly string[]>> = {
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  B: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X...X', 'X...X', 'XXXX.'],
  C: ['.XXX.', 'X...X', 'X....', 'X....', 'X....', 'X...X', '.XXX.'],
  D: ['XXXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'XXXX.'],
  E: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
  F: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....'],
  G: ['.XXX.', 'X...X', 'X....', 'X.XXX', 'X...X', 'X...X', '.XXX.'],
  H: ['X...X', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  I: ['XXX', '.X.', '.X.', '.X.', '.X.', '.X.', 'XXX'],
  J: ['..XXX', '...X.', '...X.', '...X.', '...X.', 'X..X.', '.XX..'],
  K: ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X'],
  L: ['X....', 'X....', 'X....', 'X....', 'X....', 'X....', 'XXXXX'],
  M: ['X...X', 'XX.XX', 'X.X.X', 'X.X.X', 'X...X', 'X...X', 'X...X'],
  N: ['X...X', 'XX..X', 'X.X.X', 'X..XX', 'X...X', 'X...X', 'X...X'],
  O: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  P: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'],
  Q: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X.X.X', 'X..X.', '.XX.X'],
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  S: ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'],
  T: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
  U: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  V: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.X.X.', '..X..'],
  W: ['X...X', 'X...X', 'X...X', 'X.X.X', 'X.X.X', 'XX.XX', 'X...X'],
  X: ['X...X', 'X...X', '.X.X.', '..X..', '.X.X.', 'X...X', 'X...X'],
  Y: ['X...X', 'X...X', '.X.X.', '..X..', '..X..', '..X..', '..X..'],
  Z: ['XXXXX', '....X', '...X.', '..X..', '.X...', 'X....', 'XXXXX'],
  Ä: ['X...X', '.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X'],
  Ö: ['X...X', '.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  Ü: ['X...X', '.....', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  '0': ['.XXX.', 'X...X', 'X..XX', 'X.X.X', 'XX..X', 'X...X', '.XXX.'],
  '1': ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '.XXX.'],
  '2': ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.X...', 'XXXXX'],
  '3': ['XXXX.', '....X', '....X', '.XXX.', '....X', '....X', 'XXXX.'],
  '4': ['...X.', '..XX.', '.X.X.', 'X..X.', 'XXXXX', '...X.', '...X.'],
  '5': ['XXXXX', 'X....', 'XXXX.', '....X', '....X', 'X...X', '.XXX.'],
  '6': ['.XXX.', 'X....', 'X....', 'XXXX.', 'X...X', 'X...X', '.XXX.'],
  '7': ['XXXXX', '....X', '...X.', '..X..', '..X..', '..X..', '..X..'],
  '8': ['.XXX.', 'X...X', 'X...X', '.XXX.', 'X...X', 'X...X', '.XXX.'],
  '9': ['.XXX.', 'X...X', 'X...X', '.XXXX', '....X', '....X', '.XXX.'],
  '-': ['.....', '.....', '.....', 'XXXXX', '.....', '.....', '.....'],
  '+': ['.....', '..X..', '..X..', 'XXXXX', '..X..', '..X..', '.....'],
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
};

/** Colours of the icons (one letter per pixel). */
const INK: Readonly<Record<string, Rgb>> = {
  Y: [255, 205, 60],
  O: [214, 150, 30],
  R: [230, 60, 60],
  B: [70, 150, 255],
  W: [255, 255, 255],
  o: [255, 159, 26],
  S: [176, 184, 196],
  H: [176, 124, 78],
  G: [85, 230, 110],
  P: [255, 106, 213],
  L: [140, 210, 255],
};

/** 7 × 7 icons, drawn for this panel. */
const ICONS: Readonly<Record<string, readonly string[]>> = {
  crown: ['Y..Y..Y', 'Y..Y..Y', 'YY.Y.YY', 'YYYYYYY', 'YRYBYRY', 'YYYYYYY', 'OOOOOOO'],
  shield: ['ooooooo', 'oooWooo', 'oWWWWWo', 'ooWWWoo', 'oWoooWo', '.ooooo.', '..ooo..'],
  sword: ['......L', '.....LL', '....LL.', 'B..LL..', '.BLL...', '..BB...', '.B..B..'],
  plus: ['..GGG..', '..GWG..', 'GGGWGGG', 'GWWWWWG', 'GGGWGGG', '..GWG..', '..GGG..'],
  hammer: ['.SSSSS.', 'SSSSSSS', '.SSSSS.', '...H...', '...H...', '...H...', '...H...'],
  play: ['PPPPPPP', 'PPWPPPP', 'PPWWPPP', 'PPWWWPP', 'PPWWPPP', 'PPWPPPP', 'PPPPPPP'],
  star: ['...Y...', '...Y...', 'YYYYYYY', '.YYYYY.', '..YYY..', '.YY.YY.', '.Y...Y.'],
  heart: ['.RR.RR.', 'RWRRRRR', 'RRRRRRR', 'RRRRRRR', '.RRRRR.', '..RRR..', '...R...'],
  bolt: ['...YY..', '..YY...', '.YYYY..', '...YY..', '..YY...', '.YY....', '.Y.....'],
  gem: ['..LLL..', '.LWLLL.', 'LLLLLLL', '.LLLLL.', '..LLL..', '...L...', '.......'],
};

/** Which icon stands for which symbol of the dashboard's picker (others get the gem). */
const ICON_OF: Readonly<Record<string, string>> = {
  '♛': 'crown',
  '✦': 'shield',
  '⚔': 'sword',
  '✚': 'plus',
  '⚒': 'hammer',
  '▶': 'play',
  '★': 'star',
  '❤': 'heart',
  '⚡': 'bolt',
};

interface Picture {
  readonly width: number;
  readonly height: number;
  /** RGBA, row by row. */
  readonly pixels: Buffer;
}

// "#ff5555" → 255, 85, 85. https://regex101.com/?flavor=javascript&regex=%5E%23(%5B0-9a-f%5D%7B2%7D)(%5B0-9a-f%5D%7B2%7D)(%5B0-9a-f%5D%7B2%7D)%24&flags=i&testString=%23ff5555
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
function rgbOf(hex: string): Rgb {
  const m = HEX.exec(hex);
  return m
    ? [parseInt(m[1] ?? '0', 16), parseInt(m[2] ?? '0', 16), parseInt(m[3] ?? '0', 16)]
    : [170, 170, 170];
}

/** The letters of a rank's name as the badge shows them: capitals, only what the font knows, not too long. */
function lettersOf(name: string): string[] {
  return [...name.toUpperCase()].filter((ch) => FONT[ch] !== undefined).slice(0, MAX_TEXT);
}

/** One badge: a tag in the rank's (darkened) colour with rounded corners, the icon, the name in white. */
export function badgePicture(rank: Pick<MorniCraftRank, 'name' | 'symbol' | 'color'>): Picture {
  const letters = lettersOf(rank.name);
  const icon = rank.symbol ? (ICONS[ICON_OF[rank.symbol] ?? 'gem'] ?? null) : null;
  const glyphs = letters.map((ch) => FONT[ch] ?? []);
  const textWidth = glyphs.reduce((sum, g) => sum + (g[0]?.length ?? 0) + 1, 0) - (glyphs.length ? 1 : 0);
  const iconWidth = icon ? ICON + PAD : 0;
  const width = PAD + iconWidth + Math.max(0, textWidth) + PAD;
  const pixels = Buffer.alloc(width * HEIGHT * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb): void => {
    pixels.set([r, g, b, 255], (y * width + x) * 4);
  };
  const [r, g, b] = rgbOf(rank.color);
  const tag: Rgb = [Math.round(r * SHADE), Math.round(g * SHADE), Math.round(b * SHADE)];
  const corner = (x: number, y: number): boolean =>
    (x === 0 || x === width - 1) && (y === 0 || y === HEIGHT - 1);
  Array.from({ length: HEIGHT }, (_, y) => y).forEach((y) =>
    Array.from({ length: width }, (_, x) => x)
      .filter((x) => !corner(x, y))
      .forEach((x) => put(x, y, tag)),
  );
  // A thin line of the rank's own colour along the bottom lifts the tag off the chat's background.
  Array.from({ length: width - 2 }, (_, x) => x + 1).forEach((x) => put(x, HEIGHT - 1, [r, g, b]));
  (icon ?? []).forEach((row, y) =>
    [...row].forEach((cell, x) => {
      const ink = INK[cell];
      if (ink) put(PAD + x, 1 + y, ink);
    }),
  );
  glyphs.reduce((left, glyph) => {
    glyph.forEach((row, y) =>
      [...row].forEach((cell, x) => {
        if (cell === 'X') put(left + x, 1 + y, WHITE);
      }),
    );
    return left + (glyph[0]?.length ?? 0) + 1;
  }, PAD + iconWidth);
  return { width, height: HEIGHT, pixels };
}

// ---------------------------------------------------------------- PNG and ZIP (small, written by hand)

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32(data.length), body, u32(zlib.crc32(body))]);
}

/** A picture as a PNG file (8-bit RGBA, no filter). */
export function pngOf(picture: Picture): Buffer {
  const stride = picture.width * 4;
  const rows = Array.from({ length: picture.height }, (_, y) =>
    Buffer.concat([Buffer.from([0]), picture.pixels.subarray(y * stride, (y + 1) * stride)]),
  );
  const header = Buffer.concat([u32(picture.width), u32(picture.height), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** Files as a ZIP archive (stored, not compressed – the pack is a few kilobytes). Always the same bytes for the same files. */
export function zipOf(entries: readonly ZipEntry[]): Buffer {
  const le = (n: number, bytes: 2 | 4): Buffer => {
    const b = Buffer.alloc(bytes);
    if (bytes === 2) b.writeUInt16LE(n);
    else b.writeUInt32LE(n >>> 0);
    return b;
  };
  // A fixed date (1 January 2026), so the pack's checksum only changes when its content does.
  const stamp = Buffer.concat([le(0, 2), le(((2026 - 1980) << 9) | (1 << 5) | 1, 2)]);
  const parts = entries.reduce<{ locals: Buffer[]; centrals: Buffer[]; offset: number }>(
    (acc, entry) => {
      const name = Buffer.from(entry.name, 'utf8');
      const sizes = Buffer.concat([
        le(zlib.crc32(entry.data), 4),
        le(entry.data.length, 4),
        le(entry.data.length, 4),
        le(name.length, 2),
        le(0, 2),
      ]);
      const local = Buffer.concat([
        le(0x04034b50, 4),
        le(20, 2),
        le(0x0800, 2),
        le(0, 2),
        stamp,
        sizes,
        name,
        entry.data,
      ]);
      const central = Buffer.concat([
        le(0x02014b50, 4),
        le(20, 2),
        le(20, 2),
        le(0x0800, 2),
        le(0, 2),
        stamp,
        sizes,
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 4),
        le(acc.offset, 4),
        name,
      ]);
      return {
        locals: [...acc.locals, local],
        centrals: [...acc.centrals, central],
        offset: acc.offset + local.length,
      };
    },
    { locals: [], centrals: [], offset: 0 },
  );
  const directory = Buffer.concat(parts.centrals);
  const end = Buffer.concat([
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(entries.length, 2),
    le(entries.length, 2),
    le(directory.length, 4),
    le(parts.offset, 4),
    le(0, 2),
  ]);
  return Buffer.concat([...parts.locals, directory, end]);
}

// ---------------------------------------------------------------- the pack

/** Resource pack formats: 15 is Minecraft 1.20; newer games read the range. */
const PACK_FORMAT = 15;
const PACK_FORMAT_MAX = 999;
const FONT_FOLDER = 'assets/mornicraft/textures/font';

export interface BadgePack {
  readonly zip: Buffer;
  /** SHA-1 of the zip (hex), as Minecraft wants it. */
  readonly sha1: string;
  /** Rank id → the character that shows its badge. */
  readonly chars: Readonly<Record<string, string>>;
}

/** The resource pack with one badge per rank. */
export function badgePack(ranks: readonly MorniCraftRank[]): BadgePack {
  const badges = ranks.map((rank, i) => ({
    rank,
    char: String.fromCharCode(FIRST_CHAR + i),
    file: `badge_${i}.png`,
  }));
  const font = {
    providers: badges.map(({ char, file }) => ({
      type: 'bitmap',
      file: `mornicraft:font/${file}`,
      ascent: 8,
      height: HEIGHT,
      chars: [char],
    })),
  };
  const meta = {
    pack: {
      description: 'MorniCraft – Rang-Abzeichen',
      pack_format: PACK_FORMAT,
      supported_formats: { min_inclusive: PACK_FORMAT, max_inclusive: PACK_FORMAT_MAX },
      min_format: PACK_FORMAT,
      max_format: PACK_FORMAT_MAX,
    },
  };
  const zip = zipOf([
    { name: 'pack.mcmeta', data: Buffer.from(JSON.stringify(meta, null, 2)) },
    { name: 'assets/minecraft/font/default.json', data: Buffer.from(JSON.stringify(font)) },
    ...badges.map(({ rank, file }) => ({ name: `${FONT_FOLDER}/${file}`, data: pngOf(badgePicture(rank)) })),
  ]);
  return {
    zip,
    sha1: crypto.createHash('sha1').update(zip).digest('hex'),
    chars: Object.fromEntries(badges.map(({ rank, char }) => [rank.id, char])),
  };
}
