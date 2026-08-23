import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { getMatter, listMatters, matterTimeline, mattersForEvent, queryEvents } from '../src/db/repo.ts';
import { linkMatters } from '../src/pipeline/link.ts';
import {
  bestLabel,
  extractBidNumbers,
  matterRef,
  normalizeAddress,
  normalizeArticle,
} from '../src/matters/key.ts';
import { readStage, rollupStatus, sentencesMentioning } from '../src/matters/stages.ts';

describe('subject normalization', () => {
  it('collapses the spellings a town actually uses for one address', () => {
    const forms = [
      '271 Pleasant St',
      '271 Pleasant St.',
      '271 Pleasant Street',
      '271  pleasant  street',
      '271A Pleasant Street',
    ];
    expect(new Set(forms.map(normalizeAddress)).size).toBe(1);
  });

  it('keeps different properties on the same street apart', () => {
    expect(normalizeAddress('14 Adams Street')).not.toBe(normalizeAddress('40 Adams Street'));
  });

  it('expands only unambiguous street-type abbreviations', () => {
    expect(normalizeAddress('8 Wharf Rd')).toBe('8 wharf road');
    expect(normalizeAddress('350 Blue Hill Ave')).toBe('350 blue hill avenue');
  });

  it('scopes warrant articles to a year, so one number is not a decade of matters', () => {
    expect(normalizeArticle('Article 14', 2026)).not.toBe(normalizeArticle('Article 14', 2027));
    expect(normalizeArticle('Article 14', 2026)).toBe(normalizeArticle('article 14', 2026));
  });

  it('refuses subjects it cannot key on confidently', () => {
    expect(matterRef('', 2026)).toBeNull();
    expect(matterRef('7', 2026)).toBeNull();
    expect(matterRef('the property', 2026)).toBeNull();
  });

  it('prefers the fullest spelling for display', () => {
    expect(bestLabel(['271 Pleasant St', '271 Pleasant Street', '271 pleasant street'])).toBe(
      '271 Pleasant Street',
    );
  });
});

describe('bid numbers', () => {
  it('reads a labelled number whatever the departmental prefix', () => {
    expect(extractBidNumbers('Bid No. SB26-9. Sealed bids for resurfacing.')).toEqual(['SB26-9']);
  });

  it('reads a recognisable procurement prefix without a label', () => {
    expect(extractBidNumbers('Award of RFP26-14 to the low bidder')).toEqual(['RFP26-14']);
  });

  it('does not invent one from a bare code it has never seen labelled', () => {
    expect(extractBidNumbers('Chapter 90 funds, FY27-2 allocation')).toEqual([]);
  });

  it('recognises a bare number once the town has published it as a bid', () => {
    // This is the link that matters: the posting labels it, the award does not.
    expect(extractBidNumbers('Award of contract, SB26-9, Central Avenue paving', ['SB26-9'])).toEqual([
      'SB26-9',
    ]);
  });
});

describe('stage reading', () => {
  it('scopes to the item that names the subject', () => {
    const agenda =
      '1. Call to Order\n2. Public hearing, 14 Adams Street, site plan review\n3. 271 Pleasant Street approved 4-1\n4. Adjournment';
    // The item number splits off as its own fragment, which costs nothing: what
    // matters is that only the one item naming this address comes back.
    expect(sentencesMentioning(agenda, '14 Adams Street')).toEqual([
      'Public hearing, 14 Adams Street, site plan review',
    ]);
  });

  it('does not let one decided item decide the rest of the agenda', () => {
    const agenda = 'Public hearing, 14 Adams Street, site plan review\n271 Pleasant Street approved 4-1';
    const scoped = sentencesMentioning(agenda, '14 Adams Street').join(' ');
    expect(readStage(scoped, 'meeting_agenda').stage).toBe('scheduled');
  });

  it('keeps an application clause whole across the applicant’s initial', () => {
    // Splitting at "A." strands the verb, and the fragment naming the address
    // stops saying that an application was filed.
    const text = 'Upon the Application of A. Resident at 271 Pleasant St dated February 2, 2026.';
    const scoped = sentencesMentioning(text, '271 Pleasant St').join(' ');
    expect(readStage(scoped, 'meeting_agenda').stage).toBe('filed');
  });

  it('reads a continuance as a continuance, not a hearing', () => {
    expect(readStage('Continued hearing, 14 Adams Street', 'meeting_agenda').stage).toBe('continued');
  });

  it('reads a recorded vote as a decision, and quotes it', () => {
    const reading = readStage('The variance was approved 4-1.', 'meeting_minutes');
    expect(reading.stage).toBe('decided');
    expect(reading.evidence).toContain('approved 4-1');
  });

  it('distinguishes an award that happened from one on the agenda', () => {
    expect(readStage('Award of Contract', 'meeting_agenda').stage).not.toBe('decided');
    expect(readStage('The contract was awarded to the low bidder.', 'meeting_minutes').stage).toBe('decided');
  });

  it('falls back to the record type rather than guessing', () => {
    expect(readStage('Discussion of parking', 'meeting_minutes')).toEqual({
      stage: 'heard',
      evidence: null,
    });
    expect(readStage('Discussion of parking', 'news_notice').stage).toBe('mentioned');
  });

  it('rolls a matter up to its most recent definite stage', () => {
    expect(rollupStatus(['filed', 'scheduled', 'continued', 'decided'])).toBe('decided');
    expect(rollupStatus(['decided', 'mentioned'])).toBe('decided');
    expect(rollupStatus([])).toBeNull();
  });
});

/* ------------------------------------------------------------------ linking */

let db: Db;
let seq = 0;

function event(opts: {
  title: string;
  eventType?: string;
  date: string;
  subjects?: string[];
  docText?: string;
  body?: string;
  channel?: string;
}): string {
  const id = `event-${++seq}`;
  db.prepare(
    `INSERT INTO events (id, jurisdiction, source_id, level, agency, body, channel, event_type, priority,
                         title, url, occurred_at, first_seen_at, last_seen_at, subjects, tags,
                         content_hash, doc_text)
     VALUES (?,'milton-ma','src','municipal','Town of Milton',?,?,?,'high',?,'https://x/1',?,?,?,?,'[]',?,?)`,
  ).run(
    id,
    opts.body ?? 'Board of Appeals',
    opts.channel ?? 'land-use',
    opts.eventType ?? 'meeting_agenda',
    opts.title,
    opts.date,
    opts.date,
    opts.date,
    JSON.stringify(opts.subjects ?? []),
    `hash-${seq}`,
    opts.docText ?? null,
  );
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  seq = 0;
  db.prepare(
    `INSERT INTO sources (id, jurisdiction, label, adapter, url, level, agency, channel, priority, tier, confidence)
     VALUES ('src','milton-ma','Test source','civicplus-agenda-center','https://x','municipal','Town of Milton','land-use','high',1,'verified')`,
  ).run();
});

describe('linking records into timelines', () => {
  it('builds the sequence the extraction was for', () => {
    event({
      title: 'Board of Appeals — Agenda, March 3',
      date: '2026-03-03T12:00:00.000Z',
      subjects: ['271 Pleasant St'],
      docText: 'Upon the Application of A. Resident at 271 Pleasant St seeking a Variance.',
    });
    event({
      title: 'Board of Appeals — Agenda, April 7',
      date: '2026-04-07T12:00:00.000Z',
      subjects: ['271 Pleasant Street'],
      docText: 'Public hearing on the variance sought at 271 Pleasant Street.',
    });
    event({
      title: 'Board of Appeals — Agenda, May 5',
      date: '2026-05-05T12:00:00.000Z',
      subjects: ['271 Pleasant Street'],
      docText: 'Continued hearing, 271 Pleasant Street.',
    });
    event({
      title: 'Board of Appeals — Minutes, June 2',
      eventType: 'meeting_minutes',
      date: '2026-06-02T12:00:00.000Z',
      subjects: ['271 Pleasant Street'],
      docText: 'The variance at 271 Pleasant Street was approved 4-1.',
    });

    const summary = linkMatters(db, { jurisdiction: 'milton-ma' });
    expect(summary.timelines).toBe(1);

    const [matter] = listMatters(db, { jurisdiction: 'milton-ma', minEvents: 2 });
    expect(matter!.label).toBe('271 Pleasant Street');
    expect(matter!.event_count).toBe(4);
    expect(matter!.status).toBe('decided');

    const timeline = matterTimeline(db, matter!.id);
    expect(timeline.map((step) => step.stage)).toEqual(['filed', 'scheduled', 'continued', 'decided']);
    // Every stage carries the phrase it was read from.
    expect(timeline.at(-1)!.evidence).toContain('approved 4-1');
  });

  it('links across boards and channels, which is the point', () => {
    event({
      title: 'IFB — Central Avenue Roadway Resurfacing',
      eventType: 'bid_posted',
      date: '2026-07-01T12:00:00.000Z',
      docText: 'Bid No. SB26-9. Sealed bids for milling and resurfacing.',
      body: 'Procurement Department',
      channel: 'money',
    });
    event({
      title: 'Select Board — Minutes, August 18',
      eventType: 'meeting_minutes',
      date: '2026-08-18T12:00:00.000Z',
      docText: 'Contract SB26-9 was awarded to the low bidder.',
      body: 'Select Board',
      channel: 'meetings',
    });

    linkMatters(db, { jurisdiction: 'milton-ma' });
    const [matter] = listMatters(db, { jurisdiction: 'milton-ma', minEvents: 2 });
    expect(matter!.kind).toBe('bid');
    expect(JSON.parse(matter!.channels)).toEqual(['meetings', 'money']);
    expect(matter!.status).toBe('decided');
  });

  it('does not merge the same article number from different years', () => {
    event({ title: 'Fall warrant', date: '2026-09-01T12:00:00.000Z', subjects: ['Article 14'] });
    event({ title: 'Spring warrant', date: '2027-05-01T12:00:00.000Z', subjects: ['Article 14'] });

    linkMatters(db, { jurisdiction: 'milton-ma' });
    const matters = listMatters(db, { jurisdiction: 'milton-ma', kinds: ['article'] });
    expect(matters).toHaveLength(2);
    expect(matters.every((m) => m.event_count === 1)).toBe(true);
  });

  it('is a rebuild, so re-running changes nothing and rule changes take effect everywhere', () => {
    event({ title: 'One', date: '2026-03-03T12:00:00.000Z', subjects: ['14 Adams Street'] });
    event({ title: 'Two', date: '2026-04-03T12:00:00.000Z', subjects: ['14 Adams St'] });

    const first = linkMatters(db, { jurisdiction: 'milton-ma' });
    const second = linkMatters(db, { jurisdiction: 'milton-ma' });
    expect(second.matters).toBe(first.matters);
    expect(second.links).toBe(first.links);
    expect(db.prepare('SELECT count(*) AS n FROM matter_events').get() as unknown as { n: number }).toEqual({
      n: 2,
    });
  });

  it('exposes a matter as a feed filter, so one property can be subscribed to', () => {
    event({ title: 'One', date: '2026-03-03T12:00:00.000Z', subjects: ['14 Adams Street'] });
    event({ title: 'Two', date: '2026-04-03T12:00:00.000Z', subjects: ['14 Adams Street'] });
    event({ title: 'Unrelated', date: '2026-04-04T12:00:00.000Z', subjects: ['8 Wharf Street'] });

    linkMatters(db, { jurisdiction: 'milton-ma' });
    const [matter] = listMatters(db, { jurisdiction: 'milton-ma', minEvents: 2 });
    const rows = queryEvents(db, { jurisdiction: 'milton-ma', matters: [matter!.id] });
    expect(rows.map((r) => r.title).sort()).toEqual(['One', 'Two']);
  });

  it('tells an event which timelines it belongs to', () => {
    const id = event({
      title: 'Busy night',
      date: '2026-05-05T12:00:00.000Z',
      subjects: ['14 Adams Street', '271 Pleasant Street'],
    });
    linkMatters(db, { jurisdiction: 'milton-ma' });
    expect(
      mattersForEvent(db, id)
        .map((m) => m.label)
        .sort(),
    ).toEqual(['14 Adams Street', '271 Pleasant Street']);
  });

  it('drops matters whose records are gone on the next run', () => {
    const id = event({ title: 'One', date: '2026-03-03T12:00:00.000Z', subjects: ['14 Adams Street'] });
    linkMatters(db, { jurisdiction: 'milton-ma' });
    const before = listMatters(db, { jurisdiction: 'milton-ma' });
    expect(before).toHaveLength(1);

    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    linkMatters(db, { jurisdiction: 'milton-ma' });
    expect(listMatters(db, { jurisdiction: 'milton-ma' })).toHaveLength(0);
    expect(getMatter(db, before[0]!.id)).toBeUndefined();
  });
});
