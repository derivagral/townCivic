import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { censusUrl, parseCensusResponse } from '../geo/census.ts';
import { withinBox } from '../geo/project.ts';
import type { BoundingBox } from '../geo/project.ts';
import { loadBoundary, pointInBoundary } from '../geo/boundary.ts';
import type { Boundary } from '../geo/boundary.ts';
import { getProfile } from '../registry/index.ts';

/**
 * Resolve address matters to coordinates, once each, and remember the answer.
 *
 * This is the only stage that talks to anyone other than the town, so it is
 * separate from the rest and off the default path: nothing else needs the
 * network to work. Results are cached permanently — a street address does not
 * move — and failures are cached too, so an address the geocoder cannot parse
 * is asked about once rather than on every run.
 *
 * The town, the state and the fence all come from the matter's own
 * jurisdiction. That is not tidiness: "271 Pleasant Street" exists in most of
 * these towns, so qualifying it with the wrong town name does not fail — it
 * confidently returns a house a reader has never heard of. Each answer is then
 * checked against that town's outline before it is kept.
 */

export interface GeocodeOptions {
  jurisdiction?: string;
  /**
   * Override the town and state a bare street address is qualified with.
   * Normally read from the matter's jurisdiction; a single value only makes
   * sense for a single-town run.
   */
  town?: string;
  state?: string;
  /**
   * Reject results outside the town's own outline. Defaults to the committed
   * boundary for each matter's jurisdiction, and falls back to `box` where none
   * exists.
   */
  boundary?: Boundary | null;
  /** The fence used when there is no boundary for a jurisdiction. */
  box?: BoundingBox;
  /** Re-resolve matters that already have a place. */
  force?: boolean;
  limit?: number;
  /** Pause between requests. Defaults to the same politeness delay as the crawler. */
  delayMs?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (report: GeocodeReport) => void;
}

export interface GeocodeReport {
  matterId: string;
  label: string;
  ok: boolean;
  lat?: number;
  lon?: number;
  matched?: string;
  error?: string;
}

interface Candidate {
  id: string;
  label: string;
  key: string;
  jurisdiction: string;
}

/**
 * Address matters this run should ask about.
 *
 * The `NOT EXISTS` is against `geocodes`, not `places`: an answer already in the
 * cache is an answer, whether or not the matter it was asked for still exists.
 * Selecting on `places` is what made every `link` rebuild re-ask the geocoder
 * for the whole town.
 */
function selectCandidates(db: Db, options: GeocodeOptions): Candidate[] {
  const conditions = ["m.kind = 'address'"];
  const params: unknown[] = [];
  if (options.jurisdiction) {
    conditions.push('m.jurisdiction = ?');
    params.push(options.jurisdiction);
  }
  if (!options.force) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM geocodes g WHERE g.jurisdiction = m.jurisdiction AND g.key = m.key)`,
    );
  }

  // Busiest first: if a run is cut short, the properties the town is actually
  // arguing about are the ones that got resolved.
  return db
    .prepare(
      `SELECT m.id, m.label, m.key, m.jurisdiction
         FROM matters m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.event_count DESC, m.last_at DESC
        LIMIT ?`,
    )
    .all(...(params as never[]), options.limit ?? 200) as unknown as Candidate[];
}

interface Answer {
  lat: number | null;
  lon: number | null;
  matched: string | null;
  failure: string | null;
}

/**
 * Write what the geocoder said, to the cache and to the map.
 *
 * Two writes on purpose. `geocodes` is the answer to a question about an
 * address and outlives every rebuild of the matters; `places` is where that
 * answer lands for the matter that happens to be asking today.
 */
function record(db: Db, candidate: Candidate, answer: Answer): void {
  const now = new Date().toISOString();
  const provider = answer.lat === null ? 'none' : 'census';

  db.prepare(
    `INSERT INTO geocodes (jurisdiction, key, query, provider, lat, lon, matched, failure, retrieved_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(jurisdiction, key, provider) DO UPDATE SET
       query = excluded.query, lat = excluded.lat, lon = excluded.lon, matched = excluded.matched,
       failure = excluded.failure, retrieved_at = excluded.retrieved_at`,
  ).run(
    candidate.jurisdiction,
    candidate.key,
    candidate.label,
    provider,
    answer.lat,
    answer.lon,
    answer.matched,
    answer.failure,
    now,
  );

  db.prepare(
    `INSERT INTO places (matter_id, lat, lon, matched, provider, failure, geocoded_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(matter_id) DO UPDATE SET
       lat = excluded.lat, lon = excluded.lon, matched = excluded.matched,
       provider = excluded.provider, failure = excluded.failure, geocoded_at = excluded.geocoded_at`,
  ).run(candidate.id, answer.lat, answer.lon, answer.matched, provider, answer.failure, now);
}

/**
 * Fill `places` from what the geocoder has already been asked.
 *
 * Called by `link` after it rebuilds a town's matters, which is what keeps the
 * map from emptying on every run. Pure database work: no network, no provider,
 * and safe to call as often as you like.
 */
export function placeFromCache(db: Db, jurisdiction?: string): number {
  const where = jurisdiction ? 'AND m.jurisdiction = ?' : '';
  const params = (jurisdiction ? [jurisdiction] : []) as never[];
  const before = (db.prepare('SELECT count(*) AS n FROM places').get() as { n: number }).n;

  db.prepare(
    `INSERT INTO places (matter_id, lat, lon, matched, provider, failure, geocoded_at)
     SELECT m.id, g.lat, g.lon, g.matched, g.provider, g.failure, g.retrieved_at
       FROM matters m
       JOIN geocodes g ON g.jurisdiction = m.jurisdiction AND g.key = m.key
      WHERE m.kind = 'address' ${where}
     ON CONFLICT(matter_id) DO UPDATE SET
       lat = excluded.lat, lon = excluded.lon, matched = excluded.matched,
       provider = excluded.provider, failure = excluded.failure, geocoded_at = excluded.geocoded_at`,
  ).run(...params);

  return (db.prepare('SELECT count(*) AS n FROM places').get() as { n: number }).n - before;
}

/**
 * Everything that varies per town, resolved once and reused for every matter in
 * it — the outline in particular is a file read and a few thousand vertices.
 */
interface TownFence {
  town: string;
  state: string;
  inside(point: { lat: number; lon: number }): boolean;
}

export async function geocodeMatters(db: Db, options: GeocodeOptions = {}): Promise<GeocodeReport[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const fences = new Map<string, TownFence>();

  const fenceFor = (jurisdiction: string): TownFence => {
    const cached = fences.get(jurisdiction);
    if (cached) return cached;

    const profile = getProfile(jurisdiction);
    // The town's real outline where we have one; the declared rectangle only as
    // a fallback for a jurisdiction whose boundary has not been fetched yet.
    const boundary = options.boundary !== undefined ? options.boundary : loadBoundary(jurisdiction);
    const box = options.box ?? profile.bbox;

    const fence: TownFence = {
      town: options.town ?? profile.name,
      state: options.state ?? profile.state,
      inside: (point) => (boundary ? pointInBoundary(point, boundary) : withinBox(point, box)),
    };
    fences.set(jurisdiction, fence);
    return fence;
  };

  const reports: GeocodeReport[] = [];

  for (const candidate of selectCandidates(db, options)) {
    const report: GeocodeReport = { matterId: candidate.id, label: candidate.label, ok: false };
    const {
      town,
      state,
      inside: insideTown,
    } = fenceFor(candidate.jurisdiction || options.jurisdiction || config.defaultJurisdiction);

    try {
      const response = await doFetch(censusUrl(candidate.label, town, state), {
        headers: { 'user-agent': config.userAgent },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const match = parseCensusResponse(await response.text());
      if (!match) {
        report.error = 'no match';
        record(db, candidate, { lat: null, lon: null, matched: null, failure: 'no match' });
      } else if (!insideTown(match)) {
        // Two different mistakes this catches. There is a Milton in Vermont,
        // New Hampshire and Florida, so a geocoder can answer confidently about
        // the wrong state entirely. And these towns all border others — Milton
        // touches Boston, Quincy, Canton and Randolph — so a street that
        // continues over the line can resolve to a house that is not in this
        // town. Only the outline catches the second.
        report.error = `outside ${town} (${match.lat.toFixed(4)}, ${match.lon.toFixed(4)})`;
        record(db, candidate, {
          lat: null,
          lon: null,
          matched: match.matchedAddress,
          failure: report.error,
        });
      } else {
        record(db, candidate, {
          lat: match.lat,
          lon: match.lon,
          matched: match.matchedAddress,
          failure: null,
        });
        Object.assign(report, {
          ok: true,
          lat: match.lat,
          lon: match.lon,
          matched: match.matchedAddress,
        });
      }
    } catch (error) {
      // A transient failure is *not* cached — only a definite "no such address"
      // is, so an outage does not permanently blank half the map.
      report.error = error instanceof Error ? error.message : String(error);
    }

    reports.push(report);
    options.onProgress?.(report);
    const delay = options.delayMs ?? config.perHostDelayMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return reports;
}
