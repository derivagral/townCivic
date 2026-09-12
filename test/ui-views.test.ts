import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { listMatters, listNearbyMatters, searchEvidenceForEvents } from '../src/db/repo.ts';
import { renderMapSvg, renderNearbyBody } from '../src/web/map.ts';
import { EMPTY_FILTERS, renderIndex } from '../src/web/views.ts';

let db: Db;

function addEvent(id: string, title: string, date: string, docText: string): void {
  db.prepare(
    `INSERT INTO events
       (id, jurisdiction, source_id, level, agency, body, channel, event_type, priority,
        title, url, occurred_at, first_seen_at, last_seen_at, content_hash, doc_text)
     VALUES (?, 'milton-ma', 'src', 'municipal', 'Town', 'Planning Board', 'land-use',
             'meeting_minutes', 'high', ?, 'https://example.test', ?, ?, ?, ?, ?)`,
  ).run(id, title, date, date, date, `hash-${id}`, docText);
}

function addMatter(id: string, label: string, date: string, eventCount: number): void {
  db.prepare(
    `INSERT INTO matters
       (id, jurisdiction, kind, key, label, event_count, first_at, last_at, bodies, channels, status, updated_at)
     VALUES (?, 'milton-ma', 'address', ?, ?, ?, ?, ?, '["Planning Board"]',
             '["land-use"]', 'continued', ?)`,
  ).run(id, label.toLowerCase(), label, eventCount, date, date, date);
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sources
       (id, jurisdiction, label, adapter, url, level, agency, channel, priority, tier, confidence)
     VALUES ('src', 'milton-ma', 'Town source', 'test', 'https://example.test', 'municipal',
             'Town', 'land-use', 'high', 1, 'verified')`,
  ).run();
});

describe('Activity search evidence', () => {
  it('returns an official-record snippet before a derived reading', () => {
    addEvent('e1', 'Planning minutes', '2026-05-01T12:00:00Z', 'The hearing at 14 Adams Street continued.');
    db.prepare(
      `INSERT INTO interpretations
       (id, event_id, kind, provider, model, prompt_version, doc_hash, text, created_at)
       VALUES ('i1', 'e1', 'summary', 'rules', NULL, '1', 'hash',
               'A separate Adams Street reading.', '2026-05-02T12:00:00Z')`,
    ).run();

    const [evidence] = searchEvidenceForEvents(db, ['e1'], 'Adams', true);
    expect(evidence?.source).toBe('record');
    expect(evidence?.text).toContain('[[Adams]]');
  });

  it('labels a match found only in interpretation text as derived', () => {
    addEvent('e1', 'Planning minutes', '2026-05-01T12:00:00Z', 'A public hearing continued.');
    db.prepare(
      `INSERT INTO interpretations
       (id, event_id, kind, provider, model, prompt_version, doc_hash, text, created_at)
       VALUES ('i1', 'e1', 'decision', 'rules', NULL, '1', 'hash',
               'The board discussed Adams Street.', '2026-05-02T12:00:00Z')`,
    ).run();

    expect(searchEvidenceForEvents(db, ['e1'], 'Adams', true)[0]).toMatchObject({
      eventId: 'e1',
      source: 'derived',
      kind: 'decision',
    });
  });
});

describe('Nearby and timeline read models', () => {
  it('pairs a mapped matter with its latest record and supports filters', () => {
    addEvent('old', 'Initial application', '2026-04-01T12:00:00Z', 'Filed.');
    addEvent('new', 'Hearing continued', '2026-06-01T12:00:00Z', 'Continued.');
    addMatter('m1', '14 Adams Street', '2026-06-01T12:00:00Z', 2);
    db.prepare(
      `INSERT INTO matter_events (matter_id, event_id, stage, linked_at)
       VALUES ('m1', 'old', 'filed', '2026-04-01'), ('m1', 'new', 'continued', '2026-06-01')`,
    ).run();
    db.prepare(
      `INSERT INTO places (matter_id, lat, lon, matched, provider, geocoded_at)
       VALUES ('m1', 42.25, -71.06, '14 ADAMS ST', 'census', '2026-06-01')`,
    ).run();

    const [row] = listNearbyMatters(db, {
      jurisdiction: 'milton-ma',
      channel: 'land-use',
      status: 'continued',
      q: 'Adams',
    });
    expect(row?.latest_event_id).toBe('new');
    expect(row?.latest_event_title).toBe('Hearing continued');
  });

  it('can order timelines by recency or depth', () => {
    addMatter('recent', '2 New Street', '2026-08-01T12:00:00Z', 2);
    addMatter('deep', '1 Long Street', '2026-06-01T12:00:00Z', 8);
    expect(listMatters(db, { order: 'recent' })[0]?.id).toBe('recent');
    expect(listMatters(db, { order: 'documented' })[0]?.id).toBe('deep');
  });
});

describe('three-view UI', () => {
  const point = {
    matterId: 'm1',
    label: '14 Adams Street',
    lat: 42.25,
    lon: -71.06,
    eventCount: 2,
    status: 'continued',
    channel: 'land-use',
    matched: '14 ADAMS ST',
    latestEventTitle: 'Hearing continued',
    latestEventAt: '2026-06-01T12:00:00Z',
  };

  it('renders the primary Activity, Nearby, and Timelines navigation', () => {
    const html = renderIndex({
      filters: EMPTY_FILTERS,
      upcoming: [],
      past: [],
      total: 0,
      facets: {
        sources: { shown: [], hidden: 0 },
        bodies: { shown: [], hidden: 0 },
        levels: { shown: [], hidden: 0 },
      },
      sampleData: false,
      town: {
        id: 'milton-ma',
        label: 'Milton, Massachusetts',
        options: [{ id: 'milton-ma', label: 'Milton, Massachusetts' }],
        path: '/',
      },
      pageSize: 60,
      feedUrl: '/feeds/all.atom',
      hasDerived: false,
    });
    expect(html).toContain('aria-label="Explore"');
    expect(html).toContain('>Activity</a>');
    expect(html).toContain('>Nearby</a>');
    expect(html).toContain('>Timelines</a>');
  });

  it('keeps pin selection in Nearby and pairs the map with a list', () => {
    const svg = renderMapSvg({
      points: [{ ...point, href: '/nearby?matter=m1' }],
      unplaced: [],
      totalAddresses: 1,
      geocoded: true,
    });
    expect(svg).toContain('href="/nearby?matter=m1"');

    const body = renderNearbyBody({
      points: [point],
      unplaced: [],
      totalAddresses: 1,
      geocoded: true,
      highlight: 'm1',
    });
    expect(body).toContain('nearby-grid');
    expect(body).toContain('aria-current="true"');
    expect(body).toContain('Hearing continued');
  });
});
