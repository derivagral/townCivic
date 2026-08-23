import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { censusUrl, parseCensusResponse } from '../geo/census.ts';
import { MILTON_BBOX, withinBox } from '../geo/project.ts';
import type { BoundingBox } from '../geo/project.ts';
import { loadBoundary, pointInBoundary } from '../geo/boundary.ts';
import type { Boundary } from '../geo/boundary.ts';

/**
 * Resolve address matters to coordinates, once each, and remember the answer.
 *
 * This is the only stage that talks to anyone other than the town, so it is
 * separate from the rest and off the default path: nothing else needs the
 * network to work. Results are cached permanently — a street address does not
 * move — and failures are cached too, so an address the geocoder cannot parse
 * is asked about once rather than on every run.
 */

export interface GeocodeOptions {
  jurisdiction?: string;
  /** Town and state to qualify a bare street address with. */
  town?: string;
  state?: string;
  /**
   * Reject results outside the town's own outline. Defaults to the committed
   * boundary for the jurisdiction, and falls back to `box` where none exists.
   */
  boundary?: Boundary | null;
  /** The fence used when there is no boundary for this jurisdiction. */
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
}

function selectCandidates(db: Db, options: GeocodeOptions): Candidate[] {
  const conditions = ["m.kind = 'address'"];
  const params: unknown[] = [];
  if (options.jurisdiction) {
    conditions.push('m.jurisdiction = ?');
    params.push(options.jurisdiction);
  }
  if (!options.force) conditions.push('p.matter_id IS NULL');

  // Busiest first: if a run is cut short, the properties the town is actually
  // arguing about are the ones that got resolved.
  return db
    .prepare(
      `SELECT m.id, m.label
         FROM matters m
         LEFT JOIN places p ON p.matter_id = m.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.event_count DESC, m.last_at DESC
        LIMIT ?`,
    )
    .all(...(params as never[]), options.limit ?? 200) as unknown as Candidate[];
}

function record(
  db: Db,
  matterId: string,
  place: { lat: number | null; lon: number | null; matched: string | null; failure: string | null },
): void {
  db.prepare(
    `INSERT INTO places (matter_id, lat, lon, matched, provider, failure, geocoded_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(matter_id) DO UPDATE SET
       lat = excluded.lat, lon = excluded.lon, matched = excluded.matched,
       provider = excluded.provider, failure = excluded.failure, geocoded_at = excluded.geocoded_at`,
  ).run(
    matterId,
    place.lat,
    place.lon,
    place.matched,
    place.lat === null ? 'none' : 'census',
    place.failure,
    new Date().toISOString(),
  );
}

export async function geocodeMatters(db: Db, options: GeocodeOptions = {}): Promise<GeocodeReport[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const box = options.box ?? MILTON_BBOX;
  const town = options.town ?? 'Milton';
  const state = options.state ?? 'MA';

  // The town's real outline where we have one; the rectangle only as a fallback
  // for a jurisdiction whose boundary has not been fetched yet.
  const boundary =
    options.boundary !== undefined
      ? options.boundary
      : loadBoundary(options.jurisdiction ?? config.defaultJurisdiction);

  const insideTown = (point: { lat: number; lon: number }) =>
    boundary ? pointInBoundary(point, boundary) : withinBox(point, box);

  const reports: GeocodeReport[] = [];

  for (const candidate of selectCandidates(db, options)) {
    const report: GeocodeReport = { matterId: candidate.id, label: candidate.label, ok: false };

    try {
      const response = await doFetch(censusUrl(candidate.label, town, state), {
        headers: { 'user-agent': config.userAgent },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const match = parseCensusResponse(await response.text());
      if (!match) {
        report.error = 'no match';
        record(db, candidate.id, { lat: null, lon: null, matched: null, failure: 'no match' });
      } else if (!insideTown(match)) {
        // Two different mistakes this catches. There is a Milton in Vermont,
        // New Hampshire and Florida, so a geocoder can answer confidently about
        // the wrong state entirely. And Milton borders Boston, Quincy, Canton
        // and Randolph, so a street that continues over the line can resolve to
        // a house that is not in this town. Only the outline catches the second.
        report.error = `outside ${town} (${match.lat.toFixed(4)}, ${match.lon.toFixed(4)})`;
        record(db, candidate.id, {
          lat: null,
          lon: null,
          matched: match.matchedAddress,
          failure: report.error,
        });
      } else {
        record(db, candidate.id, {
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
