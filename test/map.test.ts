import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { listPlacedMatters, listUnplacedMatters } from '../src/db/repo.ts';
import { GEOCODER_CACHE_VERSION, geocodeMatters, geocodeQueries } from '../src/pipeline/geocode.ts';
import { censusUrl, parseCensusResponse } from '../src/geo/census.ts';
import { fitBox, project, scaleBar, viewportFor, withinBox } from '../src/geo/project.ts';
import { miltonProfile } from '../src/registry/index.ts';
import { normalizeAddress } from '../src/matters/key.ts';

/** The town's declared fence, which now lives on its profile rather than in geo/. */
const MILTON_BBOX = miltonProfile.bbox;
import { renderMapSvg } from '../src/web/map.ts';

describe('projection', () => {
  it('corrects for longitude being shorter than latitude at this latitude', () => {
    // A square in degrees is not a square on the ground. At 42°N a degree of
    // longitude is about three quarters of a degree of latitude, so a box with
    // equal degree spans must render taller than it is wide.
    const viewport = viewportFor({ south: 42.2, west: -71.1, north: 42.3, east: -71.0 }, 900);
    expect(viewport.height).toBeGreaterThan(900);
  });

  it('puts the north-west corner at the origin and south-east at the far corner', () => {
    const box = { south: 42.2, west: -71.1, north: 42.3, east: -71.0 };
    const viewport = viewportFor(box, 900);
    expect(project({ lat: box.north, lon: box.west }, viewport)).toEqual({ x: 0, y: 0 });

    const far = project({ lat: box.south, lon: box.east }, viewport);
    expect(far.x).toBeCloseTo(900, 5);
    expect(far.y).toBeCloseTo(viewport.height, 5);
  });

  it('gives a single point a real extent instead of dividing by zero', () => {
    const box = fitBox([{ lat: 42.25, lon: -71.06 }]);
    expect(box).not.toBeNull();
    expect(box!.north).toBeGreaterThan(box!.south);
    expect(box!.east).toBeGreaterThan(box!.west);
    expect(Number.isFinite(viewportFor(box!, 900).height)).toBe(true);
  });

  it('gives a row of points along one street a real extent too', () => {
    const box = fitBox([
      { lat: 42.25, lon: -71.06 },
      { lat: 42.25, lon: -71.04 },
    ])!;
    expect(box.north).toBeGreaterThan(box.south);
  });

  it('keeps a north-south corridor from rendering as an unreadable ribbon', () => {
    // Everything on one road running the length of the town. Fitted tightly
    // this is a 1:20 box; at a fixed width that is a page-long sliver.
    const corridor = [42.21, 42.23, 42.25, 42.27, 42.29].map((lat) => ({ lat, lon: -71.06 }));
    const viewport = viewportFor(fitBox(corridor)!, 900);
    expect(viewport.height).toBeLessThan(900 / 0.8 + 1);
    // The points are all still inside the frame.
    for (const point of corridor) {
      const { x, y } = project(point, viewport);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(900);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(viewport.height);
    }
  });

  it('picks a scale bar that fits', () => {
    const bar = scaleBar(viewportFor(MILTON_BBOX, 900), 225);
    expect(bar.pixels).toBeLessThanOrEqual(225);
    expect(bar.metres).toBeGreaterThan(0);
  });

  it('fences out a Milton in the wrong state', () => {
    expect(withinBox({ lat: 42.25, lon: -71.06 }, MILTON_BBOX)).toBe(true);
    // Milton, Vermont.
    expect(withinBox({ lat: 44.64, lon: -73.11 }, MILTON_BBOX)).toBe(false);
  });
});

describe('census geocoder', () => {
  it('qualifies a bare street address with the town and state', () => {
    const url = new URL(censusUrl('271 Pleasant Street', 'Milton', 'MA'));
    expect(url.searchParams.get('address')).toBe('271 Pleasant Street, Milton, MA');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('reads x as longitude and y as latitude, not the other way round', () => {
    const body = JSON.stringify({
      result: {
        addressMatches: [
          {
            matchedAddress: '271 PLEASANT ST, MILTON, MA, 02186',
            coordinates: { x: -71.0812, y: 42.2494 },
          },
        ],
      },
    });
    expect(parseCensusResponse(body)).toEqual({
      lat: 42.2494,
      lon: -71.0812,
      matchedAddress: '271 PLEASANT ST, MILTON, MA, 02186',
    });
  });

  it('returns null rather than throwing on anything unexpected', () => {
    expect(parseCensusResponse('not json')).toBeNull();
    expect(parseCensusResponse('{}')).toBeNull();
    expect(parseCensusResponse(JSON.stringify({ result: { addressMatches: [] } }))).toBeNull();
  });
});

/* ----------------------------------------------------------------- geocoding */

let db: Db;

function matter(id: string, label: string, kind = 'address', eventCount = 2): void {
  db.prepare(
    `INSERT INTO matters (id, jurisdiction, kind, key, label, event_count, channels, updated_at)
     VALUES (?,'milton-ma',?,?,?,?,'["land-use"]','2026-01-01T00:00:00.000Z')`,
  ).run(id, kind, kind === 'address' ? normalizeAddress(label) : label.toLowerCase(), label, eventCount);
}

function respond(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: ok ? 200 : 500,
    })) as unknown as typeof fetch;
}

const match = (lat: number, lon: number, address = '271 PLEASANT ST, MILTON, MA') => ({
  result: { addressMatches: [{ matchedAddress: address, coordinates: { x: lon, y: lat } }] },
});

beforeEach(() => {
  db = openDb(':memory:');
});

describe('geocoding matters', () => {
  it('falls back to the normalized matter key when a display spelling misses', async () => {
    expect(geocodeQueries({ label: '39A Frothingham Street', key: '39 frothingham street' })).toEqual([
      '39A Frothingham Street',
      '39 frothingham street',
    ]);
    matter('m1', '39A Frothingham Street');
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      asked.push(url.searchParams.get('address')!);
      return new Response(
        JSON.stringify(asked.length === 1 ? { result: { addressMatches: [] } } : match(42.25, -71.06)),
      );
    }) as typeof fetch;

    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl,
    });

    expect(reports[0]!.ok).toBe(true);
    expect(asked).toEqual(['39A Frothingham Street, Milton, MA', '39 frothingham street, Milton, MA']);
    expect(db.prepare('SELECT query FROM geocodes WHERE lat IS NOT NULL').get()).toEqual({
      query: '39 frothingham street',
    });
  });

  it('stores a match and puts it on the map', async () => {
    matter('m1', '271 Pleasant Street');
    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl: respond(match(42.2494, -71.0812)),
    });

    expect(reports[0]!.ok).toBe(true);
    const [placed] = listPlacedMatters(db, 'milton-ma');
    expect(placed!.lat).toBeCloseTo(42.2494, 6);
    expect(placed!.channel).toBe('land-use');
  });

  it('rejects a confident answer in the wrong state', async () => {
    matter('m1', '271 Pleasant Street');
    // Milton, Vermont — the geocoder is happy, and it is the wrong town.
    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl: respond(match(44.6395, -73.1101)),
    });

    expect(reports[0]!.ok).toBe(false);
    expect(reports[0]!.error).toContain('outside Milton');
    expect(listPlacedMatters(db, 'milton-ma')).toHaveLength(0);
    // Named on the map page rather than silently missing.
    expect(listUnplacedMatters(db, 'milton-ma')[0]!.failure).toContain('outside Milton');
  });

  it('caches a definite miss so the service is not asked twice', async () => {
    matter('m1', '271 Pleasant Street');
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify({ result: { addressMatches: [] } }));
    }) as unknown as typeof fetch;

    await geocodeMatters(db, { jurisdiction: 'milton-ma', delayMs: 0, fetchImpl: counting });
    await geocodeMatters(db, { jurisdiction: 'milton-ma', delayMs: 0, fetchImpl: counting });
    expect(calls).toBe(1);
    expect(listUnplacedMatters(db, 'milton-ma')[0]!.failureCode).toBe('no_match');
  });

  it('retries an old-version miss but keeps successful coordinates forever', async () => {
    matter('miss', '271 Pleasant Street');
    matter('hit', '10 Main Street');
    db.prepare(
      `INSERT INTO geocodes
         (jurisdiction, key, query, provider, lat, lon, failure, failure_code, cache_version, retrieved_at)
       VALUES
         ('milton-ma','271 pleasant street','271 Pleasant Street','none',NULL,NULL,
          'no match','no_match',?,'2026-01-01'),
         ('milton-ma','10 main street','10 Main Street','census',42.25,-71.06,
          NULL,NULL,1,'2026-01-01')`,
    ).run(GEOCODER_CACHE_VERSION - 1);
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify(match(42.2494, -71.0812)));
    }) as typeof fetch;

    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]!.label).toBe('271 Pleasant Street');
    expect(asked[0]).toContain('271+Pleasant+Street');
  });

  it('does not cache a transient failure, so an outage is not permanent', async () => {
    matter('m1', '271 Pleasant Street');
    const failing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await geocodeMatters(db, { jurisdiction: 'milton-ma', delayMs: 0, fetchImpl: failing });
    expect(db.prepare('SELECT count(*) AS n FROM places').get()).toEqual({ n: 0 });

    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl: respond(match(42.2494, -71.0812)),
    });
    expect(reports[0]!.ok).toBe(true);
  });

  it('does not let a failed forced lookup replace a known good point', async () => {
    matter('m1', '271 Pleasant Street');
    await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl: respond(match(42.2494, -71.0812)),
    });

    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      force: true,
      fetchImpl: respond({ result: { addressMatches: [] } }),
    });

    expect(reports[0]).toMatchObject({ ok: false, failureCode: 'no_match' });
    expect(listPlacedMatters(db, 'milton-ma')).toHaveLength(1);
  });

  it('only geocodes address matters', async () => {
    matter('m1', 'Article 14 (2026)', 'article');
    matter('m2', 'RFP26-14', 'bid');
    const reports = await geocodeMatters(db, {
      jurisdiction: 'milton-ma',
      delayMs: 0,
      fetchImpl: respond(match(42.2494, -71.0812)),
    });
    expect(reports).toHaveLength(0);
  });
});

describe('map rendering', () => {
  const point = (matterId: string, lat: number, lon: number, eventCount = 3) => ({
    matterId,
    label: `${matterId} Street`,
    lat,
    lon,
    eventCount,
    status: 'continued',
    channel: 'land-use',
    matched: null,
  });

  it('draws a pin per point, linked to its timeline', () => {
    const svg = renderMapSvg({
      points: [point('a', 42.24, -71.08), point('b', 42.26, -71.05)],
      unplaced: [],
      totalAddresses: 2,
      geocoded: true,
    });
    expect(svg).toContain('href="/matter/a"');
    expect(svg).toContain('href="/matter/b"');
    expect(svg.match(/<circle/g)).toHaveLength(2);
  });

  it('makes a busier matter a bigger pin', () => {
    const svg = renderMapSvg({
      points: [point('a', 42.24, -71.08, 1), point('b', 42.26, -71.05, 16)],
      unplaced: [],
      totalAddresses: 2,
      geocoded: true,
    });
    const radii = [...svg.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii));
  });

  it('references nothing outside the page', () => {
    const svg = renderMapSvg({
      points: [point('a', 42.24, -71.08)],
      unplaced: [],
      totalAddresses: 1,
      geocoded: true,
    });
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('escapes a label rather than letting it into the markup', () => {
    const svg = renderMapSvg({
      points: [{ ...point('a', 42.24, -71.08), label: '1 <script>alert(1)</script> Street' }],
      unplaced: [],
      totalAddresses: 1,
      geocoded: true,
    });
    expect(svg).not.toContain('<script>');
  });
});
