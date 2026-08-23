import { createHash } from 'node:crypto';
import type { NormalizedEvent, RawItem, SourceDef } from '../types.ts';
import { classify } from './classify.ts';
import { extractSubjects, truncate } from '../util/text.ts';
import { canonicalBody, classifyBody } from '../registry/milton-ma.ts';

/**
 * Stable identity for an item.
 *
 * Keyed on the jurisdiction and the artifact's own id — not on the source — so
 * the same agenda PDF seen on a board's page and on the Agenda Center index
 * collapses into one record. Adapters namespace their ids (`agenda-center:…`,
 * `bid:…`) or fall back to the URL, all of which are unique within a town.
 */
export function eventId(jurisdiction: string, externalId: string): string {
  return createHash('sha256').update(`${jurisdiction}|${externalId}`).digest('hex').slice(0, 32);
}

/** Hash of the fields a reader would notice changing. Drives revision detection. */
export function contentHash(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

const toIso = (value: Date | undefined): string | null => {
  if (!value) return null;
  const time = value.getTime();
  return Number.isNaN(time) ? null : value.toISOString();
};

/** "Planning Board — regular meeting" → "Planning Board". */
function titlePrefixBody(title: string): string | undefined {
  const match = /^(.{3,60}?)\s+[—–-]\s+/.exec(title);
  return match?.[1];
}

/**
 * Work out which public body a record belongs to.
 *
 * In order of trust: what the adapter read off the page, what the source is
 * declared to cover, and — only where a source opts in — the title's prefix.
 * That last one is off by default because a headline like "Blue Hill Avenue
 * water main work — road closure" would otherwise invent a board.
 */
function resolveBody(source: SourceDef, item: RawItem): string | null {
  const fromAdapter = typeof item.extra?.['board'] === 'string' ? (item.extra['board'] as string) : undefined;
  const raw =
    fromAdapter ??
    source.body ??
    (source.options['bodyFromTitlePrefix'] ? titlePrefixBody(item.title) : undefined);
  return raw ? canonicalBody(raw) : null;
}

export function normalize(source: SourceDef, item: RawItem): NormalizedEvent {
  const body = resolveBody(source, item);

  // A source that covers one board already answers the channel question. For a
  // site-wide feed the board name is the better signal than the source default,
  // so a Planning Board agenda found on the index lands in land-use just as it
  // would have from the board's own page.
  const derived = body && !source.body ? classifyBody(body) : null;
  const scoped: RawItem = derived ? { ...item, channel: item.channel ?? derived.channel } : item;

  const { channel, eventType, priority, tags } = classify(source, scoped);

  const externalId = item.externalId ?? item.url;
  const occurredAt = toIso(item.occurredAt);
  const publishedAt = toIso(item.publishedAt);
  const summary = item.summary ? truncate(item.summary, 400) : null;

  // Adapter-supplied subjects win; otherwise take a pass over the text.
  const subjects = item.subjects?.length
    ? item.subjects
    : extractSubjects(`${item.title} ${item.summary ?? ''}`);

  return {
    id: eventId(source.jurisdiction, externalId),
    jurisdiction: source.jurisdiction,
    sourceId: source.id,
    level: source.level,
    agency: source.agency,
    body,
    channel,
    eventType,
    priority,
    title: truncate(item.title, 300),
    summary,
    url: item.url,
    documentUrl: item.documentUrl ?? null,
    occurredAt,
    publishedAt,
    subjects,
    tags,
    precedence: source.precedence,
    contentHash: contentHash({
      title: item.title,
      summary,
      url: item.url,
      documentUrl: item.documentUrl ?? null,
      occurredAt,
      publishedAt,
      channel,
      eventType,
      subjects,
    }),
    raw: { ...(item.extra ?? {}), externalId },
  };
}
