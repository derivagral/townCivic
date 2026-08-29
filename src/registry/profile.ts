import type { SourceInput } from '../types.ts';
import type { BoundingBox } from '../geo/project.ts';
import type { Channel, Priority } from '../taxonomy.ts';

/**
 * Everything the pipeline needs to know about one town.
 *
 * Until now this knowledge lived in `milton-ma.ts` as module-level exports, and
 * four other modules imported them directly — `normalize`, `extract`,
 * `meeting-notice` and `discover` all called `canonicalBody()` with no way to
 * ask *whose* body names they were canonicalizing. That is fine for one town and
 * silently wrong for two: Hull's "Board of Health" would be read through
 * Milton's alias table, and every Weymouth notice would be checked against
 * Milton's town hall addresses.
 *
 * So a jurisdiction is now a value. A town is a file that exports one of these,
 * a line in `REGISTRY`, and nothing else — no code path knows a town by name.
 *
 * The shape is deliberately data, not behaviour: patterns and lookup tables
 * rather than functions, so a profile can be printed, diffed in review, and one
 * day loaded from somewhere other than a TypeScript module.
 */

/** How a public body's name maps into the taxonomy. First match wins. */
export interface BodyRule {
  pattern: RegExp;
  channel: Channel;
  priority: Priority;
}

/** Where the town's outline comes from. Only MassGIS is implemented. */
export interface BoundarySource {
  provider: 'massgis';
  /** Town name as the layer spells it, upper case. */
  townName: string;
  url?: string;
}

export interface JurisdictionProfile {
  /** Stable id, and the value in `events.jurisdiction`. */
  id: string;
  /** The town's own name: "Milton". Used to qualify addresses for the geocoder. */
  name: string;
  /** How the UI says it: "Milton, Massachusetts". */
  label: string;
  state: string;
  timeZone: string;
  /**
   * The platform the town's site runs on. `discover` only knows how to probe
   * CivicPlus; anything else has to be registered by hand.
   */
  platform: 'civicplus' | 'other';
  baseUrl: string;
  boundary: BoundarySource | null;
  /**
   * The fence `geocode` uses when no outline has been fetched yet. Padded
   * outwards — it exists to reject an answer in another state, not to draw a
   * border. The committed boundary supersedes it.
   */
  bbox: BoundingBox;
  /** Spellings that mean the same body, lower-cased on the left. */
  bodyAliases: Record<string, string>;
  bodyRules: BodyRule[];
  /**
   * Municipal buildings, which are where meetings happen rather than what they
   * are about. Without these every record in town lists the clerk's address as
   * a subject, because it is printed on the notice template.
   */
  venueAddresses: string[];
  sources: SourceInput[];
  /** Fixture file per source id, for `seed`. Relative to `fixtures/`. */
  fixtures: Record<string, string>;
  notes?: string;
}

/**
 * Committee names in Massachusetts are close to standardized — the enabling
 * statutes name most of these bodies — so the classification that used to sit
 * in the Milton module is the default for every town, and a profile overrides
 * only where its town is unusual.
 */
export const DEFAULT_BODY_RULES: BodyRule[] = [
  { pattern: /planning board|master plan/i, channel: 'land-use', priority: 'high' },
  { pattern: /board of appeals|zoning|zba/i, channel: 'land-use', priority: 'high' },
  { pattern: /conservation|open space/i, channel: 'land-use', priority: 'high' },
  { pattern: /design review|historic|sign review/i, channel: 'land-use', priority: 'medium' },
  { pattern: /housing|affordable/i, channel: 'land-use', priority: 'high' },
  {
    pattern:
      /warrant committee|advisory board|finance|capital|budget|appropriat|audit|assessors|retirement|taxation|pilot/i,
    channel: 'money',
    priority: 'high',
  },
  { pattern: /procurement|purchasing|bid|rfp|community preservation/i, channel: 'money', priority: 'high' },
  // `ordinance` is here because a city's ordinances are a town's by-laws, and
  // the towns this covers include both forms of government.
  {
    pattern: /town meeting|by-?law|ordinance|charter|town government study/i,
    channel: 'law',
    priority: 'high',
  },
  { pattern: /school|education|curriculum/i, channel: 'schools', priority: 'high' },
  {
    pattern: /registrar|election|town clerk|city clerk|electronic voting/i,
    channel: 'elections',
    priority: 'high',
  },
  {
    pattern: /board of health|water|sewer|public works|dpw|traffic|police|fire|emergency|animal/i,
    channel: 'public-safety',
    priority: 'medium',
  },
  {
    pattern: /select board|selectmen|town administrator|town council|city council|mayor|personnel/i,
    channel: 'meetings',
    priority: 'high',
  },
  {
    pattern:
      /library|recreation|park|council on aging|cemetery|cultural|veterans|youth|coalition|anniversary/i,
    channel: 'admin',
    priority: 'low',
  },
];

/**
 * Aliases that hold anywhere in the state, because they come from the statute
 * or from universal local usage: a "Zoning Board of Appeals" and a "Board of
 * Appeals" are the same board in every town that has one.
 */
export const DEFAULT_BODY_ALIASES: Record<string, string> = {
  'zoning board of appeals': 'Board of Appeals',
  zba: 'Board of Appeals',
  'conservation comm': 'Conservation Commission',
  concom: 'Conservation Commission',
  'community preservation committee (cpc)': 'Community Preservation Committee',
  'board of selectmen': 'Select Board',
  selectboard: 'Select Board',
};

export interface JurisdictionInput extends Partial<
  Omit<JurisdictionProfile, 'id' | 'name' | 'baseUrl' | 'bbox'>
> {
  id: string;
  name: string;
  baseUrl: string;
  bbox: BoundingBox;
}

/**
 * Fill in everything a town does not have to say for itself.
 *
 * Body rules and aliases are *extended* rather than replaced: a town adds the
 * names peculiar to it and inherits the rest, and its own rules are tried first
 * so an override actually overrides.
 */
export function defineJurisdiction(input: JurisdictionInput): JurisdictionProfile {
  return {
    label: `${input.name}, Massachusetts`,
    state: 'MA',
    timeZone: 'America/New_York',
    platform: 'civicplus',
    boundary: null,
    venueAddresses: [],
    sources: [],
    fixtures: {},
    ...input,
    bodyAliases: { ...DEFAULT_BODY_ALIASES, ...(input.bodyAliases ?? {}) },
    bodyRules: [...(input.bodyRules ?? []), ...DEFAULT_BODY_RULES],
  };
}

/**
 * The profile used for a jurisdiction the registry has never heard of.
 *
 * Rows outlive registries: a town removed from `REGISTRY`, or a database
 * restored from an older build, still has events in it and the UI still has to
 * render them. Degrading to the statewide defaults is better than throwing, and
 * `status` reports such rows as orphans so they get cleaned up deliberately.
 */
export function unknownJurisdiction(id: string): JurisdictionProfile {
  return defineJurisdiction({
    id,
    name: id,
    label: id,
    platform: 'other',
    baseUrl: 'https://example.invalid',
    bbox: MASSACHUSETTS_BBOX,
  });
}

/**
 * The whole state, padded. Used only as the last fence for a jurisdiction with
 * neither a committed outline nor a declared box — wide enough to be nearly
 * useless as a filter, which is the honest behaviour when nothing is known.
 */
export const MASSACHUSETTS_BBOX: BoundingBox = {
  south: 41.18,
  west: -73.55,
  north: 42.92,
  east: -69.85,
};

/** Collapse the spellings of one body into the name the filter rail shows. */
export function canonicalBody(profile: JurisdictionProfile, name: string): string {
  return profile.bodyAliases[name.trim().toLowerCase()] ?? name.trim();
}

export function classifyBody(
  profile: JurisdictionProfile,
  name: string,
): { channel: Channel; priority: Priority } {
  for (const rule of profile.bodyRules) {
    if (rule.pattern.test(name)) return { channel: rule.channel, priority: rule.priority };
  }
  return { channel: 'meetings', priority: 'medium' };
}

/** True when an address is a municipal building rather than a subject. */
export function isVenueAddress(profile: JurisdictionProfile, address: string): boolean {
  const normalized = address
    .toLowerCase()
    .replace(/\bave\b\.?/g, 'avenue')
    .replace(/\bst\b\.?/g, 'street');
  return profile.venueAddresses.some((venue) => normalized.startsWith(venue.toLowerCase()));
}
