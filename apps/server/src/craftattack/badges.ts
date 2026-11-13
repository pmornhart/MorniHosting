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

/** The picture is as tall as a line of chat; the tag itself leaves a row free above and below. */
const HEIGHT = 9;
const TAG_TOP = 1;
const TAG_BOTTOM = 7;
/** The name starts one row below the tag's top edge. */
const TEXT_TOP = 2;
const PAD = 2;
const ICON = 7;
const WHITE: Rgb = [255, 255, 255];
/** How dark the tag is compared with the rank's colour (the name stays readable in white). */
const SHADE = 0.5;
/** Longest name on a badge (a font picture may be at most 256 pixels wide). */
const MAX_TEXT = 16;
/** First of the private-use characters the badges live on. */
const FIRST_CHAR = 0xe700;

/**
 * Small capitals, 5 pixels tall (most 3 wide; M, N and W wider): the name sits inside the tag with a pixel of
 * room above and below, and the tags of two chat lines don't touch.
 */
const FONT: Readonly<Record<string, readonly string[]>> = {
  A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'],
  B: ['XX.', 'X.X', 'XX.', 'X.X', 'XX.'],
  C: ['.XX', 'X..', 'X..', 'X..', '.XX'],
  D: ['XX.', 'X.X', 'X.X', 'X.X', 'XX.'],
  E: ['XXX', 'X..', 'XX.', 'X..', 'XXX'],
  F: ['XXX', 'X..', 'XX.', 'X..', 'X..'],
  G: ['.XX', 'X..', 'X.X', 'X.X', '.XX'],
  H: ['X.X', 'X.X', 'XXX', 'X.X', 'X.X'],
  I: ['XXX', '.X.', '.X.', '.X.', 'XXX'],
  J: ['..X', '..X', '..X', 'X.X', '.X.'],
  K: ['X.X', 'X.X', 'XX.', 'X.X', 'X.X'],
  L: ['X..', 'X..', 'X..', 'X..', 'XXX'],
  M: ['X...X', 'XX.XX', 'X.X.X', 'X...X', 'X...X'],
  N: ['X..X', 'XX.X', 'X.XX', 'X..X', 'X..X'],
  O: ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  P: ['XX.', 'X.X', 'XX.', 'X..', 'X..'],
  Q: ['.X.', 'X.X', 'X.X', 'XXX', '.XX'],
  R: ['XX.', 'X.X', 'XX.', 'X.X', 'X.X'],
  S: ['.XX', 'X..', '.X.', '..X', 'XX.'],
  T: ['XXX', '.X.', '.X.', '.X.', '.X.'],
  U: ['X.X', 'X.X', 'X.X', 'X.X', 'XXX'],
  V: ['X.X', 'X.X', 'X.X', 'X.X', '.X.'],
  W: ['X...X', 'X...X', 'X.X.X', 'XX.XX', 'X...X'],
  X: ['X.X', 'X.X', '.X.', 'X.X', 'X.X'],
  Y: ['X.X', 'X.X', '.X.', '.X.', '.X.'],
  Z: ['XXX', '..X', '.X.', 'X..', 'XXX'],
  Ä: ['X.X', '.X.', 'X.X', 'XXX', 'X.X'],
  Ö: ['X.X', 'XXX', 'X.X', 'X.X', 'XXX'],
  Ü: ['X.X', '...', 'X.X', 'X.X', 'XXX'],
  '0': ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  '1': ['.X.', 'XX.', '.X.', '.X.', 'XXX'],
  '2': ['XX.', '..X', '.X.', 'X..', 'XXX'],
  '3': ['XX.', '..X', '.X.', '..X', 'XX.'],
  '4': ['X.X', 'X.X', 'XXX', '..X', '..X'],
  '5': ['XXX', 'X..', 'XX.', '..X', 'XX.'],
  '6': ['.XX', 'X..', 'XXX', 'X.X', 'XXX'],
  '7': ['XXX', '..X', '.X.', '.X.', '.X.'],
  '8': ['XXX', 'X.X', 'XXX', 'X.X', 'XXX'],
  '9': ['XXX', 'X.X', 'XXX', '..X', 'XX.'],
  '-': ['...', '...', 'XXX', '...', '...'],
  '+': ['...', '.X.', 'XXX', '.X.', '...'],
  ' ': ['..', '..', '..', '..', '..'],
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
  // Head and shoulders: everyone without another rank.
  player: ['..WWW..', '.WWWWW.', '.WWWWW.', '..WWW..', '.WWWWW.', 'WWWWWWW', 'WWWWWWW'],
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

/** The icon of a rank: by its symbol; the rank for everyone else gets the player; no symbol, no icon. */
function iconOf(rank: Pick<MorniCraftRank, 'symbol'> & { readonly isDefault?: boolean }): string {
  if (rank.symbol) return ICON_OF[rank.symbol] ?? 'gem';
  return rank.isDefault ? 'player' : 'none';
}

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

/** Only the icon, nothing around it (Philip: "nur noch die Krone"); one pixel of room to the next letter. */
function iconPicture(icon: readonly string[]): Picture {
  const width = ICON + 1;
  const pixels = Buffer.alloc(width * HEIGHT * 4);
  icon.forEach((row, y) =>
    [...row].forEach((cell, x) => {
      const ink = INK[cell];
      if (ink) pixels.set([...ink, 255], ((TAG_TOP + y) * width + x) * 4);
    }),
  );
  return { width, height: HEIGHT, pixels };
}

/**
 * One badge. Standard: only the rank's icon. With `text`: a tag in the rank's (darkened) colour with rounded corners,
 * the icon and the name in white.
 */
export function badgePicture(
  rank: Pick<MorniCraftRank, 'name' | 'symbol' | 'color'> & { readonly isDefault?: boolean },
  options: { readonly text?: boolean } = { text: true },
): Picture {
  const plain = ICONS[iconOf(rank)];
  if (options.text === false && plain) return iconPicture(plain);
  const letters = lettersOf(rank.name);
  const icon = ICONS[iconOf(rank)] ?? null;
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
    (x === 0 || x === width - 1) && (y === TAG_TOP || y === TAG_BOTTOM);
  Array.from({ length: TAG_BOTTOM - TAG_TOP + 1 }, (_, i) => TAG_TOP + i).forEach((y) =>
    Array.from({ length: width }, (_, x) => x)
      .filter((x) => !corner(x, y))
      .forEach((x) => put(x, y, tag)),
  );
  // A thin line of the rank's own colour along the bottom lifts the tag off the chat's background.
  Array.from({ length: width - 2 }, (_, x) => x + 1).forEach((x) => put(x, TAG_BOTTOM, [r, g, b]));
  (icon ?? []).forEach((row, y) =>
    [...row].forEach((cell, x) => {
      const ink = INK[cell];
      if (ink) put(PAD + x, TAG_TOP + y, ink);
    }),
  );
  glyphs.reduce((left, glyph) => {
    glyph.forEach((row, y) =>
      [...row].forEach((cell, x) => {
        if (cell === 'X') put(left + x, TEXT_TOP + y, WHITE);
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
export function badgePack(
  ranks: readonly MorniCraftRank[],
  options: { readonly text?: boolean } = {},
): BadgePack {
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
    ...badges.map(({ rank, file }) => ({
      name: `${FONT_FOLDER}/${file}`,
      data: pngOf(badgePicture(rank, { text: options.text ?? true })),
    })),
  ]);
  return {
    zip,
    sha1: crypto.createHash('sha1').update(zip).digest('hex'),
    chars: Object.fromEntries(badges.map(({ rank, char }) => [rank.id, char])),
  };
}
