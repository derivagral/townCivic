import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { queryEvents, upsertEvent, upsertSource, countEvents, facetCounts } from '../src/db/repo.ts';
import { normalize } from '../src/pipeline/normalize.ts';
import { classify } from '../src/pipeline/classify.ts';
import { sourceSchema } from '../src/types.ts';
import type { RawItem, SourceDef, SourceInput } from '../src/types.ts';

function source(overrides: Partial<SourceInput> = {}): SourceDef {
  return sourceSchema.parse({
    id: 'milton-ma:test',
    jurisdiction: 'milton-ma',
    label: 'Test',
    adapter: 'rss',
    url: 'https://www.miltonma.gov/feed',
    level: 'municipal',
    agency: 'Town of Milton',
    channel: 'meetings',
    tier: 1,
    ...overrides,
  });
}

const item = (overrides: Partial<RawItem> = {}): RawItem => ({
  title: 'A notice',
  url: 'https://www.miltonma.gov/x/1',
  ...overrides,
});

describe('classification', () => {
  it('lets a board-scoped source keep its channel', () => {
    // A Planning Board hearing about a by-law is still land-use: someone
    // following development should not have to also watch /law.
    const result = classify(
      source({ channel: 'land-use', body: 'Planning Board' }),
      item({ title: 'Public hearing on a proposed zoning by-law amendment, Article 7' }),
    );
    expect(result.channel).toBe('land-use');
    expect(result.tags).toContain('bylaw');
    expect(result.tags).toContain('hearing');
  });

  it('routes items from a broad feed by their text', () => {
    const broad = source({ channel: 'meetings' });
    expect(classify(broad, item({ title: 'Voter registration deadline' })).channel).toBe('elections');
    expect(classify(broad, item({ title: 'Blue Hill Avenue road closure' })).channel).toBe('public-safety');
    expect(classify(broad, item({ title: 'RFP for audit services' })).channel).toBe('money');
  });

  it('does not mistake the Warrant Committee for a Town Meeting warrant', () => {
    // Milton's Warrant Committee is its finance committee.
    const result = classify(source(), item({ title: 'Warrant Committee — FY27 capital plan' }));
    expect(result.channel).toBe('money');
    expect(result.eventType).not.toBe('warrant_article');
  });

  it('still recognizes an actual warrant article', () => {
    const result = classify(source(), item({ title: 'Fall Town Meeting warrant opens for articles' }));
    expect(result.channel).toBe('law');
    expect(result.eventType).toBe('warrant_article');
  });

  it('never lets a text rule overrule an agenda or minutes read off the URL', () => {
    const result = classify(
      source({ body: 'Select Board' }),
      item({
        title: 'Select Board — Agenda, September 1, 2026',
        eventType: 'meeting_agenda',
        summary: 'RFP award',
      }),
    );
    expect(result.eventType).toBe('meeting_agenda');
  });

  it('collapses routine administration to low priority', () => {
    const result = classify(source({ priority: 'medium' }), item({ title: 'One-day liquor license' }));
    expect(result.channel).toBe('admin');
    expect(result.priority).toBe('low');
  });
});

describe('normalize', () => {
  it('gives the same artifact one id across different sources', () => {
    const fromIndex = normalize(
      source({ id: 'milton-ma:agenda:index', precedence: 20 }),
      item({ externalId: 'agenda-center:agenda:7431' }),
    );
    const fromBoard = normalize(
      source({ id: 'milton-ma:agenda:planning-board', precedence: 10 }),
      item({ externalId: 'agenda-center:agenda:7431' }),
    );
    expect(fromIndex.id).toBe(fromBoard.id);
  });

  it('keeps different jurisdictions apart', () => {
    const a = normalize(source({ jurisdiction: 'milton-ma' }), item({ externalId: 'bid:42' }));
    const b = normalize(source({ jurisdiction: 'quincy-ma' }), item({ externalId: 'bid:42' }));
    expect(a.id).not.toBe(b.id);
  });

  it('canonicalizes body aliases', () => {
    const event = normalize(
      source({ options: { bodyFromTitlePrefix: true } }),
      item({ title: 'Zoning Board of Appeals — public hearing' }),
    );
    expect(event.body).toBe('Board of Appeals');
  });

  it('only reads a body out of the title where the source opts in', () => {
    const event = normalize(source(), item({ title: 'Blue Hill Avenue water main work — road closure' }));
    expect(event.body).toBeNull();
  });

  it('changes the content hash when something a reader would notice changes', () => {
    const before = normalize(source(), item({ title: 'Hearing on Sept 9' }));
    const after = normalize(source(), item({ title: 'Hearing continued to Sept 23' }));
    expect(before.contentHash).not.toBe(after.contentHash);
  });
});

describe('storage', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    // `events.source_id` is a foreign key, so the registry has to exist first.
    for (const id of ['milton-ma:test', 'milton-ma:agenda:index', 'milton-ma:agenda:planning-board']) {
      upsertSource(db, source({ id, precedence: id.endsWith('index') ? 20 : 10 }));
    }
  });

  const boardEvent = () =>
    normalize(
      source({
        id: 'milton-ma:agenda:planning-board',
        precedence: 10,
        body: 'Planning Board',
        channel: 'land-use',
      }),
      item({ externalId: 'agenda-center:agenda:7431', title: 'Planning Board — Agenda' }),
    );
  const indexEvent = () =>
    normalize(
      source({ id: 'milton-ma:agenda:index', precedence: 20 }),
      item({ externalId: 'agenda-center:agenda:7431', title: 'Index copy' }),
    );

  it('reports an unchanged re-fetch as unchanged', () => {
    expect(upsertEvent(db, boardEvent())).toBe('new');
    expect(upsertEvent(db, boardEvent())).toBe('unchanged');
  });

  it('records an in-place edit as a revision', () => {
    upsertEvent(db, boardEvent());
    const amended = normalize(
      source({ id: 'milton-ma:agenda:planning-board', precedence: 10, body: 'Planning Board' }),
      item({ externalId: 'agenda-center:agenda:7431', title: 'Planning Board — Agenda (amended)' }),
    );
    expect(upsertEvent(db, amended)).toBe('revised');
    expect(queryEvents(db)[0]!.revision).toBe(2);
  });

  it('lets the more authoritative source take a record over', () => {
    expect(upsertEvent(db, indexEvent())).toBe('new');
    expect(upsertEvent(db, boardEvent())).toBe('revised');
    expect(queryEvents(db)[0]!.source_id).toBe('milton-ma:agenda:planning-board');
  });

  it('refuses to let a weaker source overwrite a stronger one', () => {
    upsertEvent(db, boardEvent());
    expect(upsertEvent(db, indexEvent())).toBe('duplicate');

    const row = queryEvents(db)[0]!;
    expect(row.source_id).toBe('milton-ma:agenda:planning-board');
    expect(row.title).toBe('Planning Board — Agenda');
    // A duplicate must not inflate the revision count.
    expect(row.revision).toBe(1);
  });

  it('is order-independent, so repeated ingests do not flip ownership', () => {
    upsertEvent(db, indexEvent());
    upsertEvent(db, boardEvent());
    upsertEvent(db, indexEvent());
    upsertEvent(db, boardEvent());
    expect(countEvents(db)).toBe(1);
    expect(queryEvents(db)[0]!.source_id).toBe('milton-ma:agenda:planning-board');
  });

  it('hides routine administration unless it is asked for', () => {
    upsertEvent(
      db,
      normalize(source({ channel: 'admin' }), item({ externalId: 'a', title: 'Raffle permit' })),
    );
    upsertEvent(db, boardEvent());

    expect(countEvents(db)).toBe(1);
    expect(countEvents(db, { includeAdmin: true })).toBe(2);
    expect(countEvents(db, { channels: ['admin'] })).toBe(1);
  });

  it('searches across title and body text', () => {
    upsertEvent(
      db,
      normalize(source(), item({ externalId: 'a', title: 'Special permit for 14 Adams Street' })),
    );
    upsertEvent(db, normalize(source(), item({ externalId: 'b', title: 'Hydrant flushing schedule' })));

    expect(queryEvents(db, { q: 'Adams' })).toHaveLength(1);
    expect(queryEvents(db, { q: 'flushing' })).toHaveLength(1);
    // A search box must not be able to throw an FTS syntax error.
    expect(() => queryEvents(db, { q: 'permit "AND (' })).not.toThrow();
  });

  it('counts facets without collapsing the facet it is counting', () => {
    upsertEvent(db, boardEvent());
    upsertEvent(db, normalize(source({ channel: 'money' }), item({ externalId: 'z', title: 'RFP' })));

    const channels = facetCounts(db, 'channel', { channels: ['land-use'] });
    expect(channels.map((c) => c.value).sort()).toEqual(['land-use', 'money']);
  });

  it('sorts by when the thing happens, not when it was filed', () => {
    upsertEvent(
      db,
      normalize(
        source(),
        item({ externalId: 'old-meeting', title: 'Old', occurredAt: new Date('2026-01-05T12:00:00Z') }),
      ),
    );
    upsertEvent(
      db,
      normalize(
        source(),
        item({ externalId: 'new-meeting', title: 'New', occurredAt: new Date('2026-08-05T12:00:00Z') }),
      ),
    );
    expect(queryEvents(db).map((r) => r.title)).toEqual(['New', 'Old']);
  });
});
