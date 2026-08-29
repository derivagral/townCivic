import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';

/**
 * Scituate, Massachusetts — registered, not yet confirmed.
 *
 * See `weymouth-ma.ts` for what that means and how to promote it. Nothing here
 * has been fetched; the two sources are platform paths and ship disabled.
 */

export const SCITUATE_BASE = 'https://www.scituatema.gov';

export const scituateProfile = defineJurisdiction({
  id: 'scituate-ma',
  name: 'Scituate',
  baseUrl: SCITUATE_BASE,
  boundary: { provider: 'massgis', townName: 'SCITUATE' },
  // Provisional; replaced by the MassGIS outline on the first `boundary` run.
  bbox: { south: 42.14, west: -70.83, north: 42.26, east: -70.68 },
  notes: 'Registered from platform URL shapes only. Run `discover` and `verify` before enabling.',
});

scituateProfile.sources = civicPlusSources(scituateProfile, {
  modules: {},
  agendaCategories: [],
  bids: true,
  confidence: 'unverified',
  enabled: false,
});
