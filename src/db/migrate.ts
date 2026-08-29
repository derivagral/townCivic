import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';

/**
 * Migrations.
 *
 * The rule this file follows: **the database is a cache**. The document store
 * is the authority, `events` is derivable from it, and everything downstream of
 * `events` is derivable from `events`. So a migration here never has to be
 * clever — the fallback for anything genuinely hard is to drop a derived table
 * and re-run the stage that fills it, which is exactly what `clear` does.
 *
 * Three mechanisms, in increasing order of violence:
 *
 *   1. `schema.sql` itself, which is all `CREATE ... IF NOT EXISTS` and is
 *      re-executed on every open. New tables and new indexes need nothing else.
 *   2. `ADDED_COLUMNS`, because `CREATE TABLE IF NOT EXISTS` will not add a
 *      column to a table that already exists.
 *   3. `MIGRATIONS`, for the changes SQLite cannot express in place — dropping
 *      an index, or rebuilding a table whose UNIQUE constraint changed.
 *
 * Everything in (3) is written to be idempotent and is guarded by
 * `PRAGMA user_version` as a fast path rather than as the source of truth. A
 * database from before this file existed reports version 0, replays each step,
 * finds most of them already done, and lands in the same place as a fresh one.
 */

export const SCHEMA_VERSION = 2;

/** Columns introduced after the first release. Additive, so an upgrade is free. */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'sources', column: 'precedence', definition: 'INTEGER NOT NULL DEFAULT 50' },
  { table: 'events', column: 'precedence', definition: 'INTEGER NOT NULL DEFAULT 50' },
  { table: 'events', column: 'doc_text', definition: 'TEXT' },
  { table: 'events', column: 'extracted_at', definition: 'TEXT' },
];

/** Columns the FTS index is expected to carry, in order. */
const FTS_COLUMNS = ['title', 'summary', 'subjects', 'agency', 'doc_text'];

function columns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'drop the indexes the jurisdiction-leading ones supersede',
    up(db) {
      // With one town, `channel` alone was a fine index. With several, every
      // query leads with `jurisdiction`, so these only cost write time.
      // `idx_matters_recent` is dropped rather than redefined because SQLite
      // will not rebuild an existing index under the same name — the schema
      // file creates `idx_matters_town_recent` in its place.
      db.exec(`
        DROP INDEX IF EXISTS idx_events_channel;
        DROP INDEX IF EXISTS idx_events_body;
        DROP INDEX IF EXISTS idx_matters_recent;
      `);
    },
  },
  {
    version: 2,
    name: 'subscriptions carry the jurisdiction they were made in',
    up: addSubscriptionJurisdiction,
  },
];

/**
 * Give `subscriptions` a jurisdiction, and move the uniqueness constraint onto
 * it.
 *
 * This is the one table whose *shape* was wrong for a second town rather than
 * merely un-indexed: `UNIQUE(user_id, kind, value)` says a reader may follow
 * one board called "Planning Board", full stop. SQLite cannot alter a UNIQUE
 * constraint in place — the index behind a table constraint is an internal
 * `sqlite_autoindex` that cannot be dropped — so the table is rebuilt.
 *
 * Existing rows predate multi-town and can only have meant the town that was
 * being served at the time, so they are backfilled with the configured default
 * jurisdiction rather than with the `*` wildcard: silently widening someone's
 * subscriptions to every town is the one outcome nobody asked for.
 */
function addSubscriptionJurisdiction(db: DatabaseSync): void {
  if (columns(db, 'subscriptions').includes('jurisdiction')) return;

  // Foreign keys off for the rebuild, per the procedure SQLite documents for
  // this. It has to be outside the transaction: the pragma is a no-op inside one.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE subscriptions_rebuilt (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        jurisdiction TEXT NOT NULL DEFAULT '*',
        kind         TEXT NOT NULL,
        value        TEXT NOT NULL,
        label        TEXT NOT NULL,
        alerts       TEXT NOT NULL DEFAULT 'none',
        created_at   TEXT NOT NULL,
        UNIQUE(user_id, jurisdiction, kind, value)
      );
    `);
    db.prepare(
      `INSERT INTO subscriptions_rebuilt (id, user_id, jurisdiction, kind, value, label, alerts, created_at)
       SELECT id, user_id, ?, kind, value, label, alerts, created_at FROM subscriptions`,
    ).run(config.defaultJurisdiction);
    db.exec(`
      DROP TABLE subscriptions;
      ALTER TABLE subscriptions_rebuilt RENAME TO subscriptions;
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
    `);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error(`${violations.length} foreign key violation(s) after rebuild`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Bring an existing database up to the current schema.
 *
 * `schemaSql` is passed in rather than read here so the FTS rebuild can replay
 * exactly the file that was just executed.
 */
export function migrate(db: DatabaseSync, schemaSql: string): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    if (columns(db, table).includes(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  // An FTS5 table cannot gain a column in place. When the shape changes, drop
  // and rebuild it — it is a derived index over `events`, so nothing is lost.
  const ftsColumns = columns(db, 'events_fts');
  const missing = FTS_COLUMNS.some((name) => !ftsColumns.includes(name));
  if (ftsColumns.length && missing) {
    db.exec(`
      DROP TRIGGER IF EXISTS events_fts_insert;
      DROP TRIGGER IF EXISTS events_fts_delete;
      DROP TRIGGER IF EXISTS events_fts_update;
      DROP TABLE IF EXISTS events_fts;
    `);
    // Re-running the schema recreates the table and its triggers.
    db.exec(schemaSql);
    db.exec(`INSERT INTO events_fts(events_fts) VALUES ('rebuild')`);
  }

  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version >= SCHEMA_VERSION) return;

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    migration.up(db);
  }
  // Not a bound parameter: SQLite does not allow one in a pragma value.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
