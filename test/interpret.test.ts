import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { countInterpretations, interpretationsForEvent, queryEvents } from '../src/db/repo.ts';
import { interpretDocuments, interpreterFor } from '../src/pipeline/interpret.ts';
import { findContinuances, findVotes, rulesInterpreter } from '../src/interpret/rules.ts';
import { createAnthropicInterpreter } from '../src/interpret/anthropic.ts';
import { InterpreterUnavailableError } from '../src/interpret/provider.ts';
import type { Interpreter } from '../src/interpret/provider.ts';

describe('the rules interpreter', () => {
  it('reads a recorded vote out of prose', () => {
    expect(findVotes('The Board voted to approve the application 4-1.')).toEqual([
      {
        outcome: 'voted',
        inFavor: 4,
        opposed: 1,
        sentence: 'The Board voted to approve the application 4-1.',
      },
    ]);
  });

  it('reads the spellings minutes actually use', () => {
    expect(findVotes('Denied, 3 to 2.')[0]).toMatchObject({ inFavor: 3, opposed: 2 });
    expect(findVotes('Approved 5–0 in favor.')[0]).toMatchObject({ inFavor: 5, opposed: 0 });
  });

  it('does not read a setback dimension as a vote', () => {
    // "reduce the rear setback from 20 feet to 11 feet" is the exact shape of a
    // tally, and boards do not have twenty members.
    expect(findVotes('Approved a variance to reduce the rear setback from 20 feet to 11 feet.')).toEqual([]);
  });

  it('reads a continuance and where it went', () => {
    expect(findContinuances('The hearing was continued to September 9, 2026.')).toEqual([
      { to: 'September 9, 2026', sentence: 'The hearing was continued to September 9, 2026.' },
    ]);
  });

  it('produces prose, because prose is what gets indexed', async () => {
    const [reading] = await rulesInterpreter.interpret({
      jurisdictionLabel: 'Milton, Massachusetts',
      eventId: 'e1',
      title: 'Minutes',
      body: 'Planning Board',
      eventType: 'meeting_minutes',
      occurredAt: null,
      text: 'The subdivision was approved 4-1.',
    });
    expect(reading!.kind).toBe('votes');
    expect(reading!.text).toContain('Recorded vote');
    expect(reading!.text).toContain('4–1');
  });

  it('finds nothing in a document that records nothing', async () => {
    expect(
      await rulesInterpreter.interpret({
        jurisdictionLabel: 'Milton, Massachusetts',
        eventId: 'e1',
        title: 'Minutes',
        body: null,
        eventType: 'meeting_minutes',
        occurredAt: null,
        text: 'Discussion of the hydrant flushing schedule. No action taken.',
      }),
    ).toEqual([]);
  });
});

describe('the anthropic interpreter', () => {
  it('is optional — a missing key is a clear message, not a crash', async () => {
    const interpreter = createAnthropicInterpreter({ apiKey: undefined });
    await expect(
      interpreter.interpret({
        jurisdictionLabel: 'Milton, Massachusetts',
        eventId: 'e1',
        title: 'Minutes',
        body: null,
        eventType: 'meeting_minutes',
        occurredAt: null,
        text: 'anything',
      }),
    ).rejects.toBeInstanceOf(InterpreterUnavailableError);
  });

  it('treats the prompt’s literal NONE as "found nothing"', async () => {
    const interpreter = createAnthropicInterpreter({ createMessage: async () => 'NONE' });
    expect(
      await interpreter.interpret({
        jurisdictionLabel: 'Milton, Massachusetts',
        eventId: 'e1',
        title: 'Minutes',
        body: null,
        eventType: 'meeting_minutes',
        occurredAt: null,
        text: 'anything',
      }),
    ).toEqual([]);
  });

  it('records which model produced a reading', async () => {
    const interpreter = createAnthropicInterpreter({
      createMessage: async () => 'The Board voted 4-1 to approve.',
    });
    const [reading] = await interpreter.interpret({
      jurisdictionLabel: 'Milton, Massachusetts',
      eventId: 'e1',
      title: 'Minutes',
      body: null,
      eventType: 'meeting_minutes',
      occurredAt: null,
      text: 'anything',
    });
    expect(reading!.text).toContain('4-1');
    expect(interpreter.model).toBe('claude-opus-5');
  });
});

/* ------------------------------------------------------------------ pipeline */

let db: Db;
let seq = 0;

function event(opts: { title: string; type?: string; docText?: string; summary?: string }): string {
  const id = `event-${++seq}`;
  db.prepare(
    `INSERT INTO events (id, jurisdiction, source_id, level, agency, body, channel, event_type, priority,
                         title, summary, url, occurred_at, first_seen_at, last_seen_at, subjects, tags,
                         content_hash, doc_text)
     VALUES (?,'milton-ma','src','municipal','Town of Milton','Planning Board','land-use',?,'high',?,?,
             'https://x/1','2026-06-02T12:00:00.000Z','2026-06-02T12:00:00.000Z','2026-06-02T12:00:00.000Z',
             '[]','[]',?,?)`,
  ).run(
    id,
    opts.type ?? 'meeting_minutes',
    opts.title,
    opts.summary ?? null,
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
     VALUES ('src','milton-ma','Test','civicplus-agenda-center','https://x','municipal','Town of Milton','land-use','high',1,'verified')`,
  ).run();
});

describe('the interpretation stage', () => {
  it('reads minutes and leaves the record alone', async () => {
    const id = event({ title: 'Minutes', docText: 'The subdivision was approved 4-1.' });
    const before = db.prepare('SELECT summary, doc_text FROM events WHERE id = ?').get(id);

    await interpretDocuments(db, { jurisdiction: 'milton-ma' });

    expect(interpretationsForEvent(db, id)).toHaveLength(1);
    // The whole design rests on this: nothing derived is written back.
    expect(db.prepare('SELECT summary, doc_text FROM events WHERE id = ?').get(id)).toEqual(before);
  });

  it('leaves agendas alone by default — they are already structured', async () => {
    event({ title: 'Agenda', type: 'meeting_agenda', docText: 'The variance was approved 4-1.' });
    const reports = await interpretDocuments(db, { jurisdiction: 'milton-ma' });
    expect(reports).toHaveLength(0);
  });

  it('reads the listing description when no document has been extracted', async () => {
    // The Agenda Center's own one-liner is text the town published, and it is
    // all there is until `extract` has run.
    const id = event({ title: 'Minutes', summary: 'Minutes — subdivision approval, 4-1 vote' });
    await interpretDocuments(db, { jurisdiction: 'milton-ma' });
    expect(interpretationsForEvent(db, id)[0]!.text).toContain('4–1');
  });

  it('does not re-read a document whose reading is current', async () => {
    event({ title: 'Minutes', docText: 'Approved 4-1.' });
    let calls = 0;
    const counting: Interpreter = {
      ...rulesInterpreter,
      interpret: async (request) => {
        calls++;
        return rulesInterpreter.interpret(request);
      },
    };

    await interpretDocuments(db, { jurisdiction: 'milton-ma', interpreter: counting });
    await interpretDocuments(db, { jurisdiction: 'milton-ma', interpreter: counting });
    expect(calls).toBe(1);
  });

  it('re-reads when the document behind it changes', async () => {
    const id = event({ title: 'Minutes', docText: 'Approved 4-1.' });
    await interpretDocuments(db, { jurisdiction: 'milton-ma' });

    db.prepare('UPDATE events SET doc_text = ? WHERE id = ?').run('Denied 2-3.', id);
    await interpretDocuments(db, { jurisdiction: 'milton-ma' });

    const [reading] = interpretationsForEvent(db, id);
    expect(reading!.text).toContain('2–3');
    expect(reading!.text).not.toContain('4–1');
  });

  it('remembers finding nothing, so quiet meetings are not re-read forever', async () => {
    event({ title: 'Minutes', docText: 'Discussion of the hydrant flushing schedule.' });
    const first = await interpretDocuments(db, { jurisdiction: 'milton-ma' });
    expect(first[0]!.found).toBe(0);

    const second = await interpretDocuments(db, { jurisdiction: 'milton-ma' });
    expect(second[0]!.skipped).toBe('unchanged');
    // An empty placeholder is not shown anywhere.
    expect(countInterpretations(db)).toBe(0);
  });

  it('keeps derived text out of the default search and reachable when asked for', async () => {
    event({ title: 'Minutes', docText: 'The subdivision was approved 4-1.' });
    await interpretDocuments(db, { jurisdiction: 'milton-ma' });

    // "Recorded vote" is the interpreter's phrasing, not the town's.
    expect(queryEvents(db, { jurisdiction: 'milton-ma', q: 'recorded vote' })).toHaveLength(0);
    expect(
      queryEvents(db, { jurisdiction: 'milton-ma', q: 'recorded vote', includeDerived: true }),
    ).toHaveLength(1);
  });

  it('still finds what the record itself says when derived search is on', async () => {
    event({ title: 'Minutes about drainage', docText: 'No action taken.' });
    await interpretDocuments(db, { jurisdiction: 'milton-ma' });
    // Widening the search must not narrow it.
    expect(queryEvents(db, { jurisdiction: 'milton-ma', q: 'drainage', includeDerived: true })).toHaveLength(
      1,
    );
  });

  it('stops on an unavailable provider instead of failing every document', async () => {
    event({ title: 'One', docText: 'Approved 4-1.' });
    event({ title: 'Two', docText: 'Approved 3-2.' });
    const broken: Interpreter = {
      ...rulesInterpreter,
      interpret: async () => {
        throw new InterpreterUnavailableError('no key');
      },
    };
    await expect(
      interpretDocuments(db, { jurisdiction: 'milton-ma', interpreter: broken }),
    ).rejects.toBeInstanceOf(InterpreterUnavailableError);
  });

  it('defaults to the provider that needs nothing configured', () => {
    expect(interpreterFor('rules').model).toBeNull();
    expect(interpreterFor('rules').name).toBe('rules');
  });
});
