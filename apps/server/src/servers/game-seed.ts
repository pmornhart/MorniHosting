import fs from 'node:fs';
import path from 'node:path';

/**
 * Big Steam games (Counter-Strike 2 ~60 GB, Garry's Mod) do not need to come from Steam again for a second
 * server: the files of an existing, fully installed server of the same game are copied on the disk – minutes
 * instead of hours. steamcmd then only fetches what changed since. Only games whose folder holds nothing but
 * game files (settings come from the panel on every start) are shared this way.
 */

export const SHARED_GAME_FILES: ReadonlySet<string> = new Set(['cs2', 'gmod']);
/** Written into a game server's folder once it has started properly: its files are complete. */
export const INSTALLED_MARK = '.mornihosting-installed';
const SKIP = new Set(['logs', INSTALLED_MARK]);
/** A folder with a few entries is still "empty": the panel may already have put its own files there. */
const EMPTY_ENOUGH = 3;

export function markInstalled(dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, INSTALLED_MARK), new Date().toISOString());
  } catch {
    // Not important enough to fail a start over.
  }
}

const entries = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** The folder of a sibling server with complete files, or null. */
export function seedSource(target: string, siblings: readonly string[]): string | null {
  if (entries(target).length > EMPTY_ENOUGH) return null;
  return siblings.find((dir) => dir !== target && fs.existsSync(path.join(dir, INSTALLED_MARK))) ?? null;
}

/** Copies the game files; returns the bytes copied. */
export async function seedGameFiles(source: string, target: string): Promise<number> {
  fs.mkdirSync(target, { recursive: true });
  let bytes = 0;
  await fs.promises.cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
    preserveTimestamps: true,
    filter: (from) => {
      const name = path.relative(source, from).split(path.sep)[0] ?? '';
      if (SKIP.has(name)) return false;
      try {
        const stat = fs.statSync(from);
        if (stat.isFile()) bytes += stat.size;
      } catch {
        // gone in the meantime
      }
      return true;
    },
  });
  return bytes;
}

/**
 * Minecraft: a new server of the same software and version takes the finished server program from one that has
 * already run – the downloaded jar, the Mojang jar, the patched version and all libraries. That skips the
 * downloads and Paper's patching (or Forge's installer) and is the slow part of a first start. Worlds, plugins,
 * mods, settings and player lists are never copied.
 */
const RUNTIME_DIRS: ReadonlySet<string> = new Set(['libraries', 'cache', 'versions', '.fabric']);
// Top-level files that belong to the server program: jars and the image helper's manifests.
// "paper-1.21.4-232.jar", ".paper-manifest.json", "user_jvm_args.txt" match; "ops.json", ".rcon-cli.env" do not.
// https://regex101.com/?flavor=javascript&regex=%5E(.%2B%5C.jar%7C%5C..%2B-manifest%5C.json%7Cuser_jvm_args%5C.txt%7Crun%5C.sh)%24&testString=paper-1.21.4-232.jar%0A.paper-manifest.json%0Auser_jvm_args.txt%0Aops.json%0A.rcon-cli.env
const RUNTIME_FILE = /^(.+\.jar|\..+-manifest\.json|user_jvm_args\.txt|run\.sh)$/;
/** Paper remaps its own program for plugins once per folder (about 10 s); the result depends only on the version. */
const RUNTIME_NESTED: readonly string[] = [
  path.join('plugins', '.paper-remapped', 'mappings'),
  path.join('plugins', '.paper-remapped', 'remap-classpath'),
];

/** True when the folder does not have a server program yet (a brand-new server). */
export function needsRuntime(target: string): boolean {
  return !entries(target).some((name) => RUNTIME_DIRS.has(name) || RUNTIME_FILE.test(name));
}

/** Copies the server program of `source` into `target`; returns the bytes copied. */
export async function seedRuntime(source: string, target: string): Promise<number> {
  const wanted = [
    ...entries(source).filter((name) => RUNTIME_DIRS.has(name) || RUNTIME_FILE.test(name)),
    ...RUNTIME_NESTED.filter((nested) => fs.existsSync(path.join(source, nested))),
  ];
  fs.mkdirSync(target, { recursive: true });
  const sizes = await Promise.all(
    wanted.map(async (name) => {
      const from = path.join(source, name);
      await fs.promises.cp(from, path.join(target, name), {
        recursive: true,
        force: false,
        errorOnExist: false,
        preserveTimestamps: true,
      });
      return folderBytes(from);
    }),
  );
  return sizes.reduce((sum, n) => sum + n, 0);
}

function folderBytes(file: string): number {
  try {
    const stat = fs.statSync(file);
    if (!stat.isDirectory()) return stat.size;
    return entries(file).reduce((sum, name) => sum + folderBytes(path.join(file, name)), 0);
  } catch {
    return 0;
  }
}
