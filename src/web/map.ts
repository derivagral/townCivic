import { escapeHtml } from './views.ts';
import { fitBox, project, round, scaleBar, viewportFor } from '../geo/project.ts';
import type { BoundingBox, LatLon } from '../geo/project.ts';
import { MASSACHUSETTS_BBOX } from '../registry/profile.ts';
import { boundaryBox, boundarySvgPath } from '../geo/boundary.ts';
import type { Boundary } from '../geo/boundary.ts';
import { CHANNEL_LABELS } from '../taxonomy.ts';
import type { Channel } from '../taxonomy.ts';
import { STAGE_LABELS, isStage } from '../matters/stages.ts';

/**
 * The map, as server-rendered SVG.
 *
 * No tiles, no JavaScript, no external requests. That is partly the project's
 * usual reflex — a page that works offline is a page that works in five years —
 * and partly honesty: this draws where the town's land-use records *are*, and a
 * borrowed street basemap would imply a precision the underlying geocoding does
 * not have. A pin is a geocoder's guess at a street address, not a parcel.
 *
 * The town's own outline, from MassGIS, is the exception and it is the thing
 * that makes the rest legible: a pin means far more against the shape of the
 * town than against an empty rectangle. It is a state GIS boundary rather than
 * a rendering of streets, so it says exactly as much as it knows.
 */

export interface MapPoint extends LatLon {
  matterId: string;
  label: string;
  eventCount: number;
  status: string | null;
  channel: string | null;
  matched: string | null;
}

export interface MapModel {
  points: MapPoint[];
  /** Address matters with no usable coordinates — named, not silently dropped. */
  unplaced: { matterId: string; label: string; reason: string | null }[];
  /** Total address matters, so the page can say what fraction is drawn. */
  totalAddresses: number;
  geocoded: boolean;
  /** The town outline. Absent for a jurisdiction whose boundary is not committed. */
  boundary?: Boundary | null;
  /**
   * The town's declared extent, used to frame the map when there is neither an
   * outline nor a single placed point — a town that has been registered but not
   * yet geocoded still gets a map of itself rather than a map of the state.
   */
  box?: BoundingBox;
  highlight?: string | undefined;
}

const CHANNEL_COLORS: Record<string, string> = {
  meetings: '#4a6fa5',
  'land-use': '#2f7d63',
  money: '#9a6b1f',
  law: '#6b4f9e',
  elections: '#a1483f',
  schools: '#2b7f92',
  'public-safety': '#8a5a2b',
  courts: '#5b5f6b',
  'state-federal': '#46738a',
  admin: '#7a7a72',
};

const WIDTH = 900;

/** Pin radius grows with the record count, by area rather than by radius. */
function radiusFor(eventCount: number): number {
  return round(4 + Math.sqrt(Math.max(0, eventCount - 1)) * 3.2, 1);
}

/** The two corners of a box, as points — enough for `fitBox` to pad and clamp. */
function cornersOf(box: { south: number; west: number; north: number; east: number }): LatLon[] {
  return [
    { lat: box.south, lon: box.west },
    { lat: box.north, lon: box.east },
  ];
}

/** Evenly spaced graticule lines at a round interval covering the span. */
function gridStep(span: number): number {
  for (const step of [0.002, 0.005, 0.01, 0.02, 0.05, 0.1]) {
    if (span / step <= 8) return step;
  }
  return 0.1;
}

export function renderMapSvg(model: MapModel): string {
  // With an outline, frame the whole town every time. That is the honest view:
  // a cluster of pins fitted tightly to itself looks like the whole town, and
  // the reader has no way to tell that it is three streets. Without one, fall
  // back to fitting the points and let the scale bar carry the meaning.
  const fallback = model.box ?? MASSACHUSETTS_BBOX;
  const box = model.boundary
    ? (fitBox(cornersOf(boundaryBox(model.boundary))) ?? fallback)
    : (fitBox(model.points) ?? fallback);
  const viewport = viewportFor(box, WIDTH);
  const height = round(viewport.height);

  const outline = model.boundary
    ? `<path class="townline" d="${boundarySvgPath(model.boundary, viewport)}" fill-rule="evenodd"></path>`
    : '';

  const latStep = gridStep(box.north - box.south);
  const lonStep = gridStep(box.east - box.west);

  const lines: string[] = [];
  for (let lat = Math.ceil(box.south / latStep) * latStep; lat < box.north; lat += latStep) {
    const y = round(project({ lat, lon: box.west }, viewport).y);
    lines.push(`<line class="grid" x1="0" y1="${y}" x2="${WIDTH}" y2="${y}"></line>`);
    lines.push(`<text class="gridlabel" x="6" y="${round(y - 4)}">${lat.toFixed(3)}°N</text>`);
  }
  for (let lon = Math.ceil(box.west / lonStep) * lonStep; lon < box.east; lon += lonStep) {
    const x = round(project({ lat: box.south, lon }, viewport).x);
    lines.push(`<line class="grid" x1="${x}" y1="0" x2="${x}" y2="${height}"></line>`);
    lines.push(
      `<text class="gridlabel" x="${round(x + 5)}" y="${round(height - 8)}">${lon.toFixed(3)}°</text>`,
    );
  }

  // Draw the biggest pins first so the small ones stay clickable on top.
  const pins = [...model.points]
    .sort((a, b) => b.eventCount - a.eventCount)
    .map((point) => {
      const { x, y } = project(point, viewport);
      const r = radiusFor(point.eventCount);
      const color = CHANNEL_COLORS[point.channel ?? ''] ?? '#5b5f6b';
      const on = model.highlight === point.matterId;
      const stage = point.status && isStage(point.status) ? STAGE_LABELS[point.status] : point.status;
      const title = `${point.label} — ${point.eventCount} record${point.eventCount === 1 ? '' : 's'}${
        stage ? ` · ${stage}` : ''
      }`;
      return `<a class="pin" href="/matter/${escapeHtml(point.matterId)}" aria-label="${escapeHtml(title)}">
  <title>${escapeHtml(title)}</title>
  <circle cx="${round(x)}" cy="${round(y)}" r="${on ? round(r + 4, 1) : r}" fill="${color}" fill-opacity="${on ? 1 : 0.82}"></circle>
</a>`;
    })
    .join('\n');

  const bar = scaleBar(viewport, WIDTH / 4);
  const barY = round(height - 24);
  const scale = `<g class="scalebar">
  <line x1="24" y1="${barY}" x2="${round(24 + bar.pixels)}" y2="${barY}"></line>
  <line x1="24" y1="${round(barY - 4)}" x2="24" y2="${round(barY + 4)}"></line>
  <line x1="${round(24 + bar.pixels)}" y1="${round(barY - 4)}" x2="${round(24 + bar.pixels)}" y2="${round(barY + 4)}"></line>
  <text x="24" y="${round(barY - 8)}">${bar.metres >= 1000 ? `${bar.metres / 1000} km` : `${bar.metres} m`}</text>
</g>`;

  return `<svg viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="Map of records by address" xmlns="http://www.w3.org/2000/svg">
  <style>
    .gridlabel { font: 10px ui-sans-serif, system-ui, sans-serif; fill: currentColor; opacity: 0.45; }
    .scalebar line { stroke: currentColor; stroke-width: 1.2; opacity: 0.7; }
    .scalebar text { font: 11px ui-sans-serif, system-ui, sans-serif; fill: currentColor; opacity: 0.7; }
  </style>
  <rect class="frame" x="0.5" y="0.5" width="${WIDTH - 1}" height="${round(height - 1)}" rx="8"></rect>
  ${lines.join('\n  ')}
  ${outline}
  ${pins}
  ${scale}
</svg>`;
}

/** The map page body, ready to hand to `layout`. */
export function renderMapBody(model: MapModel): string {
  // Before geocoding there are no pins, but with an outline there is still a
  // map — so draw the town and say what is missing, rather than showing a page
  // that looks broken. The outline needs no network; the pins do.
  if (!model.geocoded) {
    const explain = `<div class="detail"${model.boundary ? ' style="margin-bottom:0"' : ''}>
  <h1>Map</h1>
  <p>No address has been placed yet.${
    model.boundary ? ' The outline below is the town; the pins are what is missing.' : ''
  }</p>
  <p>Addresses become coordinates in their own stage, because it is the one part of the pipeline that
     asks a service other than the town anything. Run <code>npm run link</code> to group records into
     matters, then <code>npm run geocode</code> to resolve the addresses among them.</p>
</div>`;

    return model.boundary ? `${explain}\n<div class="mapwrap">${renderMapSvg(model)}</div>` : explain;
  }

  const channels = [...new Set(model.points.map((p) => p.channel).filter(Boolean))] as Channel[];
  const legend = channels
    .map(
      (channel) =>
        `<span><i style="background:${CHANNEL_COLORS[channel] ?? '#5b5f6b'}"></i>${escapeHtml(CHANNEL_LABELS[channel] ?? channel)}</span>`,
    )
    .join('');

  const unplaced = model.unplaced.length
    ? `<details class="detail" style="margin-top:18px">
  <summary>${model.unplaced.length} address${model.unplaced.length === 1 ? '' : 'es'} could not be placed</summary>
  <p class="count">Named rather than dropped, because an address missing from the map is a gap in it.</p>
  <ul>${model.unplaced
    .map(
      (item) =>
        `<li><a href="/matter/${escapeHtml(item.matterId)}">${escapeHtml(item.label)}</a>${
          item.reason ? ` <span class="count">— ${escapeHtml(item.reason)}</span>` : ''
        }</li>`,
    )
    .join('')}</ul>
</details>`
    : '';

  return `<div class="detail" style="margin-bottom:0">
  <h1>Map</h1>
  <p>Every property the town has a record about, sized by how many records mention it and coloured by
     channel. ${model.points.length} of ${model.totalAddresses} address${model.totalAddresses === 1 ? '' : 'es'}
     resolved to a point. Click a pin for that property's timeline.</p>
</div>
<div class="mapwrap">
  ${renderMapSvg(model)}
  <div class="maplegend">${legend}</div>
  ${
    model.boundary
      ? `<p class="count" style="margin:10px 0 0;font-size:12px">Town outline:
           ${escapeHtml(model.boundary.source)}${
             model.boundary.retrieved ? `, retrieved ${escapeHtml(model.boundary.retrieved)}` : ''
           }. It is a municipal boundary, not a rendering of streets.</p>`
      : ''
  }
  <p class="count" style="margin:10px 0 0;font-size:12px">Pins are a geocoder's reading of a street address,
     not a parcel boundary, and the grid is latitude and longitude rather than streets. Use them to see
     whether records cluster, not to identify a lot line.</p>
</div>
${unplaced}`;
}
