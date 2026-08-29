import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';
import type { AgendaCategory, CivicPlusModules } from './civicplus.ts';

/**
 * Hull, Massachusetts.
 *
 * A barrier peninsula of about 10,000 people on seven square miles, most of it
 * a sandbar. That matters twice over: its outline is long, thin and full of
 * water — precisely the case where a bounding-box fence is useless and the real
 * polygon earns its keep — and its Sewer Commission and Stormwater Authority are
 * genuinely load-bearing civic bodies rather than the afterthoughts they would
 * be inland.
 *
 * The fullest CivicPlus install of the four: unlike Weymouth and Scituate it
 * publishes `/rss.aspx`, so the module ids below were read off it rather than
 * inferred. They happen to match Milton's, which is the platform's default
 * numbering and not something to rely on — Weymouth publishes no modules at all.
 *
 *    ModID=1   News Flash        ModID=58  Calendar
 *    ModID=51  Blog              ModID=63  Alert Center
 *    ModID=53  Photo Gallery     ModID=65  Agenda Center
 *    ModID=66  Jobs              ModID=76  Pages
 *
 * Every one of those feeds was fetched and every one came back with no items
 * (checked Aug 2026), so they are registered and disabled — the same treatment
 * Milton's empty feeds get. The Agenda Center is where this town's record
 * actually lives.
 */

export const HULL_BASE = 'https://www.town.hull.ma.us';

/** Read off `/rss.aspx`, not guessed. */
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
 * The boards worth following first, out of the 48 categories `discover` found.
 *
 * A wider slice than Milton's, deliberately. Hull is small enough that one
 * board's agendas are a meaningful fraction of the town's whole public record,
 * and bodies that would be peripheral in a larger town — the Light Board, which
 * runs the municipal electric plant, the Sewer Commission, the Stormwater
 * Authority — are here central.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  { slug: 'Select-Board', cid: 25, body: 'Select Board' },
  { slug: 'Advisory-Board', cid: 3, body: 'Advisory Board' },
  { slug: 'Planning-Board', cid: 23, body: 'Planning Board' },
  { slug: 'Zoning-Board-of-Appeals', cid: 31, body: 'Zoning Board of Appeals' },
  { slug: 'Zoning-By-Law-Committee', cid: 32, body: 'Zoning By-Law Committee' },
  { slug: 'Conservation-Commission', cid: 10, body: 'Conservation Commission' },
  { slug: 'Board-of-Health', cid: 2, body: 'Board of Health' },
  { slug: 'School-Commitee', cid: 35, body: 'School Commitee' },
  { slug: 'Community-Preservation-Committee', cid: 9, body: 'Community Preservation Committee' },
  { slug: 'Capital-Improvement-Committee', cid: 8, body: 'Capital Improvement Committee' },
  { slug: 'Board-of-Assessors', cid: 7, body: 'Board of Assessors' },
  { slug: 'Board-of-Registrars', cid: 41, body: 'Board of Registrars' },
  { slug: 'Historic-District-Commission', cid: 15, body: 'Historic District Commission' },
  { slug: 'Redevelopment-Authority', cid: 34, body: 'Redevelopment Authority' },
  { slug: 'Light-Board', cid: 19, body: 'Light Board' },
  { slug: 'Affordable-Housing-Committee', cid: 4, body: 'Affordable Housing Committee' },
  { slug: 'Sewer-Commission', cid: 26, body: 'Sewer Commission' },
  { slug: 'Stormwater-Authority', cid: 27, body: 'Stormwater Authority' },
];

export const hullProfile = defineJurisdiction({
  id: 'hull-ma',
  name: 'Hull',
  baseUrl: HULL_BASE,
  boundary: { provider: 'massgis', townName: 'HULL' },
  // Superseded by the committed MassGIS outline, which for this town is not a
  // formality: a rectangle around Hull contains most of Hingham Bay.
  bbox: { south: 42.24, west: -70.96, north: 42.33, east: -70.84 },
  bodyAliases: {
    // The town's own spelling in its Agenda Center. Kept as the alias rather
    // than corrected in the category list, so the registry says what the site
    // says and the filter rail says what a reader expects.
    'school commitee': 'School Committee',
    'hull redevelopment authority': 'Redevelopment Authority',
  },
  bodyRules: [
    // Hull Municipal Light Plant is the town's electric utility, and its board
    // is a utility body rather than a general committee.
    { pattern: /light board|municipal light/i, channel: 'public-safety', priority: 'medium' },
  ],
  // Town Hall and the Municipal Light Plant, both of which appear as meeting
  // locations. Unconfirmed against a Hull notice PDF until `extract` has run.
  venueAddresses: ['253 Atlantic Avenue', '15 Edgewater Road'],
  notes: 'Full CivicPlus install; every RSS module answered but published no items (checked Aug 2026).',
});

hullProfile.sources = civicPlusSources(hullProfile, {
  modules: MODULES,
  agendaCategories: AGENDA_CATEGORIES,
  // A real Bid Postings page that parsed cleanly with nothing posted on it
  // (checked Aug 2026). Left enabled rather than off: an empty procurement page
  // is a fact about this week, not about the URL, and it costs one request.
  bids: true,
  /**
   * Registered and off. Each of these was fetched: the news flash, the town
   * alerts and the Public Meetings calendar returned zero items, and the
   * site-wide calendar returned one holiday closure. Correct URLs, unpopulated
   * modules — exactly Milton's situation, and worth one flag each if the town
   * starts using them.
   */
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
      notes: 'Feed is live but empty (checked Aug 2026).',
    },
    {
      key: 'calendar:meetings',
      label: 'Public meetings calendar',
      modId: MODULES.calendar!,
      cid: 'Public-Meetings-23',
      channel: 'meetings',
      eventType: 'meeting_notice',
      priority: 'high',
      precedence: 40,
      confidence: 'verified',
      enabled: false,
      options: { bodyFromTitlePrefix: true },
      notes:
        'A dedicated posted-meetings category, which Milton does not have — but empty (checked Aug 2026). The best candidate to enable if this town starts publishing notices through the calendar.',
    },
    {
      key: 'alerts',
      label: 'Town alerts',
      modId: MODULES.alertCenter!,
      cid: 'Town-Alerts-4',
      channel: 'public-safety',
      eventType: 'alert',
      priority: 'high',
      precedence: 10,
      confidence: 'verified',
      enabled: false,
      notes: 'Feed is live but empty (checked Aug 2026).',
    },
  ],
  confidence: 'verified',
  enabled: true,
});
