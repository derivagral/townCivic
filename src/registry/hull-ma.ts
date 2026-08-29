import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';

/**
 * Hull, Massachusetts — registered, not yet confirmed.
 *
 * See `weymouth-ma.ts` for what "registered, not yet confirmed" means and for
 * the three commands that promote a town out of it. The short version: the two
 * sources below are platform paths that are identical on every CivicPlus
 * install, nothing here has been fetched, and everything ships disabled.
 *
 * Hull is the useful second town to get right, for two reasons that have
 * nothing to do with software. It is small enough that one board's agendas are
 * a meaningful fraction of the town's whole public record, and its finance
 * committee is called the Advisory Board — a name Milton's rules would have
 * filed under `meetings` rather than `money`, which is why that spelling is in
 * `DEFAULT_BODY_RULES` rather than in one town's file.
 */

export const HULL_BASE = 'https://www.town.hull.ma.us';

export const hullProfile = defineJurisdiction({
  id: 'hull-ma',
  name: 'Hull',
  baseUrl: HULL_BASE,
  boundary: { provider: 'massgis', townName: 'HULL' },
  // Provisional; replaced by the MassGIS outline on the first `boundary` run.
  // Hull is a barrier peninsula, so its outline is long, thin and full of
  // water — precisely the case where a rectangle is a bad fence and the real
  // polygon earns its keep.
  bbox: { south: 42.24, west: -70.96, north: 42.33, east: -70.84 },
  bodyAliases: {
    'advisory board': 'Advisory Board',
    'board of selectman': 'Select Board',
  },
  notes: 'Registered from platform URL shapes only. Run `discover` and `verify` before enabling.',
});

hullProfile.sources = civicPlusSources(hullProfile, {
  modules: {},
  agendaCategories: [],
  bids: true,
  confidence: 'unverified',
  enabled: false,
});
