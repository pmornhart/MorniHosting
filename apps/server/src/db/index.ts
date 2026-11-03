import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  readonly db: Db;
  readonly close: () => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_CANDIDATES = [path.resolve(here, '../drizzle'), path.resolve(here, '../../drizzle')];

function migrationsFolder(): string {
  const found = MIGRATION_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'meta', '_journal.json')));
  if (!found)
    throw new Error(`Datenbank-Migrationen nicht gefunden (gesucht in ${MIGRATION_CANDIDATES.join(', ')})`);
  return found;
}

/** Opens (and if needed creates) the panel database and brings its schema up to date. */
export function openDatabase(file: string): DbHandle {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  // Safe together with WAL and much faster for the many small writes (stats, logs, audit).
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, close: () => sqlite.close() };
}
