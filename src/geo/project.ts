/**
 * Just enough map projection to draw a town.
 *
 * A municipality spans a couple of kilometres, so the choice of projection is
 * not the interesting question — at this scale everything is a rectangle. The
 * only correction that matters is that a degree of longitude is shorter than a
 * degree of latitude, by cos(latitude); without it a town comes out visibly
 * stretched east-west and two properties on the same street look further apart
 * than two on the same avenue.
 *
 * Nothing here knows about any particular town. A town's bounding box lives on
 * its profile in `src/registry/`, because it is data about a place rather than
 * about drawing.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function withinBox(point: LatLon, box: BoundingBox): boolean {
  return point.lat >= box.south && point.lat <= box.north && point.lon >= box.west && point.lon <= box.east;
}

/**
 * How far from landscape the drawn map is allowed to get, as ground
 * width ÷ ground height.
 *
 * A town's land-use activity is often strung along one corridor — a main road,
 * a river — and fitting a box tightly around that gives an aspect ratio like
 * 1:5. Rendered at a fixed width that is a page-long ribbon nobody can read, so
 * the narrow dimension is widened until the frame is a usable shape. It shows
 * more of the town than strictly necessary, which is the harmless direction.
 */
const MIN_ASPECT = 0.8;
const MAX_ASPECT = 2.0;

/** Grow a span symmetrically about its midpoint to at least `target`. */
function widen(low: number, high: number, target: number): [number, number] {
  if (high - low >= target) return [low, high];
  const mid = (low + high) / 2;
  return [mid - target / 2, mid + target / 2];
}

/** The smallest box containing every point, with a margin so nothing sits on the edge. */
export function fitBox(points: LatLon[], marginFraction = 0.08): BoundingBox | null {
  if (!points.length) return null;

  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  let [south, north] = [Math.min(...lats), Math.max(...lats)];
  let [west, east] = [Math.min(...lons), Math.max(...lons)];

  // A single point, or a row of them along one street, gives a zero-height or
  // zero-width box and a division by zero downstream. Give it a real extent.
  const minSpan = 0.004; // about 450 m
  [south, north] = widen(south, north, minSpan);
  [west, east] = widen(west, east, minSpan);

  const lonScale = Math.cos((((north + south) / 2) * Math.PI) / 180);
  const groundHeight = north - south;
  const groundWidth = (east - west) * lonScale;
  const aspect = groundWidth / groundHeight;

  if (aspect < MIN_ASPECT) {
    [west, east] = widen(west, east, (groundHeight * MIN_ASPECT) / lonScale);
  } else if (aspect > MAX_ASPECT) {
    [south, north] = widen(south, north, groundWidth / MAX_ASPECT);
  }

  const padLat = (north - south) * marginFraction;
  const padLon = (east - west) * marginFraction;
  return { south: south - padLat, west: west - padLon, north: north + padLat, east: east + padLon };
}

export interface Viewport {
  box: BoundingBox;
  width: number;
  height: number;
}

/**
 * Fit a bounding box into a viewport of a given width, returning the height
 * that keeps the aspect ratio honest at this latitude.
 */
export function viewportFor(box: BoundingBox, width: number): Viewport {
  const midLat = (box.north + box.south) / 2;
  const lonScale = Math.cos((midLat * Math.PI) / 180);
  const widthDegrees = (box.east - box.west) * lonScale;
  const heightDegrees = box.north - box.south;
  const height = widthDegrees > 0 ? (width * heightDegrees) / widthDegrees : width;
  return { box, width, height };
}

/** Project a point into viewport pixels. y grows downwards, as SVG expects. */
export function project(point: LatLon, viewport: Viewport): { x: number; y: number } {
  const { box, width, height } = viewport;
  const x = ((point.lon - box.west) / (box.east - box.west)) * width;
  const y = ((box.north - point.lat) / (box.north - box.south)) * height;
  return { x, y };
}

/** Round to a fixed number of decimals so the rendered SVG is diff-stable. */
export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * A rounded distance for the scale bar, in metres, that fits in `maxPixels`.
 *
 * Without a basemap the scale bar is the only thing telling a reader whether
 * two pins are neighbours or a mile apart, so it is not decoration.
 */
export function scaleBar(viewport: Viewport, maxPixels: number): { metres: number; pixels: number } {
  const midLat = (viewport.box.north + viewport.box.south) / 2;
  const metresPerDegreeLon = 111_320 * Math.cos((midLat * Math.PI) / 180);
  const metresAcross = (viewport.box.east - viewport.box.west) * metresPerDegreeLon;
  const metresPerPixel = metresAcross / viewport.width;

  const candidates = [100, 200, 250, 500, 1000, 2000, 5000];
  const fitting = candidates.filter((m) => m / metresPerPixel <= maxPixels);
  const metres = fitting.at(-1) ?? candidates[0]!;
  return { metres, pixels: metres / metresPerPixel };
}
