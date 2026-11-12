/* eslint-disable ts-patterns/no-magic-numbers -- a building plan: block offsets as the build needs them */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The MorniCraft spawn: a floating island high above the sea, built by a datapack when the panel says where.
 *
 * - The island: grass on top, rock below that narrows to a rough point, with ores, glowing spots, dripstone and
 *   hanging lanterns underneath; five small islets and a hot-air balloon float around it.
 * - On top: a round plaza with a fountain in three tiers (basin, bowl with four spouts, a glowing crown with four
 *   streams); four paths lead to wooden launch decks ("Absprung") that stick out over the edge – from there players
 *   glide down with the start elytra (the MorniCraft plugin: double jump to glide, F / sneak to boost, no fall
 *   damage). Between the paths: a lookout tower, a pavilion, a cherry grove and a pond with a campfire; a flowering
 *   azalea hedge runs round the edge, lamps everywhere (and invisible light blocks, so no monsters spawn up there).
 *
 * Only commands that exist unchanged since 1.20.5 (fill, setblock, forceload, schedule, setworldspawn, scoreboard);
 * a single unknown command would stop a whole function from loading. Game rules whose name changed between
 * versions go into separate functions behind a tag with optional entries.
 */

export const SPAWN_PACK_DIR = 'mornihosting-craftattack';
const NAMESPACE = 'craftattack';
/** Height of the plaza (players walk at this y). High in the sky, under the clouds. */
export const SPAWN_Y = 170;
/** Radius of the island's top. */
const RT = 32;
/** How many layers the rock reaches down below the grass. */
const DEPTH = 30;
const PLAZA = 11.5;
const BASIN = 5.5;
const PATH_FROM = 11;
const DECK_FROM = 30;
const DECK_TO = 39;
/** Room cleared above the island before building (blocks). */
const CLEAR_HEIGHT = 40;
const CLEAR_HALF = 41;
const CLEAR_SLAB = 8;
/** Ticks after loading before building: the forced chunks are loaded by then. */
const BUILD_DELAY_TICKS = 60;
/** Players appear on the plaza in front of the fountain. */
const SPAWN_Z = 9;
/** pack.mcmeta: old and new format fields, so every version from 1.20.5 on accepts the pack. */
const PACK_FORMAT_OLD = 41;
const PACK_FORMAT_MAX = 999;

type Block = string;
const LEAVES = (kind: string): Block => `${kind}_leaves[persistent=true]`;

const range = (from: number, to: number): number[] =>
  to < from ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** Stable pseudo-random 0…1 for a position: the same island every time. */
const noise = (a: number, b: number): number => {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

const at = (x: number, y: number, z: number): string => `~${x || ''} ~${y || ''} ~${z || ''}`;
const fill = (
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  block: Block,
  mode = '',
): string => `fill ${at(x1, y1, z1)} ${at(x2, y2, z2)} ${block}${mode ? ` ${mode}` : ''}`;
const set = (x: number, y: number, z: number, block: Block, mode = ''): string =>
  `setblock ${at(x, y, z)} ${block}${mode ? ` ${mode}` : ''}`;

/** A filled circle, one fill per row. `rough` frays the edge (left and right differently). */
function disc(y: number, r: number, block: Block, cx = 0, cz = 0, rough = 0): string[] {
  return range(-Math.floor(r), Math.floor(r)).flatMap((dz) => {
    const w = Math.sqrt(Math.max(0, r * r - dz * dz));
    const left = Math.floor(w + rough * noise(dz + cz, y - cx));
    const right = Math.floor(w + rough * noise(y + cx, dz - cz));
    return [fill(cx - left, y, cz + dz, cx + right, y, cz + dz, block)];
  });
}

/** Places with a building or water, where no flowers go. */
const BUSY: readonly ((x: number, z: number) => boolean)[] = [
  (x, z) => Math.hypot(x - 15, z - 14) < 5.5,
  (x, z) => Math.abs(x + 15) <= 4 && Math.abs(z - 15) <= 4,
  (x, z) => Math.abs(x + 14) <= 6 && Math.abs(z + 14) <= 6,
  (x, z) => Math.abs(x - 20) <= 3 && Math.abs(z - 6) <= 3,
  (x, z) => Math.hypot(x - MAYPOLE.x, z - MAYPOLE.z) < 3.5,
];
/** The maypole stands on the lawn in the west, between tower and pavilion. */
const MAYPOLE = { x: -24, z: 6 } as const;
const SUNFLOWERS = [
  [11, 11],
  [19, 17],
  [12, 18],
  [19, 10],
] as const;

/**
 * Sugar cane by the pond: where it stands, how tall, and the water block right beside it. Sugar cane only stays
 * on earth with water next to it – so both are set here, whatever shape the pond's edge has at that spot.
 */
const REEDS: readonly (readonly [number, number, number, number, number])[] = [
  [18, 12, 2, 17, 12],
  [12, 16, 3, 13, 16],
];

export function reedCommands(): string[] {
  return REEDS.flatMap(([x, z, height, wx, wz]) => [
    set(wx, -1, wz, 'water'),
    set(x, -1, z, 'grass_block'),
    fill(x, 0, z, x, height - 1, z, 'sugar_cane'),
  ]);
}

/** Language of what is written into the paving (the letter for east: O or E). */
export type SpawnLang = 'de' | 'en';

/** Directions of the four paths: u runs outwards along the path, v across it. */
const DIRECTIONS = [
  {
    name: 'north',
    axis: 'x',
    colour: 'light_blue',
    inward: 'south',
    pos: (u: number, v: number): [number, number] => [v, -u],
  },
  {
    name: 'south',
    axis: 'x',
    colour: 'red',
    inward: 'north',
    pos: (u: number, v: number): [number, number] => [-v, u],
  },
  {
    name: 'east',
    axis: 'z',
    colour: 'yellow',
    inward: 'west',
    pos: (u: number, v: number): [number, number] => [u, v],
  },
  {
    name: 'west',
    axis: 'z',
    colour: 'lime',
    inward: 'east',
    pos: (u: number, v: number): [number, number] => [-u, -v],
  },
] as const;
type Direction = (typeof DIRECTIONS)[number];

/** A rectangle along a path (u1…u2 outwards, v1…v2 across). */
function strip(
  d: Direction,
  u1: number,
  u2: number,
  v1: number,
  v2: number,
  y1: number,
  y2: number,
  block: Block,
) {
  const [x1, z1] = d.pos(u1, v1);
  const [x2, z2] = d.pos(u2, v2);
  return fill(Math.min(x1, x2), y1, Math.min(z1, z2), Math.max(x1, x2), y2, Math.max(z1, z2), block);
}
const onPath = (d: Direction, u: number, v: number, y: number, block: Block, mode = ''): string => {
  const [x, z] = d.pos(u, v);
  return set(x, y, z, block, mode);
};

/** The island's radius at a depth below the grass (0 = the grass layer). */
export function islandRadius(depth: number): number {
  if (depth <= 2) return RT - depth * 0.4;
  const t = (depth - 2) / (DEPTH - 2);
  return Math.max(0.6, (RT - 1) * (1 - t ** 1.35));
}

const MID_ROCK: readonly Block[] = ['andesite', 'stone', 'tuff'];
const DRIP_PARTS = (length: number, n: number): string => {
  if (n === length) return 'tip';
  return n === 1 && length > 2 ? 'base' : 'frustum';
};
const ISLET_ROCK: readonly Block[] = ['grass_block', 'dirt'];

function rockFor(depth: number, row: number): Block {
  if (depth <= 2) return 'dirt';
  if (depth < 8) return row % 5 === 0 ? 'andesite' : 'stone';
  if (depth < 14) return MID_ROCK[row % MID_ROCK.length] ?? 'stone';
  if (depth < 20) return row % 2 === 0 ? 'tuff' : 'deepslate';
  return 'cobbled_deepslate';
}

/** The island itself: grass, earth and rock narrowing to a point, decorated underneath. */
export function islandCommands(): string[] {
  const body = range(0, DEPTH).flatMap((depth) => {
    const y = -1 - depth;
    const r = islandRadius(depth);
    if (depth === 0) return disc(y, r, 'grass_block', 0, 0, 1.6);
    return range(-Math.floor(r), Math.floor(r)).flatMap((dz) => {
      const w = Math.sqrt(Math.max(0, r * r - dz * dz));
      const left = Math.floor(w + 1.6 * noise(dz, y));
      const right = Math.floor(w + 1.6 * noise(y, dz));
      return [fill(-left, y, dz, right, y, dz, rockFor(depth, dz + depth))];
    });
  });
  /** The lowest layer that still covers a spot at distance `rho` from the middle (safely inside the edge). */
  const bottomDepth = (rho: number): number =>
    range(0, DEPTH)
      .filter((d) => islandRadius(d) >= rho + 1.5)
      .at(-1) ?? 0;
  const spots = range(0, 47).map((i) => {
    const angle = i * 2.39996;
    const rho = 3 + noise(i, 7) * (RT - 9);
    return { x: Math.round(Math.cos(angle) * rho), z: Math.round(Math.sin(angle) * rho), rho, i };
  });
  // Dripstone hanging from the bottom, glowing blocks set into it.
  const underside = spots.flatMap(({ x, z, rho, i }) => {
    const y = -1 - bottomDepth(rho);
    if (i % 4 === 0) return [set(x, y, z, i % 8 === 0 ? 'shroomlight' : 'glowstone')];
    const length = 1 + (i % 3);
    const parts = range(1, length).map((n) => {
      const thickness = DRIP_PARTS(length, n);
      return set(x, y - n, z, `pointed_dripstone[vertical_direction=down,thickness=${thickness}]`);
    });
    return parts;
  });
  // Ores showing in the rock face.
  const ores = [
    'coal_ore',
    'iron_ore',
    'copper_ore',
    'coal_ore',
    'gold_ore',
    'lapis_ore',
    'iron_ore',
    'emerald_ore',
  ];
  const veins = range(0, 39).map((i) => {
    const depth = 4 + (i % (DEPTH - 8));
    const r = islandRadius(depth) - 0.5;
    const angle = i * 1.7 + noise(i, 3);
    const ore = depth > 13 ? `deepslate_${ores[i % ores.length]}` : (ores[i % ores.length] ?? 'coal_ore');
    return set(Math.round(Math.cos(angle) * r), -1 - depth, Math.round(Math.sin(angle) * r), ore);
  });
  // Lanterns hanging under the rim on short posts.
  const hanging = range(0, 11).flatMap((i) => {
    const angle = (i / 12) * Math.PI * 2 + 0.26;
    const rho = RT - 7;
    const x = Math.round(Math.cos(angle) * rho);
    const z = Math.round(Math.sin(angle) * rho);
    const y = -1 - bottomDepth(rho);
    return [fill(x, y - 2, z, x, y - 1, z, 'spruce_fence'), set(x, y - 3, z, 'lantern[hanging=true]')];
  });
  // Roots hang from the earth under the rim; glow lichen lights the rock from below.
  const below = (rho: number, angle: number): [number, number, number] => {
    const x = Math.round(Math.cos(angle) * rho);
    const z = Math.round(Math.sin(angle) * rho);
    return [x, -2 - bottomDepth(rho), z];
  };
  const roots = range(0, 35).map((i) => {
    const [x, y, z] = below(RT - 4 - noise(i, 5) * 3, i * 0.1745);
    return set(x, y, z, 'hanging_roots', 'keep');
  });
  const lichen = range(0, 29).map((i) => {
    const [x, y, z] = below(2 + noise(i, 9) * (RT - 8), i * 2.1 + 0.4);
    return set(x, y, z, 'glow_lichen[up=true]', 'keep');
  });
  return [...body, ...underside, ...veins, ...hanging, ...roots, ...lichen];
}

function tree(x: number, z: number, wood: 'oak' | 'cherry' | 'dark_oak', height = 6, base = 0): string[] {
  const leaves = LEAVES(wood);
  const top = base + height;
  return [
    ...disc(top - 2, 3.2, leaves, x, z, 0.8),
    ...disc(top - 1, 3.4, leaves, x, z, 0.8),
    ...disc(top, 2.5, leaves, x, z),
    ...disc(top + 1, 1.5, leaves, x, z),
    fill(x, base, z, x, top - 1, z, `${wood}_log`),
  ];
}

function lampPost(x: number, z: number, post = 'oak_fence', height = 3): string[] {
  return [fill(x, 0, z, x, height - 1, z, post), set(x, height, z, 'lantern')];
}

/** A small floating islet with a bush or tree. */
function islet(cx: number, cy: number, cz: number, r: number, top: 'tree' | 'azalea'): string[] {
  const layers = range(0, Math.ceil(r) + 2).flatMap((d) => {
    const rr = Math.max(0.6, r - d * (r / (Math.ceil(r) + 2)));
    const block = ISLET_ROCK[d] ?? (d % 2 === 0 ? 'stone' : 'andesite');
    return disc(cy - 1 - d, rr, block, cx, cz, 1);
  });
  const crown =
    top === 'tree'
      ? tree(cx, cz, 'oak', 5, cy)
      : [
          set(cx, cy, cz, 'flowering_azalea'),
          set(cx + 1, cy, cz, 'lantern'),
          set(cx - 1, cy, cz + 1, 'azalea'),
        ];
  return [...layers, ...crown];
}

/** The small islands floating round the big one: x, y, z of the top's middle, radius, what grows on it. */
const ISLETS: readonly (readonly [number, number, number, number, 'tree' | 'azalea'])[] = [
  [46, -6, -20, 5, 'tree'],
  [-40, 8, 34, 3.8, 'azalea'],
  [14, -16, 50, 4.2, 'tree'],
  [-48, -12, -22, 4.6, 'tree'],
  [24, 12, -46, 3.2, 'azalea'],
];

type Voxel = readonly [number, number, number, Block];

/** Single blocks as few commands: neighbours in a row (along x) with the same block become one fill. */
function paint(voxels: readonly Voxel[]): string[] {
  const rows = new Map<string, Voxel[]>();
  voxels.forEach((v) => {
    const key = `${v[1]}|${v[2]}|${v[3]}`;
    const row = rows.get(key) ?? [];
    row.push(v);
    rows.set(key, row);
  });
  return [...rows.values()].flatMap((row) => {
    const [first] = row;
    if (!first) return [];
    const [, y, z, block] = first;
    const xs = row.map((v) => v[0]).sort((a, b) => a - b);
    const runs = xs.reduce<[number, number][]>((acc, x) => {
      const last = acc.at(-1);
      return last && x <= last[1] + 1
        ? [...acc.slice(0, -1), [last[0], x] as [number, number]]
        : [...acc, [x, x] as [number, number]];
    }, []);
    return runs.map(([a, b]) => fill(a, y, z, b, y, z, block));
  });
}

const TULIPS: readonly Block[] = ['red_tulip', 'white_tulip', 'orange_tulip', 'pink_tulip'];
/** Close to a path: nothing may stand in the way there. */
const nearPath = (x: number, z: number): boolean => Math.abs(x) <= 4 || Math.abs(z) <= 4;

/**
 * The rim: an azalea hedge that flowers every third step, behind it (towards the middle) a band of tulips in four
 * colours, and every few steps a short post with a lantern.
 */
function rimCommands(): string[] {
  const ring = (count: number, r: number, turn: number): [number, number, number][] =>
    range(0, count - 1).map((i) => {
      const angle = (i / count) * Math.PI * 2 + turn;
      return [Math.round(Math.cos(angle) * r), Math.round(Math.sin(angle) * r), i];
    });
  return [
    ...disc(0, RT - 0.5, LEAVES('azalea'), 0, 0, 1),
    ...disc(0, RT - 2, 'air'),
    ...ring(64, RT - 1.3, 0.05).map(([x, z]) => set(x, 0, z, LEAVES('flowering_azalea'))),
    ...ring(120, RT - 3.2, 0.02)
      .filter(([x, z]) => !nearPath(x, z))
      .map(([x, z, i]) => set(x, 0, z, TULIPS[i % TULIPS.length] ?? 'red_tulip', 'keep')),
    ...ring(16, RT - 4.4, Math.PI / 16)
      .filter(([x, z]) => !nearPath(x, z))
      .flatMap(([x, z]) => lampPost(x, z, 'oak_fence', 2)),
  ];
}

/** Tulips along both sides of a path (not where the lamp posts stand). */
function tulipRows(d: Direction): string[] {
  return range(PATH_FROM + 1, DECK_FROM - 2)
    .filter((u) => u !== 15 && u !== 21)
    .flatMap((u) =>
      [-3, 3].map((v) =>
        onPath(d, u, v, 0, TULIPS[(u + (v > 0 ? 2 : 0)) % TULIPS.length] ?? 'red_tulip', 'keep'),
      ),
    );
}

/** 5 × 5 letters for the paving: N, O (Ost) / E (east), S, W. */
const LETTERS: Readonly<Record<string, readonly string[]>> = {
  N: ['X...X', 'XX..X', 'X.X.X', 'X..XX', 'X...X'],
  O: ['.XXX.', 'X...X', 'X...X', 'X...X', '.XXX.'],
  E: ['XXXXX', 'X....', 'XXXX.', 'X....', 'XXXXX'],
  S: ['.XXXX', 'X....', '.XXX.', '....X', 'XXXX.'],
  W: ['X...X', 'X...X', 'X.X.X', 'XX.XX', 'X...X'],
};
const LETTER_OF: Readonly<Record<SpawnLang, Readonly<Record<Direction['name'], string>>>> = {
  de: { north: 'N', south: 'S', east: 'O', west: 'W' },
  en: { north: 'N', south: 'S', east: 'E', west: 'W' },
};
/** Where the letter's top row lies on the path (it reads right way up when walking outwards). */
const LETTER_TOP = DECK_FROM - 2;

/** The direction, written into the path in its colour on white – readable on the way out to the deck. */
function directionLetter(d: Direction, lang: SpawnLang): string[] {
  const rows = LETTERS[LETTER_OF[lang][d.name]] ?? [];
  return rows.flatMap((row, r) =>
    [...row].map((cell, c) =>
      onPath(d, LETTER_TOP - r, c - 2, -1, cell === 'X' ? `${d.colour}_concrete` : 'white_concrete'),
    ),
  );
}

/**
 * The MorniCraft flag: an emerald field with a white M at the pole, then white-and-blue lozenges (a little
 * Bavaria). `x` is the column next to the pole, `y` the bottom row; it flies towards +x.
 */
const FLAG_M: readonly string[] = [
  '.......',
  '.X...X.',
  '.XX.XX.',
  '.X.X.X.',
  '.X...X.',
  '.X...X.',
  '.......',
];
const FLAG_LOZENGES = 6;
export function flagCommands(x: number, y: number, z: number): string[] {
  const top = FLAG_M.length - 1;
  const field: Voxel[] = FLAG_M.flatMap((row, r) =>
    [...row].map((cell, c): Voxel => [x + c, y + top - r, z, cell === 'X' ? 'white_wool' : 'emerald_block']),
  );
  const lozenges: Voxel[] = range(0, FLAG_LOZENGES - 1).flatMap((c) =>
    range(0, top).map((r): Voxel => [
      x + FLAG_M.length + c,
      y + r,
      z,
      (c + r) % 2 === 0 ? 'light_blue_wool' : 'white_wool',
    ]),
  );
  return paint([...field, ...lozenges]);
}

/**
 * The lookout tower: a stone foot, white walls with dark timber at the corners and round the floors, windows with
 * flowers below them, an open lookout under a pointed red roof, and the flag on top. Inside a ladder; on the
 * lookout a plank sticks out over the edge to jump from.
 */
function towerCommands(): string[] {
  const tx = TOWER_X;
  const tz = TOWER_Z;
  const corners: readonly [number, number][] = [
    [-2, -2],
    [2, -2],
    [-2, 2],
    [2, 2],
  ];
  const sides: readonly [number, number][] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const ringAt = (y: number, half: number, block: Block): string[] => [
    fill(tx - half, y, tz - half, tx + half, y, tz + half, block),
    fill(tx - half + 1, y, tz - half + 1, tx + half - 1, y, tz + half - 1, 'air'),
  ];
  const windows = [6, 12].flatMap((y) =>
    sides.flatMap(([dx, dz]) => [
      set(tx + dx * 2, y, tz + dz * 2, 'glass_pane'),
      set(tx + dx * 2, y + 1, tz + dz * 2, 'glass_pane'),
      // The flower box below the window.
      set(tx + dx * 3, y - 1, tz + dz * 3, LEAVES('flowering_azalea')),
    ]),
  );
  const roof = [
    fill(tx - 4, 20, tz - 4, tx + 4, 20, tz + 4, 'brick_slab'),
    fill(tx - 3, 20, tz - 3, tx + 3, 21, tz + 3, 'bricks'),
    fill(tx - 2, 22, tz - 2, tx + 2, 23, tz + 2, 'bricks'),
    fill(tx - 1, 24, tz - 1, tx + 1, 25, tz + 1, 'bricks'),
    set(tx, 26, tz, 'bricks'),
    // Hollow inside, with a lantern under the ridge.
    fill(tx - 2, 20, tz - 2, tx + 2, 21, tz + 2, 'air'),
    set(tx, 21, tz, 'lantern[hanging=true]'),
  ];
  return [
    fill(tx - 2, -1, tz - 2, tx + 2, 2, tz + 2, 'stone_bricks'),
    fill(tx - 2, 3, tz - 2, tx + 2, 15, tz + 2, 'white_concrete'),
    fill(tx - 1, 0, tz - 1, tx + 1, 15, tz + 1, 'air'),
    ...[3, 9, 15].flatMap((y) => [
      fill(tx - 2, y, tz - 2, tx + 2, y, tz + 2, 'spruce_planks', 'replace white_concrete'),
    ]),
    ...corners.map(([dx, dz]) => fill(tx + dx, 0, tz + dz, tx + dx, 15, tz + dz, 'stripped_spruce_log')),
    ...windows,
    // The door (towards the plaza) and the ladder up the inside.
    fill(tx + 2, 0, tz, tx + 2, 1, tz, 'air'),
    fill(tx, 0, tz - 1, tx, 16, tz - 1, 'ladder[facing=south]'),
    // The lookout: a floor, a railing, four posts carrying the roof.
    fill(tx - 3, 16, tz - 3, tx + 3, 16, tz + 3, 'spruce_planks'),
    set(tx, 16, tz - 1, 'ladder[facing=south]'),
    ...ringAt(17, 3, 'spruce_fence'),
    ...corners.map(([dx, dz]) =>
      fill(
        tx + Math.sign(dx) * 3,
        17,
        tz + Math.sign(dz) * 3,
        tx + Math.sign(dx) * 3,
        19,
        tz + Math.sign(dz) * 3,
        'stripped_spruce_log',
      ),
    ),
    // A gap in the railing and a plank out over the edge: the place to jump from.
    set(tx - 3, 17, tz, 'air'),
    fill(tx - 5, 16, tz, tx - 4, 16, tz, 'spruce_slab[type=top]'),
    ...roof,
    // The flagpole on the ridge and the flag.
    fill(tx, 27, tz, tx, 37, tz, 'spruce_fence'),
    ...flagCommands(tx + 1, 30, tz),
    // Invisible light in the shaft and on the lookout.
    ...TOWER_LIGHTS.map(([x, y, z, block]) => set(tx + x, y, tz + z, block)),
    set(tx + 1, 17, tz + 1, 'light[level=15]'),
  ];
}

/**
 * The pavilion: a wooden floor, four posts, a tent roof in white and blue stripes; benches round a table with a
 * cake, a candle and flowers.
 */
function pavilionCommands(): string[] {
  const px = -14;
  const pz = -14;
  const stripe = (x: number): Block => (Math.abs(x) % 2 === 0 ? 'white_wool' : 'light_blue_wool');
  const roofLayer = (y: number, half: number): string[] =>
    range(px - half, px + half).map((x) => fill(x, y, pz - half, x, y, pz + half, stripe(x)));
  return [
    fill(px - 4, -1, pz - 4, px + 4, -1, pz + 4, 'oak_planks'),
    fill(px - 3, -1, pz - 3, px + 3, -1, pz + 3, 'birch_planks'),
    ...[
      [-4, -4],
      [4, -4],
      [-4, 4],
      [4, 4],
    ].map(([dx = 0, dz = 0]) => fill(px + dx, 0, pz + dz, px + dx, 3, pz + dz, 'stripped_oak_log')),
    ...roofLayer(4, 5),
    ...roofLayer(5, 3),
    ...roofLayer(6, 1),
    set(px, 7, pz, 'lantern'),
    set(px, 3, pz + 3, 'lantern[hanging=true]'),
    set(px, 3, pz - 3, 'lantern[hanging=true]'),
    fill(px - 3, 0, pz - 3, px + 3, 0, pz - 3, 'birch_stairs[facing=north]'),
    fill(px - 3, 0, pz + 3, px - 1, 0, pz + 3, 'birch_stairs[facing=south]'),
    fill(px - 3, 0, pz - 2, px - 3, 0, pz + 2, 'birch_stairs[facing=west]'),
    // The table: three by two, with something on it.
    fill(px - 1, 0, pz - 1, px + 1, 0, pz, 'oak_slab[type=top]'),
    set(px, 1, pz - 1, 'cake'),
    set(px - 1, 1, pz, 'candle[candles=3,lit=true]'),
    set(px + 1, 1, pz, 'potted_cornflower'),
    set(px + 1, 1, pz - 1, 'potted_red_tulip'),
    set(px + 4, 0, pz + 2, 'potted_red_tulip'),
    set(px + 4, 0, pz - 2, 'potted_blue_orchid'),
  ];
}

/** A maypole: white-and-blue pole, a green wreath on four arms, little banners, a light on top. */
function maypoleCommands(): string[] {
  const { x, z } = MAYPOLE;
  const height = 13;
  const wreathY = 10;
  const pole = range(0, height).map((y) =>
    set(x, y, z, y % 2 === 0 ? 'white_concrete' : 'light_blue_concrete'),
  );
  const arms: readonly [number, number, string][] = [
    [1, 0, 'east'],
    [-1, 0, 'west'],
    [0, 1, 'south'],
    [0, -1, 'north'],
  ];
  const wreath: readonly [number, number][] = [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
    [2, 1],
    [2, -1],
    [-2, 1],
    [-2, -1],
    [1, 2],
    [-1, 2],
    [1, -2],
    [-1, -2],
  ];
  return [
    set(x, -1, z, 'stone_bricks'),
    ...pole,
    set(x, height + 1, z, 'lantern'),
    ...arms.map(([dx, dz]) => set(x + dx, wreathY, z + dz, 'oak_fence')),
    ...wreath.map(([dx, dz]) => set(x + dx, wreathY, z + dz, LEAVES('oak'))),
    ...arms.map(([dx, dz, facing], i) =>
      set(x + dx, 7, z + dz, `${i % 2 === 0 ? 'light_blue' : 'white'}_wall_banner[facing=${facing}]`),
    ),
    ...wreath
      .slice(0, 8)
      .map(([dx, dz], i) => set(x + dx, 0, z + dz, TULIPS[i % TULIPS.length] ?? 'red_tulip', 'keep')),
  ];
}

/** Everything on top of the island, relative to the plaza (y = 0 is where players stand). */
export function topCommands(lang: SpawnLang = 'de'): string[] {
  const clear = range(0, Math.ceil((2 * CLEAR_HALF + 1) / CLEAR_SLAB) - 1).map((i) => {
    const z1 = -CLEAR_HALF + i * CLEAR_SLAB;
    return fill(
      -CLEAR_HALF,
      0,
      z1,
      CLEAR_HALF,
      CLEAR_HEIGHT,
      Math.min(CLEAR_HALF, z1 + CLEAR_SLAB - 1),
      'air',
    );
  });
  // The rim: a flowering hedge with a post and a lantern every few steps, tulips in all colours along its inside.
  const hedge = rimCommands();
  const plaza = [
    ...disc(-1, PLAZA, 'stone_bricks'),
    ...disc(-1, PLAZA - 1.5, 'polished_andesite'),
    ...disc(-1, 8.5, 'chiseled_stone_bricks'),
    ...disc(-1, 7.6, 'smooth_stone'),
    // A compass star in the paving, each ray in its direction's colour.
    ...DIRECTIONS.flatMap((d) => range(6, 10).map((u) => onPath(d, u, 0, -1, `${d.colour}_concrete`))),
  ];
  const fountain = fountainCommands();
  const plazaLamps = range(0, 7).flatMap((i) => {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
    return lampPost(
      Math.round(Math.cos(angle) * 9.5),
      Math.round(Math.sin(angle) * 9.5),
      'stone_brick_wall',
      2,
    );
  });
  // Paths to the edge and the launch decks beyond it.
  const paths = DIRECTIONS.flatMap((d) => [
    strip(d, PATH_FROM, DECK_FROM, -2, 2, -1, -1, 'stone_bricks'),
    strip(d, PATH_FROM, DECK_FROM, -1, 1, -1, -1, 'polished_andesite'),
    strip(d, PATH_FROM, DECK_FROM + 2, -2, 2, 0, 4, 'air'),
    ...[15, 21].flatMap((u) =>
      [-3, 3].flatMap((v) => {
        const [x, z] = d.pos(u, v);
        return lampPost(x, z);
      }),
    ),
    ...[13, 18].map((u) => onPath(d, u, (u % 3) - 1, -1, 'cracked_stone_bricks')),
    // Tulips along both sides, and the direction written into the paving just before the gate.
    ...tulipRows(d),
    ...directionLetter(d, lang),
  ]);
  const decks = DIRECTIONS.flatMap((d) => {
    const beam = `stripped_spruce_log[axis=${d.axis}]`;
    return [
      strip(d, DECK_FROM, DECK_TO, -2, 2, -1, -1, 'spruce_planks'),
      strip(d, DECK_FROM, DECK_TO, 0, 0, -1, -1, 'stripped_spruce_log'),
      strip(d, DECK_FROM, DECK_TO - 1, -3, -3, 0, 0, 'spruce_fence'),
      strip(d, DECK_FROM, DECK_TO - 1, 3, 3, 0, 0, 'spruce_fence'),
      strip(d, DECK_TO, DECK_TO, -2, 2, 0, 0, `${d.colour}_carpet`),
      // Banners in the direction's colour on the gate, looking back at the plaza.
      onPath(d, DECK_FROM - 1, -3, 2, `${d.colour}_wall_banner[facing=${d.inward}]`),
      onPath(d, DECK_FROM - 1, 3, 2, `${d.colour}_wall_banner[facing=${d.inward}]`),
      // The gate at the start of the deck.
      strip(d, DECK_FROM, DECK_FROM, -3, -3, 0, 3, 'stripped_spruce_log'),
      strip(d, DECK_FROM, DECK_FROM, 3, 3, 0, 3, 'stripped_spruce_log'),
      strip(d, DECK_FROM, DECK_FROM, -4, 4, 4, 4, beam),
      strip(d, DECK_FROM, DECK_FROM, -2, 2, 5, 5, 'spruce_slab'),
      onPath(d, DECK_FROM, 0, 3, 'lantern[hanging=true]'),
      onPath(d, DECK_FROM, -4, 5, 'lantern'),
      onPath(d, DECK_FROM, 4, 5, 'lantern'),
      // Lanterns at the deck's end posts and hanging below it.
      onPath(d, DECK_TO - 1, -3, 1, 'lantern'),
      onPath(d, DECK_TO - 1, 3, 1, 'lantern'),
      strip(d, DECK_TO - 1, DECK_TO - 1, -2, -2, -3, -2, 'spruce_fence'),
      strip(d, DECK_TO - 1, DECK_TO - 1, 2, 2, -3, -2, 'spruce_fence'),
      onPath(d, DECK_TO - 1, -2, -4, 'lantern[hanging=true]'),
      onPath(d, DECK_TO - 1, 2, -4, 'lantern[hanging=true]'),
      // Supports under the deck down to the rock.
      strip(d, DECK_FROM + 3, DECK_FROM + 3, -2, -2, -4, -2, 'spruce_log'),
      strip(d, DECK_FROM + 3, DECK_FROM + 3, 2, 2, -4, -2, 'spruce_log'),
    ];
  });
  // South-west: the lookout tower – white with dark timber, a red roof and the MorniCraft flag.
  const tower = towerCommands();
  // North-west: the pavilion – a white-and-blue tent roof, benches and a table with cake.
  const pavilion = pavilionCommands();
  // North-east: a cherry grove with petals on the ground.
  const cherries = [
    ...tree(14, -15, 'cherry', 6),
    ...tree(20, -8, 'cherry', 5),
    ...tree(8, -20, 'cherry', 5),
    ...range(0, 29).map((i) => {
      const x = 7 + Math.floor(noise(i, 1) * 16);
      const z = -7 - Math.floor(noise(1, i) * 16);
      return set(x, 0, z, 'pink_petals', 'keep');
    }),
  ];
  // South-east: a pond with lily pads, reeds and a campfire with log seats.
  const pond = [
    ...disc(-1, 3.4, 'water', 15, 14, 0.6),
    ...disc(-2, 2.5, 'clay', 15, 14),
    set(14, 0, 13, 'lily_pad'),
    set(16, 0, 15, 'lily_pad'),
    ...reedCommands(),
    ...tree(8, 20, 'oak', 7),
    set(20, 0, 6, 'campfire[lit=true]'),
    set(22, 0, 6, 'oak_log[axis=z]'),
    set(18, 0, 6, 'oak_log[axis=z]'),
    set(20, 0, 8, 'oak_log[axis=x]'),
    // Sunflowers by the water.
    ...SUNFLOWERS.flatMap(([x, z]) => [
      set(x, 0, z, 'sunflower[half=lower]'),
      set(x, 1, z, 'sunflower[half=upper]'),
    ]),
  ];
  // Flowers on the open grass (only where it is still free).
  const flowerKinds = [
    'poppy',
    'dandelion',
    'cornflower',
    'allium',
    'oxeye_daisy',
    'azure_bluet',
    'lily_of_the_valley',
    'red_tulip',
    'orange_tulip',
    'pink_tulip',
    'white_tulip',
  ];
  const flowers = range(0, 119).flatMap((i) => {
    const angle = noise(i, 11) * Math.PI * 2;
    const rho = 13 + noise(11, i) * (RT - 16);
    const x = Math.round(Math.cos(angle) * rho);
    const z = Math.round(Math.sin(angle) * rho);
    if (Math.abs(x) <= 4 || Math.abs(z) <= 4 || BUSY.some((b) => b(x, z))) return [];
    return [
      set(x, 0, z, i % 9 === 0 ? 'short_grass' : (flowerKinds[i % flowerKinds.length] ?? 'poppy'), 'keep'),
    ];
  });
  // Invisible light everywhere on top, so no monsters spawn on the island.
  const lights = lightGrid();

  const islets = ISLETS.flatMap(([x, y, z, r, crown]) => islet(x, y, z, r, crown));
  const rocks = (
    [
      [-25, -8],
      [25, 12],
      [-9, 24],
    ] as const
  ).flatMap(([x, z]) => [
    fill(x, 0, z, x + 1, 1, z + 1, 'mossy_cobblestone'),
    set(x + 1, 2, z, 'moss_carpet'),
    set(x + 2, 0, z, 'moss_block'),
    set(x, 0, z + 2, 'mossy_cobblestone'),
  ]);
  return [
    ...clear,
    ...hedge,
    ...plaza,
    ...fountain,
    ...plazaLamps,
    ...paths,
    ...decks,
    ...tower,
    ...pavilion,
    ...cherries,
    ...pond,
    ...maypoleCommands(),
    ...flowers,
    ...lights,
    ...islets,
    ...rocks,
    `setworldspawn ${at(0, 0, SPAWN_Z)}`,
  ];
}

/** Lights of the lookout tower, relative to its middle: glowing blocks set into the walls, light blocks inside. */
const TOWER_LIGHTS: readonly (readonly [number, number, number, Block])[] = [
  [0, 1, 1, 'light[level=15]'],
  [0, 8, 1, 'light[level=15]'],
  [0, 13, 1, 'light[level=15]'],
];
/** The lookout tower's middle. */
const TOWER_X = -15;
const TOWER_Z = 15;

/**
 * The fountain in the middle of the plaza: a wide round basin, a chalice-shaped bowl on a pedestal with four
 * spouts pouring into the basin, and a small crown with a glowing core from which four thin streams fall into the
 * bowl. Light quartz, prismarine floors with sea lanterns under the water.
 *
 * Water never runs out: everything next to water is a full block (stairs, slabs, walls or lanterns could take on
 * water and pass it on), and every stream falls straight down into a basin – falling water stops on still water.
 */
const F_RIM: Block = 'quartz_bricks';
const F_FLOOR: Block = 'smooth_quartz';
const F_PILLAR: Block = 'quartz_pillar';
const F_ACCENT: Block = 'chiseled_quartz_block';
const F_WATER_FLOOR: Block = 'dark_prismarine';
const BOWL_Y = 3;
const BOWL_R = 3.6;
const CROWN_Y = 7;
/** Spouts and streams: the four directions. */
const CARDINAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
/** Posts with a light round the rim: eight, evenly round the basin, clear of the streams. */
const RIM_POSTS = [
  [5, 2],
  [2, 5],
  [-2, 5],
  [-5, 2],
  [-5, -2],
  [-2, -5],
  [2, -5],
  [5, -2],
] as const;
/** Lily pads on the basin, between the streams and outside the bowl's shadow. */
const LILIES = [
  [3, 3],
  [-3, 3],
  [3, -3],
  [-3, -3],
] as const;

export function fountainCommands(): string[] {
  const basin = [
    ...disc(-1, BASIN, F_RIM),
    ...disc(-1, BASIN - 1, F_WATER_FLOOR),
    ...range(0, 7).map((i) => {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
      return set(Math.round(Math.cos(angle) * 3.4), -1, Math.round(Math.sin(angle) * 3.4), 'sea_lantern');
    }),
    ...disc(0, BASIN, F_RIM),
    ...disc(0, BASIN - 1, 'water'),
    // Posts on the rim with a light on top, between the spouts' streams.
    ...RIM_POSTS.flatMap(([x, z]) => [set(x, 1, z, F_ACCENT), set(x, 2, z, 'end_rod')]),
    ...LILIES.map(([x, z]) => set(x, 1, z, 'lily_pad')),
  ];
  const pedestal = [fill(-1, 0, -1, 1, 1, 1, F_PILLAR)];
  // The bowl: floor, rim, water; in each direction one rim block is water – a spout pouring into the basin.
  const bowl = [
    // Narrower underneath, the rim sticks out as a lip: a chalice. The spouts sit on the lip, so their water
    // falls straight down into the basin.
    ...disc(1, 1.9, F_FLOOR),
    ...disc(BOWL_Y - 1, BOWL_R - 1, F_FLOOR),
    ...disc(BOWL_Y, BOWL_R, F_RIM),
    ...disc(BOWL_Y, BOWL_R - 1, 'water'),
    ...CARDINAL.map(([dx, dz]) => set(dx * 3, BOWL_Y, dz * 3, 'water')),
    set(0, BOWL_Y - 1, 0, 'sea_lantern'),
    fill(-1, BOWL_Y, -1, 1, BOWL_Y, 1, F_ACCENT),
  ];
  // The crown: a slim column, a small top with a glowing core; four streams fall from it into the bowl.
  const crown = [
    fill(0, BOWL_Y + 1, 0, 0, CROWN_Y - 2, 0, F_PILLAR),
    fill(-1, CROWN_Y - 1, -1, 1, CROWN_Y - 1, 1, F_FLOOR),
    fill(-1, CROWN_Y, -1, 1, CROWN_Y, 1, F_RIM),
    ...CARDINAL.map(([dx, dz]) => set(dx, CROWN_Y, dz, 'water')),
    set(0, CROWN_Y, 0, 'sea_lantern'),
    set(0, CROWN_Y + 1, 0, F_ACCENT),
    set(0, CROWN_Y + 2, 0, 'end_rod'),
  ];
  return [...basin, ...pedestal, ...bowl, ...crown];
}

/** Old islands: the old fountain (a column with a beacon) makes way for the new one. */
const OLD_FOUNTAIN_HALF = 6;
const OLD_FOUNTAIN_HEIGHT = 14;

export function fixFountainCommands(): string[] {
  return [
    fill(
      -OLD_FOUNTAIN_HALF,
      0,
      -OLD_FOUNTAIN_HALF,
      OLD_FOUNTAIN_HALF,
      OLD_FOUNTAIN_HEIGHT,
      OLD_FOUNTAIN_HALF,
      'air',
    ),
    ...fountainCommands(),
  ];
}

/** The fountain's rims of older islands: full blocks, which (unlike walls) can never hold water. */
const RIM: Block = 'chiseled_stone_bricks';
/** Half-size of the box round the fountain whose walls become full blocks (the plaza lamps stand further out). */
const RIM_BOX = 6;

/** No light blocks this close to the fountain (the plaza lamps light it). */
const LIGHT_FREE = 8;

/** Invisible light all over the top, so no monsters spawn on the island. */
function lightGrid(): string[] {
  return range(-3, 3).flatMap((gx) =>
    range(-3, 3).flatMap((gz) => {
      const x = gx * 8 + 4;
      const z = gz * 8 + 4;
      // Not right next to the fountain: a light block takes on water (waterlogged) and then feeds it onto the plaza.
      const distance = Math.hypot(x, z);
      return distance > RT - 2 || distance < LIGHT_FREE ? [] : [set(x, 0, z, 'light[level=15]', 'keep')];
    }),
  );
}

/** Grass hills of the first version (taken off again: blocky, and two reached onto the paths). */
const OLD_HILLS: readonly (readonly [number, number])[] = [
  [22, -20],
  [-24, 2],
  [6, 26],
  [-6, -26],
];
const OLD_HILL_REACH = 5;

/** Takes the old grass hills off again (only grass blocks and the bush on top; lamps and paths stay). */
export function fixHillsCommands(): string[] {
  return OLD_HILLS.flatMap(([x, z]) => {
    const box = (y1: number, y2: number, block: Block, mode: string): string =>
      fill(
        x - OLD_HILL_REACH,
        y1,
        z - OLD_HILL_REACH,
        x + OLD_HILL_REACH,
        y2,
        z + OLD_HILL_REACH,
        block,
        mode,
      );
    return [
      fill(x - 1, 1, z - 1, x + 1, 3, z + 1, 'air', 'replace flowering_azalea'),
      // Covered grass turned into dirt: both go, and the lawn underneath is grass again.
      box(0, 2, 'air', 'replace grass_block'),
      box(0, 2, 'air', 'replace dirt'),
      box(-1, -1, 'grass_block', 'replace dirt'),
    ];
  });
}

/** Where the two springs of the first version sat (removed: their water never ran off cleanly). */
const OLD_SPRING_ANGLES = [2.6, 5.75] as const;
const OLD_SPRING_RADIUS = 28;
/** Radius around the fountain where spilled water is cleared. */
const SPILL_HALF = 14;
const SPILL_HEIGHT = 11;

/**
 * Repairs islands built by the first version: the upper bowl had no rim and water ran from the top of the column,
 * so water spread over the plaza; the two springs at the edge stood still in a hole; lanterns blocked the tower. Clears all water around the
 * fountain, fills basin and bowl again (now with a rim) and turns the springs back into lawn.
 */
export function fixWaterCommands(): string[] {
  const springs = OLD_SPRING_ANGLES.flatMap((angle) => {
    const point = (r: number): [number, number] => [
      Math.round(Math.cos(angle) * r),
      Math.round(Math.sin(angle) * r),
    ];
    const [sx, sz] = point(OLD_SPRING_RADIUS);
    return [
      fill(sx - 1, -1, sz - 1, sx + 1, 1, sz + 1, 'air'),
      fill(sx - 1, -1, sz - 1, sx + 1, -1, sz + 1, 'grass_block'),
      ...range(OLD_SPRING_RADIUS + 1, RT - 1).map((r) => {
        const [x, z] = point(r);
        return set(x, -1, z, 'grass_block');
      }),
      set(sx - 1, 0, sz, 'mossy_cobblestone'),
    ];
  });
  return [
    // Light blocks round the fountain had taken on water and kept feeding it onto the plaza: away with them first
    // (the ones far enough out come back below, dry).
    fill(-SPILL_HALF, 0, -SPILL_HALF, SPILL_HALF, 0, SPILL_HALF, 'air', 'replace light'),
    fill(-SPILL_HALF, 0, -SPILL_HALF, SPILL_HALF, SPILL_HEIGHT, SPILL_HALF, 'air', 'replace water'),
    ...disc(0, BASIN - 1, 'water').map((c) => `${c} replace air`),
    fill(-RIM_BOX, 0, -RIM_BOX, RIM_BOX, 4, RIM_BOX, RIM, 'replace stone_brick_wall'),
    ...disc(4, 3.6, RIM).map((c) => `${c} replace air`),
    ...disc(4, 2.6, 'water').map((c) => `${c} replace ${RIM}`),
    ...lightGrid().filter((cmd) => {
      const [x = 0, , z = 0] = cmd
        .split(' ')
        .slice(1, 4)
        .map((v) => Number(v.replace('~', '') || 0));
      return Math.abs(x) <= SPILL_HALF && Math.abs(z) <= SPILL_HALF;
    }),
    ...springs,
    // The first tower had a lantern on its floor and one hanging in the air inside – both in the way.
    set(TOWER_X, 1, TOWER_Z, 'air'),
    set(TOWER_X, 9, TOWER_Z, 'air'),
    ...TOWER_LIGHTS.map(([x, y, z, block]) => set(TOWER_X + x, y, TOWER_Z + z, block)),
  ];
}

/** The whole spawn, in building order (for previews and tests). */
export function plazaCommands(): string[] {
  return [...islandCommands(), ...topCommands()];
}

/** Where an island stands (x/z of its middle). Islands of older versions stand at 0/0. */
export interface IslandSpot {
  readonly x: number;
  readonly z: number;
}
const ORIGIN: IslandSpot = { x: 0, z: 0 };
/** Half the area kept loaded while a repair runs. */
const AREA_HALF = 64;
const areaOf = ({ x, z }: IslandSpot): string =>
  `${x - AREA_HALF} ${z - AREA_HALF} ${x + AREA_HALF} ${z + AREA_HALF}`;

/** Older islands had a rainbow of glass north of the plaza: it goes again (Philip did not like it). */
const OLD_RAINBOW = ['red', 'orange', 'yellow', 'lime', 'light_blue', 'blue', 'purple'] as const;
const OLD_RAINBOW_REACH = 31;
const OLD_RAINBOW_TOP = 32;
const OLD_RAINBOW_Z = -12;

export function removeRainbowCommands(): string[] {
  return OLD_RAINBOW.map((colour) =>
    fill(
      -OLD_RAINBOW_REACH,
      0,
      OLD_RAINBOW_Z - 1,
      OLD_RAINBOW_REACH,
      OLD_RAINBOW_TOP,
      OLD_RAINBOW_Z,
      'air',
      `replace ${colour}_stained_glass`,
    ),
  );
}

/** Older islands had wooden benches on the plaza: they go again (Philip did not like them). */
const OLD_BENCHES: readonly (readonly [number, number])[] = [
  [5, 7],
  [7, 5],
  [-5, 7],
  [-7, 5],
  [5, -7],
  [7, -5],
  [-5, -7],
  [-7, -5],
];

export function removeBenchesCommands(): string[] {
  return OLD_BENCHES.map(([x, z]) => fill(x, 0, z, x, 0, z, 'air', 'replace oak_stairs'));
}

/** Dropped items this close to the island's middle are swept up after a rebuild. */
const TIDY_REACH = 90;

/** The first balloon (one, with ropes far too long): where it stood, so it can be taken away again. */
const OLD_BALLOON = { x: 38, y: 24, z: 22 } as const;

/** Hot-air balloons floating round the island, each in its own colours (the white-and-blue one for Bavaria). */
interface Balloon {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly a: Block;
  readonly b: Block;
  readonly band: Block;
}
const BALLOONS: readonly Balloon[] = [
  { x: 40, y: 26, z: 24, r: 6, a: 'red_wool', b: 'white_wool', band: 'yellow_wool' },
  { x: -46, y: 30, z: 6, r: 5, a: 'light_blue_wool', b: 'white_wool', band: 'blue_wool' },
  { x: 4, y: 38, z: -52, r: 6.5, a: 'orange_wool', b: 'yellow_wool', band: 'red_wool' },
  { x: -22, y: 20, z: 48, r: 5, a: 'lime_wool', b: 'white_wool', band: 'green_wool' },
  { x: 52, y: 42, z: -36, r: 5.5, a: 'magenta_wool', b: 'pink_wool', band: 'purple_wool' },
];
/** Radius of the opening at the bottom of the envelope. */
const MOUTH = 1.7;
/** Coloured panels round the envelope. */
const GORES = 8;
/** The envelope starts this far above the basket's floor. */
const ROPES = 3;

function balloonCommands(balloon: Balloon): string[] {
  const { x, y, z, r, a, b, band } = balloon;
  // A teardrop: from the narrow mouth out to the widest ring, then a round top.
  const widest = Math.round(r * 1.15);
  const top = widest + Math.round(r * 0.9);
  const radius = (layer: number): number => {
    if (layer < 0 || layer > top) return 0;
    if (layer <= widest) return MOUTH + (r - MOUTH) * Math.sin((layer / widest) * (Math.PI / 2));
    return r * Math.cos(((layer - widest) / (top - widest + 0.6)) * (Math.PI / 2));
  };
  const inside = (layer: number, dx: number, dz: number): boolean =>
    Math.hypot(dx, dz) <= radius(layer) + 0.3;
  const half = Math.ceil(r) + 1;
  const colour = (layer: number, dx: number, dz: number): Block => {
    if (layer === Math.round(widest * 0.5) || layer >= top - 1) return band;
    const gore = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * GORES + 0.5) % GORES;
    return gore % 2 === 0 ? a : b;
  };
  // Only the skin: a block of the shape with at least one neighbour outside it (the mouth stays open).
  const skin: Voxel[] = range(0, top).flatMap((layer) =>
    range(-half, half).flatMap((dx) =>
      range(-half, half)
        .filter((dz) => inside(layer, dx, dz))
        .filter(
          (dz) =>
            !inside(layer + 1, dx, dz) ||
            (layer > 0 && !inside(layer - 1, dx, dz)) ||
            !inside(layer, dx + 1, dz) ||
            !inside(layer, dx - 1, dz) ||
            !inside(layer, dx, dz + 1) ||
            !inside(layer, dx, dz - 1),
        )
        .map((dz): Voxel => [x + dx, y + ROPES + 1 + layer, z + dz, colour(layer, dx, dz)]),
    ),
  );
  const corners: readonly [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  const basket = [
    fill(x - 1, y, z - 1, x + 1, y, z + 1, 'oak_planks'),
    fill(x - 1, y + 1, z - 1, x + 1, y + 1, z + 1, 'oak_fence'),
    set(x, y + 1, z, 'lantern'),
    ...corners.map(([dx, dz]) => fill(x + dx, y + 2, z + dz, x + dx, y + ROPES, z + dz, 'oak_fence')),
  ];
  return [...paint(skin), ...basket];
}

/** Takes the first balloon away (wool, its long ropes, the basket). */
function removeOldBalloon(): string[] {
  const { x, y, z } = OLD_BALLOON;
  return [fill(x - 8, y - 3, z - 8, x + 8, y + 20, z + 8, 'air')];
}

/**
 * Round spots that belong to the spawn although they float outside its circle (the small islands, the balloons):
 * x and z relative to the world spawn, with a radius. The plugin protects them like the island itself.
 */
export const SPAWN_ZONES: readonly { readonly x: number; readonly z: number; readonly r: number }[] = [
  ...ISLETS.map(([x, , z, r]) => ({ x, z: z - SPAWN_Z, r: Math.ceil(r) + 6 })),
  ...BALLOONS.map(({ x, z, r }) => ({ x, z: z - SPAWN_Z, r: Math.ceil(r) + 3 })),
];

/** Extras that make the spawn stand out (also added to islands of older versions once). */
export function extrasCommands(): string[] {
  return BALLOONS.flatMap(balloonCommands);
}

/**
 * Islands of older versions become the new spawn (brighter: white tower with a red roof and the flag, tent roof,
 * maypole, tulips, directions in the paving, five balloons): everything above the ground is cleared and built anew.
 */
export function renewCommands(): string[] {
  return [
    ...removeOldBalloon(),
    `function ${NAMESPACE}:top`,
    `function ${NAMESPACE}:extras`,
    // Whatever fell off while clearing (lanterns, ladders …) is swept up.
    `kill @e[type=item,distance=..${TIDY_REACH}]`,
  ];
}

/** A marker entity at the spawn point: the protection follows it wherever the island was built. */
const CENTER_TAG = 'mh_spawn_center';
const summonCenter = `summon marker ~ ~ ~${SPAWN_Z} {Tags:["${CENTER_TAG}"]}`;

/** One-time repairs of islands built by older versions (each has a flag and runs at the island's middle). */
const REPAIRS: readonly string[] = [
  'water',
  'hills',
  'center',
  'extras',
  'rainbow',
  'fountain',
  'benches',
  'renew',
  'reeds',
];

/** The datapack's files (path relative to the pack folder → content). */
export function spawnPackFiles(spot: IslandSpot = ORIGIN, lang: SpawnLang = 'de'): Record<string, string> {
  const area = areaOf(spot);
  const middle = `${spot.x} ${SPAWN_Y} ${spot.z}`;
  const load = [
    'scoreboard objectives add mh_craftattack dummy',
    // Islands of older versions: each repair runs once.
    ...REPAIRS.flatMap((name) => [
      `execute if score #built mh_craftattack matches 1 unless score #${name} mh_craftattack matches 1 run forceload add ${area}`,
      `execute if score #built mh_craftattack matches 1 unless score #${name} mh_craftattack matches 1 run schedule function ${NAMESPACE}:fix_${name} ${BUILD_DELAY_TICKS}t`,
    ]),
  ];
  const repairs = Object.fromEntries(
    REPAIRS.map((name) => [
      `fix_${name}`,
      [
        `execute positioned ${middle} run function ${NAMESPACE}:${name}`,
        `scoreboard players set #${name} mh_craftattack 1`,
        `forceload remove ${area}`,
      ],
    ]),
  );
  // Run by the panel at the chosen place (over an ocean): `execute positioned <x> ${SPAWN_Y} <z> run function …:build`.
  const build = [
    `function ${NAMESPACE}:island`,
    `function ${NAMESPACE}:top`,
    `function ${NAMESPACE}:extras`,
    summonCenter,
    `function #${NAMESPACE}:rules`,
    'scoreboard players set #built mh_craftattack 1',
    ...REPAIRS.map((name) => `scoreboard players set #${name} mh_craftattack 1`),
  ];
  // The MorniCraft plugin protects the spawn now. Earlier versions put players there into adventure mode: whoever
  // still carries that mark gets survival back once, then the tag is gone.
  const tick = [
    'gamemode survival @a[tag=mh_spawn,gamemode=adventure]',
    'tag @a[tag=mh_spawn] remove mh_spawn',
  ];
  const meta = {
    pack: {
      description: 'MorniHosting MorniCraft: Spawn',
      pack_format: PACK_FORMAT_OLD,
      supported_formats: { min_inclusive: PACK_FORMAT_OLD, max_inclusive: PACK_FORMAT_MAX },
      min_format: PACK_FORMAT_OLD,
      max_format: PACK_FORMAT_MAX,
    },
  };
  const loadTag = JSON.stringify({ values: [`${NAMESPACE}:load`] });
  const tickTag = JSON.stringify({ values: [`${NAMESPACE}:tick`] });
  // Players appear exactly at the spawn point (not somewhere around it, maybe off the island). The game rule was
  // renamed in newer versions; each name sits in its own function, so the one that does not exist only skips itself.
  const rulesTag = JSON.stringify({
    values: [
      { id: `${NAMESPACE}:rules_old`, required: false },
      { id: `${NAMESPACE}:rules_new`, required: false },
    ],
  });
  const functions: Record<string, string[]> = {
    load,
    build,
    island: islandCommands(),
    top: topCommands(lang),
    tick,
    ...repairs,
    water: fixWaterCommands(),
    hills: fixHillsCommands(),
    center: [summonCenter],
    extras: extrasCommands(),
    rainbow: removeRainbowCommands(),
    fountain: fixFountainCommands(),
    benches: removeBenchesCommands(),
    renew: renewCommands(),
    // The sugar cane sometimes had no water beside it and fell off: planted again, properly.
    reeds: [...reedCommands(), `kill @e[type=item,distance=..${TIDY_REACH}]`],
    rules_old: ['gamerule spawnRadius 0'],
    rules_new: ['gamerule respawn_radius 0'],
  };
  // "function" since 1.21, "functions" before – both, so the pack works everywhere.
  const files = Object.entries(functions).flatMap(([name, lines]) =>
    ['function', 'functions'].map(
      (dir) => [`data/${NAMESPACE}/${dir}/${name}.mcfunction`, `${lines.join('\n')}\n`] as const,
    ),
  );
  const tags = ['function', 'functions'].flatMap((dir) => [
    [`data/minecraft/tags/${dir}/load.json`, loadTag] as const,
    [`data/minecraft/tags/${dir}/tick.json`, tickTag] as const,
    [`data/${NAMESPACE}/tags/${dir}/rules.json`, rulesTag] as const,
  ]);
  return Object.fromEntries([['pack.mcmeta', `${JSON.stringify(meta, null, 2)}\n`], ...tags, ...files]);
}

/** Puts the datapack into the world folder; the server loads it when it creates the world. */
export function writeSpawnPack(worldDir: string, spot: IslandSpot = ORIGIN, lang: SpawnLang = 'de'): void {
  const root = path.join(worldDir, 'datapacks', SPAWN_PACK_DIR);
  Object.entries(spawnPackFiles(spot, lang)).forEach(([file, content]) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  });
}
