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
 * The fullest install of the seven, and the first where every module the
 * platform offers is not only published but populated. `discover` found 39
 * Agenda Center categories and eight RSS modules.
 *
 * The thing that makes this town's record shaped differently from the others:
 * **the Town Council does its work in twelve standing committees**, each with
 * its own Agenda Center category — Ways & Means, Ordinance & Rules, Public
 * Works, a Zoning Work Group. Under a town-meeting government most of that
 * happens in a warrant committee and a floor debate that produce one record
 * between them. Here it produces twelve streams, and the two that decide things
 * — Ways & Means for money, Ordinance & Rules for by-laws — are curated below
 * while the rest come in through the site-wide index.
 */

export const BRAINTREE_BASE = 'https://www.braintreema.gov';

/**
 * Read off `/rss.aspx`, not guessed. The numbering matches Milton's and Hull's,
 * which is the platform's default and still not something to rely on — Weymouth
 * and Scituate publish no modules at all.
 *
 *    ModID=1   News Flash        ModID=63  Alert Center
 *    ModID=51  Blog              ModID=65  Agenda Center
 *    ModID=53  Photo Gallery     ModID=66  Jobs
 *    ModID=58  Calendar          ModID=76  Pages
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
 * The boards worth following first, out of the 39 categories `discover` found.
 *
 * Two notes on the curation:
 *
 *   - **No School Committee.** Braintree's schools publish their agendas on a
 *     district site outside this domain, so the `schools` channel here carries
 *     the School Building Committee and the Council's Education & Library
 *     Committee and not the committee itself. A gap in coverage, not in the
 *     town — the same shape as Scituate's.
 *   - **Public Meeting Notices** (cid 21) is a category the other six installs
 *     do not have: the clerk posts open-meeting notices into it directly. Worth
 *     following for the same reason Hull's posted-meetings calendar would be if
 *     it had anything in it.
 *
 * `verify` fetched and parsed every one of these (Sep 2026). Two answered with
 * nothing in them — the Board of Assessors and the Retirement Board, whose
 * listings hold roughly a year and who have posted nothing in that year. Left
 * enabled rather than dropped: an empty listing is a fact about this year, not
 * about the URL, and it costs one conditional request.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  { slug: 'Town-Council', cid: 6, body: 'Town Council' },
  { slug: 'Planning-Board', cid: 7, body: 'Planning Board' },
  { slug: 'Zoning-Board-of-Appeals', cid: 3, body: 'Zoning Board of Appeals' },
  { slug: 'Conservation-Commission', cid: 4, body: 'Conservation Commission' },
  { slug: 'Board-of-Health', cid: 14, body: 'Board of Health' },
  { slug: 'Town-Council-Ways-Means-Committee', cid: 23, body: 'Town Council - Ways & Means Committee' },
  {
    slug: 'Town-Council-Ordinance-Rules-Committee',
    cid: 24,
    body: 'Town Council - Ordinance & Rules Committee',
  },
  {
    slug: 'Town-Council-Zoning-Work-Group-Agendas',
    cid: 38,
    body: 'Town Council - Zoning Work Group Agendas',
  },
  { slug: 'Community-Preservation-Committee', cid: 2, body: 'Community Preservation Committee' },
  { slug: 'Board-of-Assessors', cid: 17, body: 'Board of Assessors' },
  { slug: 'Retirement-Board', cid: 10, body: 'Retirement Board' },
  { slug: 'Charter-Review-Committee', cid: 39, body: 'Charter Review Committee' },
  { slug: 'Historical-Commission', cid: 5, body: 'Historical Commission' },
  { slug: 'Master-Plan-Steering-Committee', cid: 41, body: 'Master Plan Steering Committee' },
  { slug: 'School-Building-Committee', cid: 40, body: 'School Building Committee' },
  { slug: 'Board-of-Registrars', cid: 18, body: 'Board of Registrars' },
  { slug: 'Board-of-License-Commissioners', cid: 35, body: 'Board of License Commissioners' },
  { slug: 'Tri-Town-Board-of-Water-Commissioners', cid: 36, body: 'Tri-Town Board of Water Commissioners' },
  { slug: 'Public-Meeting-Notices', cid: 21, body: 'Public Meeting Notices' },
];

export const braintreeProfile = defineJurisdiction({
  id: 'braintree-ma',
  name: 'Braintree',
  boundary: { provider: 'massgis', townName: 'BRAINTREE' },
  baseUrl: BRAINTREE_BASE,
  // Superseded by the committed MassGIS outline. Padded outwards — it exists to
  // reject an answer in Quincy or Randolph, not to draw the border with them.
  bbox: { south: 42.16, west: -71.07, north: 42.27, east: -70.92 },
  bodyAliases: {
    'braintree town council': 'Town Council',
    'office of the mayor': 'Mayor',
    // Two names for one body — the site carries both categories, and the
    // Licensing Board (cid 13) is the older of them.
    'licensing board': 'Board of License Commissioners',
  },
  bodyRules: [
    /**
     * Ways & Means is this Council's finance committee, the way Hull's is an
     * Advisory Board and Scituate's an Advisory Committee. Without this it
     * files as a routine meeting, because the statewide money rule looks for
     * "warrant committee", "financ" and "budget" and the name says none of them.
     */
    { pattern: /ways (&|and) means/i, channel: 'money', priority: 'high' },
  ],
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
    'The fullest CivicPlus install of the seven: 39 Agenda Center categories, every RSS module populated, and a Town Council that works through twelve standing committees.',
});

braintreeProfile.sources = civicPlusSources(braintreeProfile, {
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
      enabled: true,
    },
    {
      key: 'alerts',
      label: 'Town emergency alerts',
      modId: MODULES.alertCenter!,
      cid: 'Town-Emergency-Alerts-6',
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
