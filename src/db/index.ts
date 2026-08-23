import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

let cached: DatabaseSync | undefined;

/** Open (and migrate) the database. `:memory:` is honoured for tests. */
export function openDb(dbPath: string = config.dbPath): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` will not add a column to a database that already
 * exists, so columns introduced after the first release are added here. Keeping
 * this additive means an existing `data/towncivic.db` survives an upgrade.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'sources', column: 'precedence', definition: 'INTEGER NOT NULL DEFAULT 50' },
  { table: 'events', column: 'precedence', definition: 'INTEGER NOT NULL DEFAULT 50' },
];

function migrate(db: DatabaseSync): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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
