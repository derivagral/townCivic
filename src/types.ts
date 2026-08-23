import { z } from 'zod';
import { CHANNELS, EVENT_TYPES, LEVELS, PRIORITIES, TIERS } from './taxonomy.ts';
import type { Channel, EventType, Level, Priority, Tier } from './taxonomy.ts';

export const ADAPTERS = ['rss', 'civicplus-agenda-center', 'civicplus-bids', 'html-links'] as const;
export type AdapterName = (typeof ADAPTERS)[number];

/**
 * How sure we are the URL is real and shaped the way the adapter expects.
 *
 *   verified   — confirmed against the live site
 *   probable   — the platform's documented pattern, host/path confirmed, not yet fetched
 *   unverified — inferred; `towncivic discover` or `verify` should confirm or replace it
 */
export const CONFIDENCES = ['verified', 'probable', 'unverified'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const sourceSchema = z.object({
  /** Stable slug, e.g. `milton-ma:select-board:agendas`. Used as a foreign key everywhere. */
  id: z.string().min(1),
  jurisdiction: z.string().min(1),
  label: z.string().min(1),
  adapter: z.enum(ADAPTERS),
  url: z.string().url(),
  level: z.enum(LEVELS),
  /** Publishing agency, e.g. "Milton Planning Board". */
  agency: z.string().min(1),
  /** Canonical public body, for grouping a board's agendas and minutes together. */
  body: z.string().optional(),
  /** Default channel for items from this source; classifiers may override per item. */
  channel: z.enum(CHANNELS),
  /** Default event type when the adapter cannot tell. */
  eventType: z.enum(EVENT_TYPES).optional(),
  priority: z.enum(PRIORITIES).default('medium'),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /**
   * Which source wins when two of them publish the same artifact. Lower is more
   * authoritative. A board's own listing (10) beats the site-wide index (20),
   * which beats a peripheral account (90) — the official PDF is the record even
   * when a Facebook post got there first.
   */
  precedence: z.number().int().default(50),
  confidence: z.enum(CONFIDENCES).default('unverified'),
  enabled: z.boolean().default(true),
  /** Adapter-specific knobs (CSS selectors, CivicPlus category ids, ...). */
  options: z.record(z.unknown()).default({}),
  notes: z.string().optional(),
});

export type SourceDef = z.infer<typeof sourceSchema>;
export type SourceInput = z.input<typeof sourceSchema>;

/**
 * What an adapter produces. Deliberately close to what a municipal listing
 * actually gives you: a title, a link, a couple of dates.
 */
export interface RawItem {
  /** Source-local stable id (guid, file id, permalink). Falls back to the url. */
  externalId?: string;
  title: string;
  summary?: string;
  /** Canonical human-facing page for this item. */
  url: string;
  /** The underlying artifact (usually a PDF) when the listing links one. */
  documentUrl?: string;
  /** When the thing happens or happened (meeting date, hearing date, bid due date). */
  occurredAt?: Date;
  /** When the source published the record. */
  publishedAt?: Date;
  eventType?: EventType;
  channel?: Channel;
  /** Addresses, parcels, docket numbers, article numbers pulled out by the adapter. */
  subjects?: string[];
  /** Anything the adapter saw but the schema has no column for. Kept verbatim. */
  extra?: Record<string, unknown>;
}

/** A `RawItem` after classification and stable-id assignment. Row shape of `events`. */
export interface NormalizedEvent {
  id: string;
  jurisdiction: string;
  sourceId: string;
  level: Level;
  agency: string;
  body: string | null;
  channel: Channel;
  eventType: EventType;
  priority: Priority;
  title: string;
  summary: string | null;
  url: string;
  documentUrl: string | null;
  occurredAt: string | null;
  publishedAt: string | null;
  subjects: string[];
  tags: string[];
  precedence: number;
  contentHash: string;
  raw: Record<string, unknown>;
}

export interface FetchResult {
  sourceId: string;
  url: string;
  ok: boolean;
  status: number;
  /** True when the server answered 304 and we reused the stored body. */
  notModified: boolean;
  body: string;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  error?: string;
}

export interface AdapterContext {
  source: SourceDef;
  /** Resolve a possibly-relative href against the source URL. */
  resolve(href: string): string;
}

export interface Adapter {
  name: AdapterName;
  parse(body: string, ctx: AdapterContext): RawItem[];
}
