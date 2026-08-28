import type { EventRow } from '../db/repo.ts';
import { CHANNEL_LABELS, EVENT_TYPE_LABELS } from '../taxonomy.ts';
import type { Channel } from '../taxonomy.ts';
import { escapeHtml } from './views.ts';

export interface FeedOptions {
  title: string;
  subtitle: string;
  /** Absolute URL of this feed. */
  selfUrl: string;
  /** Absolute URL of the equivalent web page. */
  htmlUrl: string;
  baseUrl: string;
  updated: string | null;
  /**
   * Per-record explanations, keyed by event id.
   *
   * A ranked or rule-matched feed has to carry its reason into the reader's
   * feed reader, not just onto the web page — otherwise the one place a curated
   * record is least explicable is the place most people will actually read it.
   */
  notes?: Map<string, string>;
}

/** Stable, opaque, non-URL entry identity — the point of a tag/urn id. */
function entryId(row: EventRow): string {
  return `urn:towncivic:${row.jurisdiction}:${row.id}`;
}

function entryDate(row: EventRow): string {
  return row.occurred_at ?? row.published_at ?? row.first_seen_at;
}

function summaryText(row: EventRow, note?: string): string {
  const parts = [row.summary ?? ''];
  const kind = EVENT_TYPE_LABELS[row.event_type as keyof typeof EVENT_TYPE_LABELS] ?? row.event_type;
  parts.push(`${kind} · ${row.body ?? row.agency}`);
  if (note) parts.push(note);
  return parts.filter(Boolean).join(' — ');
}

export function renderAtom(rows: EventRow[], options: FeedOptions): string {
  const updated = options.updated ?? new Date().toISOString();

  const entries = rows
    .map((row) => {
      const subjects = safeArray(row.subjects);
      const categories = [row.channel, ...subjects]
        .map((term) => `    <category term="${escapeHtml(term)}"/>`)
        .join('\n');
      return `  <entry>
    <id>${escapeHtml(entryId(row))}</id>
    <title>${escapeHtml(row.title)}</title>
    <link rel="alternate" type="text/html" href="${escapeHtml(row.url)}"/>
    <link rel="related" type="text/html" href="${escapeHtml(`${options.baseUrl}/event/${row.id}`)}"/>
    <updated>${escapeHtml(row.last_seen_at)}</updated>
    <published>${escapeHtml(entryDate(row))}</published>
    <author><name>${escapeHtml(row.agency)}</name></author>
${categories}
    <summary type="text">${escapeHtml(summaryText(row, options.notes?.get(row.id)))}</summary>
  </entry>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeHtml(options.selfUrl)}</id>
  <title>${escapeHtml(options.title)}</title>
  <subtitle>${escapeHtml(options.subtitle)}</subtitle>
  <updated>${escapeHtml(updated)}</updated>
  <link rel="self" type="application/atom+xml" href="${escapeHtml(options.selfUrl)}"/>
  <link rel="alternate" type="text/html" href="${escapeHtml(options.htmlUrl)}"/>
  <generator uri="https://github.com/derivagral/towncivic">townCivic</generator>
${entries}
</feed>
`;
}

export function renderJsonFeed(rows: EventRow[], options: FeedOptions): string {
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: options.title,
      description: options.subtitle,
      home_page_url: options.htmlUrl,
      feed_url: options.selfUrl,
      items: rows.map((row) => ({
        id: entryId(row),
        url: row.url,
        external_url: row.document_url ?? undefined,
        title: row.title,
        summary: summaryText(row, options.notes?.get(row.id)),
        content_text: row.summary ?? row.title,
        date_published: entryDate(row),
        date_modified: row.last_seen_at,
        authors: [{ name: row.agency }],
        tags: [row.channel, ...safeArray(row.tags), ...safeArray(row.subjects)],
        _towncivic: {
          jurisdiction: row.jurisdiction,
          source_id: row.source_id,
          source_level: row.level,
          source_agency: row.agency,
          body: row.body,
          channel: row.channel,
          event_type: row.event_type,
          priority: row.priority,
          occurred_at: row.occurred_at,
          published_at: row.published_at,
          revision: row.revision,
          permalink: `${options.baseUrl}/event/${row.id}`,
        },
      })),
    },
    null,
    2,
  );
}

function safeArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function feedTitle(channel: string, jurisdictionLabel: string): string {
  if (channel === 'all') return `${jurisdictionLabel} — all civic records`;
  return `${jurisdictionLabel} — ${CHANNEL_LABELS[channel as Channel] ?? channel}`;
}
