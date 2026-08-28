import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import {
  IMPACT_RULES,
  extractEventImpacts,
  extractImpacts,
  impactsForEvent,
  impactsForEvents,
} from '../src/pipeline/impacts.ts';
import { IMPACT_DIMENSIONS } from '../src/profile/impacts.ts';
import type { Impact } from '../src/profile/impacts.ts';

/**
 * What is worth testing here is restraint.
 *
 * An extractor that finds a lot is easy; one that can be trusted to reroute
 * somebody's feed is not. So these tests pin down three things: that every
 * claim carries the words it was read from, that the claims a record does not
 * support are absent, and that a re-run does not quietly change what the record
 * is understood to say.
 */

let db: Db;
let seq = 0;

beforeEach(() => {
  db = openDb(':memory:');
  seq = 0;
  db.prepare(
    `INSERT INTO sources (id, jurisdiction, label, adapter, url, level, agency, channel, priority,
                          tier, confidence, updated_at)
     VALUES ('src','milton-ma','Test source','rss','https://x/','municipal','Town of Milton',
             'land-use','medium',1,'verified',datetime('now'))`,
  ).run();
});

function event(opts: {
  title: string;
  summary?: string;
  docText?: string;
  body?: string;
  channel?: string;
  eventType?: string;
  date?: string;
}): string {
  const id = `event-${++seq}`;
  const date = opts.date ?? '2026-09-10T19:00:00-04:00';
  // `first_seen_at` is when the crawler found the record, so it is always in the
  // past — and the freshness check compares against it. Giving it the meeting's
  // own future date would make every record look permanently newer than its
  // reading, which is a fixture mistake rather than a real one.
  const seen = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO events (id, jurisdiction, source_id, level, agency, body, channel, event_type, priority,
                         title, summary, url, occurred_at, first_seen_at, last_seen_at, subjects, tags,
                         content_hash, doc_text)
     VALUES (?,'milton-ma','src','municipal','Town of Milton',?,?,?,'high',?,?,'https://x/1',?,?,?,'[]','[]',?,?)`,
  ).run(
    id,
    opts.body ?? 'Planning Board',
    opts.channel ?? 'land-use',
    opts.eventType ?? 'meeting_agenda',
    opts.title,
    opts.summary ?? null,
    date,
    seen,
    seen,
    `hash-${seq}`,
    opts.docText ?? null,
  );
  return id;
}

const keys = (impacts: Impact[]) => impacts.map((impact) => `${impact.dimension}:${impact.value}`);
const find = (impacts: Impact[], key: string) => impacts.find((impact) => keys([impact])[0] === key);

describe('the rules table', () => {
  it('covers every dimension the vocabulary defines', () => {
    for (const dimension of IMPACT_DIMENSIONS) {
      expect(
        IMPACT_RULES.some((rule) => rule.dimension === dimension),
        `no rule produces ${dimension}`,
      ).toBe(true);
    }
  });

  it('gives every rule an id, so a bad reading is traceable to one line', () => {
    const ids = IMPACT_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('reading a record', () => {
  it('reads a zoning hearing as a dated hearing about a place', () => {
    const impacts = extractImpacts({
      title: 'Notice of Public Hearing — Special Permit, 271 Pleasant Street',
      summary: 'The Planning Board will hold a public hearing on a special permit.',
      body: 'Planning Board',
      channel: 'land-use',
      eventType: 'hearing_scheduled',
      occurredAt: '2026-09-10T19:00:00-04:00',
      hasPlace: true,
    });

    const hearing = find(impacts, 'property:hearing_date');
    expect(hearing).toBeDefined();
    expect(hearing!.detail).toBe('2026-09-10');
    expect(hearing!.evidence).toContain('Public Hearing');
    expect(keys(impacts)).toContain('property:geography');
  });

  it('reads the services a record actually names', () => {
    const service = (title: string) =>
      keys(extractImpacts({ title, channel: 'land-use' })).filter((key) => key.startsWith('service:'));

    expect(service('MBTA Communities zoning amendment for multi-family housing')).toContain(
      'service:housing',
    );
    expect(service('MBTA Mattapan trolley shutdown and bus replacement')).toContain('service:transit');
    expect(service('DPW sidewalk reconstruction and traffic calming')).toContain('service:roads');
    expect(service('Council on Aging — Senior Tax Work-Off Program')).toContain('service:senior_services');
    expect(service('Library Trustees — Sunday hours')).toContain('service:libraries');
  });

  it('keeps a School Committee budget districtwide rather than inventing a tier', () => {
    // This is the row that makes the retiree case work: a reader who downranked
    // routine school programming still gets the budget, because the budget is a
    // districtwide fact rather than an elementary-school one.
    const impacts = extractImpacts({
      title: 'School Committee — FY27 Operating Budget Vote',
      summary: 'The Committee will vote on the district operating budget.',
      body: 'School Committee',
      channel: 'schools',
      eventType: 'meeting_agenda',
    });

    expect(keys(impacts)).toContain('school:districtwide');
    expect(keys(impacts)).toContain('finance:operating_budget');
    expect(keys(impacts)).not.toContain('school:elementary');
    expect(keys(impacts)).not.toContain('school:middle');
    expect(find(impacts, 'school:districtwide')!.confidence).toBe('derived');
  });

  it('reads a named school as both a tier and an institution', () => {
    const impacts = extractImpacts({
      title: 'Tucker Elementary School — Building Committee',
      channel: 'schools',
    });
    expect(keys(impacts)).toContain('school:elementary');
    expect(keys(impacts)).toContain('institution:Tucker Elementary School');
  });

  it('normalizes a written dollar figure into a number', () => {
    const impacts = extractImpacts({
      title: 'Roof replacement, cost estimate $1.2 million',
      channel: 'money',
    });
    expect(find(impacts, 'property:estimated_cost')?.detail).toBe('1200000');
  });

  it('reads eligibility off the program, never off the reader', () => {
    const impacts = extractImpacts({
      title: 'Senior Tax Work-Off Program',
      summary: 'Open to residents 60 and over. Income-eligible applicants may also apply.',
      channel: 'meetings',
    });
    // These describe who the *program* is for. That a program is income-based is
    // public information; whether a reader qualifies is not something townCivic
    // knows, asks, or stores.
    expect(keys(impacts)).toContain('eligibility:age_based');
    expect(keys(impacts)).toContain('eligibility:income_based');
    expect(find(impacts, 'eligibility:age_based')!.evidence).toContain('60');
  });

  it('quotes the record for everything it claims the record said', () => {
    const impacts = extractImpacts({
      title: 'Notice of Public Hearing — Special Permit, 271 Pleasant Street',
      summary: 'Public comment will be taken. Applications due September 30, 2026.',
      channel: 'land-use',
      eventType: 'hearing_scheduled',
      occurredAt: '2026-09-10T19:00:00-04:00',
      hasPlace: true,
    });

    for (const impact of impacts) {
      if (impact.confidence === 'derived') continue;
      expect(impact.evidence, `${impact.dimension}:${impact.value} has no evidence`).toBeTruthy();
      expect(impact.evidence!.length).toBeGreaterThan(0);
    }
  });

  it('does not read Milton’s finance committee as a warrant article', () => {
    // "Warrant Committee" is the finance committee here, and matching a bare
    // "warrant" would misfile its entire calendar — the same trap classify.ts
    // already documents.
    const impacts = extractImpacts({
      title: 'Warrant Committee — regular meeting',
      summary: 'Routine business.',
      body: 'Warrant Committee',
      channel: 'money',
    });
    expect(keys(impacts).filter((key) => key.startsWith('finance:'))).toEqual([]);
  });

  it('finds nothing in a record that says nothing', () => {
    expect(extractImpacts({ title: 'Meeting cancelled', channel: 'meetings' })).toEqual([]);
  });
});

describe('extraction over the database', () => {
  it('stores what it read, and reads it back', () => {
    const id = event({
      title: 'Tucker Elementary School — Building Committee',
      summary: 'Public comment will be taken.',
      channel: 'schools',
      body: 'School Building Committee',
    });

    const summary = extractEventImpacts(db, { jurisdiction: 'milton-ma' });
    expect(summary.eventsConsidered).toBe(1);
    expect(summary.impacts).toBeGreaterThan(0);

    const stored = impactsForEvent(db, id);
    expect(keys(stored)).toContain('school:elementary');
    expect(summary.byDimension['school']).toBeGreaterThan(0);
  });

  it('is idempotent: a second run does not change what the record says', () => {
    event({ title: 'Council on Aging — Senior Tax Work-Off Program', channel: 'meetings' });
    event({ title: 'School Committee — FY27 Operating Budget Vote', channel: 'schools' });

    extractEventImpacts(db, { jurisdiction: 'milton-ma' });
    const first = db.prepare('SELECT count(*) AS n FROM event_impacts').get() as { n: number };

    extractEventImpacts(db, { jurisdiction: 'milton-ma', force: true });
    const second = db.prepare('SELECT count(*) AS n FROM event_impacts').get() as { n: number };

    expect(second.n).toBe(first.n);
  });

  it('skips a record whose reading is already current, and says so', () => {
    event({ title: 'Council on Aging — Senior Tax Work-Off Program', channel: 'meetings' });
    extractEventImpacts(db, { jurisdiction: 'milton-ma' });

    const again = extractEventImpacts(db, { jurisdiction: 'milton-ma' });
    expect(again.reports.every((report) => report.skipped === 'unchanged')).toBe(true);
    expect(again.impacts).toBe(0);
  });

  it('fetches many records’ impacts in one query', () => {
    const a = event({ title: 'MBTA Mattapan trolley shutdown', channel: 'public-safety' });
    const b = event({ title: 'Library Trustees — Sunday hours', channel: 'meetings' });
    extractEventImpacts(db, { jurisdiction: 'milton-ma' });

    const map = impactsForEvents(db, [a, b]);
    expect(keys(map.get(a) ?? [])).toContain('service:transit');
    expect(keys(map.get(b) ?? [])).toContain('service:libraries');
  });

  it('returns an empty map rather than querying for nothing', () => {
    expect(impactsForEvents(db, []).size).toBe(0);
    expect(impactsForEvent(db, 'no-such-event')).toEqual([]);
  });
});
