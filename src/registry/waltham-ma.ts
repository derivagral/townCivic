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
 * What did need work is that **almost every body here is named something the
 * statewide rules do not recognise.** Waltham's planning board is the Board of
 * Survey and Planning; its health board is a Health Department; its capital
 * body is a Long Term Debt Committee. Five town-specific rules below, more than
 * any other town needs, and each one is the difference between a channel that
 * carries the city's land-use record and a channel that is empty while
 * `meetings` fills up with everything.
 *
 * **A migration sits in the middle of this town's record.** Waltham moved onto
 * CivicPlus during 2025 from a Granicus-hosted Drupal site whose agenda URLs
 * (`/node/1979/agenda`, `/sites/g/files/vyhlif12301/f/agendas/…`) are still
 * indexed and still resolve. The city's own guidance is that agendas and minutes
 * from before 2025 are in the Document Center rather than the Agenda Center. So
 * expect this town's archive to stop rather than thin out, and do not read that
 * edge as the city having published nothing — it is the seam, and the older
 * record is reachable by a route no adapter here drives yet.
 */

export const WALTHAM_BASE = 'https://www.city.waltham.ma.us';

/**
 * Read off `/rss.aspx`, not guessed. No Blog and no Photo Gallery on this
 * install, which is why the list is shorter than Braintree's.
 *
 *    ModID=1   News Flash        ModID=65  Agenda Center
 *    ModID=58  Calendar          ModID=66  Jobs
 *    ModID=63  Alert Center      ModID=76  Pages
 */
export const MODULES: CivicPlusModules = {
  newsFlash: 1,
  calendar: 58,
  alertCenter: 63,
  agendaCenter: 65,
  jobs: 66,
  pages: 76,
};

/**
 * Nineteen of the 23 categories `discover` found — the least curation of any
 * town here, because a city of 65,000 publishes a narrower Agenda Center than
 * Braintree or Rockland do. What is left out is four bodies that post no
 * decisions: the Disability Services Commission, the Energy Action Committee,
 * Veterans Services and the Parks Recreation Board, all of which still arrive
 * through the site-wide index.
 *
 * `verify` fetched and parsed every one of these (Sep 2026). Two answered with
 * nothing in them — the Health Department, which posts through the Board of
 * Health category instead, and the Retirement Board. Left enabled rather than
 * dropped: an empty listing is a fact about this year, not about the URL.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  { slug: 'City-Council', cid: 2, body: 'City Council' },
  { slug: 'Ordinances-Rules-Committee', cid: 19, body: 'Ordinances & Rules Committee' },
  { slug: 'Board-of-Survey-and-Planning', cid: 36, body: 'Board of Survey and Planning' },
  { slug: 'Zoning-Board-of-Appeals', cid: 38, body: 'Zoning Board of Appeals' },
  { slug: 'Conservation-Commission', cid: 30, body: 'Conservation Commission' },
  { slug: 'Planning-Department', cid: 33, body: 'Planning Department' },
  { slug: 'Economic-Community-Development', cid: 31, body: 'Economic & Community Development' },
  { slug: 'Historical-Commission', cid: 16, body: 'Historical Commission' },
  { slug: 'Board-of-Health', cid: 32, body: 'Board of Health' },
  { slug: 'Health-Department', cid: 4, body: 'Health Department' },
  { slug: 'Finance-Committee', cid: 29, body: 'Finance Committee' },
  { slug: 'Long-Term-Debt-Committee', cid: 28, body: 'Long Term Debt Committee' },
  { slug: 'Community-Preservation', cid: 35, body: 'Community Preservation' },
  { slug: 'Retirement-Board', cid: 24, body: 'Retirement Board' },
  { slug: 'School-Department', cid: 8, body: 'School Department' },
  { slug: 'Licensing-Commission', cid: 17, body: 'Licensing Commission' },
  { slug: 'Licenses-Franchises-Committee', cid: 37, body: 'Licenses & Franchises Committee' },
  { slug: 'Public-Works-Committee', cid: 21, body: 'Public Works Committee' },
  { slug: 'Traffic-Commission', cid: 26, body: 'Traffic Commission' },
];

export const walthamProfile = defineJurisdiction({
  id: 'waltham-ma',
  name: 'Waltham',
  boundary: { provider: 'massgis', townName: 'WALTHAM' },
  baseUrl: WALTHAM_BASE,
  // Superseded by the committed MassGIS outline. Padded outwards: it exists to
  // reject an answer in Newton or Lexington, not to border them.
  bbox: { south: 42.32, west: -71.31, north: 42.44, east: -71.16 },
  bodyAliases: {
    'waltham city council': 'City Council',
    'office of the mayor': 'Mayor',
  },
  /**
   * Five rules, tried before the statewide defaults. Every one of them exists
   * because this city names a body after its department rather than after the
   * statute, and the defaults recognise the statutory names.
   */
  bodyRules: [
    // The planning board, holding both offices at once. `/planning board/` does
    // not match "survey and planning", so without this the most consequential
    // land-use body in the city files as a generic meeting.
    { pattern: /board of survey|survey and planning/i, channel: 'land-use', priority: 'high' },
    // The department, which posts its own hearings separately from the board's.
    { pattern: /planning department/i, channel: 'land-use', priority: 'high' },
    // Waltham's economic development arm — the same trap Weymouth's "Planning &
    // Community Development" sprang, under a different name.
    { pattern: /community development|economic development/i, channel: 'land-use', priority: 'high' },
    // The city's capital committee. The statewide money rule looks for
    // "capital", "budget" and "appropriat"; this one says "debt".
    { pattern: /long[- ]term debt|debt committee/i, channel: 'money', priority: 'high' },
    // A separate category from the Board of Health, and the defaults match only
    // the board.
    { pattern: /health department/i, channel: 'public-safety', priority: 'medium' },
  ],
  // City Hall, whose address is printed on the notice template. Unconfirmed
  // against a Waltham notice PDF until `extract` has run against this town.
  venueAddresses: ['610 Main Street'],
  notes:
    'CivicPlus CivicEngage, migrated onto it during 2025 — anything earlier is in the Document Center, so the archive stops rather than thins out. Names most of its bodies after departments rather than statutes, which is what the five body rules are for.',
});

walthamProfile.sources = civicPlusSources(walthamProfile, {
  modules: MODULES,
  agendaCategories: AGENDA_CATEGORIES,
  bids: true,
  feeds: [
    {
      key: 'news',
      label: 'City news flash',
      modId: MODULES.newsFlash!,
      cid: 'All-newsflash.xml',
      channel: 'meetings',
      eventType: 'news_notice',
      agency: 'City of Waltham',
      confidence: 'verified',
      enabled: true,
    },
    {
      key: 'alerts',
      label: 'City alerts',
      modId: MODULES.alertCenter!,
      cid: 'City-Alerts-5',
      channel: 'public-safety',
      eventType: 'alert',
      agency: 'City of Waltham',
      priority: 'high',
      precedence: 10,
      confidence: 'verified',
      enabled: false,
      notes: 'Live and correctly addressed, but publishes no items (checked Sep 2026).',
    },
    {
      key: 'calendar',
      label: 'City calendar',
      modId: MODULES.calendar!,
      cid: 'All-calendar.xml',
      channel: 'meetings',
      eventType: 'meeting_notice',
      agency: 'City of Waltham',
      precedence: 40,
      confidence: 'verified',
      enabled: true,
      options: { bodyFromTitlePrefix: true },
    },
  ],
  confidence: 'verified',
  enabled: true,
});
