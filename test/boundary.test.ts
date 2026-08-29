import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.ts';
import {
  boundaryBox,
  boundarySvgPath,
  hasBoundary,
  loadBoundary,
  pointInBoundary,
  pointInPolygon,
  pointInRing,
  readPolygons,
} from '../src/geo/boundary.ts';
import type { Boundary, Ring } from '../src/geo/boundary.ts';
import { viewportFor, withinBox } from '../src/geo/project.ts';
import { miltonProfile } from '../src/registry/index.ts';

const MILTON_BBOX = miltonProfile.bbox;
import { interiorPoint, queryUrl, roundPolygons } from '../src/commands/boundary.ts';
import { geocodeMatters } from '../src/pipeline/geocode.ts';
import { listPlacedMatters, listUnplacedMatters } from '../src/db/repo.ts';
import { renderMapSvg } from '../src/web/map.ts';
import { status } from '../src/commands/status.ts';

/**
 * Anchors from the source itself.
 *
 * `INTPTLAT20`/`INTPTLON20` is a coordinate the Census guarantees falls inside
 * each town's own polygon, so these are ground truth rather than a coordinate
 * someone eyeballed off a map — which is exactly the mistake that made the
 * first draft of these tests wrong.
 */
const MILTON_INTERIOR = { lat: 42.2415589, lon: -71.0824369 };
const NEIGHBOURS = {
  Canton: { lat: 42.1757371, lon: -71.1253849 },
  Quincy: { lat: 42.261_0059, lon: -71.0089876 },
  Boston: { lat: 42.3385513, lon: -71.018253 },
};
/** There are several other Miltons. This one is in Vermont. */
const MILTON_VT = { lat: 44.6395, lon: -73.1101 };

const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

describe('the committed Milton boundary', () => {
  const boundary = loadBoundary('milton-ma');

  it('is present and says where it came from', () => {
    expect(hasBoundary('milton-ma')).toBe(true);
    expect(boundary).not.toBeNull();
    expect(boundary!.source).toMatch(/MassGIS/);
    expect(boundary!.sourceUrl).toMatch(/^https:\/\//);
    expect(boundary!.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the land area the source reports, within the projection’s slop', () => {
    // 13.01 sq mi. If a ring were dropped or mis-wound this would be far off.
    expect(boundary!.landAreaSqM).toBeGreaterThan(33_000_000);
    expect(boundary!.landAreaSqM).toBeLessThan(34_500_000);
  });

  it('contains the Census internal point for Milton', () => {
    expect(pointInBoundary(MILTON_INTERIOR, boundary!)).toBe(true);
  });

  it('excludes every neighbouring town’s internal point', () => {
    for (const [name, point] of Object.entries(NEIGHBOURS)) {
      expect(pointInBoundary(point, boundary!), `${name} should be outside Milton`).toBe(false);
    }
  });

  it('excludes the other Miltons', () => {
    expect(pointInBoundary(MILTON_VT, boundary!)).toBe(false);
  });

  it('is a real fence, not a rectangle in disguise', () => {
    // The whole reason for the polygon: it covers about half its own bounding
    // box, so a box — even a perfectly tight one — accepts twice the town.
    const box = boundaryBox(boundary!);
    let inside = 0;
    let total = 0;
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 60; j++) {
        const lat = box.south + ((box.north - box.south) * (i + 0.5)) / 60;
        const lon = box.west + ((box.east - box.west) * (j + 0.5)) / 60;
        total++;
        if (pointInBoundary({ lat, lon }, boundary!)) inside++;
      }
    }
    expect(inside / total).toBeLessThan(0.7);
    expect(inside / total).toBeGreaterThan(0.3);
  });

  it('is tighter than the bounding box it replaces', () => {
    // Every neighbour's internal point is inside the old hand-written box, and
    // outside the polygon. That gap is the bug this fixes.
    for (const [name, point] of Object.entries(NEIGHBOURS)) {
      if (!withinBox(point, MILTON_BBOX)) continue;
      expect(pointInBoundary(point, boundary!), `${name} slipped through the old box`).toBe(false);
    }
    expect(withinBox(NEIGHBOURS.Quincy, MILTON_BBOX)).toBe(true);
  });

  it('derives its own bounding box instead of trusting a typed-in one', () => {
    const box = boundaryBox(boundary!);
    expect(box.south).toBeGreaterThan(MILTON_BBOX.south);
    expect(box.north).toBeLessThan(MILTON_BBOX.north);
    expect(box.west).toBeGreaterThan(MILTON_BBOX.west);
    expect(box.east).toBeLessThan(MILTON_BBOX.east);
  });
});

describe('point in polygon', () => {
  it('handles a simple ring', () => {
    const ring = square(0, 0, 10, 10);
    expect(pointInRing({ lat: 5, lon: 5 }, ring)).toBe(true);
    expect(pointInRing({ lat: 15, lon: 5 }, ring)).toBe(false);
    expect(pointInRing({ lat: 5, lon: -5 }, ring)).toBe(false);
  });

  it('treats a hole as outside', () => {
    // A town with a doughnut in it. Massachusetts has a few.
    const polygon = [square(0, 0, 10, 10), square(4, 4, 6, 6)];
    expect(pointInPolygon({ lat: 1, lon: 1 }, polygon)).toBe(true);
    expect(pointInPolygon({ lat: 5, lon: 5 }, polygon)).toBe(false);
  });

  it('handles a town in two pieces', () => {
    const boundary: Boundary = {
      jurisdiction: 't',
      name: 'T',
      source: '',
      sourceUrl: '',
      retrieved: '',
      landAreaSqM: null,
      polygons: [[square(0, 0, 2, 2)], [square(10, 10, 12, 12)]],
    };
    expect(pointInBoundary({ lat: 1, lon: 1 }, boundary)).toBe(true);
    expect(pointInBoundary({ lat: 11, lon: 11 }, boundary)).toBe(true);
    expect(pointInBoundary({ lat: 6, lon: 6 }, boundary)).toBe(false);
  });
});

describe('reading source geometry', () => {
  it('accepts a Polygon and a MultiPolygon alike', () => {
    const ring = square(0, 0, 1, 1);
    expect(readPolygons({ type: 'Polygon', coordinates: [ring] })).toHaveLength(1);
    expect(readPolygons({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })).toHaveLength(2);
  });

  it('discards malformed rings rather than throwing', () => {
    expect(readPolygons(undefined)).toEqual([]);
    expect(readPolygons({ type: 'Polygon', coordinates: 'nope' })).toEqual([]);
    expect(
      readPolygons({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
    ).toEqual([]);
    expect(
      readPolygons({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            ['x', 1],
            [0, 1],
            [0, 0],
          ],
        ],
      }),
    ).toEqual([]);
  });

  it('keeps a tiny ring, because a threshold would delete a real island', () => {
    // Milton's second polygon is an 18 m² Census artefact. Harmless — and any
    // rule that removed it would also remove a genuine islet elsewhere.
    expect(loadBoundary('milton-ma')!.polygons).toHaveLength(2);
  });

  it('returns null for a jurisdiction with no boundary', () => {
    expect(loadBoundary('nowhere-zz')).toBeNull();
    expect(hasBoundary('nowhere-zz')).toBe(false);
  });
});

describe('the boundary refresh command', () => {
  it('asks MassGIS for one town in WGS84', () => {
    const url = new URL(queryUrl({ provider: 'massgis', townName: 'MILTON' }));
    expect(url.searchParams.get('where')).toBe("TOWN20='MILTON'");
    expect(url.searchParams.get('outSR')).toBe('4326');
    expect(url.searchParams.get('f')).toBe('geojson');
    expect(url.searchParams.get('outFields')).toContain('INTPTLAT20');
  });

  it('parses the Census internal point out of its padded string form', () => {
    expect(interiorPoint({ INTPTLAT20: '+42.2415589', INTPTLON20: '-071.0824369' })).toEqual([
      -71.0824369, 42.2415589,
    ]);
    expect(interiorPoint({})).toBeNull();
    expect(interiorPoint({ INTPTLAT20: 'x', INTPTLON20: 'y' })).toBeNull();
  });

  it('rounds coordinates without moving them meaningfully', () => {
    const [poly] = roundPolygons([
      [
        [
          [-71.049945582546, 42.277348657484],
          [1, 1],
          [2, 2],
          [-71.049945582546, 42.277348657484],
        ],
      ],
    ]);
    expect(poly![0]![0]).toEqual([-71.04995, 42.27735]);
  });
});

describe('the geocoding fence', () => {
  const respond = (lat: number, lon: number): typeof fetch =>
    (async () =>
      new Response(
        JSON.stringify({
          result: { addressMatches: [{ matchedAddress: 'SOMEWHERE', coordinates: { x: lon, y: lat } }] },
        }),
      )) as unknown as typeof fetch;

  const withMatter = () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO matters (id, jurisdiction, kind, key, label, event_count, channels, updated_at)
       VALUES ('m1','milton-ma','address','x','1 Somewhere Street',2,'["land-use"]','2026-01-01T00:00:00.000Z')`,
    ).run();
    return db;
  };

  it('accepts a point inside the town', async () => {
    const db = withMatter();
    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl: respond(MILTON_INTERIOR.lat, MILTON_INTERIOR.lon),
    });
    expect(reports[0]!.ok).toBe(true);
    expect(listPlacedMatters(db, 'milton-ma')).toHaveLength(1);
  });

  it('rejects a neighbouring town the old rectangle would have accepted', async () => {
    // Quincy's internal point is inside MILTON_BBOX. This is the regression.
    expect(withinBox(NEIGHBOURS.Quincy, MILTON_BBOX)).toBe(true);

    const db = withMatter();
    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl: respond(NEIGHBOURS.Quincy.lat, NEIGHBOURS.Quincy.lon),
    });
    expect(reports[0]!.ok).toBe(false);
    expect(reports[0]!.error).toContain('outside Milton');
    expect(listUnplacedMatters(db, 'milton-ma')[0]!.failure).toContain('outside Milton');
  });

  it('still rejects the wrong state entirely', async () => {
    const db = withMatter();
    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl: respond(MILTON_VT.lat, MILTON_VT.lon),
    });
    expect(reports[0]!.ok).toBe(false);
  });

  it('falls back to the rectangle when a town has no committed outline', async () => {
    const db = withMatter();
    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      boundary: null, // stand in for a town whose boundary has not been fetched
      delayMs: 0,
      fetchImpl: respond(NEIGHBOURS.Quincy.lat, NEIGHBOURS.Quincy.lon),
    });
    // Inside the box, so the looser fence lets it through — which is exactly
    // why `status` complains when a boundary is missing.
    expect(reports[0]!.ok).toBe(true);
  });
});

describe('the map', () => {
  const boundary = loadBoundary('milton-ma')!;
  const base = { points: [], unplaced: [], totalAddresses: 0, geocoded: false };

  it('draws the outline as one path with no external requests', () => {
    const svg = renderMapSvg({ ...base, boundary });
    expect(svg).toContain('class="townline"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('emits one subpath per ring, so holes can render as holes', () => {
    const svg = renderMapSvg({ ...base, boundary });
    const d = /class="townline" d="([^"]*)"/.exec(svg)?.[1] ?? '';
    expect((d.match(/M/g) ?? []).length).toBe(2); // Milton has two rings
    expect(d.endsWith('Z')).toBe(true);
  });

  it('frames the whole town rather than zooming to a cluster of pins', () => {
    const cluster = [1, 2, 3].map((i) => ({
      matterId: `m${i}`,
      label: `${i} Short Street`,
      lat: 42.245 + i * 0.0002,
      lon: -71.075 + i * 0.0002,
      eventCount: 2,
      status: null,
      channel: 'land-use',
      matched: null,
    }));

    const framed = renderMapSvg({ ...base, points: cluster, geocoded: true, boundary });
    const unframed = renderMapSvg({ ...base, points: cluster, geocoded: true });

    const scaleOf = (svg: string) => /<text x="24"[^>]*>([^<]+)</.exec(svg)?.[1] ?? '';
    // Three pins on one block should not read as the whole of Milton.
    expect(scaleOf(framed)).not.toBe(scaleOf(unframed));
    expect(scaleOf(framed)).toMatch(/km/);
  });

  it('has no outline to draw for a town without one', () => {
    expect(renderMapSvg(base)).not.toContain('townline');
  });
});

describe('status reports the outline', () => {
  it('counts it when present', () => {
    const db = openDb(':memory:');
    const report = status(db, 'milton-ma');
    expect(report.boundary?.present).toBe(true);
    expect(report.boundary!.points).toBeGreaterThan(800);
    expect(report.problems.join('\n')).not.toContain('no town outline');
  });

  it('flags its absence, because the fence silently loosens without it', () => {
    const db = openDb(':memory:');
    const report = status(db, 'nowhere-zz');
    expect(report.boundary).toBeNull();
    expect(report.problems.join('\n')).toContain('no town outline committed');
  });
});
