import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { BOUNDARY_DIR, boundaryPath, loadBoundary, readPolygons } from '../geo/boundary.ts';
import type { Polygon } from '../geo/boundary.ts';
import { getProfile, hasJurisdiction } from '../registry/index.ts';
import type { BoundarySource } from '../registry/profile.ts';

/**
 * Refetch a town's outline from MassGIS.
 *
 * The boundary is committed, so this is a maintenance command rather than a
 * pipeline stage — the same shape as `discover`. It proposes; a human reads the
 * diff and commits it. Nothing in the running system calls it.
 *
 * MassGIS publishes every Massachusetts municipality in one layer, which is why
 * adding a second town costs one query rather than one asset pipeline. The town
 * name to query with lives on the jurisdiction profile, so a new town's outline
 * needs no edit here at all.
 */

export const MASSGIS_TOWNS =
  'https://arcgisserver.digital.mass.gov/arcgisserver/rest/services/AGOL/Census2020_Towns/FeatureServer/2';

export type { BoundarySource };

export interface BoundaryReport {
  jurisdiction: string;
  ok: boolean;
  file: string;
  polygons: number;
  points: number;
  bytes: number;
  landAreaSqM: number | null;
  /** What changed against what was already committed. */
  change: 'created' | 'updated' | 'unchanged';
  error?: string;
}

export function queryUrl(source: BoundarySource): string {
  const url = new URL(`${source.url ?? MASSGIS_TOWNS}/query`);
  url.searchParams.set('where', `TOWN20='${source.townName}'`);
  // INTPTLAT20/INTPTLON20 are the Census's own internal point — a coordinate it
  // guarantees falls inside the polygon, even for a crescent-shaped town where
  // the centroid would not. Kept because it is a free self-check: if
  // point-in-polygon ever says this point is outside, the geometry is broken.
  url.searchParams.set('outFields', 'TOWN20,TOWN_ID,GEOID20,ALAND20,AWATER20,INTPTLAT20,INTPTLON20');
  // WGS84, because everything downstream speaks latitude and longitude.
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'geojson');
  return url.toString();
}

interface FeatureCollection {
  features?: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } }[];
  error?: { message?: string };
}

/** Round to `places` decimals — 5 is about 1.1 m, finer than the source's own detail. */
export function roundPolygons(polygons: Polygon[], places = 5): Polygon[] {
  const f = 10 ** places;
  const r = (n: number) => Math.round(n * f) / f;
  return polygons.map((polygon) =>
    polygon.map((ring) => ring.map(([lon, lat]) => [r(lon), r(lat)] as [number, number])),
  );
}

/**
 * The Census internal point, as `[lon, lat]`.
 *
 * It arrives as signed zero-padded strings (`"+42.2415589"`, `"-071.0824369"`),
 * which `Number` handles, but the leading `+` and the three-digit longitude are
 * why this is not just a cast.
 */
export function interiorPoint(props: Record<string, unknown>): [number, number] | null {
  const read = (key: string): number | null => {
    const raw = props[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
    return Number.isFinite(value) ? value : null;
  };
  const lat = read('INTPTLAT20');
  const lon = read('INTPTLON20');
  return lat === null || lon === null ? null : [lon, lat];
}

export interface FetchBoundaryOptions {
  jurisdiction?: string;
  fetchImpl?: typeof fetch;
  /** Report what would change without writing. */
  dryRun?: boolean;
  now?: Date;
}

export async function fetchBoundary(options: FetchBoundaryOptions = {}): Promise<BoundaryReport> {
  const jurisdiction = options.jurisdiction ?? config.defaultJurisdiction;
  const source = hasJurisdiction(jurisdiction) ? getProfile(jurisdiction).boundary : null;
  const file = boundaryPath(jurisdiction);

  const report: BoundaryReport = {
    jurisdiction,
    ok: false,
    file,
    polygons: 0,
    points: 0,
    bytes: 0,
    landAreaSqM: null,
    change: 'unchanged',
  };

  if (!source) {
    report.error =
      `No boundary source registered for "${jurisdiction}". Add a \`boundary\` to its profile in ` +
      'src/registry/ — for a Massachusetts town that is the name as MassGIS spells it, upper case.';
    return report;
  }

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(queryUrl(source), {
    headers: { 'user-agent': config.userAgent },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) {
    report.error = `HTTP ${response.status}`;
    return report;
  }

  const body = (await response.json()) as FeatureCollection;
  if (body.error) {
    report.error = body.error.message ?? 'the service returned an error';
    return report;
  }

  const feature = body.features?.[0];
  if (!feature) {
    report.error = `the layer has no feature matching TOWN20='${source.townName}'`;
    return report;
  }

  const polygons = roundPolygons(readPolygons(feature.geometry));
  if (!polygons.length) {
    report.error = 'the feature carried no usable polygon';
    return report;
  }

  const props = feature.properties ?? {};
  const num = (key: string) => (typeof props[key] === 'number' ? (props[key] as number) : null);
  const name = typeof props['TOWN20'] === 'string' ? (props['TOWN20'] as string) : source.townName;

  const output = {
    type: 'Feature',
    properties: {
      jurisdiction,
      name: name.charAt(0) + name.slice(1).toLowerCase(),
      source: 'MassGIS, Census 2020 Towns (AGOL/Census2020_Towns, layer 2)',
      sourceUrl: source.url ?? MASSGIS_TOWNS,
      sourceQuery: `TOWN20='${source.townName}'`,
      geoid: props['GEOID20'] ?? null,
      townId: props['TOWN_ID'] ?? null,
      landAreaSqM: num('ALAND20'),
      waterAreaSqM: num('AWATER20'),
      interiorPoint: interiorPoint(props),
      retrieved: (options.now ?? new Date()).toISOString().slice(0, 10),
      crs: 'EPSG:4326',
      coordinatePrecision: 5,
      // Every ring the source published is kept, including slivers. An area
      // threshold that dropped Milton's 18 m² artefact would also drop a real
      // island somewhere else, and a boundary that quietly loses land is worse
      // than one carrying a harmless speck.
      note: 'Verbatim from the source apart from coordinate rounding.',
    },
    geometry: { type: 'MultiPolygon', coordinates: polygons },
  };

  const serialized = `${JSON.stringify(output)}\n`;
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

  report.ok = true;
  report.polygons = polygons.length;
  report.points = polygons.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
  report.bytes = Buffer.byteLength(serialized);
  report.landAreaSqM = num('ALAND20');
  report.change = previous === null ? 'created' : previous === serialized ? 'unchanged' : 'updated';

  if (!options.dryRun && report.change !== 'unchanged') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serialized);
  }
  return report;
}

/** Every jurisdiction with a committed boundary, for `status` and the CLI. */
export function committedBoundaries(): { jurisdiction: string; points: number; retrieved: string }[] {
  if (!fs.existsSync(BOUNDARY_DIR)) return [];
  return fs
    .readdirSync(BOUNDARY_DIR)
    .filter((name) => name.endsWith('.geojson'))
    .map((name) => name.replace(/\.geojson$/, ''))
    .flatMap((jurisdiction) => {
      const boundary = loadBoundary(jurisdiction);
      if (!boundary) return [];
      const points = boundary.polygons.reduce(
        (n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0),
        0,
      );
      return [{ jurisdiction, points, retrieved: boundary.retrieved }];
    });
}
