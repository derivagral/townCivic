import type { SourceInput } from '../types.ts';
import { defineJurisdiction } from './profile.ts';
import type { JurisdictionProfile } from './profile.ts';
import { agendaCenterSource, agendaIndexSource, bidsSource, rssSource, stateSources } from './civicplus.ts';
import type { AgendaCategory } from './civicplus.ts';

/**
 * Milton, Massachusetts.
 *
 * The town runs CivicPlus CivicEngage. Two hostnames serve the same site —
 * `townofmilton.org` is the legacy alias, `miltonma.gov` is canonical — so
 * every source here is pinned to the canonical host.
 *
 * Module and category ids below were read off the live site with
 * `towncivic discover`, not guessed. For this install:
 *
 *    ModID=1   News Flash        ModID=58  Calendar
 *    ModID=51  Blog              ModID=63  Alert Center
 *    ModID=53  Photo Gallery     ModID=65  Agenda Center
 *    ModID=66  Jobs              ModID=76  Pages
 *
 * They are per-install values. Re-run `discover` before trusting them on any
 * other town, and `verify` after the town upgrades its site.
 *
 * Tier 1 leans on the Agenda Center HTML listing rather than its RSS feed. That
 * is a deliberate, measured choice: the listing for one board returns roughly
 * thirty agendas and minutes going back a year, while the matching ModID=65
 * feed returned a single item pointing at an undated `PreviousVersions` URL.
 * The listing also embeds the meeting date and the agenda/minutes distinction
 * in the href, so the parser reads structure instead of prose.
 *
 * This file writes its sources out one at a time rather than through
 * `civicPlusSources()`. Every row here carries a note or an `enabled: false`
 * earned by looking at what the live feed actually returned, and flattening
 * that into a generic call would throw away the evidence. A town whose sources
 * are all alike should use the compact form — see `hull-ma.ts`.
 */

export const MILTON_BASE = 'https://www.miltonma.gov';
export const JURISDICTION = 'milton-ma';

/** CivicPlus module ids for this install, confirmed via /rss.aspx. */
export const MODULES = {
  newsFlash: 1,
  blog: 51,
  calendar: 58,
  alertCenter: 63,
  agendaCenter: 65,
  jobs: 66,
  pages: 76,
} as const;

/**
 * The boards worth following first.
 *
 * Milton publishes 78 Agenda Center categories. Most are advisory bodies that
 * meet rarely; ingesting all of them would bury the Select Board under the
 * Shade Tree Advisory Committee. This is the curated core — the five pipelines
 * that carry the institutional life of the town — and `towncivic discover`
 * lists everything else so a category can be promoted deliberately.
 *
 * `cid` values are the real Agenda Center category ids.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  { slug: 'Select-Board', cid: 6, body: 'Select Board' },
  { slug: 'Planning-Board', cid: 39, body: 'Planning Board' },
  { slug: 'Board-of-Appeals', cid: 38, body: 'Board of Appeals' },
  { slug: 'Conservation-Commission', cid: 15, body: 'Conservation Commission' },
  { slug: 'Warrant-Committee', cid: 34, body: 'Warrant Committee' },
  { slug: 'School-Committee', cid: 41, body: 'School Committee' },
  { slug: 'Board-of-Health', cid: 42, body: 'Board of Health' },
  { slug: 'Town-Clerk', cid: 4, body: 'Town Clerk' },
  { slug: 'Bylaw-Review-Committee', cid: 12, body: 'Bylaw Review Committee' },
  { slug: 'Capital-Improvement-Planning-Committee', cid: 13, body: 'Capital Improvement Planning Committee' },
  { slug: 'Community-Preservation-Committee', cid: 14, body: 'Community Preservation Committee' },
  { slug: 'Board-of-Registrars', cid: 11, body: 'Board of Registrars' },
  { slug: 'Historical-Commission', cid: 24, body: 'Historical Commission' },
  { slug: 'Affordable-Housing-Trust', cid: 32, body: 'Affordable Housing Trust' },
];

/**
 * The shell of the profile, before its sources.
 *
 * The source builders need the profile — they read the town's name for the
 * agency string and its body rules for the channel — so it is built in two
 * steps rather than one. The alternative is passing the same four fields to
 * every builder.
 */
const milton: JurisdictionProfile = defineJurisdiction({
  id: JURISDICTION,
  name: 'Milton',
  baseUrl: MILTON_BASE,
  boundary: { provider: 'massgis', townName: 'MILTON' },
  /**
   * Roughly the extent of Milton, padded outwards.
   *
   * A sanity fence, not cartography: it exists so that a geocoder answering
   * with a Milton in another state — there are several — is rejected rather
   * than drawn. The committed MassGIS outline supersedes it.
   */
  bbox: { south: 42.18, west: -71.15, north: 42.31, east: -70.99 },
  /**
   * Different systems name the same body differently — the Agenda Center says
   * "Board of Appeals" where a meeting notice says "Zoning Board of Appeals".
   * Collapsing them keeps the filter rail from splitting one board into two.
   * The statewide ones live in `DEFAULT_BODY_ALIASES`; these are Milton's own.
   */
  bodyAliases: {
    'trustees of the affordable housing trust': 'Affordable Housing Trust',
    "selectmen's office": 'Select Board',
  },
  /**
   * Municipal buildings, which are where meetings happen rather than what they
   * are about.
   *
   * Every meeting notice carries the Town Clerk's address in its template, so
   * without this every record in the town would list "525 Canton Avenue" as a
   * subject and the one address that actually matters would be lost in it.
   */
  venueAddresses: ['525 Canton Avenue', '515 Canton Avenue', '40 Highland Street', '1 Wharf Street'],
  fixtures: {
    'milton-ma:agenda:index': 'milton-ma/agenda-center-index.html',
    'milton-ma:agenda:select-board': 'milton-ma/select-board-6.html',
    'milton-ma:agenda:planning-board': 'milton-ma/planning-board-39.html',
    'milton-ma:agenda:board-of-health': 'milton-ma/board-of-health-42.html',
    'milton-ma:bids': 'milton-ma/bids.html',
    'milton-ma:news': 'milton-ma/newsflash.xml',
    'milton-ma:calendar': 'milton-ma/calendar.xml',
  },
});

const verified = { confidence: 'verified', enabled: true } as const;

const tier1: SourceInput[] = [
  ...AGENDA_CATEGORIES.map((category) => agendaCenterSource(milton, category, MODULES, verified)),

  agendaIndexSource(milton, {
    ...verified,
    notes:
      'Covers all 78 categories, including ones not curated above. Also the input to `towncivic discover`.',
  }),

  bidsSource(milton, {
    ...verified,
    agency: 'Milton Procurement Department',
    notes:
      'Defaults to open bids only. Add `?showAllBids=on` for closed and awarded postings once history matters.',
  }),

  rssSource(milton, {
    ...verified,
    key: 'news',
    label: 'Town news flash',
    modId: MODULES.newsFlash,
    cid: 'All-newsflash.xml',
    channel: 'meetings',
    eventType: 'news_notice',
    notes: 'Mixed quality — carries election notices and road closures alongside recreation signups.',
  }),

  rssSource(milton, {
    key: 'alerts',
    label: 'Emergency alerts',
    modId: MODULES.alertCenter,
    cid: 'Town-of-Milton-Emergency-Alerts-14',
    channel: 'public-safety',
    eventType: 'alert',
    priority: 'high',
    precedence: 10,
    confidence: 'verified',
    // Reachable and correctly addressed, but Milton publishes nothing through
    // Alert Center RSS — every category returned zero items (checked Aug 2026).
    // Registered and off, so it costs one flag if that changes.
    enabled: false,
    notes: 'Feed is live but empty. Emergency notices go out through News Flash and Notify Me instead.',
  }),

  rssSource(milton, {
    key: 'alerts:dpw',
    label: 'Public Works notices',
    modId: MODULES.alertCenter,
    cid: 'Public-Works-8',
    channel: 'public-safety',
    eventType: 'alert',
    agency: 'Milton Department of Public Works',
    body: 'Department of Public Works',
    precedence: 10,
    confidence: 'verified',
    enabled: false,
    notes: 'Feed is live but empty (checked Aug 2026).',
  }),

  rssSource(milton, {
    key: 'alerts:clerk',
    label: 'Town Clerk notices',
    modId: MODULES.alertCenter,
    cid: 'Town-Clerk-15',
    channel: 'elections',
    eventType: 'election_notice',
    agency: 'Milton Town Clerk',
    body: 'Town Clerk',
    priority: 'high',
    precedence: 10,
    confidence: 'verified',
    enabled: false,
    notes:
      'Elections, ballot questions and filing deadlines — the clerk is the statutory posting point. Feed is live but empty (checked Aug 2026); the Town Clerk Agenda Center category carries this material instead.',
  }),

  rssSource(milton, {
    key: 'calendar',
    label: 'Town calendar (posted meeting notices)',
    modId: MODULES.calendar,
    cid: 'All-calendar.xml',
    channel: 'meetings',
    eventType: 'meeting_notice',
    priority: 'high',
    precedence: 40,
    confidence: 'verified',
    // Verified as reachable and well-formed, but the town publishes no items
    // through it — the Agenda Center is where notices actually land. Left
    // registered and off so it is one flag away if the town starts using it.
    enabled: false,
    options: { bodyFromTitlePrefix: true },
    notes:
      'Feed is live but empty (checked Aug 2026). Meeting notices come through the Agenda Center instead. Re-check with `verify --all`.',
  }),
];

milton.sources = [...tier1, ...stateSources(milton)];

export const miltonProfile = milton;
