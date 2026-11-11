/* eslint-disable ts-patterns/no-magic-numbers -- a building plan: block offsets as the build needs them */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Craft Attack spawn: a floating island high above the world, built by a datapack on the world's first start.
 *
 * - The island: grass on top, rock below that narrows to a rough point, with ores, glowing spots, dripstone and
 *   hanging lanterns underneath; five small islets float around it.
 * - On top: a round plaza with a fountain whose column carries a beacon (a green beam visible from far away) and
 *   water running down its sides; four paths lead to wooden launch decks ("Absprung") that stick out over the edge –
 *   from there players jump and glide down with the start elytra (the SpawnElytra plugin: double jump to glide,
 *   F / sneak to boost, no fall damage). Between the paths: a lookout tower, a pavilion, a cherry grove and a pond
 *   with a campfire; a flowering azalea hedge runs round the edge, lamps everywhere (and invisible light blocks, so
 *   no monsters spawn up there).
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
const CLEAR_HEIGHT = 30;
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
];

/** Directions of the four paths: u runs outwards along the path, v across it. */
const DIRECTIONS = [
  { name: 'north', axis: 'x', pos: (u: number, v: number): [number, number] => [v, -u] },
  { name: 'south', axis: 'x', pos: (u: number, v: number): [number, number] => [-v, u] },
  { name: 'east', axis: 'z', pos: (u: number, v: number): [number, number] => [u, v] },
  { name: 'west', axis: 'z', pos: (u: number, v: number): [number, number] => [-u, -v] },
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
const onPath = (d: Direction, u: number, v: number, y: number, block: Block): string => {
  const [x, z] = d.pos(u, v);
  return set(x, y, z, block);
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

function lampPost(x: number, z: number, post = 'dark_oak_fence', height = 3): string[] {
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

/** Everything on top of the island, relative to the plaza (y = 0 is where players stand). */
export function topCommands(): string[] {
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
  // Hedge round the edge: a ring of azalea, flowering here and there.
  const hedge = [
    ...disc(0, RT - 0.5, LEAVES('azalea'), 0, 0, 1),
    ...disc(0, RT - 2, 'air'),
    ...range(0, 23).map((i) => {
      const angle = (i / 24) * Math.PI * 2 + 0.13;
      const r = RT - 1.3;
      return set(
        Math.round(Math.cos(angle) * r),
        0,
        Math.round(Math.sin(angle) * r),
        LEAVES('flowering_azalea'),
      );
    }),
  ];
  const plaza = [
    ...disc(-1, PLAZA, 'stone_bricks'),
    ...disc(-1, PLAZA - 1.5, 'polished_andesite'),
    ...disc(-1, 8.5, 'chiseled_stone_bricks'),
    ...disc(-1, 7.6, 'smooth_stone'),
    // A compass star in the paving.
    ...DIRECTIONS.flatMap((d) => range(6, 10).map((u) => onPath(d, u, 0, -1, 'polished_deepslate'))),
  ];
  const fountain = [
    ...disc(-1, BASIN, 'stone_bricks'),
    ...disc(-1, BASIN - 1, 'prismarine_bricks'),
    // Rims of full blocks: walls can hold water themselves (waterlogged) and let it run out over the plaza.
    ...disc(0, BASIN, RIM),
    ...disc(0, BASIN - 1, 'water'),
    ...[
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
    ].map(([x = 0, z = 0]) => set(x, -1, z, 'sea_lantern')),
    // The column: quartz with glowing bands, an upper bowl that spills water all round into the basin,
    // iron on top for the beacon, a green beam through the glass.
    fill(-1, 0, -1, 1, 8, 1, 'quartz_bricks'),
    fill(-1, 1, -1, 1, 1, 1, 'sea_lantern'),
    fill(-1, 6, -1, 1, 6, 1, 'sea_lantern'),
    ...disc(3, 3.6, 'stone_bricks'),
    ...disc(3, 2.2, 'prismarine_bricks'),
    fill(-1, 3, -1, 1, 3, 1, 'quartz_bricks'),
    // A rim round the upper bowl, so its water stays in (it used to spill over the whole plaza).
    ...disc(4, 3.6, RIM),
    ...disc(4, 2.6, 'water'),
    fill(-1, 4, -1, 1, 4, 1, 'quartz_bricks'),
    fill(-1, 8, -1, 1, 8, 1, 'chiseled_quartz_block'),
    fill(-1, 9, -1, 1, 9, 1, 'iron_block'),
    set(0, 10, 0, 'beacon'),
    set(0, 11, 0, 'lime_stained_glass'),
    ...[
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].map(([x = 0, z = 0]) => set(x, 10, z, 'end_rod')),
  ];
  const plazaLamps = range(0, 7).flatMap((i) => {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
    return lampPost(
      Math.round(Math.cos(angle) * 9.5),
      Math.round(Math.sin(angle) * 9.5),
      'stone_brick_wall',
      2,
    );
  });
  const benches = [
    set(5, 0, 7, 'oak_stairs[facing=south]'),
    set(7, 0, 5, 'oak_stairs[facing=east]'),
    set(-5, 0, 7, 'oak_stairs[facing=south]'),
    set(-7, 0, 5, 'oak_stairs[facing=west]'),
    set(5, 0, -7, 'oak_stairs[facing=north]'),
    set(7, 0, -5, 'oak_stairs[facing=east]'),
    set(-5, 0, -7, 'oak_stairs[facing=north]'),
    set(-7, 0, -5, 'oak_stairs[facing=west]'),
  ];
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
    ...[13, 18, 23].map((u) => onPath(d, u, (u % 3) - 1, -1, 'cracked_stone_bricks')),
  ]);
  const decks = DIRECTIONS.flatMap((d) => {
    const beam = `spruce_log[axis=${d.axis}]`;
    return [
      strip(d, DECK_FROM, DECK_TO, -2, 2, -1, -1, 'spruce_planks'),
      strip(d, DECK_FROM, DECK_TO, 0, 0, -1, -1, 'stripped_spruce_log'),
      strip(d, DECK_FROM, DECK_TO - 1, -3, -3, 0, 0, 'spruce_fence'),
      strip(d, DECK_FROM, DECK_TO - 1, 3, 3, 0, 0, 'spruce_fence'),
      strip(d, DECK_TO, DECK_TO, -2, 2, 0, 0, 'lime_carpet'),
      // The gate at the start of the deck.
      strip(d, DECK_FROM, DECK_FROM, -3, -3, 0, 3, 'spruce_log'),
      strip(d, DECK_FROM, DECK_FROM, 3, 3, 0, 3, 'spruce_log'),
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
  // North-west: the lookout tower (players jump off its top too).
  const tx = TOWER_X;
  const tz = TOWER_Z;
  const tower = [
    fill(tx - 2, -1, tz - 2, tx + 2, 15, tz + 2, 'stone_bricks'),
    fill(tx - 1, 0, tz - 1, tx + 1, 15, tz + 1, 'air'),
    ...[3, 8, 13].flatMap((y) => [
      fill(tx - 2, y, tz - 2, tx + 2, y, tz + 2, 'mossy_stone_bricks', 'replace stone_bricks'),
      set(tx - 2, y + 1, tz, 'glass_pane'),
      set(tx, y + 1, tz + 2, 'glass_pane'),
    ]),
    fill(tx + 2, 0, tz, tx + 2, 1, tz, 'air'),
    fill(tx, 0, tz - 1, tx, 16, tz - 1, 'ladder[facing=south]'),
    fill(tx - 3, 16, tz - 3, tx + 3, 16, tz + 3, 'stone_bricks'),
    set(tx, 16, tz - 1, 'ladder[facing=south]'),
    fill(tx - 3, 17, tz - 3, tx + 3, 17, tz + 3, 'stone_brick_wall'),
    fill(tx - 2, 17, tz - 2, tx + 2, 17, tz + 2, 'air'),
    ...[
      [tx - 3, tz - 3],
      [tx + 3, tz - 3],
      [tx - 3, tz + 3],
      [tx + 3, tz + 3],
    ].map(([x = 0, z = 0]) => set(x, 18, z, 'lantern')),
    fill(tx + 2, 17, tz + 2, tx + 2, 21, tz + 2, 'spruce_fence'),
    fill(tx + 2, 20, tz + 3, tx + 2, 21, tz + 5, 'lime_wool'),
    // Light inside without anything in the way: glowing blocks in the walls, invisible light in the shaft.
    ...TOWER_LIGHTS.map(([x, y, z, block]) => set(tx + x, y, tz + z, block)),
  ];
  // South-west … north-west: the pavilion with benches.
  const px = -14;
  const pz = -14;
  const pavilion = [
    fill(px - 4, -1, pz - 4, px + 4, -1, pz + 4, 'dark_oak_planks'),
    fill(px - 3, -1, pz - 3, px + 3, -1, pz + 3, 'spruce_planks'),
    ...[
      [-4, -4],
      [4, -4],
      [-4, 4],
      [4, 4],
    ].map(([dx = 0, dz = 0]) => fill(px + dx, 0, pz + dz, px + dx, 3, pz + dz, 'dark_oak_log')),
    fill(px - 5, 4, pz - 5, px + 5, 4, pz + 5, 'dark_oak_slab'),
    fill(px - 4, 4, pz - 4, px + 4, 4, pz + 4, 'dark_oak_planks'),
    fill(px - 3, 5, pz - 3, px + 3, 5, pz + 3, 'dark_oak_slab'),
    fill(px - 2, 5, pz - 2, px + 2, 5, pz + 2, 'dark_oak_planks'),
    fill(px - 1, 6, pz - 1, px + 1, 6, pz + 1, 'dark_oak_slab'),
    set(px, 6, pz, 'dark_oak_planks'),
    set(px, 7, pz, 'lantern'),
    set(px, 3, pz, 'lantern[hanging=true]'),
    fill(px - 3, 0, pz - 3, px + 3, 0, pz - 3, 'spruce_stairs[facing=north]'),
    fill(px - 3, 0, pz + 3, px - 1, 0, pz + 3, 'spruce_stairs[facing=south]'),
    fill(px - 3, 0, pz - 2, px - 3, 0, pz + 2, 'spruce_stairs[facing=west]'),
    set(px, 0, pz, 'spruce_fence'),
    set(px, 1, pz, 'spruce_pressure_plate'),
    set(px + 4, 0, pz + 2, 'potted_red_tulip'),
    set(px + 4, 0, pz - 2, 'potted_blue_orchid'),
  ];
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
    fill(18, 0, 12, 18, 1, 12, 'sugar_cane'),
    fill(12, 0, 16, 12, 2, 16, 'sugar_cane'),
    ...tree(8, 20, 'oak', 7),
    set(20, 0, 6, 'campfire[lit=true]'),
    set(22, 0, 6, 'oak_log[axis=z]'),
    set(18, 0, 6, 'oak_log[axis=z]'),
    set(20, 0, 8, 'oak_log[axis=x]'),
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
  ];
  const flowers = range(0, 119).flatMap((i) => {
    const angle = noise(i, 11) * Math.PI * 2;
    const rho = 13 + noise(11, i) * (RT - 16);
    const x = Math.round(Math.cos(angle) * rho);
    const z = Math.round(Math.sin(angle) * rho);
    if (Math.abs(x) <= 3 || Math.abs(z) <= 3 || BUSY.some((b) => b(x, z))) return [];
    return [
      set(x, 0, z, i % 9 === 0 ? 'short_grass' : (flowerKinds[i % flowerKinds.length] ?? 'poppy'), 'keep'),
    ];
  });
  // Lamps along the rim, between the paths.
  const rimLamps = range(0, 7).flatMap((i) => {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
    return lampPost(Math.round(Math.cos(angle) * (RT - 4)), Math.round(Math.sin(angle) * (RT - 4)));
  });
  // Invisible light everywhere on top, so no monsters spawn on the island.
  const lights = lightGrid();

  const islets = [
    ...islet(46, -6, -20, 5, 'tree'),
    ...islet(-40, 8, 34, 3.8, 'azalea'),
    ...islet(14, -16, 50, 4.2, 'tree'),
    ...islet(-48, -12, -22, 4.6, 'tree'),
    ...islet(24, 12, -46, 3.2, 'azalea'),
  ];
  // Gentle grass hills, so the open lawns are not flat; rocks with moss here and there.
  const hills = (
    [
      [22, -20, 3.6],
      [-24, 2, 3.2],
      [6, 26, 3],
      [-6, -26, 2.8],
    ] as const
  ).flatMap(([x, z, r]) => [
    ...disc(0, r, 'grass_block', x, z, 0.8),
    ...disc(1, r - 1.4, 'grass_block', x, z, 0.6),
    set(x, 2, z, 'flowering_azalea', 'keep'),
  ]);
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
    ...benches,
    ...paths,
    ...decks,
    ...tower,
    ...pavilion,
    ...cherries,
    ...pond,
    ...rimLamps,
    ...flowers,
    ...lights,
    ...islets,
    ...hills,
    ...rocks,
    `setworldspawn ${at(0, 0, SPAWN_Z)}`,
  ];
}

/** Lights of the lookout tower, relative to its middle: glowing blocks set into the walls, light blocks inside. */
const TOWER_LIGHTS: readonly (readonly [number, number, number, Block])[] = [
  [-2, 5, 1, 'shroomlight'],
  [2, 10, -1, 'shroomlight'],
  [0, 1, 1, 'light[level=15]'],
  [0, 8, 1, 'light[level=15]'],
  [0, 13, 1, 'light[level=15]'],
];
/** The lookout tower's middle. */
const TOWER_X = -15;
const TOWER_Z = 15;

/** The fountain's rims: full blocks, which (unlike walls) can never hold water. */
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

const AREA = '-64 -64 64 64';

/** The datapack's files (path relative to the pack folder → content). */
export function spawnPackFiles(): Record<string, string> {
  const load = [
    'scoreboard objectives add mh_craftattack dummy',
    `execute unless score #built mh_craftattack matches 1 run forceload add ${AREA}`,
    `execute unless score #built mh_craftattack matches 1 run schedule function ${NAMESPACE}:build ${BUILD_DELAY_TICKS}t`,
    // Islands of the first version: clear the spilled water once.
    `execute if score #built mh_craftattack matches 1 unless score #water mh_craftattack matches 1 run forceload add ${AREA}`,
    `execute if score #built mh_craftattack matches 1 unless score #water mh_craftattack matches 1 run schedule function ${NAMESPACE}:fix_water ${BUILD_DELAY_TICKS}t`,
  ];
  const fixWater = [
    `execute positioned 0 ${SPAWN_Y} 0 run function ${NAMESPACE}:water`,
    'scoreboard players set #water mh_craftattack 1',
    `forceload remove ${AREA}`,
  ];
  const build = [
    `execute positioned 0 ${SPAWN_Y} 0 run function ${NAMESPACE}:island`,
    `execute positioned 0 ${SPAWN_Y} 0 run function ${NAMESPACE}:top`,
    `function #${NAMESPACE}:rules`,
    'scoreboard players set #built mh_craftattack 1',
    'scoreboard players set #water mh_craftattack 1',
    `forceload remove ${AREA}`,
  ];
  const meta = {
    pack: {
      description: 'MorniHosting Craft Attack: Spawn',
      pack_format: PACK_FORMAT_OLD,
      supported_formats: { min_inclusive: PACK_FORMAT_OLD, max_inclusive: PACK_FORMAT_MAX },
      min_format: PACK_FORMAT_OLD,
      max_format: PACK_FORMAT_MAX,
    },
  };
  const loadTag = JSON.stringify({ values: [`${NAMESPACE}:load`] });
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
    top: topCommands(),
    fix_water: fixWater,
    water: fixWaterCommands(),
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
    [`data/${NAMESPACE}/tags/${dir}/rules.json`, rulesTag] as const,
  ]);
  return Object.fromEntries([['pack.mcmeta', `${JSON.stringify(meta, null, 2)}\n`], ...tags, ...files]);
}

/** Puts the datapack into the world folder; the server loads it when it creates the world. */
export function writeSpawnPack(worldDir: string): void {
  const root = path.join(worldDir, 'datapacks', SPAWN_PACK_DIR);
  Object.entries(spawnPackFiles()).forEach(([file, content]) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  });
}

/**
 * The start elytra (SpawnElytra plugin): only the settings that differ from its defaults; it fills in the rest.
 * Flight starts anywhere above or below the island (players falling off can still glide), no tracking, no update
 * notices (the panel keeps plugins up to date).
 */
export function spawnElytraConfig(world: string): string {
  return [
    '# Set up by MorniHosting for the Craft Attack spawn (floating island).',
    `world: ${world}`,
    'spawnRadius: 45',
    'ignoreYInSpawnRadius: true',
    'spawnAreaMode: circle',
    'boostEnabled: true',
    'multiplyValue: 4',
    'boostDirection: forward',
    'totalBoosts: 1',
    'enableMetrics: false',
    'checkForUpdates: false',
    '',
  ].join('\n');
}
