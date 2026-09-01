import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { status } from '../src/commands/status.ts';

let db: Db;
let seq = 0;

const NOW = new Date('2026-09-01T00:00:00.000Z');

/**
 * Short names for real registered source ids.
 *
 * They have to be real: `status` now reports a source row the registry does not
 * list, because with a multi-town registry that is how a renamed or dropped
 * source announces itself. A fixture called `a` would be exactly that.
 */
const IDS: Record<string, string> = {
  a: 'milton-ma:news',
  b: 'milton-ma:bids',
  c: 'milton-ma:calendar',
  d: 'milton-ma:alerts',
  ok: 'milton-ma:news',
  broken: 'milton-ma:bids',
  gone: 'milton-ma:calendar',
  empty: 'milton-ma:alerts',
  off: 'milton-ma:alerts:dpw',
};

const id = (name: string): string => IDS[name] ?? name;

function source(
  name: string,
  overrides: {
    enabled?: boolean;
    lastFetchAt?: string | null;
    lastStatus?: number | null;
    lastError?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO sources (id, jurisdiction, label, adapter, url, level, agency, channel, priority,
                          tier, confidence, enabled, last_fetch_at, last_status, last_error)
     VALUES (?,'milton-ma',?,'rss','https://x','municipal','Town of Milton','meetings','high',1,'verified',?,?,?,?)`,
  ).run(
    id(name),
    name,
    overrides.enabled === false ? 0 : 1,
    overrides.lastFetchAt ?? null,
    overrides.lastStatus ?? null,
    overrides.lastError ?? null,
  );
}

function event(name: string, firstSeenAt: string): void {
  db.prepare(
    `INSERT INTO events (id, jurisdiction, source_id, level, agency, channel, event_type, priority,
                         title, url, first_seen_at, last_seen_at, subjects, tags, content_hash)
     VALUES (?,'milton-ma',?,'municipal','Town of Milton','meetings','meeting_agenda','high','A record',
             'https://x/1',?,?,'[]','[]',?)`,
  ).run(`e${++seq}`, id(name), firstSeenAt, firstSeenAt, `h${seq}`);
}

beforeEach(() => {
  db = openDb(':memory:');
  seq = 0;
});

describe('status', () => {
  it('says an unrun install is unrun, once, rather than listing every source', () => {
    for (const name of ['a', 'b', 'c', 'd']) source(name);
    const report = status(db, 'milton-ma', NOW);

    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(['no source has ever been fetched — run `npm run ingest`']);
  });

  it('is quiet when everything is working', () => {
    source('a', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });
    event('a', '2026-08-30T00:00:00.000Z');

    const report = status(db, 'milton-ma', NOW);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.events).toBe(1);
  });

  it('reports the quiet failure: answering fine, producing nothing new', () => {
    // The one this exists for. HTTP 200 every time, no error, and the town
    // stopped publishing five months ago — indistinguishable from a quiet week
    // unless you look at when a record last arrived.
    source('a', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });
    event('a', '2026-03-01T00:00:00.000Z');

    const report = status(db, 'milton-ma', NOW);
    const [entry] = report.sources;
    expect(entry!.stale).toBe(true);
    expect(entry!.staleDays).toBe(184);
    expect(report.warnings[0]).toContain('nothing new in 184 days');
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does not call a monthly board stale over its summer recess', () => {
    source('a', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });
    event('a', '2026-07-15T00:00:00.000Z');
    expect(status(db, 'milton-ma', NOW).problems).toEqual([]);
  });

  it('reports a failing fetch and a bad status', () => {
    source('ok', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });
    event('ok', '2026-08-30T00:00:00.000Z');
    source('broken', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastError: 'ECONNRESET' });
    source('gone', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 404 });

    const problems = status(db, 'milton-ma', NOW).problems.join('\n');
    expect(problems).toContain(`${id('broken')}: last fetch failed — ECONNRESET`);
    expect(problems).toContain(`${id('gone')}: HTTP 404`);
  });

  it('reports a source that answers but yields nothing', () => {
    source('ok', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });
    event('ok', '2026-08-30T00:00:00.000Z');
    source('empty', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });

    const report = status(db, 'milton-ma', NOW);
    expect(report.warnings.join('\n')).toContain(`${id('empty')}: answered but has produced no records`);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does not complain about a source that is deliberately off', () => {
    source('ok', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });
    event('ok', '2026-08-30T00:00:00.000Z');
    // Milton's Alert Center feeds are live, correct and empty; they ship off.
    source('off', { enabled: false });

    expect(status(db, 'milton-ma', NOW).problems).toEqual([]);
    expect(status(db, 'milton-ma', NOW).sources.find((s) => s.sourceId === id('off'))!.stale).toBe(false);
  });

  it('counts the downstream stages so a stalled one is visible', () => {
    source('a', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });
    event('a', '2026-08-30T00:00:00.000Z');
    db.prepare("UPDATE events SET document_url = 'https://x/doc.pdf'").run();

    const report = status(db, 'milton-ma', NOW);
    expect(report.documentsPending).toBe(1);
    expect(report.documentsExtracted).toBe(0);

    db.prepare("UPDATE events SET extracted_at = '2026-08-31T00:00:00.000Z'").run();
    expect(status(db, 'milton-ma', NOW).documentsPending).toBe(0);
  });

  it('is machine-readable, because that is how it will actually be used', () => {
    source('a', { lastFetchAt: '2026-08-31T00:00:00.000Z', lastStatus: 200 });
    event('a', '2026-08-30T00:00:00.000Z');

    const report = status(db, 'milton-ma', NOW);
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({
      jurisdiction: 'milton-ma',
      ok: true,
      events: 1,
      placed: { resolved: 0, total: 0 },
    });
  });
});
