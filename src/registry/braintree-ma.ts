import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';
import type { AgendaCategory, CivicPlusModules } from './civicplus.ts';

/**
 * Braintree, Massachusetts.
 *
 * Officially the Town of Braintree and governed as a city since the 2008
 * charter: a mayor and a nine-member Town Council rather than a select board and
 * open town meeting. Weymouth next door has the same shape, which is why the
 * statewide rules already know `town council`, `mayor` and `ordinance` — nothing
 * here needed a new rule for the form of government.
 *
 * **Registered, nothing enabled.** The install is CivicPlus CivicEngage — the
 * Agenda Center, `Calendar.aspx`, `Archive.aspx` and the `/NNN/Board-Name` page
 * ids are all the product's own URL shapes — but no URL below has been fetched
 * from the live site by this build, because the environment it was written in
 * has no egress to `braintreema.gov`. So every source ships `unverified` and
 * off, which is the rule the registry has always kept: an unverified claim does
 * not get to make requests.
 *
 * What that means for whoever picks this up:
 *
 *   1. `discover --jurisdiction braintree-ma` for the real category list. It
 *      will confirm or correct the four ids below and print the rest.
 *   2. `verify --jurisdiction braintree-ma --all`, then promote what answered.
 *   3. `boundary --jurisdiction braintree-ma` and commit the outline.
 *
 * Two things `verify` settles that guessing cannot:
 *
 *   - **Which host answers.** Both `braintreema.gov` and `www.braintreema.gov`
 *     appear as live URLs, and the apex is used here. Weymouth is the precedent
 *     for why this is not a formality: there the www host does not resolve at
 *     all, so the whole town would have failed on a coin flip.
 *   - **Whether there is a bids module.** Unknown. Milton and Hull publish
 *     `/bids.aspx`; Weymouth and Scituate 404 on it. Not registered until
 *     someone has seen it answer.
 */

export const BRAINTREE_BASE = 'https://www.braintreema.gov';

/**
 * Unread rather than absent. Braintree's `/rss.aspx` has not been fetched, so
 * unlike Weymouth's and Scituate's empty objects — which record "we looked and
 * there were none" — this one records that nobody has looked yet. `discover`
 * reads it in one request.
 */
export const MODULES: CivicPlusModules = {};

/**
 * A starting slice, not the curated set.
 *
 * These four ids were read off Agenda Center URLs the site publishes rather than
 * inferred from the platform's numbering, so they are the site's own — but they
 * are still second-hand, which is exactly what `discover` exists to fix. The
 * bodies that carry this town's institutional life and are certainly missing
 * here: the School Committee, the Board of Health, the Board of License
 * Commissioners, the Historical Commission, and whatever Braintree calls its
 * finance committee under a mayor.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  { slug: 'Town-Council', cid: 6, body: 'Town Council' },
  // The site's own slug carries a typo — `/AgendaCenter/Plannng-Board-7` — while
  // the page it serves is titled "Planning Board". Kept verbatim for the same
  // reason Hull's "School Commitee" is: the registry says what the site says,
  // and the alias table below says what a reader expects. `discover` is what
  // will show whether the category has since been renamed.
  { slug: 'Plannng-Board', cid: 7, body: 'Planning Board' },
  { slug: 'Zoning-Board-of-Appeals', cid: 3, body: 'Zoning Board of Appeals' },
  { slug: 'Conservation-Commission', cid: 4, body: 'Conservation Commission' },
];

export const braintreeProfile = defineJurisdiction({
  id: 'braintree-ma',
  name: 'Braintree',
  boundary: { provider: 'massgis', townName: 'BRAINTREE' },
  baseUrl: BRAINTREE_BASE,
  // Provisional, and only ever the fence `geocode` uses until the MassGIS
  // outline is committed. Padded outwards on purpose — it exists to reject an
  // answer in Quincy or Randolph, not to draw the border with them.
  bbox: { south: 42.16, west: -71.07, north: 42.27, east: -70.92 },
  bodyAliases: {
    'braintree town council': 'Town Council',
    'office of the mayor': 'Mayor',
    // See the note on the category above: the misspelling is the site's, and it
    // can reach `normalize` through the Agenda Center index as well as through
    // the category listing, so it is fixed here rather than at one call site.
    'plannng board': 'Planning Board',
  },
  // Town Hall, where the Council sits — Cahill Auditorium and Johnson Chambers
  // are both rooms in it, and the address is printed on the notice template. The
  // four spellings are the ones the town's own documents use interchangeably;
  // `isVenueAddress` matches on a prefix, so each has to be written out.
  venueAddresses: [
    '1 John F. Kennedy Memorial Drive',
    'One John F. Kennedy Memorial Drive',
    '1 JFK Memorial Drive',
    'One JFK Memorial Drive',
  ],
  notes:
    'CivicPlus CivicEngage, registered from published URL shapes and not yet fetched: run `discover`, then `verify`, before enabling anything.',
});

braintreeProfile.sources = civicPlusSources(braintreeProfile, {
  modules: MODULES,
  agendaCategories: AGENDA_CATEGORIES,
  // Unknown, so unregistered. A source pointing at a page the town does not
  // serve is a source that fails forever, and `discover` costs one request.
  bids: false,
  feeds: [],
  confidence: 'unverified',
  enabled: false,
});
