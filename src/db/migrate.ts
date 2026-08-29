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

export const SCHEMA_VERSION = 4;

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
  {
    version: 3,
    name: 'the statewide sources are namespaced by town',
    up: renameSources,
  },
  {
    version: 4,
    name: 'seed the geocode cache from the points already resolved',
    up(db) {
      // Every point in `places` was paid for with a request to the Census
      // geocoder. The cache is new, but the answers are not, and an upgrade
      // that made the next `link` re-ask for all of them would be the very
      // thing the cache exists to stop.
      db.exec(`
        INSERT OR IGNORE INTO geocodes
          (jurisdiction, key, query, provider, lat, lon, matched, failure, retrieved_at)
        SELECT m.jurisdiction, m.key, m.label, p.provider, p.lat, p.lon, p.matched, p.failure,
               p.geocoded_at
          FROM places p
          JOIN matters m ON m.id = p.matter_id
         WHERE m.kind = 'address'
      `);
    },
  },
];

/**
 * Source ids that changed, and what they changed to.
 *
 * `ma:commbuys` was a fine id for exactly as long as there was one town: the
 * query it describes ("contracts where this town is the purchasing org") is
 * per-town even though the system is statewide, so with two towns there would
 * have been two sources claiming the same primary key.
 *
 * A rename rather than a delete-and-recreate, because a source id is a foreign
 * key: dropping the row would cascade to every record it ever produced. These
 * two happen to be disabled and empty, but the mechanism is what a rename of a
 * *populated* source will need, and getting it right once is cheaper than
 * finding out later.
 */
const SOURCE_RENAMES: { from: string; to: string }[] = [
  { from: 'ma:ago:municipal-law-unit', to: 'milton-ma:state:ago-municipal-law' },
  { from: 'ma:commbuys', to: 'milton-ma:state:commbuys' },
];

function sourceExists(db: DatabaseSync, id: string): boolean {
  return Boolean(db.prepare('SELECT 1 AS hit FROM sources WHERE id = ?').get(id));
}

function renameSources(db: DatabaseSync): void {
  const pending = SOURCE_RENAMES.filter((rename) => sourceExists(db, rename.from));
  if (!pending.length) return;

  db.exec('BEGIN');
  try {
    // Updating a primary key that other tables point at would fail immediately
    // under normal enforcement. Deferring the check to COMMIT lets the parent
    // and its children move together, which is the whole point.
    db.exec('PRAGMA defer_foreign_keys = ON');

    for (const { from, to } of pending) {
      // Children first, and deliberately: `ON DELETE CASCADE` is an action
      // rather than a check, so deferring foreign keys does not defer it.
      // Dropping the old row while records still pointed at it would take the
      // records with it.
      for (const table of ['events', 'fetches', 'documents']) {
        db.prepare(`UPDATE ${table} SET source_id = ? WHERE source_id = ?`).run(to, from);
      }
      if (sourceExists(db, to)) {
        // Both ids present — a database that has already seen a newer build.
        // The new row is the one to keep.
        db.prepare('DELETE FROM sources WHERE id = ?').run(from);
      } else {
        db.prepare('UPDATE sources SET id = ? WHERE id = ?').run(to, from);
      }
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error(`${violations.length} foreign key violation(s) after rename`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

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
