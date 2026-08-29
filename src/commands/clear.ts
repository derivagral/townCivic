import type { Db } from '../db/index.ts';
import { hasJurisdiction, orphanJurisdictions } from '../registry/index.ts';

/**
 * Delete one town's rows.
 *
 * This is the command multi-town makes necessary. With one town, "start over"
 * was `rm data/towncivic.db`; with several, throwing away Hull's bad first
 * ingest cannot mean throwing away Milton's nine years of archive too.
 *
 * It is safe to run because of what the layers mean. The document store is the
 * authority and nothing here touches it. `events` is derivable from documents
 * by re-fetching, and everything below `events` — matters, places, readings,
 * attachments — is derivable from `events` with no network at all. So each
 * scope names the deepest layer it removes, and the way back is to re-run the
 * stages that fill it:
 *
 *   derived   matters, timelines, map pins, model readings   → link, geocode, interpret
 *   records   the above plus `events` and what hangs off them → ingest, extract, …
 *   town      the above plus the town's sources, fetch log,
 *             document index and its row in `jurisdictions`   → the town is gone
 *
 * `town` is what to run for a jurisdiction removed from the registry, and what
 * `--orphans` runs for every such jurisdiction it finds.
 */

export const CLEAR_SCOPES = ['derived', 'records', 'town'] as const;
export type ClearScope = (typeof CLEAR_SCOPES)[number];

export function isClearScope(value: string): value is ClearScope {
  return (CLEAR_SCOPES as readonly string[]).includes(value);
}

export interface ClearReport {
  jurisdiction: string;
  scope: ClearScope;
  dryRun: boolean;
  /** Rows removed, by table. Only tables the scope touches appear. */
  removed: Record<string, number>;
  /** True when the registry no longer knows this jurisdiction. */
  orphan: boolean;
  /** Documents left in the content-addressed store, which is never deleted. */
  documentsKept: number;
}

export interface ClearOptions {
  jurisdiction: string;
  scope?: ClearScope;
  /** Count what would go, change nothing. */
  dryRun?: boolean;
}

const count = (db: Db, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...(params as never[])) as { n: number }).n;

/**
 * What each scope removes, deepest first.
 *
 * Written as count/delete pairs rather than as `DELETE ... RETURNING` so a dry
 * run and a real run report the same numbers from the same SQL — a dry run that
 * counts differently from what the delete does is worse than no dry run.
 */
function plan(scope: ClearScope): { table: string; count: string; delete: string }[] {
  const derived = [
    {
      table: 'interpretations',
      count: `SELECT count(*) AS n FROM interpretations i JOIN events e ON e.id = i.event_id
               WHERE e.jurisdiction = ?`,
      delete: `DELETE FROM interpretations WHERE event_id IN
                 (SELECT id FROM events WHERE jurisdiction = ?)`,
    },
    {
      table: 'places',
      count: `SELECT count(*) AS n FROM places p JOIN matters m ON m.id = p.matter_id
               WHERE m.jurisdiction = ?`,
      delete: `DELETE FROM places WHERE matter_id IN (SELECT id FROM matters WHERE jurisdiction = ?)`,
    },
    {
      table: 'matter_events',
      count: `SELECT count(*) AS n FROM matter_events me JOIN matters m ON m.id = me.matter_id
               WHERE m.jurisdiction = ?`,
      delete: `DELETE FROM matter_events WHERE matter_id IN (SELECT id FROM matters WHERE jurisdiction = ?)`,
    },
    {
      table: 'matters',
      count: 'SELECT count(*) AS n FROM matters WHERE jurisdiction = ?',
      delete: 'DELETE FROM matters WHERE jurisdiction = ?',
    },
  ];

  const records = [
    ...derived,
    {
      table: 'attachments',
      count: `SELECT count(*) AS n FROM attachments a JOIN events e ON e.id = a.event_id
               WHERE e.jurisdiction = ?`,
      delete: `DELETE FROM attachments WHERE event_id IN (SELECT id FROM events WHERE jurisdiction = ?)`,
    },
    {
      table: 'events',
      count: 'SELECT count(*) AS n FROM events WHERE jurisdiction = ?',
      delete: 'DELETE FROM events WHERE jurisdiction = ?',
    },
  ];

  if (scope === 'derived') return derived;
  if (scope === 'records') return records;

  return [
    ...records,
    {
      table: 'fetches',
      count: `SELECT count(*) AS n FROM fetches f JOIN sources s ON s.id = f.source_id
               WHERE s.jurisdiction = ?`,
      delete: `DELETE FROM fetches WHERE source_id IN (SELECT id FROM sources WHERE jurisdiction = ?)`,
    },
    {
      // The rows, not the bytes: the content-addressed store is the authority
      // and is never deleted by this command. Re-ingesting rebuilds the index.
      table: 'documents',
      count: `SELECT count(*) AS n FROM documents d JOIN sources s ON s.id = d.source_id
               WHERE s.jurisdiction = ?`,
      delete: `DELETE FROM documents WHERE source_id IN (SELECT id FROM sources WHERE jurisdiction = ?)`,
    },
    {
      table: 'sources',
      count: 'SELECT count(*) AS n FROM sources WHERE jurisdiction = ?',
      delete: 'DELETE FROM sources WHERE jurisdiction = ?',
    },
    {
      table: 'jurisdictions',
      count: 'SELECT count(*) AS n FROM jurisdictions WHERE id = ?',
      delete: 'DELETE FROM jurisdictions WHERE id = ?',
    },
  ];
}

export function clearJurisdiction(db: Db, options: ClearOptions): ClearReport {
  const scope = options.scope ?? 'derived';
  const { jurisdiction } = options;
  const steps = plan(scope);

  const report: ClearReport = {
    jurisdiction,
    scope,
    dryRun: Boolean(options.dryRun),
    removed: {},
    orphan: !hasJurisdiction(jurisdiction),
    documentsKept: count(
      db,
      `SELECT count(*) AS n FROM documents d JOIN sources s ON s.id = d.source_id
        WHERE s.jurisdiction = ?`,
      jurisdiction,
    ),
  };

  for (const step of steps) report.removed[step.table] = count(db, step.count, jurisdiction);
  if (options.dryRun) return report;

  // One transaction: a half-cleared town — matters gone, events left — would
  // look to `link` like a town whose records simply have no subjects.
  db.exec('BEGIN');
  try {
    for (const step of steps) db.prepare(step.delete).run(jurisdiction);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return report;
}

/** Clear every jurisdiction with rows in the database that the registry has dropped. */
export function clearOrphans(db: Db, options: { dryRun?: boolean } = {}): ClearReport[] {
  return orphanJurisdictions(db).map((orphan) =>
    clearJurisdiction(db, {
      jurisdiction: orphan.jurisdiction,
      scope: 'town',
      ...(options.dryRun ? { dryRun: true } : {}),
    }),
  );
}
