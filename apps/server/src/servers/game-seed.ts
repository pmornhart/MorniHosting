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
