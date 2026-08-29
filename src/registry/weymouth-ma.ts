import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';
import type { AgendaCategory, CivicPlusModules } from './civicplus.ts';

/**
 * Weymouth, Massachusetts.
 *
 * Officially the Town of Weymouth, governed as a city: a mayor and a town
 * council rather than a select board and open town meeting. That is why the
 * statewide body rules know `town council`, `mayor` and `ordinance` — a city's
 * ordinances are a town's by-laws, and "Ordinance Review Committee" should land
 * in `law` for the same reason Milton's "Bylaw Review Committee" does.
 *
 * The second town, and the one that proved the seam was in the right place.
 * Two things about this install differ from Milton's and neither needed a code
 * change beyond the parser noted below:
 *
 *   - **No RSS at all.** `/rss.aspx` returns 404, so there is no module index
 *     and no ModIDs to read. Milton's news, calendar and alert sources have no
 *     counterpart here; the Agenda Center is the whole of it.
 *   - **No bids module.** `/bids.aspx` returns 404 as well. Procurement is
 *     published somewhere else on the site and has not been located yet.
 *
 * The one thing that *did* need a code change: this install renders the Agenda
 * Center index as collapsible panels (`<div id="cat4"><h2>Board of Health</h2>`)
 * rather than as links to each category, so `extractAgendaCategories` learned to
 * read both layouts. The category ids below came out of `towncivic discover`
 * against the live site; the slugs are derived from the names and were
 * confirmed by `towncivic verify`, which fetched each listing and parsed real
 * agendas out of it.
 */

export const WEYMOUTH_BASE = 'https://weymouth.ma.us';

/**
 * No RSS modules are published by this install, so there are no ids to record.
 * Kept as an explicit empty object rather than omitted: "we looked and there
 * were none" is a different statement from "nobody has looked yet".
 */
export const MODULES: CivicPlusModules = {};

/**
 * The boards worth following first, out of the 32 categories `discover` found.
 *
 * Same curation rule as Milton: the bodies that carry the institutional life of
 * the town — who decides, who spends, who permits — rather than every committee
 * that has ever posted a notice. `discover` lists the rest (Fourth of July
 * Committee, Cemetery Commission, the regional recreation district) so any of
 * them can be promoted deliberately.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  { slug: 'Town-Council', cid: 24, body: 'Town Council' },
  { slug: 'Planning-Board', cid: 19, body: 'Planning Board' },
  { slug: 'Board-of-Zoning-Appeals', cid: 7, body: 'Board of Zoning Appeals' },
  { slug: 'Conservation-Commission', cid: 11, body: 'Conservation Commission' },
  { slug: 'Board-of-Health', cid: 4, body: 'Board of Health' },
  { slug: 'Community-Preservation-Committee', cid: 10, body: 'Community Preservation Committee' },
  { slug: 'Weymouth-Public-Schools', cid: 27, body: 'Weymouth Public Schools' },
  { slug: 'Ordinance-Review-Committee', cid: 32, body: 'Ordinance Review Committee' },
  { slug: 'Board-of-Registrars', cid: 39, body: 'Board of Registrars' },
  { slug: 'Board-of-Assessors', cid: 3, body: 'Board of Assessors' },
  { slug: 'Historical-Commission', cid: 16, body: 'Historical Commission' },
  { slug: 'Planning-Community-Development', cid: 18, body: 'Planning & Community Development' },
  { slug: 'Redevelopment-Authority', cid: 45, body: 'Redevelopment Authority' },
  { slug: 'Southfield-Redevelopment-Authority', cid: 21, body: 'Southfield Redevelopment Authority' },
];

export const weymouthProfile = defineJurisdiction({
  id: 'weymouth-ma',
  name: 'Weymouth',
  baseUrl: WEYMOUTH_BASE,
  boundary: { provider: 'massgis', townName: 'WEYMOUTH' },
  // Provisional, and only ever used as a geocoding fence until the MassGIS
  // outline is fetched. Padded outwards on purpose: too wide accepts a
  // neighbour, too narrow silently drops real addresses, and the fix for both
  // is one `boundary` run.
  bbox: { south: 42.16, west: -71.02, north: 42.28, east: -70.88 },
  bodyAliases: {
    'weymouth town council': 'Town Council',
    'office of the mayor': 'Mayor',
    'zoning board of appeals': 'Board of Zoning Appeals',
  },
  /**
   * Weymouth's own names, tried before the statewide rules. Its two
   * redevelopment authorities — Union Point, the redeveloped naval air station —
   * are covered by the statewide `redevelopment` rule instead.
   */
  bodyRules: [
    { pattern: /planning & community/i, channel: 'land-use', priority: 'high' },
    { pattern: /waterfront/i, channel: 'land-use', priority: 'medium' },
  ],
  // The municipal buildings that appear on notice templates. Not yet confirmed
  // against a Weymouth notice PDF — `extract` is what will show whether these
  // are the addresses their templates actually carry.
  venueAddresses: ['75 Middle Street', '182 Green Street'],
  notes: 'CivicPlus, Agenda Center only: this install publishes no RSS modules and no bids page.',
});

weymouthProfile.sources = civicPlusSources(weymouthProfile, {
  modules: MODULES,
  agendaCategories: AGENDA_CATEGORIES,
  // Both 404 on this install, so neither is registered — an entry pointing at a
  // page the town does not serve is a source that fails forever.
  bids: false,
  feeds: [],
  confidence: 'verified',
  enabled: true,
});
