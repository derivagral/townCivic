import { Hono } from 'hono';
import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import {
  countEvents,
  facetCounts,
  getEvent,
  latestEventTimestamp,
  listSourceRows,
  queryEvents,
} from '../db/repo.ts';
import type { EventQuery } from '../db/repo.ts';
import { hasSampleData } from '../commands/seed.ts';
import { CHANNEL_DESCRIPTIONS, isChannel } from '../taxonomy.ts';
import { STYLES } from './styles.ts';
import { EMPTY_FILTERS, renderEvent, renderFeedIndex, renderIndex, renderSources } from './views.ts';
import type { Filters } from './views.ts';
import { feedTitle, renderAtom, renderJsonFeed } from './feeds.ts';

const PAGE_SIZE = 60;
const FEED_SIZE = 50;
/**
 * Milton has 78 boards. Listing every one turns the filter rail into a wall, so
 * it shows the most active and says how many it left out.
 */
const FACET_LIMIT = 16;

const JURISDICTION_LABELS: Record<string, string> = {
  'milton-ma': 'Milton, Massachusetts',
};

function labelFor(jurisdiction: string): string {
  return JURISDICTION_LABELS[jurisdiction] ?? jurisdiction;
}

/** Read filters off the query string, ignoring anything that is not a known value. */
function readFilters(url: URL): Filters {
  const get = (key: string) => url.searchParams.get(key)?.trim() || undefined;
  const channel = get('channel');
  const whenRaw = get('when');
  const page = Number(get('page') ?? 1);

  return {
    ...(channel && isChannel(channel) ? { channel } : {}),
    ...(get('source') ? { source: get('source') } : {}),
    ...(get('body') ? { body: get('body') } : {}),
    ...(get('level') ? { level: get('level') } : {}),
    ...(get('q') ? { q: get('q') } : {}),
    when: whenRaw === 'upcoming' || whenRaw === 'past' ? whenRaw : 'all',
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

function toQuery(filters: Filters, jurisdiction: string): EventQuery {
  return {
    jurisdiction,
    ...(filters.channel ? { channels: [filters.channel] } : {}),
    ...(filters.source ? { sources: [filters.source] } : {}),
    ...(filters.body ? { bodies: [filters.body] } : {}),
    ...(filters.level ? { levels: [filters.level] } : {}),
    ...(filters.q ? { q: filters.q } : {}),
  };
}

export interface AppOptions {
  jurisdiction?: string;
  /** Absolute URL this instance is reachable at; used for feed self-links. */
  baseUrl?: string;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const app = new Hono();
  const jurisdiction = options.jurisdiction ?? config.defaultJurisdiction;
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const label = labelFor(jurisdiction);

  /**
   * Keep the selected value visible even when it falls outside the top slice,
   * so an active filter never disappears from the rail that set it.
   */
  const trim = (facets: { value: string; n: number }[], selected?: string) => {
    const head = facets.slice(0, FACET_LIMIT);
    if (selected && !head.some((f) => f.value === selected)) {
      const match = facets.find((f) => f.value === selected);
      if (match) head.push(match);
    }
    return { shown: head, hidden: Math.max(0, facets.length - FACET_LIMIT) };
  };

  app.get('/styles.css', (c) => c.body(STYLES, 200, { 'content-type': 'text/css; charset=utf-8' }));
  app.get('/healthz', (c) => c.json({ ok: true, jurisdiction }));

  app.get('/', (c) => {
    const url = new URL(c.req.url);
    const filters = readFilters(url);
    const base = toQuery(filters, jurisdiction);

    // "All" shows what is coming up, then what already happened. Explicitly
    // choosing a mode collapses to just that half.
    const showUpcoming = filters.when !== 'past';
    const showPast = filters.when !== 'upcoming';

    const upcoming =
      showUpcoming && filters.page === 1 ? queryEvents(db, { ...base, when: 'upcoming', limit: 40 }) : [];
    const past = showPast
      ? queryEvents(db, {
          ...base,
          when: 'past',
          limit: PAGE_SIZE,
          offset: (filters.page - 1) * PAGE_SIZE,
        })
      : [];

    return c.html(
      renderIndex({
        filters,
        upcoming,
        past,
        total: countEvents(db, base),
        facets: {
          sources: trim(
            facetCounts(db, 'source_id', base).map((f) => ({ ...f, label: sourceLabel(db, f.value) })),
            filters.source,
          ),
          bodies: trim(facetCounts(db, 'body', base), filters.body),
          levels: trim(facetCounts(db, 'level', base), filters.level),
        },
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        pageSize: PAGE_SIZE,
        feedUrl: `/feeds/${filters.channel ?? 'all'}.atom`,
      }),
    );
  });

  app.get('/event/:id', (c) => {
    const row = getEvent(db, c.req.param('id'));
    if (!row) return c.notFound();
    return c.html(renderEvent(row, hasSampleData(db), label));
  });

  app.get('/sources', (c) =>
    c.html(renderSources(listSourceRows(db, jurisdiction), hasSampleData(db), label)),
  );

  app.get('/feeds', (c) => c.html(renderFeedIndex(hasSampleData(db), label, baseUrl)));

  app.get('/feeds/:name{.+\\.(atom|json)}', (c) => {
    const name = c.req.param('name');
    const dot = name.lastIndexOf('.');
    const channel = name.slice(0, dot);
    const format = name.slice(dot + 1);
    if (channel !== 'all' && !isChannel(channel)) return c.notFound();

    const url = new URL(c.req.url);
    const filters: Filters = {
      ...EMPTY_FILTERS,
      ...(channel === 'all' ? {} : { channel }),
      ...(url.searchParams.get('source') ? { source: url.searchParams.get('source')! } : {}),
      ...(url.searchParams.get('body') ? { body: url.searchParams.get('body')! } : {}),
      ...(url.searchParams.get('q') ? { q: url.searchParams.get('q')! } : {}),
    };

    const query = toQuery(filters, jurisdiction);
    const rows = queryEvents(db, { ...query, limit: FEED_SIZE });
    const options = {
      title: feedTitle(channel, label),
      subtitle:
        channel === 'all'
          ? 'Primary-source records published by and about this jurisdiction.'
          : (CHANNEL_DESCRIPTIONS[channel] ?? ''),
      selfUrl: `${baseUrl}/feeds/${name}${url.search}`,
      htmlUrl: `${baseUrl}/${channel === 'all' ? '' : `?channel=${channel}`}`,
      baseUrl,
      updated: latestEventTimestamp(db, query),
    };

    return format === 'json'
      ? c.body(renderJsonFeed(rows, options), 200, {
          'content-type': 'application/feed+json; charset=utf-8',
        })
      : c.body(renderAtom(rows, options), 200, {
          'content-type': 'application/atom+xml; charset=utf-8',
        });
  });

  return app;
}

const labelCache = new Map<string, string>();
function sourceLabel(db: Db, sourceId: string): string {
  const cached = labelCache.get(sourceId);
  if (cached) return cached;
  const row = db.prepare('SELECT label FROM sources WHERE id = ?').get(sourceId) as
    { label: string } | undefined;
  const label = row?.label ?? sourceId;
  labelCache.set(sourceId, label);
  return label;
}
