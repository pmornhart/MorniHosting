/* eslint-disable ts-patterns/no-magic-numbers -- a building plan: block offsets as the build needs them */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Craft Attack spawn: a decorated plaza built by a datapack on the world's first start – a fountain with a
 * lit pillar, paths in four directions, lamp posts, benches, flower beds, trees and a hedge around it. It sits on
 * the surface at 0/0 (levelled with a stone foundation, so hills or water do not matter) and becomes the world
 * spawn; EssentialsX Spawn's /spawn leads there. Built once: a scoreboard flag remembers it.
 *
 * Only commands that exist unchanged since 1.20.5 (fill, setblock, forceload, schedule, setworldspawn, execute
 * positioned over); a single unknown command would stop the whole function from loading.
 */

const PACK_DIR = 'mornihosting-craftattack';
const NAMESPACE = 'craftattack';
/** Half the plaza's width: it spans -R … R around the centre. */
const R = 16;
/** Ring of smooth stone around the fountain. */
const RING = 12;
const FOUNTAIN = 4;
const PATH_HALF = 2;
const LAMP = 9;
const TREE = 13;
const BENCH = 7;
const FOUNDATION_DEPTH = 6;
const CLEAR_HEIGHT = 14;
const PILLAR_HEIGHT = 3;
const TRUNK_HEIGHT = 4;
const LAMP_HEIGHT = 2;
/** Ticks after loading before building: the forced chunks are loaded by then. */
const BUILD_DELAY_TICKS = 60;
/** Players appear on the path in front of the fountain, not in the water. */
const SPAWN_OFFSET = FOUNTAIN + PATH_HALF;
/** pack.mcmeta: old and new format fields, so every version from 1.20.5 on accepts the pack. */
const PACK_FORMAT_OLD = 41;
const PACK_FORMAT_MAX = 999;

const SIGNS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const FLOWERS = [
  'poppy',
  'dandelion',
  'cornflower',
  'allium',
  'oxeye_daisy',
  'azure_bluet',
  'lily_of_the_valley',
];

const at = (x: number, y: number, z: number): string => `~${x || ''} ~${y || ''} ~${z || ''}`;
const fill = (
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  block: string,
): string => `fill ${at(x1, y1, z1)} ${at(x2, y2, z2)} ${block}`;
const set = (x: number, y: number, z: number, block: string): string => `setblock ${at(x, y, z)} ${block}`;

/** Commands for the plaza, relative to the first air block above the surface at the centre. */
export function plazaCommands(): string[] {
  const ground = [
    // Room above, a solid foundation below (fills holes and water), grass as the base.
    fill(-R, 0, -R, R, CLEAR_HEIGHT, R, 'air'),
    fill(-R, -FOUNDATION_DEPTH, -R, R, -2, R, 'stone'),
    fill(-R, -1, -R, R, -1, R, 'grass_block'),
    fill(-RING, -1, -RING, RING, -1, RING, 'smooth_stone'),
    fill(-RING, -1, -RING, RING, -1, -RING, 'stone_bricks'),
    fill(-RING, -1, RING, RING, -1, RING, 'stone_bricks'),
    fill(-RING, -1, -RING, -RING, -1, RING, 'stone_bricks'),
    fill(RING, -1, -RING, RING, -1, RING, 'stone_bricks'),
    fill(-R, -1, -PATH_HALF, R, -1, PATH_HALF, 'polished_andesite'),
    fill(-PATH_HALF, -1, -R, PATH_HALF, -1, R, 'polished_andesite'),
  ];
  const hedge = [
    fill(-R, 0, -R, R, 0, -R, 'oak_leaves[persistent=true]'),
    fill(-R, 0, R, R, 0, R, 'oak_leaves[persistent=true]'),
    fill(-R, 0, -R, -R, 0, R, 'oak_leaves[persistent=true]'),
    fill(R, 0, -R, R, 0, R, 'oak_leaves[persistent=true]'),
    // Openings where the paths leave the plaza.
    fill(-PATH_HALF, 0, -R, PATH_HALF, 0, -R, 'air'),
    fill(-PATH_HALF, 0, R, PATH_HALF, 0, R, 'air'),
    fill(-R, 0, -PATH_HALF, -R, 0, PATH_HALF, 'air'),
    fill(R, 0, -PATH_HALF, R, 0, PATH_HALF, 'air'),
  ];
  const fountain = [
    fill(-FOUNTAIN, -1, -FOUNTAIN, FOUNTAIN, -1, FOUNTAIN, 'stone_bricks'),
    fill(-FOUNTAIN, 0, -FOUNTAIN, FOUNTAIN, 0, FOUNTAIN, 'stone_brick_wall'),
    fill(1 - FOUNTAIN, 0, 1 - FOUNTAIN, FOUNTAIN - 1, 0, FOUNTAIN - 1, 'water'),
    ...SIGNS.map(([sx, sz]) => set(sx * (FOUNTAIN - 1), -1, sz * (FOUNTAIN - 1), 'sea_lantern')),
    fill(0, 0, 0, 0, PILLAR_HEIGHT, 0, 'quartz_pillar'),
    set(0, PILLAR_HEIGHT + 1, 0, 'sea_lantern'),
    set(0, PILLAR_HEIGHT + 2, 0, 'water'),
  ];
  const lamps = SIGNS.flatMap(([sx, sz]) => [
    fill(sx * LAMP, 0, sz * LAMP, sx * LAMP, LAMP_HEIGHT, sz * LAMP, 'dark_oak_fence'),
    set(sx * LAMP, LAMP_HEIGHT + 1, sz * LAMP, 'lantern'),
  ]);
  // Lamps beside each path where it leaves the ring.
  const pathLamps = (
    [
      [PATH_HALF + 1, RING + 2],
      [-PATH_HALF - 1, -RING - 2],
      [RING + 2, -PATH_HALF - 1],
      [-RING - 2, PATH_HALF + 1],
    ] as const
  ).flatMap(([x, z]) => [
    fill(x, 0, z, x, LAMP_HEIGHT, z, 'dark_oak_fence'),
    set(x, LAMP_HEIGHT + 1, z, 'lantern'),
  ]);
  // Benches on the ring, two per side, looking at the fountain.
  const benches = [
    set(-1, 0, BENCH, 'oak_stairs[facing=south]'),
    set(1, 0, BENCH, 'oak_stairs[facing=south]'),
    set(-1, 0, -BENCH, 'oak_stairs[facing=north]'),
    set(1, 0, -BENCH, 'oak_stairs[facing=north]'),
    set(BENCH, 0, -1, 'oak_stairs[facing=east]'),
    set(BENCH, 0, 1, 'oak_stairs[facing=east]'),
    set(-BENCH, 0, -1, 'oak_stairs[facing=west]'),
    set(-BENCH, 0, 1, 'oak_stairs[facing=west]'),
  ];
  const trees = SIGNS.flatMap(([sx, sz]) => {
    const x = sx * TREE;
    const z = sz * TREE;
    return [
      fill(x - 2, TRUNK_HEIGHT - 1, z - 2, x + 2, TRUNK_HEIGHT, z + 2, 'oak_leaves[persistent=true]'),
      fill(x - 1, TRUNK_HEIGHT + 1, z - 1, x + 1, TRUNK_HEIGHT + 1, z + 1, 'oak_leaves[persistent=true]'),
      fill(x, 0, z, x, TRUNK_HEIGHT, z, 'oak_log'),
    ];
  });
  // Flower beds in the four grass corners inside the hedge.
  const flowers = SIGNS.flatMap(([sx, sz], corner) =>
    FLOWERS.map((flower, i) => set(sx * (RING + 1 + (i % 2)), 0, sz * (RING - 1 - i), flower)).concat(
      set(sx * (RING - 1 - corner), 0, sz * (RING + 2), FLOWERS[corner] ?? 'poppy'),
    ),
  );
  return [
    ...ground,
    ...hedge,
    ...fountain,
    ...lamps,
    ...pathLamps,
    ...benches,
    ...trees,
    ...flowers,
    `setworldspawn ${at(0, 0, SPAWN_OFFSET)}`,
  ];
}

const AREA = `${-R - 8} ${-R - 8} ${R + 8} ${R + 8}`;

/** The datapack's files (path relative to the pack folder → content). */
export function spawnPackFiles(): Record<string, string> {
  const load = [
    'scoreboard objectives add mh_craftattack dummy',
    `execute unless score #built mh_craftattack matches 1 run forceload add ${AREA}`,
    `execute unless score #built mh_craftattack matches 1 run schedule function ${NAMESPACE}:build ${BUILD_DELAY_TICKS}t`,
  ];
  const build = [
    `execute positioned 0 64 0 positioned over motion_blocking_no_leaves run function ${NAMESPACE}:plaza`,
    'scoreboard players set #built mh_craftattack 1',
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
  const tag = JSON.stringify({ values: [`${NAMESPACE}:load`] });
  const functions: Record<string, string[]> = { load, build, plaza: plazaCommands() };
  // "function" since 1.21, "functions" before – both, so the pack works everywhere.
  const files = Object.entries(functions).flatMap(([name, lines]) =>
    ['function', 'functions'].map(
      (dir) => [`data/${NAMESPACE}/${dir}/${name}.mcfunction`, `${lines.join('\n')}\n`] as const,
    ),
  );
  return Object.fromEntries([
    ['pack.mcmeta', `${JSON.stringify(meta, null, 2)}\n`],
    ['data/minecraft/tags/function/load.json', tag],
    ['data/minecraft/tags/functions/load.json', tag],
    ...files,
  ]);
}

/** Puts the datapack into the world folder; the server loads it when it creates the world. */
export function writeSpawnPack(worldDir: string): void {
  const root = path.join(worldDir, 'datapacks', PACK_DIR);
  Object.entries(spawnPackFiles()).forEach(([file, content]) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  });
}
