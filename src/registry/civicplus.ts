import type { Confidence, SourceInput } from '../types.ts';
import type { JurisdictionProfile } from './profile.ts';
import { canonicalBody, classifyBody } from './profile.ts';

/**
 * Source builders for a CivicPlus CivicEngage install.
 *
 * Weymouth, Hull and Scituate run the same product Milton does, which is the
 * whole reason a second town is cheap: the URL shapes are identical and only
 * the module and category ids differ per install. Those ids are what
 * `towncivic discover` reads off the live site — they are never guessed here.
 *
 * These take the profile rather than a base URL so a source's agency string
 * ("Milton Planning Board") and its channel come out right without every town
 * file repeating the same three lines.
 */

/** CivicPlus module ids. Per-install values; `discover` prints the real ones. */
export interface CivicPlusModules {
  newsFlash?: number;
  blog?: number;
  calendar?: number;
  alertCenter?: number;
  agendaCenter?: number;
  jobs?: number;
  pages?: number;
}

export interface AgendaCategory {
  /** URL slug as the site spells it: `Select-Board`. */
  slug: string;
  /** Agenda Center category id. */
  cid: number;
  /** The board's name, before aliasing. */
  body: string;
}

/** Knobs every builder here accepts, so a whole town can ship disabled. */
export interface SourceDefaults {
  confidence?: Confidence;
  enabled?: boolean;
}

const defaults = (options: SourceDefaults): { confidence: Confidence; enabled: boolean } => ({
  confidence: options.confidence ?? 'unverified',
  // An unverified source stays off. Enabling it is the act that says a human
  // ran `verify` and looked at what came back.
  enabled: options.enabled ?? options.confidence === 'verified',
});

/**
 * One board's agendas and minutes.
 *
 * The HTML listing rather than the matching RSS feed, deliberately: the listing
 * returns roughly a year of agendas and minutes with the meeting date and the
 * agenda/minutes distinction encoded in each href, where the feed returns a
 * single undated item. The feed URL is kept in `options` so it is one edit away
 * if a town's install behaves differently.
 */
export function agendaCenterSource(
  profile: JurisdictionProfile,
  category: AgendaCategory,
  modules: CivicPlusModules,
  options: SourceDefaults = {},
): SourceInput {
  const body = canonicalBody(profile, category.body);
  const { channel, priority } = classifyBody(profile, body);
  return {
    id: `${profile.id}:agenda:${category.slug.toLowerCase()}`,
    jurisdiction: profile.id,
    label: `${body} — agendas & minutes`,
    adapter: 'civicplus-agenda-center',
    url: `${profile.baseUrl}/AgendaCenter/${category.slug}-${category.cid}`,
    level: 'municipal',
    agency: `${profile.name} ${body}`,
    body,
    channel,
    priority,
    tier: 1,
    // A board's own listing outranks the site-wide index for the same file.
    precedence: 10,
    ...defaults(options),
    options: {
      cid: category.cid,
      slug: category.slug,
      ...(modules.agendaCenter
        ? {
            rssFeed: `${profile.baseUrl}/RSSFeed.aspx?ModID=${modules.agendaCenter}&CID=${category.slug}-${category.cid}`,
          }
        : {}),
    },
  };
}

/** The site-wide Agenda Center index: everything the curated list leaves out. */
export function agendaIndexSource(
  profile: JurisdictionProfile,
  options: SourceDefaults & { notes?: string } = {},
): SourceInput {
  return {
    id: `${profile.id}:agenda:index`,
    jurisdiction: profile.id,
    label: 'Agenda Center — all boards (index)',
    adapter: 'civicplus-agenda-center',
    url: `${profile.baseUrl}/AgendaCenter`,
    level: 'municipal',
    agency: `Town of ${profile.name}`,
    channel: 'meetings',
    priority: 'medium',
    tier: 1,
    // Catches boards the curated list omits, but yields to a board's own page.
    precedence: 20,
    ...defaults(options),
    options: { isIndex: true },
    ...(options.notes ? { notes: options.notes } : {}),
  };
}

export function bidsSource(
  profile: JurisdictionProfile,
  options: SourceDefaults & { agency?: string; body?: string; notes?: string } = {},
): SourceInput {
  return {
    id: `${profile.id}:bids`,
    jurisdiction: profile.id,
    label: 'Bids, RFPs and invitations for bid',
    adapter: 'civicplus-bids',
    url: `${profile.baseUrl}/bids.aspx`,
    level: 'municipal',
    agency: options.agency ?? `${profile.name} Procurement Department`,
    body: options.body ?? 'Procurement Department',
    channel: 'money',
    eventType: 'bid_posted',
    priority: 'high',
    tier: 1,
    precedence: 10,
    ...defaults(options),
    ...(options.notes ? { notes: options.notes } : {}),
  };
}

export interface RssFeedInput extends SourceDefaults {
  /** Suffix of the source id: `news`, `alerts:dpw`. */
  key: string;
  label: string;
  modId: number;
  /** The `CID` query value, verbatim as the site publishes it. */
  cid: string;
  channel: SourceInput['channel'];
  eventType?: SourceInput['eventType'];
  priority?: SourceInput['priority'];
  agency?: string;
  body?: string;
  precedence?: number;
  options?: Record<string, unknown>;
  notes?: string;
}

/** Any of the CivicPlus RSS modules: News Flash, Calendar, Alert Center. */
export function rssSource(profile: JurisdictionProfile, input: RssFeedInput): SourceInput {
  return {
    id: `${profile.id}:${input.key}`,
    jurisdiction: profile.id,
    label: input.label,
    adapter: 'rss',
    url: `${profile.baseUrl}/RSSFeed.aspx?ModID=${input.modId}&CID=${input.cid}`,
    level: 'municipal',
    agency: input.agency ?? `Town of ${profile.name}`,
    ...(input.body ? { body: input.body } : {}),
    channel: input.channel,
    ...(input.eventType ? { eventType: input.eventType } : {}),
    priority: input.priority ?? 'medium',
    tier: 1,
    precedence: input.precedence ?? 30,
    ...defaults(input),
    ...(input.options ? { options: input.options } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

/**
 * Tier 2 — state systems, queried for one town.
 *
 * Every town gets its own copy, because the query is per-town even though the
 * system is statewide. That is also why the ids are namespaced by jurisdiction:
 * a bare `ma:commbuys` was unique while there was one town and collides the
 * moment there are two.
 *
 * Shipped disabled everywhere: the URLs are real, but each needs an adapter
 * that can drive a search form rather than read a listing.
 */
export function stateSources(profile: JurisdictionProfile): SourceInput[] {
  return [
    {
      id: `${profile.id}:state:ago-municipal-law`,
      jurisdiction: profile.id,
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
      options: { town: profile.name },
      notes:
        'Closes the bylaw lifecycle: town meeting adopts → clerk submits within 30 days → AG decides within 90. Needs a form-driving adapter; the page is an OnBase search app.',
    },
    {
      id: `${profile.id}:state:commbuys`,
      jurisdiction: profile.id,
      label: `COMMBUYS — contracts where ${profile.name} is the purchasing org`,
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
      options: { purchasingOrg: `Town of ${profile.name}` },
      notes:
        'Filter by purchasing organization, never ingest the statewide vendor universe. Needs session handling.',
    },
  ];
}

export interface CivicPlusSourcesInput extends SourceDefaults {
  modules: CivicPlusModules;
  agendaCategories: readonly AgendaCategory[];
  /**
   * The site-wide Agenda Center index. On by default: `/AgendaCenter` is a
   * platform path rather than a per-install id, so it is the one source that
   * can be registered before `discover` has run — and it is what `discover`
   * reads.
   */
  agendaIndex?: boolean;
  /** Registered when the install publishes a bids module. */
  bids?: boolean;
  /** Extra RSS feeds — news, calendar, alert categories — as `discover` found them. */
  feeds?: RssFeedInput[];
  /** Include the per-town copies of the statewide sources. */
  state?: boolean;
}

/**
 * The whole standard set for a CivicPlus town, in one call.
 *
 * This is what makes adding a town configuration rather than code: a new file
 * declares its ids and calls this. Milton does not use it — it predates the
 * abstraction and carries per-source notes and enabled flags that the generic
 * builder would flatten — which is the intended shape of the seam. A town with
 * anything unusual composes the individual builders instead.
 */
export function civicPlusSources(profile: JurisdictionProfile, input: CivicPlusSourcesInput): SourceInput[] {
  const shared = {
    ...(input.confidence ? { confidence: input.confidence } : {}),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  };

  return [
    ...input.agendaCategories.map((category) => agendaCenterSource(profile, category, input.modules, shared)),
    ...(input.agendaIndex === false ? [] : [agendaIndexSource(profile, shared)]),
    ...(input.bids ? [bidsSource(profile, shared)] : []),
    ...(input.feeds ?? []).map((feed) => rssSource(profile, { ...shared, ...feed })),
    ...(input.state === false ? [] : stateSources(profile)),
  ];
}
