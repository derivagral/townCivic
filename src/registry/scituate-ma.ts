import { defineJurisdiction } from './profile.ts';
import { civicPlusSources } from './civicplus.ts';
import type { AgendaCategory, CivicPlusModules } from './civicplus.ts';

/**
 * Scituate, Massachusetts.
 *
 * Another Agenda-Center-only install, like Weymouth: `/rss.aspx` and
 * `/bids.aspx` both return 404, so there are no module ids to record and no
 * procurement page to register. Its Agenda Center index uses the linked layout,
 * so the category ids and slugs below are the site's own rather than derived.
 *
 * Two things a reader should know about the curation:
 *
 *   - The **Advisory Committee** is Scituate's finance committee, the way Hull's
 *     is an Advisory Board and Milton's is a Warrant Committee. It gets a
 *     town-specific rule below, because a bare "advisory committee" cannot be
 *     assumed to mean money anywhere else — most towns have a dozen advisory
 *     committees about everything but the budget.
 *   - There is **no School Committee category**. The school department publishes
 *     its meetings elsewhere, so the schools channel will look empty here until
 *     a source for it is found. That is a gap in coverage, not in the town.
 */

export const SCITUATE_BASE = 'https://www.scituatema.gov';

/**
 * No RSS modules are published by this install. Recorded as an explicit empty
 * object: "we looked and there were none" is a different statement from "nobody
 * has looked yet".
 */
export const MODULES: CivicPlusModules = {};

/**
 * The boards worth following first, out of the 44 categories `discover` found.
 *
 * The coastal bodies — Coastal Advisory Commission, Waterways, Water Resources —
 * are in the curated set for the same reason Hull's stormwater bodies are: on
 * this coast they are where the consequential decisions get made.
 */
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = [
  { slug: 'Select-Board', cid: 37, body: 'Select Board' },
  { slug: 'Advisory-Committee', cid: 3, body: 'Advisory Committee' },
  { slug: 'Planning-Board', cid: 33, body: 'Planning Board' },
  { slug: 'Zoning-Board-of-Appeals', cid: 15, body: 'Zoning Board of Appeals' },
  { slug: 'Conservation-Commission', cid: 16, body: 'Conservation Commission' },
  { slug: 'Board-of-Health', cid: 8, body: 'Board of Health' },
  { slug: 'Town-Clerk', cid: 27, body: 'Town Clerk' },
  { slug: 'Community-Preservation-Committee', cid: 14, body: 'Community Preservation Committee' },
  { slug: 'Capital-Planning-Committee', cid: 10, body: 'Capital Planning Committee' },
  { slug: 'Bylaw-Review-Committee', cid: 9, body: 'Bylaw Review Committee' },
  { slug: 'Board-of-Assessors', cid: 5, body: 'Board of Assessors' },
  { slug: 'Historical-Commission', cid: 26, body: 'Historical Commission' },
  { slug: 'Affordable-Housing-Trust', cid: 4, body: 'Affordable Housing Trust' },
  { slug: 'Coastal-Advisory-Commission', cid: 11, body: 'Coastal Advisory Commission' },
  { slug: 'Water-Resources-Commission', cid: 22, body: 'Water Resources Commission' },
  { slug: 'Waterways-Commission', cid: 20, body: 'Waterways Commission' },
];

export const scituateProfile = defineJurisdiction({
  id: 'scituate-ma',
  name: 'Scituate',
  baseUrl: SCITUATE_BASE,
  boundary: { provider: 'massgis', townName: 'SCITUATE' },
  // Superseded by the committed MassGIS outline.
  bbox: { south: 42.14, west: -70.83, north: 42.26, east: -70.68 },
  bodyRules: [
    // The finance committee, under a name that means nothing of the kind
    // elsewhere. Anchored so that "Coastal Advisory Commission" and the rest of
    // the town's advisory bodies are untouched.
    { pattern: /^advisory committee$/i, channel: 'money', priority: 'high' },
    { pattern: /coastal|waterways|harbor/i, channel: 'land-use', priority: 'medium' },
  ],
  // Town Hall and the Public Safety Complex. Unconfirmed against a Scituate
  // notice PDF until `extract` has run.
  venueAddresses: ['600 Chief Justice Cushing Highway', '800 Chief Justice Cushing Highway'],
  notes: 'CivicPlus, Agenda Center only: no RSS modules, no bids page, and no School Committee category.',
});

scituateProfile.sources = civicPlusSources(scituateProfile, {
  modules: MODULES,
  agendaCategories: AGENDA_CATEGORIES,
  // Both 404 on this install.
  bids: false,
  feeds: [],
  confidence: 'verified',
  enabled: true,
});
