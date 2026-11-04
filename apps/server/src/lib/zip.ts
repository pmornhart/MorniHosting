import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { AppError } from './errors.js';
import { HTTP_BAD_REQUEST, HTTP_PAYLOAD_TOO_LARGE } from './http-status.js';
import { resolveInside } from './paths.js';

export interface ExtractLimits {
  /** Total size of all files after unpacking (protects against zip bombs). */
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export interface ExtractResult {
  readonly files: number;
  readonly bytes: number;
}

const SYMLINK_TYPE = 0o120000;
const FILE_TYPE_MASK = 0o170000;
const UNIX_MODE_SHIFT = 16;
const DIR_SUFFIX = '/';

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: true, decodeStrings: true, strictFileNames: false },
      (err, zip) =>
        err || !zip
          ? reject(new AppError(HTTP_BAD_REQUEST, 'invalid_zip', {}, { cause: err }))
          : resolve(zip),
    );
  });
}

/** yauzl refuses unsafe names itself ("invalid relative path: ../x"); report that as the path error it is. */
function zipError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code =
    message.includes('invalid relative path') || message.includes('absolute path')
      ? 'path_outside'
      : 'invalid_zip';
  return new AppError(HTTP_BAD_REQUEST, code, {}, { cause: err });
}

function isSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> UNIX_MODE_SHIFT) & FILE_TYPE_MASK;
  return mode === SYMLINK_TYPE;
}

/** Lists entry names without unpacking anything. */
export async function listZip(file: string, maxEntries: number): Promise<string[]> {
  const zip = await openZip(file);
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      names.push(entry.fileName);
      if (names.length > maxEntries) {
        zip.close();
        reject(new AppError(HTTP_PAYLOAD_TOO_LARGE, 'file_too_large'));
        return;
      }
      zip.readEntry();
    });
    zip.on('end', resolve);
    zip.on('error', (err: unknown) => reject(zipError(err)));
    zip.readEntry();
  });
  return names;
}

/**
 * Unpacks a ZIP into `destination`. Every entry must land inside it (no "zip slip"),
 * symbolic links are skipped, and the unpacked size is capped.
 * `stripPrefix` removes a leading folder, e.g. "MyServer/" when the ZIP wraps everything in one folder.
 */
export async function extractZip(
  file: string,
  destination: string,
  limits: ExtractLimits,
  stripPrefix = '',
): Promise<ExtractResult> {
  fs.mkdirSync(destination, { recursive: true });
  const zip = await openZip(file);
  const totals = { files: 0, bytes: 0 };
  await new Promise<void>((resolve, reject) => {
    const fail = (err: unknown): void => {
      zip.close();
      reject(zipError(err));
    };
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName.replaceAll('\\', '/');
      const relative = stripPrefix && name.startsWith(stripPrefix) ? name.slice(stripPrefix.length) : name;
      if (!relative || isSymlink(entry)) {
        zip.readEntry();
        return;
      }
      totals.files += 1;
      totals.bytes += entry.uncompressedSize;
      if (totals.files > limits.maxEntries || totals.bytes > limits.maxBytes) {
        fail(new AppError(HTTP_PAYLOAD_TOO_LARGE, 'file_too_large'));
        return;
      }
      const target = (() => {
        try {
          return resolveInside(destination, relative);
        } catch (err) {
          fail(err);
          return null;
        }
      })();
      if (!target) return;
      if (name.endsWith(DIR_SUFFIX)) {
        fs.mkdirSync(target, { recursive: true });
        zip.readEntry();
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          fail(err ?? new Error('no stream'));
          return;
        }
        void (async () => {
          try {
            await pipeline(stream, fs.createWriteStream(target));
            zip.readEntry();
          } catch (pipeErr) {
            fail(pipeErr);
          }
        })();
      });
    });
    zip.on('end', resolve);
    zip.on('error', fail);
    zip.readEntry();
  });
  return totals;
}

/** Packs files and folders (relative to `root`) into a ZIP at `outFile`. */
export async function createZip(
  root: string,
  relativePaths: readonly string[],
  outFile: string,
  exclude: readonly string[] = [],
): Promise<number> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const output = fs.createWriteStream(outFile);
  const archive = archiver('zip', { zlib: { level: 6 } }); // eslint-disable-line ts-patterns/no-magic-numbers -- balanced zlib level
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    output.on('error', reject);
  });
  archive.pipe(output);
  relativePaths.forEach((relative) => {
    const absolute = resolveInside(root, relative);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      archive.glob(
        '**/*',
        { cwd: absolute, dot: true, ignore: [...exclude] },
        { prefix: relative === '.' ? '' : relative },
      );
    } else {
      archive.file(absolute, { name: relative });
    }
  });
  await archive.finalize();
  await done;
  return archive.pointer();
}

/** Text of the first entry whose name is in `names` (e.g. "plugin.yml" in a plugin's jar), or null. */
export async function readZipText(
  file: string,
  names: readonly string[],
  maxBytes: number,
): Promise<string | null> {
  const zip = await openZip(file);
  return new Promise<string | null>((resolve, reject) => {
    const done = (text: string | null): void => {
      zip.close();
      resolve(text);
    };
    zip.on('entry', (entry: yauzl.Entry) => {
      if (!names.includes(entry.fileName) || entry.uncompressedSize > maxBytes) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          done(null);
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', () => done(null));
      });
    });
    zip.on('end', () => resolve(null));
    zip.on('error', (err: unknown) => reject(zipError(err)));
    zip.readEntry();
  });
}
