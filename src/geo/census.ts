import type { LatLon } from './project.ts';

/**
 * The US Census Bureau's geocoder.
 *
 * Chosen for the same reasons as everything else in this project: it is public
 * infrastructure, it is free, it needs no account and no API key, its results
 * are public domain, and its terms do not restrict caching — so a town's
 * addresses get resolved once and stored, and the service is asked nothing
 * twice. Commercial geocoders are more forgiving of messy input, but all of
 * them require a key and most forbid storing the coordinates.
 *
 * The obvious upgrade for Massachusetts is MassGIS, which publishes the
 * statewide parcel layer: that would resolve to a *parcel* rather than a point,
 * which is what a land-use record is actually about. This is the version that
 * works without downloading a shapefile.
 */

export const CENSUS_GEOCODER = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

export interface GeocodeMatch extends LatLon {
  /** The address as the geocoder understood it — worth storing to spot bad matches. */
  matchedAddress: string;
}

/** Build the request URL for one address, scoped to the town and state. */
export function censusUrl(address: string, town: string, state: string): string {
  const url = new URL(CENSUS_GEOCODER);
  url.searchParams.set('address', `${address}, ${town}, ${state}`);
  // `Public_AR_Current` is the current public address ranges benchmark.
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  return url.toString();
}

interface CensusResponse {
  result?: {
    addressMatches?: {
      matchedAddress?: string;
      coordinates?: { x?: number; y?: number };
    }[];
  };
}

/**
 * Read the first match out of a Census geocoder response.
 *
 * `x` is longitude and `y` is latitude — the opposite order to how they are
 * usually written, and a reliable source of maps of the Indian Ocean.
 */
export function parseCensusResponse(body: string): GeocodeMatch | null {
  let parsed: CensusResponse;
  try {
    parsed = JSON.parse(body) as CensusResponse;
  } catch {
    return null;
  }

  const match = parsed.result?.addressMatches?.[0];
  const lon = match?.coordinates?.x;
  const lat = match?.coordinates?.y;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return { lat, lon, matchedAddress: match?.matchedAddress ?? '' };
}
