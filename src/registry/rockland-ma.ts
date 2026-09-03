import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';
import type { AgendaCategory, CivicPlusModules } from './civicplus.ts';

/**
 * Rockland, Massachusetts.
 *
 * About 18,000 people on ten square miles, open town meeting with a select
 * board — the same shape as Hull and Scituate, and the shape the statewide
 * defaults were written for.
 *
 * **Registered, nothing enabled**, for the same reason as Braintree and
 * Waltham: the install is plainly CivicPlus CivicEngage, but nothing below has
 * been fetched from the live site by this build — the environment it was written
 * in has no egress to `rockland-ma.gov`. `discover`, then `verify`, then promote.
 *
 * One thing about this install worth knowing before running either:
 *
 * **The Agenda Center is shared across the town's other domains.** The same
 * categories, with the same ids, are served from `rocklandpolice.com`,
 * `rocklandmemoriallibrary.org`, `rocklandparksandrec.org` and `arjww.org` (the
 * Abington & Rockland Joint Water Works), all of which render the "Rockland
 * Town, MA" install. Two consequences: the category ids below are install-wide
 * rather than per-hostname, so one of them was legitimately read off a sibling
 * domain; and there is no reason to register those hostnames as sources, since
 * `rockland-ma.gov` serves the whole of it.
 */

export const ROCKLAND_BASE = 'https://www.rockland-ma.gov';

/**
 * Unread rather than absent — `/rss.aspx` has not been fetched. Weymouth's and
 * Scituate's empty objects mean "we looked and there were none"; this one means
 * nobody has looked yet.
 */
export const MODULES: CivicPlusModules = {};

/**
 * The categories whose ids the site publishes, which is a good but incomplete
 * slice of the boards worth following.
 *
 * These are the site's own ids rather than the platform's default numbering, but
 * they are still second-hand, and `discover` is what turns them into facts. The
 * gaps to expect: the School Committee (its minutes are in this Agenda Center,
 * so the category exists and its id is simply not published anywhere indexed),
 * the Capital Planning Committee, and the Historical Commission.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  // The site's own slug still says "Board of Selectmen" while the page it serves
  // is titled "Select Board" — a renamed category whose slug did not follow.
  // Harmless: the statewide alias table already collapses the two spellings.
  { slug: 'Board-of-Selectmen', cid: 6, body: 'Board of Selectmen' },
  { slug: 'Finance-Committee', cid: 24, body: 'Finance Committee' },
  { slug: 'Planning-Board', cid: 15, body: 'Planning Board' },
  { slug: 'Zoning-Board-of-Appeals', cid: 12, body: 'Zoning Board of Appeals' },
  { slug: 'Conservation-Commission', cid: 22, body: 'Conservation Commission' },
  { slug: 'Board-of-Health', cid: 19, body: 'Board of Health' },
  { slug: 'Sewer-Commission', cid: 7, body: 'Sewer Commission' },
  { slug: 'Rent-Control-Board', cid: 25, body: 'Rent Control Board' },
  { slug: 'Cultural-Council', cid: 23, body: 'Cultural Council' },
];

export const rocklandProfile = defineJurisdiction({
  id: 'rockland-ma',
  name: 'Rockland',
  // The site titles itself "Rockland Town, MA", which is the CMS's phrasing
  // rather than anyone's usage. The UI says it the way a reader would.
  label: 'Rockland, Massachusetts',
  boundary: { provider: 'massgis', townName: 'ROCKLAND' },
  baseUrl: ROCKLAND_BASE,
  // Provisional, superseded by the committed MassGIS outline. Padded outwards:
  // it exists to reject an answer in Abington or Hanover, not to draw a border.
  bbox: { south: 42.07, west: -70.99, north: 42.19, east: -70.84 },
  bodyRules: [
    /**
     * Rockland regulates rents in its manufactured-home parks, which is why a
     * Rent Control Board exists here and in almost no other town this size. It
     * is a housing body, and the statewide rules file housing under `land-use`
     * — but they recognise it by the words "housing" and "affordable", neither
     * of which appears in the name.
     */
    { pattern: /rent control|manufactured home|mobile home park/i, channel: 'land-use', priority: 'high' },
  ],
  // Town Hall, whose address is printed on the notice template. The Monahan
  // Hearing Room, where the Select Board sits, is a room inside it.
  venueAddresses: ['242 Union Street'],
  notes:
    'CivicPlus CivicEngage, shared with the town’s library, police, parks and water-works domains. Registered from published URL shapes and not yet fetched: run `discover`, then `verify`, before enabling anything.',
});

rocklandProfile.sources = civicPlusSources(rocklandProfile, {
  modules: MODULES,
  agendaCategories: AGENDA_CATEGORIES,
  // Unknown, so unregistered — `discover` costs one request and settles it.
  bids: false,
  feeds: [],
  confidence: 'unverified',
  enabled: false,
});
