import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { migrate } from './migrate.ts';

/**
 * `node:sqlite` is loaded at evaluation time rather than imported statically.
 *
 * Node emits its "SQLite is an experimental feature" warning when the builtin
 * is *linked*, which happens before any module body runs — so a static import
 * here fires the warning before `util/quiet.ts` can install its filter, no
 * matter which module imports which. Requiring it during evaluation puts the
 * filter first and keeps the warning out of every command's output.
 *
 * The type import above is erased at compile time and does not link anything.
 */
const { DatabaseSync: Sqlite } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

let cached: DatabaseSync | undefined;

/** Open (and migrate) the database. `:memory:` is honoured for tests. */
export function openDb(dbPath: string = config.dbPath): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Sqlite(dbPath);
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  migrate(db, schemaSql);
  return db;
}

/** Process-wide handle for the CLI and server. */
export function getDb(): DatabaseSync {
  cached ??= openDb();
  return cached;
}

export function closeDb(): void {
  cached?.close();
  cached = undefined;
}

export type Db = DatabaseSync;
