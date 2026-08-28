import type { Db } from '../db/index.ts';
import { loadBoundary } from '../geo/boundary.ts';

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
  generatedAt: string;
  events: number;
  matters: number;
  /** Address matters resolved to a point, over address matters in total. */
  placed: { resolved: number; total: number };
  interpretations: number;
  /**
   * How many records have had their civic impacts extracted, over how many
   * exist. This is the coverage whose absence is invisible: nothing errors, the
   * record stays complete, and For You quietly ranks against a stale reading.
   */
  impacts: { events: number; rows: number };
  documentsExtracted: number;
  documentsPending: number;
  /**
   * Whether this town's outline is committed. Without it `geocode` falls back
   * to a rectangle, which accepts addresses in neighbouring towns — worth
   * knowing before trusting the map.
   */
  boundary: { present: boolean; points: number; retrieved: string } | null;
  sources: SourceStatus[];
  /** Anything an operator should look at. Empty means healthy. */
  problems: string[];
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

  // A database where nothing has ever been fetched is not seventeen broken
  // sources, it is an install that has not been run yet — and saying so once is
  // the difference between a useful alarm and a wall of noise nobody reads.
  const everRun = sources.some((source) => source.lastFetchAt);

  if (!everRun) {
    problems.push('no source has ever been fetched — run `npm run ingest`');
  } else {
    for (const source of sources.filter((s) => s.enabled)) {
      if (source.lastError) problems.push(`${source.sourceId}: last fetch failed — ${source.lastError}`);
      else if (source.lastStatus && source.lastStatus >= 400) {
        problems.push(`${source.sourceId}: HTTP ${source.lastStatus}`);
      }
      if (!source.lastFetchAt) problems.push(`${source.sourceId}: never fetched`);
      else if (source.events === 0) {
        problems.push(`${source.sourceId}: answered but has produced no records`);
      } else if (source.stale) problems.push(`${source.sourceId}: nothing new in ${source.staleDays} days`);
    }
  }

  const outline = loadBoundary(jurisdiction);
  if (!outline) {
    problems.push(
      `${jurisdiction}: no town outline committed — geocoding falls back to a bounding box that ` +
        'accepts neighbouring towns. Run `npm run boundary`.',
    );
  }

  const impactedEvents = scalar(
    db,
    `SELECT count(DISTINCT i.event_id) AS n FROM event_impacts i
       JOIN events e ON e.id = i.event_id WHERE e.jurisdiction = ?`,
    jurisdiction,
  );
  const eventCount = scalar(db, 'SELECT count(*) AS n FROM events WHERE jurisdiction = ?', jurisdiction);

  // Never having run the stage is not a problem — it is optional, the same way
  // `interpret` is, and a database that has never been asked for impacts is an
  // install that has not opted in rather than one that is broken. Having run it
  // and drifted is different: that is a stage that silently stopped keeping up,
  // and For You is now ranking this week against last week's reading.
  if (impactedEvents > 0 && impactedEvents * 2 < eventCount) {
    problems.push(
      `${jurisdiction}: civic impacts cover ${impactedEvents} of ${eventCount} records — ` +
        'For You is ranking against an incomplete reading. Run `npm run impacts`.',
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
    generatedAt: now.toISOString(),
    events: eventCount,
    matters: scalar(db, 'SELECT count(*) AS n FROM matters WHERE jurisdiction = ?', jurisdiction),
    placed: { resolved: placed, total: addressMatters },
    interpretations: scalar(db, "SELECT count(*) AS n FROM interpretations WHERE text <> ''"),
    impacts: {
      events: impactedEvents,
      rows: scalar(
        db,
        `SELECT count(*) AS n FROM event_impacts i JOIN events e ON e.id = i.event_id
          WHERE e.jurisdiction = ?`,
        jurisdiction,
      ),
    },
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
    sources,
    problems,
    ok: problems.length === 0,
  };
}
