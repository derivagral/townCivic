import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';
import type { AgendaCategory, CivicPlusModules } from './civicplus.ts';

/**
 * Rockland, Massachusetts.
 *
 * About 18,000 people on ten square miles, open town meeting with a select
 * board — the shape the statewide defaults were written for, and after Braintree
 * and Waltham a welcome one.
 *
 * Two things about this install are worth knowing before touching it:
 *
 *   - **The Agenda Center is shared across the town's other domains.** The same
 *     categories, with the same ids, are served from `rocklandpolice.com`,
 *     `rocklandmemoriallibrary.org`, `rocklandparksandrec.org` and `arjww.org`
 *     (the Abington & Rockland Joint Water Works). The ids are install-wide
 *     rather than per-hostname, and `rockland-ma.gov` serves the whole of it, so
 *     none of those hostnames is registered.
 *   - **A quarter of the 46 categories are regional bodies, not town ones** —
 *     the MBTA Advisory Board, Plymouth County Advisory Board, the South Shore
 *     Recycling Cooperative, South Shore Technical High School, MAPC. Rockland
 *     posts the seat it holds on each. They come in through the site-wide index
 *     and are deliberately left out of the curated list below: they are real
 *     records, and they are not this town deciding anything.
 */

export const ROCKLAND_BASE = 'https://www.rockland-ma.gov';

/**
 * Read off `/rss.aspx`, not guessed.
 *
 *    ModID=1   News Flash        ModID=64  Real Estate Locator
 *    ModID=51  Blog              ModID=65  Agenda Center
 *    ModID=58  Calendar          ModID=66  Jobs
 *    ModID=63  Alert Center      ModID=76  Pages
 *
 * `CivicPlusModules` has no field for the Real Estate Locator because no other
 * install here publishes one and nothing reads it; it is recorded above so the
 * next person does not have to re-probe to find that out.
 */
export const MODULES: CivicPlusModules = {
  newsFlash: 1,
  blog: 51,
  calendar: 58,
  alertCenter: 63,
  agendaCenter: 65,
  jobs: 66,
  pages: 76,
};

/**
 * The boards worth following first, out of the 46 categories `discover` found.
 *
 * Weighted towards land and water, which is what this town argues about: a
 * Housing Production Plan Committee and a Housing Authority, the Southfield
 * Redevelopment Authority (the former South Weymouth Naval Air Station, whose
 * redevelopment Rockland shares with Weymouth and Abington), a Rent Control
 * Board, and separate Sewer and Water commissions.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  { slug: 'Select-Board', cid: 6, body: 'Select Board' },
  { slug: 'Finance-Committee', cid: 24, body: 'Finance Committee' },
  { slug: 'Capital-Planning-Committee', cid: 20, body: 'Capital Planning Committee' },
  { slug: 'Planning-Board', cid: 15, body: 'Planning Board' },
  { slug: 'Zoning-Board-of-Appeals', cid: 12, body: 'Zoning Board of Appeals' },
  { slug: 'Conservation-Commission', cid: 22, body: 'Conservation Commission' },
  { slug: 'Board-of-Health', cid: 19, body: 'Board of Health' },
  { slug: 'Sewer-Commission', cid: 7, body: 'Sewer Commission' },
  { slug: 'Board-of-Water-Commissioners', cid: 9, body: 'Board of Water Commissioners' },
  { slug: 'Rockland-School-Committee', cid: 10, body: 'Rockland School Committee' },
  { slug: 'Community-Preservation-Act-CPA', cid: 21, body: 'Community Preservation Act (CPA)' },
  { slug: 'Board-of-Assessors', cid: 17, body: 'Board of Assessors' },
  { slug: 'Board-of-Registrars', cid: 8, body: 'Board of Registrars' },
  { slug: 'Historical-Commission', cid: 31, body: 'Historical Commission' },
  { slug: 'Housing-Production-Plan-Committee', cid: 49, body: 'Housing Production Plan Committee' },
  { slug: 'Rockland-Housing-Authority', cid: 18, body: 'Rockland Housing Authority' },
  { slug: 'Rent-Control-Board', cid: 25, body: 'Rent Control Board' },
  { slug: 'Southfield-Redevelopment-Authority', cid: 26, body: 'Southfield Redevelopment Authority' },
  { slug: 'Charter-Review', cid: 41, body: 'Charter Review' },
];

export const rocklandProfile = defineJurisdiction({
  id: 'rockland-ma',
  name: 'Rockland',
  // The site titles itself "Rockland Town, MA", which is the CMS's phrasing
  // rather than anyone's usage. The UI says it the way a reader would.
  label: 'Rockland, Massachusetts',
  boundary: { provider: 'massgis', townName: 'ROCKLAND' },
  baseUrl: ROCKLAND_BASE,
  // Superseded by the committed MassGIS outline. Padded outwards: it exists to
  // reject an answer in Abington or Hanover, not to draw a border.
  bbox: { south: 42.07, west: -70.99, north: 42.19, east: -70.84 },
  bodyAliases: {
    'rockland school committee': 'School Committee',
    'rockland housing authority': 'Housing Authority',
    'rockland recreation': 'Recreation',
    // The site's own spelling of the statutory name.
    'community preservation act (cpa)': 'Community Preservation Committee',
    // Two typos the town's Agenda Center carries. Corrected here rather than in
    // the category list, so the registry says what the site says and the filter
    // rail says what a reader expects — Hull's "School Commitee" precedent.
    'ada commisson - american disabilities act': 'ADA Commission',
    'metropolitan aea planning council (mapc)': 'Metropolitan Area Planning Council',
  },
  bodyRules: [
    /**
     * Rockland regulates rents in its manufactured-home parks, which is why a
     * Rent Control Board exists here and in almost no other town this size. It
     * is a housing body, and the statewide rules file housing under `land-use` —
     * but they recognise it by the words "housing" and "affordable", neither of
     * which appears in the name.
     */
    { pattern: /rent control|manufactured home|mobile home park/i, channel: 'land-use', priority: 'high' },
    /**
     * The former South Weymouth Naval Air Station: Southfield sits across
     * Rockland, Weymouth and Abington, and its environmental cleanup runs
     * through a Restoration Advisory Board. Ahead of the statewide money rule,
     * which would otherwise catch the words "advisory board" and file the
     * largest land-use question in town as a budget meeting.
     */
    { pattern: /restoration advisory|naval air station|former nas/i, channel: 'land-use', priority: 'high' },
  ],
  // Town Hall, whose address is printed on the notice template. The Monahan
  // Hearing Room, where the Select Board sits, is a room inside it.
  venueAddresses: ['242 Union Street'],
  notes:
    'CivicPlus CivicEngage, shared with the town’s library, police, parks and water-works domains. A quarter of its Agenda Center categories are regional bodies Rockland holds a seat on rather than town boards.',
});

rocklandProfile.sources = civicPlusSources(rocklandProfile, {
  modules: MODULES,
  agendaCategories: AGENDA_CATEGORIES,
  bids: true,
  feeds: [
    {
      key: 'news',
      label: 'Town news flash',
      modId: MODULES.newsFlash!,
      cid: 'All-newsflash.xml',
      channel: 'meetings',
      eventType: 'news_notice',
      confidence: 'verified',
      enabled: false,
      notes:
        'Live and correctly addressed, but publishes no items (checked Sep 2026) — the town news flash posts through per-year categories instead.',
    },
    {
      key: 'alerts',
      label: 'Emergency alerts',
      modId: MODULES.alertCenter!,
      cid: 'Emergency-Alerts-6',
      channel: 'public-safety',
      eventType: 'alert',
      priority: 'high',
      precedence: 10,
      confidence: 'verified',
      enabled: false,
      notes: 'Live and correctly addressed, but publishes no items (checked Sep 2026).',
    },
    {
      key: 'calendar',
      label: 'Town calendar',
      modId: MODULES.calendar!,
      cid: 'All-calendar.xml',
      channel: 'meetings',
      eventType: 'meeting_notice',
      precedence: 40,
      confidence: 'verified',
      enabled: true,
      options: { bodyFromTitlePrefix: true },
    },
  ],
  confidence: 'verified',
  enabled: true,
});
