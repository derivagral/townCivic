import type { Db } from '../db/index.ts';
import { loadBoundary } from '../geo/boundary.ts';
import { countInterpretations } from '../db/repo.ts';
import { getProfile, hasJurisdiction, loadSources, orphanJurisdictions } from '../registry/index.ts';

/**
 * What an operator needs to know at a glance, and what a monitor needs to alarm on.
 *
 * The failure this exists to catch is the quiet one. A crawler that errors is
 * obvious; a crawler that keeps returning 200 while the town's site quietly
 * stops publishing looks exactly like a quiet week. So the question is not "did
 * the last run succeed" but "when did each source last actually produce
 * something, and is that longer ago than it should be".
 *
 * `--json` output is the contract for anything automated.
 */

export interface SourceStatus {
  sourceId: string;
  label: string;
  enabled: boolean;
  lastFetchAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  events: number;
  /** When this source last produced a record nobody had seen before. */
  lastNewAt: string | null;
  staleDays: number | null;
  stale: boolean;
}

export interface StatusReport {
  jurisdiction: string;
  /** How the UI says the town's name; `jurisdiction` alone when unregistered. */
  label: string;
  generatedAt: string;
  events: number;
  matters: number;
  /** Address matters resolved to a point, over address matters in total. */
  placed: { resolved: number; total: number };
  interpretations: number;
  documentsExtracted: number;
  documentsPending: number;
  /**
   * Whether this town's outline is committed. Without it `geocode` falls back
   * to a rectangle, which accepts addresses in neighbouring towns — worth
   * knowing before trusting the map.
   */
  boundary: { present: boolean; points: number; retrieved: string } | null;
  /**
   * Towns with rows in this database that the registry no longer knows about.
   * A property of the database rather than of this town, reported here because
   * `status` is what an operator and a monitor actually run.
   */
  orphans: { jurisdiction: string; events: number }[];
  /** Source rows in the database that this town's registry entry no longer lists. */
  orphanSources: string[];
  sources: SourceStatus[];
  /** Anything that means the refresh itself is unhealthy. Empty means publishable. */
  problems: string[];
  /** Data-quality signals worth inspecting, but not reasons to freeze a good snapshot. */
  warnings: string[];
  ok: boolean;
}

/**
 * How long a source may go without a new record before it is worth a look.
 *
 * Boards meet monthly and take August off, so anything under about two months
 * produces false alarms every summer. This is a smoke detector, not an SLA.
 */
const STALE_DAYS = 60;

function days(from: string | null, to: Date): number | null {
  if (!from) return null;
  const parsed = Date.parse(from);
  return Number.isNaN(parsed) ? null : Math.floor((to.getTime() - parsed) / 86_400_000);
}

const scalar = (db: Db, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...(params as never[])) as { n: number }).n;

export function status(db: Db, jurisdiction: string, now = new Date()): StatusReport {
  const sourceRows = db
    .prepare(
      `SELECT s.id, s.label, s.enabled, s.last_fetch_at, s.last_status, s.last_error,
              (SELECT count(*) FROM events e WHERE e.source_id = s.id) AS events,
              (SELECT max(e.first_seen_at) FROM events e WHERE e.source_id = s.id) AS last_new_at
         FROM sources s
        WHERE s.jurisdiction = ?
        ORDER BY s.enabled DESC, s.label`,
    )
    .all(jurisdiction) as unknown as {
    id: string;
    label: string;
    enabled: number;
    last_fetch_at: string | null;
    last_status: number | null;
    last_error: string | null;
    events: number;
    last_new_at: string | null;
  }[];

  const sources: SourceStatus[] = sourceRows.map((row) => {
    const staleDays = days(row.last_new_at, now);
    return {
      sourceId: row.id,
      label: row.label,
      enabled: Boolean(row.enabled),
      lastFetchAt: row.last_fetch_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
      events: row.events,
      lastNewAt: row.last_new_at,
      staleDays,
      // A disabled source is not stale, it is off. A source that has never
      // produced anything is a registry problem, reported separately.
      stale: Boolean(row.enabled) && staleDays !== null && staleDays > STALE_DAYS,
    };
  });

  const problems: string[] = [];
  const warnings: string[] = [];

  /**
   * Whether this town is supposed to be producing anything yet.
   *
   * A town can sit in the registry for a long time with every source disabled,
   * waiting for someone to run `discover` and `verify` against its site. That
   * is a normal state, not a fault, and grading it against a live town's
   * expectations would put a permanent red light on a scheduled run — which is
   * the same as having no red light at all. So a dormant town reports its
   * counts and nothing else.
   *
   * A jurisdiction the registry does not know is *not* dormant. It has no
   * sources for a different reason, and that reason is worth saying out loud.
   */
  const dormant =
    hasJurisdiction(jurisdiction) && !loadSources(jurisdiction).some((source) => source.enabled);

  // A database where nothing has ever been fetched is not seventeen broken
  // sources, it is an install that has not been run yet — and saying so once is
  // the difference between a useful alarm and a wall of noise nobody reads.
  const everRun = sources.some((source) => source.lastFetchAt);

  if (dormant) {
    // Nothing to say about a town nobody has enabled yet.
  } else if (!everRun) {
    problems.push('no source has ever been fetched — run `npm run ingest`');
  } else {
    for (const source of sources.filter((s) => s.enabled)) {
      if (source.lastError) problems.push(`${source.sourceId}: last fetch failed — ${source.lastError}`);
      else if (source.lastStatus && source.lastStatus >= 400) {
        problems.push(`${source.sourceId}: HTTP ${source.lastStatus}`);
      }
      if (!source.lastFetchAt) problems.push(`${source.sourceId}: never fetched`);
      else if (source.events === 0) {
        warnings.push(`${source.sourceId}: answered but has produced no records`);
      } else if (source.stale) warnings.push(`${source.sourceId}: nothing new in ${source.staleDays} days`);
    }
  }

  if (!dormant && !sources.length) {
    problems.push(
      hasJurisdiction(jurisdiction)
        ? `${jurisdiction}: registered with enabled sources, but none are in the database — ` +
            `run \`npm run ingest -- --jurisdiction ${jurisdiction}\``
        : `${jurisdiction}: not in the registry — nothing will ever be fetched for it`,
    );
  }

  const outline = loadBoundary(jurisdiction);
  if (!outline && !dormant) {
    problems.push(
      `${jurisdiction}: no town outline committed — geocoding falls back to a bounding box that ` +
        'accepts neighbouring towns. Run `npm run boundary`.',
    );
  }

  const orphans = orphanJurisdictions(db);
  for (const orphan of orphans) {
    problems.push(
      `${orphan.jurisdiction}: ${orphan.events} record(s) for a town the registry no longer knows — ` +
        `re-register it, or drop it with \`clear --jurisdiction ${orphan.jurisdiction} --scope town\``,
    );
  }

  /**
   * Source rows this town no longer registers.
   *
   * Reported rather than removed. A source id is a foreign key with
   * `ON DELETE CASCADE`, so deleting the row would take every record it ever
   * produced with it — which is right for a source that was dropped and wrong
   * for one that was renamed. A rename belongs in `migrate.ts`; this is here so
   * the difference is noticed rather than discovered.
   */
  const registeredIds = new Set(loadSources(jurisdiction).map((source) => source.id));
  // Skipped for a jurisdiction the registry does not know at all: every one of
  // its sources would be an orphan, and it already has a problem of its own.
  const orphanSources = hasJurisdiction(jurisdiction)
    ? sources.filter((source) => !registeredIds.has(source.sourceId))
    : [];
  for (const source of orphanSources) {
    problems.push(
      `${source.sourceId}: in the database but not in the registry, holding ${source.events} record(s) — ` +
        'renamed sources belong in `migrate.ts`; dropping the row would drop its records',
    );
  }

  const addressMatters = scalar(
    db,
    "SELECT count(*) AS n FROM matters WHERE kind='address' AND jurisdiction=?",
    jurisdiction,
  );
  const placed = scalar(
    db,
    `SELECT count(*) AS n FROM places p JOIN matters m ON m.id = p.matter_id
      WHERE p.lat IS NOT NULL AND m.jurisdiction = ?`,
    jurisdiction,
  );

  return {
    jurisdiction,
    label: getProfile(jurisdiction).label,
    generatedAt: now.toISOString(),
    events: scalar(db, 'SELECT count(*) AS n FROM events WHERE jurisdiction = ?', jurisdiction),
    matters: scalar(db, 'SELECT count(*) AS n FROM matters WHERE jurisdiction = ?', jurisdiction),
    placed: { resolved: placed, total: addressMatters },
    interpretations: countInterpretations(db, jurisdiction),
    documentsExtracted: scalar(
      db,
      'SELECT count(*) AS n FROM events WHERE jurisdiction = ? AND extracted_at IS NOT NULL',
      jurisdiction,
    ),
    documentsPending: scalar(
      db,
      `SELECT count(*) AS n FROM events
        WHERE jurisdiction = ? AND document_url IS NOT NULL AND extracted_at IS NULL`,
      jurisdiction,
    ),
    boundary: outline
      ? {
          present: true,
          points: outline.polygons.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0),
          retrieved: outline.retrieved,
        }
      : null,
    orphans,
    orphanSources: orphanSources.map((source) => source.sourceId),
    sources,
    problems,
    warnings,
    ok: problems.length === 0,
  };
}
