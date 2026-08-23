import type { SourceInput } from '../types.ts';
import type { Channel, Priority } from '../taxonomy.ts';

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
export const AGENDA_CATEGORIES = [
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
] as const;

/**
 * Different systems name the same body differently — the Agenda Center says
 * "Board of Appeals" where a meeting notice says "Zoning Board of Appeals".
 * Collapsing them keeps the filter rail from splitting one board into two.
 */
export const BODY_ALIASES: Record<string, string> = {
  'zoning board of appeals': 'Board of Appeals',
  zba: 'Board of Appeals',
  'conservation comm': 'Conservation Commission',
  concom: 'Conservation Commission',
  'community preservation committee (cpc)': 'Community Preservation Committee',
  'trustees of the affordable housing trust': 'Affordable Housing Trust',
  selectboard: 'Select Board',
  "selectmen's office": 'Select Board',
  'board of selectmen': 'Select Board',
};

export function canonicalBody(name: string): string {
  return BODY_ALIASES[name.trim().toLowerCase()] ?? name.trim();
}

/**
 * Municipal buildings, which are where meetings happen rather than what they
 * are about.
 *
 * Every meeting notice carries the Town Clerk's address in its template, so
 * without this every record in the town would list "525 Canton Avenue" as a
 * subject and the one address that actually matters would be lost in it.
 */
export const VENUE_ADDRESSES = [
  '525 Canton Avenue',
  '515 Canton Avenue',
  '40 Highland Street',
  '1 Wharf Street',
];

export function isVenueAddress(address: string): boolean {
  const normalized = address
    .toLowerCase()
    .replace(/\bave\b\.?/g, 'avenue')
    .replace(/\bst\b\.?/g, 'street');
  return VENUE_ADDRESSES.some((venue) => normalized.startsWith(venue.toLowerCase()));
}

/**
 * How a public body's name maps into the taxonomy.
 *
 * Used both for the static registry and for anything `discover` turns up, so a
 * newly created committee lands in the right channel without a code change.
 * First match wins; order matters.
 */
export const BODY_RULES: { pattern: RegExp; channel: Channel; priority: Priority }[] = [
  { pattern: /planning board|master plan/i, channel: 'land-use', priority: 'high' },
  { pattern: /board of appeals|zoning|zba/i, channel: 'land-use', priority: 'high' },
  { pattern: /conservation|open space/i, channel: 'land-use', priority: 'high' },
  { pattern: /design review|historic|sign review/i, channel: 'land-use', priority: 'medium' },
  { pattern: /housing|affordable/i, channel: 'land-use', priority: 'high' },
  {
    pattern: /warrant committee|finance|capital|budget|appropriat|audit|assessors|retirement|taxation|pilot/i,
    channel: 'money',
    priority: 'high',
  },
  { pattern: /procurement|purchasing|bid|rfp|community preservation/i, channel: 'money', priority: 'high' },
  { pattern: /town meeting|by-?law|charter|town government study/i, channel: 'law', priority: 'high' },
  { pattern: /school|education|curriculum/i, channel: 'schools', priority: 'high' },
  { pattern: /registrar|election|town clerk|electronic voting/i, channel: 'elections', priority: 'high' },
  {
    pattern: /board of health|water|sewer|public works|dpw|traffic|police|fire|emergency|animal/i,
    channel: 'public-safety',
    priority: 'medium',
  },
  { pattern: /select board|town administrator|personnel/i, channel: 'meetings', priority: 'high' },
  {
    pattern:
      /library|recreation|park|council on aging|cemetery|cultural|veterans|youth|coalition|anniversary/i,
    channel: 'admin',
    priority: 'low',
  },
];

export function classifyBody(name: string): { channel: Channel; priority: Priority } {
  for (const rule of BODY_RULES) {
    if (rule.pattern.test(name)) return { channel: rule.channel, priority: rule.priority };
  }
  return { channel: 'meetings', priority: 'medium' };
}

/** Build the source entry for one Agenda Center category. */
export function agendaCenterSource(category: { slug: string; cid: number; body: string }): SourceInput {
  const body = canonicalBody(category.body);
  const { channel, priority } = classifyBody(body);
  return {
    id: `${JURISDICTION}:agenda:${category.slug.toLowerCase()}`,
    jurisdiction: JURISDICTION,
    label: `${body} — agendas & minutes`,
    adapter: 'civicplus-agenda-center',
    url: `${MILTON_BASE}/AgendaCenter/${category.slug}-${category.cid}`,
    level: 'municipal',
    agency: `Milton ${body}`,
    body,
    channel,
    priority,
    tier: 1,
    // A board's own listing outranks the site-wide index for the same file.
    precedence: 10,
    confidence: 'verified',
    enabled: true,
    options: {
      cid: category.cid,
      slug: category.slug,
      rssFeed: `${MILTON_BASE}/RSSFeed.aspx?ModID=${MODULES.agendaCenter}&CID=${category.slug}-${category.cid}`,
    },
  };
}

const tier1: SourceInput[] = [
  ...AGENDA_CATEGORIES.map((c) => agendaCenterSource({ ...c })),

  {
    id: `${JURISDICTION}:agenda:index`,
    jurisdiction: JURISDICTION,
    label: 'Agenda Center — all boards (index)',
    adapter: 'civicplus-agenda-center',
    url: `${MILTON_BASE}/AgendaCenter`,
    level: 'municipal',
    agency: 'Town of Milton',
    channel: 'meetings',
    priority: 'medium',
    tier: 1,
    // Catches boards the curated list omits, but yields to a board's own page.
    precedence: 20,
    confidence: 'verified',
    enabled: true,
    options: { isIndex: true },
    notes:
      'Covers all 78 categories, including ones not curated above. Also the input to `towncivic discover`.',
  },

  {
    id: `${JURISDICTION}:bids`,
    jurisdiction: JURISDICTION,
    label: 'Bids, RFPs and invitations for bid',
    adapter: 'civicplus-bids',
    url: `${MILTON_BASE}/bids.aspx`,
    level: 'municipal',
    agency: 'Milton Procurement Department',
    body: 'Procurement Department',
    channel: 'money',
    eventType: 'bid_posted',
    priority: 'high',
    tier: 1,
    precedence: 10,
    confidence: 'verified',
    enabled: true,
    notes:
      'Defaults to open bids only. Add `?showAllBids=on` for closed and awarded postings once history matters.',
  },

  {
    id: `${JURISDICTION}:news`,
    jurisdiction: JURISDICTION,
    label: 'Town news flash',
    adapter: 'rss',
    url: `${MILTON_BASE}/RSSFeed.aspx?ModID=${MODULES.newsFlash}&CID=All-newsflash.xml`,
    level: 'municipal',
    agency: 'Town of Milton',
    channel: 'meetings',
    eventType: 'news_notice',
    priority: 'medium',
    tier: 1,
    precedence: 30,
    confidence: 'verified',
    enabled: true,
    notes: 'Mixed quality — carries election notices and road closures alongside recreation signups.',
  },

  {
    id: `${JURISDICTION}:alerts`,
    jurisdiction: JURISDICTION,
    label: 'Emergency alerts',
    adapter: 'rss',
    url: `${MILTON_BASE}/RSSFeed.aspx?ModID=${MODULES.alertCenter}&CID=Town-of-Milton-Emergency-Alerts-14`,
    level: 'municipal',
    agency: 'Town of Milton',
    channel: 'public-safety',
    eventType: 'alert',
    priority: 'high',
    tier: 1,
    precedence: 10,
    confidence: 'verified',
    // Reachable and correctly addressed, but Milton publishes nothing through
    // Alert Center RSS — every category returned zero items (checked Aug 2026).
    // Registered and off, so it costs one flag if that changes.
    enabled: false,
    notes: 'Feed is live but empty. Emergency notices go out through News Flash and Notify Me instead.',
  },

  {
    id: `${JURISDICTION}:alerts:dpw`,
    jurisdiction: JURISDICTION,
    label: 'Public Works notices',
    adapter: 'rss',
    url: `${MILTON_BASE}/RSSFeed.aspx?ModID=${MODULES.alertCenter}&CID=Public-Works-8`,
    level: 'municipal',
    agency: 'Milton Department of Public Works',
    body: 'Department of Public Works',
    channel: 'public-safety',
    eventType: 'alert',
    priority: 'medium',
    tier: 1,
    precedence: 10,
    confidence: 'verified',
    enabled: false,
    notes: 'Feed is live but empty (checked Aug 2026).',
  },

  {
    id: `${JURISDICTION}:alerts:clerk`,
    jurisdiction: JURISDICTION,
    label: 'Town Clerk notices',
    adapter: 'rss',
    url: `${MILTON_BASE}/RSSFeed.aspx?ModID=${MODULES.alertCenter}&CID=Town-Clerk-15`,
    level: 'municipal',
    agency: 'Milton Town Clerk',
    body: 'Town Clerk',
    channel: 'elections',
    eventType: 'election_notice',
    priority: 'high',
    tier: 1,
    precedence: 10,
    confidence: 'verified',
    enabled: false,
    notes:
      'Elections, ballot questions and filing deadlines — the clerk is the statutory posting point. Feed is live but empty (checked Aug 2026); the Town Clerk Agenda Center category carries this material instead.',
  },

  {
    id: `${JURISDICTION}:calendar`,
    jurisdiction: JURISDICTION,
    label: 'Town calendar (posted meeting notices)',
    adapter: 'rss',
    url: `${MILTON_BASE}/RSSFeed.aspx?ModID=${MODULES.calendar}&CID=All-calendar.xml`,
    level: 'municipal',
    agency: 'Town of Milton',
    channel: 'meetings',
    eventType: 'meeting_notice',
    priority: 'high',
    tier: 1,
    precedence: 40,
    confidence: 'verified',
    // Verified as reachable and well-formed, but the town publishes no items
    // through it — the Agenda Center is where notices actually land. Left
    // registered and off so it is one flag away if the town starts using it.
    enabled: false,
    options: { bodyFromTitlePrefix: true },
    notes:
      'Feed is live but empty (checked Aug 2026). Meeting notices come through the Agenda Center instead. Re-check with `verify --all`.',
  },
];

/**
 * Tier 2 — state systems, queried for this town.
 *
 * Shipped disabled: the URLs are real, but each needs an adapter that can drive
 * a search form rather than read a listing. Turning these on is the next
 * meaningful expansion after Tier 1 is solid.
 */
const tier2: SourceInput[] = [
  {
    id: 'ma:ago:municipal-law-unit',
    jurisdiction: JURISDICTION,
    label: 'AG Municipal Law Unit — bylaw decisions',
    adapter: 'html-links',
    url: 'https://massaqo.onbaseonline.com/Massaqo/1700PublicAccess/MLU.htm',
    level: 'state',
    agency: "Massachusetts Attorney General's Office",
    channel: 'law',
    eventType: 'bylaw_decision',
    priority: 'high',
    tier: 2,
    precedence: 10,
    confidence: 'unverified',
    enabled: false,
    options: { town: 'Milton' },
    notes:
      'Closes the bylaw lifecycle: town meeting adopts → clerk submits within 30 days → AG decides within 90. Needs a form-driving adapter; the page is an OnBase search app.',
  },
  {
    id: 'ma:commbuys',
    jurisdiction: JURISDICTION,
    label: 'COMMBUYS — contracts where Milton is the purchasing org',
    adapter: 'html-links',
    url: 'https://www.commbuys.com/bso/',
    level: 'state',
    agency: 'Commonwealth of Massachusetts',
    channel: 'money',
    eventType: 'bid_posted',
    priority: 'medium',
    tier: 2,
    precedence: 20,
    confidence: 'unverified',
    enabled: false,
    options: { purchasingOrg: 'Town of Milton' },
    notes:
      'Filter by purchasing organization, never ingest the statewide vendor universe. Needs session handling.',
  },
];

export const miltonSources: SourceInput[] = [...tier1, ...tier2];
