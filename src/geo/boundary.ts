import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoundingBox, LatLon, Viewport } from './project.ts';
import { project, round } from './project.ts';

/**
 * The town's actual shape, from the state's own GIS.
 *
 * Two things need this, and the second is the reason it is worth having:
 *
 *   1. The map draws it, so a reader can see where in Milton a property is
 *      rather than only where it is relative to other properties.
 *   2. `geocode` fences results against it. The fence used to be a hand-written
 *      rectangle, which overshot the real town by 3.6 km to the north and
 *      3.4 km to the east — far enough to accept an address in Mattapan or
 *      Quincy as Milton. A polygon does not have that problem.
 *
 * The boundary is committed rather than fetched at runtime. It is a few tens of
 * kilobytes, it changes about as often as the town's borders do, and a map that
 * needs a network call to draw its own frame is a map that breaks offline. It
 * is regenerable — `towncivic boundary` refetches it from MassGIS and reports
 * what changed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOUNDARY_DIR = path.join(HERE, '..', 'registry', 'boundaries');

/** `[lon, lat]`, the order GeoJSON uses — the opposite of how they are spoken. */
export type Position = [number, number];
/** A closed ring. The first ring of a polygon is its outline, the rest are holes. */
export type Ring = Position[];
export type Polygon = Ring[];

export interface Boundary {
  jurisdiction: string;
  name: string;
  source: string;
  sourceUrl: string;
  retrieved: string;
  /** Land area in square metres, as the source reports it. */
  landAreaSqM: number | null;
  polygons: Polygon[];
}

interface BoundaryFile {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
}

export function boundaryPath(jurisdiction: string): string {
  return path.join(BOUNDARY_DIR, `${jurisdiction}.geojson`);
}

export function hasBoundary(jurisdiction: string): boolean {
  return fs.existsSync(boundaryPath(jurisdiction));
}

/**
 * Read a committed boundary.
 *
 * Returns null rather than throwing when a town has none: a jurisdiction
 * without a boundary should degrade to the old rectangle, not fail to start.
 */
export function loadBoundary(jurisdiction: string): Boundary | null {
  const file = boundaryPath(jurisdiction);
  if (!fs.existsSync(file)) return null;

  let parsed: BoundaryFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BoundaryFile;
  } catch {
    return null;
  }

  const polygons = readPolygons(parsed.geometry);
  if (!polygons.length) return null;

  const props = parsed.properties ?? {};
  const str = (key: string, fallback: string) =>
    typeof props[key] === 'string' ? (props[key] as string) : fallback;

  return {
    jurisdiction: str('jurisdiction', jurisdiction),
    name: str('name', jurisdiction),
    source: str('source', 'unknown'),
    sourceUrl: str('sourceUrl', ''),
    retrieved: str('retrieved', ''),
    landAreaSqM: typeof props['landAreaSqM'] === 'number' ? (props['landAreaSqM'] as number) : null,
    polygons,
  };
}

/** Accept either a Polygon or a MultiPolygon, and normalise to a list of polygons. */
export function readPolygons(geometry: BoundaryFile['geometry']): Polygon[] {
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates)) return [];

  const polygons = geometry?.type === 'MultiPolygon' ? coordinates : [coordinates];
  const out: Polygon[] = [];

  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    const rings: Polygon = [];
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) continue;

      // One bad vertex discards the whole ring rather than the vertex. Skipping
      // it would keep a ring that is subtly the wrong shape, and a boundary that
      // quietly moved is worse than one that is visibly missing — the same
      // reflex as the adapters, which prefer "found nothing" to plausible
      // garbage.
      const points: Ring = [];
      let usable = true;
      for (const point of ring) {
        if (!Array.isArray(point) || point.length < 2) {
          usable = false;
          break;
        }
        const [lon, lat] = point as [unknown, unknown];
        if (typeof lon !== 'number' || typeof lat !== 'number') {
          usable = false;
          break;
        }
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
          usable = false;
          break;
        }
        points.push([lon, lat]);
      }
      if (usable && points.length >= 4) rings.push(points);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

/**
 * Is this point inside the town?
 *
 * Ray casting: count how many times a ray east from the point crosses the ring.
 * Odd means inside. A point inside a hole is outside the polygon, which is what
 * lets a town with a doughnut in it — Massachusetts has a few — work correctly.
 *
 * Points exactly on the border are not worth agonising over: a geocoder's answer
 * is metres-accurate at best, so a boundary case is already a coin toss. What
 * matters is that a point 3 km away is rejected.
 */
export function pointInRing(point: LatLon, ring: Ring): boolean {
  const { lat, lon } = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    // Does the edge straddle the point's latitude, and is the crossing east of it?
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(point: LatLon, polygon: Polygon): boolean {
  const [outer, ...holes] = polygon;
  if (!outer || !pointInRing(point, outer)) return false;
  return !holes.some((hole) => pointInRing(point, hole));
}

export function pointInBoundary(point: LatLon, boundary: Boundary): boolean {
  return boundary.polygons.some((polygon) => pointInPolygon(point, polygon));
}

/** The tightest box containing the boundary — no longer a number typed by hand. */
export function boundaryBox(boundary: Boundary): BoundingBox {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;

  for (const polygon of boundary.polygons) {
    for (const [lon, lat] of polygon[0] ?? []) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
  }
  return { south, west, north, east };
}

/**
 * The boundary as an SVG path.
 *
 * `fill-rule="evenodd"` on the element is what makes holes render as holes,
 * so every ring — outline and hole alike — is emitted the same way.
 */
export function boundarySvgPath(boundary: Boundary, viewport: Viewport): string {
  const parts: string[] = [];

  for (const polygon of boundary.polygons) {
    for (const ring of polygon) {
      const points = ring.map(([lon, lat]) => {
        const { x, y } = project({ lat, lon }, viewport);
        return `${round(x)},${round(y)}`;
      });
      if (points.length) parts.push(`M${points.join('L')}Z`);
    }
  }
  return parts.join('');
}
