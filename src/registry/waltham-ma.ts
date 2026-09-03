import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';
import type { AgendaCategory, CivicPlusModules } from './civicplus.ts';

/**
 * Waltham, Massachusetts.
 *
 * A city of about 65,000 — a mayor and a fifteen-member City Council — and the
 * first jurisdiction here that is not a South Shore town. Nothing about that
 * needed a code change: the statewide rules already know `city council`, `mayor`
 * and `ordinance`, because Weymouth and Braintree are governed as cities too.
 *
 * **Registered with the Agenda Center index and nothing else**, which is a
 * weaker starting position than Braintree's or Rockland's and worth being
 * explicit about. The install is certainly CivicPlus CivicEngage — `/Rss.aspx`,
 * `/Calendar.aspx`, `/m/directory` and `/AgendaCenter/ViewFile/Agenda/…` are all
 * the product's own URL shapes, and current agendas come out of them — but not
 * one `/AgendaCenter/<Board>-<id>` category URL is published anywhere this build
 * could read, and it has no egress to `city.waltham.ma.us` to ask. So there are
 * no category ids to write down and none are invented. `/AgendaCenter` is the
 * one source that can be registered before `discover` has run, because it is a
 * platform path rather than a per-install id — and it is what `discover` reads.
 *
 * Two things this town has that none of the other six do:
 *
 *   - **A live `/Rss.aspx` whose module ids nobody has read.** Hull is the only
 *     other install here that publishes one at all; Weymouth and Scituate 404.
 *     So `MODULES` below is empty in a different sense than theirs — see the
 *     note on it.
 *   - **A migration in the middle of its record.** Waltham moved onto CivicPlus
 *     during 2025, from a Granicus-hosted Drupal site whose agenda URLs
 *     (`/node/1979/agenda`, `/sites/g/files/vyhlif12301/f/agendas/…`) are still
 *     indexed and still resolve. The city's own guidance is that agendas and
 *     minutes before 2025 are in the Document Center rather than the Agenda
 *     Center. Expect the archive to stop rather than thin out, and do not read
 *     that edge as a gap in the town's publishing.
 */

export const WALTHAM_BASE = 'https://www.city.waltham.ma.us';

/**
 * Empty because unread, and that is a third state worth distinguishing.
 *
 * Weymouth's and Scituate's empty objects mean "`/rss.aspx` 404s; there are no
 * modules". Hull's is populated because its index was fetched. This one means
 * the index is there — the site serves `/Rss.aspx` — and nobody has read the
 * ids off it yet. One `discover` run closes the difference.
 */
export const MODULES: CivicPlusModules = {};

/**
 * Deliberately empty: not one category id for this install is published
 * anywhere, and the rule this registry keeps is that these are read off the live
 * site and never guessed. The bodies to expect once `discover` has run are the
 * City Council and its standing committees, the Board of Survey and Planning
 * (see the rule below), the Zoning Board of Appeals, the Conservation
 * Commission, the Board of Health, the License Commission, the School Committee
 * and the Parks & Recreation Board — each of which has been seen posting through
 * this Agenda Center, without its id.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [];

export const walthamProfile = defineJurisdiction({
  id: 'waltham-ma',
  name: 'Waltham',
  boundary: { provider: 'massgis', townName: 'WALTHAM' },
  baseUrl: WALTHAM_BASE,
  // Provisional, superseded by the committed MassGIS outline. Padded outwards:
  // it exists to reject an answer in Newton or Lexington, not to border them.
  bbox: { south: 42.32, west: -71.31, north: 42.44, east: -71.16 },
  bodyAliases: {
    'waltham city council': 'City Council',
    'office of the mayor': 'Mayor',
  },
  bodyRules: [
    /**
     * Waltham's planning board is called the Board of Survey and Planning — it
     * holds both offices at once — and no statewide rule would recognise it:
     * `/planning board/` does not match "survey and planning", so the most
     * consequential land-use body in the city would file as a generic meeting.
     * The same trap Weymouth's "Planning & Community Development" sprang.
     */
    { pattern: /board of survey|survey and planning/i, channel: 'land-use', priority: 'high' },
  ],
  // City Hall, whose address is on the notice template. Unconfirmed against a
  // Waltham notice PDF until `extract` has run against this town.
  venueAddresses: ['610 Main Street'],
  notes:
    'CivicPlus CivicEngage, migrated onto it during 2025 — anything before that is in the Document Center. Live `/Rss.aspx` with unread module ids, and no category ids published: `discover` is the whole of what this town needs.',
});

walthamProfile.sources = civicPlusSources(walthamProfile, {
  modules: MODULES,
  agendaCategories: AGENDA_CATEGORIES,
  // Unknown, so unregistered. `discover` settles both in one pass.
  bids: false,
  feeds: [],
  confidence: 'unverified',
  enabled: false,
});
