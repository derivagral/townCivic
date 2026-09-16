import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceSchema } from '../src/types.ts';
import { MATV_TRANSCRIPTS } from '../src/registry/milton-ma.ts';
import { parseWithSource } from '../src/adapters/index.ts';
import { normalize } from '../src/pipeline/normalize.ts';
import { ingestBody } from '../src/pipeline/ingest.ts';
import { linkMatters } from '../src/pipeline/link.ts';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { queryEvents, upsertEvent, upsertSource } from '../src/db/repo.ts';
import { transcriptFromRaw } from '../src/transcripts.ts';
import { renderEvent } from '../src/web/views.ts';
import { ROOT } from '../src/config.ts';

const source = sourceSchema.parse({
  ...MATV_TRANSCRIPTS,
  adapter: 'matv-transcripts',
  url: 'https://miltonaccesstv.org/category/transcript/feed/',
});
const xml = fs.readFileSync(path.join(ROOT, 'fixtures/milton-ma/matv-transcripts.xml'), 'utf8');
const parse = (body = xml) => parseWithSource(source, body);
let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  upsertSource(db, source);
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('MATV public transcripts', () => {
  it.each([
    ['Board Of Appeals – September 15th, 2025 (7pm)', '2025-09-15'],
    ['Planning Board Meeting September 25th, 2014 Pt 1', '2014-09-25'],
    ['Board of Selectmen September 23th, 2014 Pt 1', '2014-09-23'],
  ])('recovers an unknown meeting date from %s', (board, meetingDate) => {
    const body = xml
      .replace('Zoning Board of Appeals</p>', `${board}</p>`)
      .replace('2026-07-21</p>', 'Unknown</p>');
    const [item] = parse(body);
    expect(item!.transcript!.meetingDate).toBe(meetingDate);
    expect(item!.extra).toMatchObject({ board, meetingDateSource: 'board-label' });
    expect(normalize(source, item!).occurredAt).toBe(`${meetingDate}T12:00:00.000Z`);
    expect(item!.publishedAt!.toISOString()).toBe('2026-09-12T10:14:07.000Z');
  });

  it.each([
    'Board of Appeals',
    'Board of Appeals September 15th',
    'Board of Appeals February 30th, 2025',
    'Board of Appeals September 15th, 2025 and September 16th, 2025',
  ])('rejects unknown or invalid meeting dates in %s', (board) => {
    const body = xml
      .replace('Zoning Board of Appeals</p>', `${board}</p>`)
      .replace('2026-07-21</p>', 'Unknown</p>');
    expect(() => parse(body)).toThrow();
  });

  it('prefers the explicit Date field over a date in the Board label', () => {
    const [item] = parse(
      xml.replace('Zoning Board of Appeals</p>', 'Board of Appeals September 15th, 2025</p>'),
    );
    expect(item!.transcript!.meetingDate).toBe('2026-07-21');
    expect(item!.extra).toMatchObject({ meetingDateSource: 'date-field' });
  });

  it('reads full content, correct board/date and case-sensitive video ID without identifying speakers', () => {
    const [item] = parse();
    const event = normalize(source, item!);
    expect(event.title).toContain('– Transcript');
    expect(event.body).toBe('Board of Appeals');
    expect(event.channel).toBe('land-use');
    expect(event.eventType).toBe('meeting_transcript');
    expect(event.occurredAt).toBe('2026-07-21T12:00:00.000Z');
    expect(event.publishedAt).toBe('2026-09-12T10:14:07.000Z');
    expect(event.docText).toContain('damn culvert');
    expect(event.docText).toContain('attention & repair');
    expect(event.docText).not.toContain('deliberately incomplete');
    expect(event.docText).not.toContain('width: 25%');
    expect(item!.transcript).toMatchObject({
      videoId: 'AbC_dEf1234',
      segments: [
        { speakerLabel: 'Speaker 1', startSeconds: 53, endSeconds: 66 },
        { speakerLabel: 'Speaker 2', startSeconds: 3602, endSeconds: 3645 },
        { speakerLabel: 'Speaker 1', startSeconds: 3660, endSeconds: 3660 },
      ],
    });
    expect(event.raw).not.toHaveProperty('attendees');
    expect(event.subjects).toEqual([]);
  });

  it.each(['', 'src="about:blank" '])(
    'reads lazy-loaded video embeds with %s as the placeholder',
    (placeholder) => {
      const lazy = xml.replace('<iframe src=', `<iframe class="lazyload" ${placeholder}data-src=`);
      expect(parse(lazy)).toEqual(parse());
    },
  );

  it('rejects an untrusted lazy-loaded video URL', () => {
    const lazy = xml.replace('<iframe src=', '<iframe data-src=');
    expect(() =>
      parse(lazy.replace('https://www.youtube.com/embed/', 'https://untrusted.test/embed/')),
    ).toThrow('MATV transcript is missing Transcript heading or video');
  });

  it('indexes every passage immediately and keeps repeat ingestion idempotent', () => {
    expect(ingestBody(db, source, xml)).toMatchObject({ created: 1 });
    expect(ingestBody(db, source, xml)).toMatchObject({ unchanged: 1, created: 0 });
    const [row] = queryEvents(db, { q: 'stormwater' });
    expect(row?.revision).toBe(1);
    expect(row?.extracted_at).toBeTruthy();
    expect(row?.document_url).toBeNull();
    expect(transcriptFromRaw(row!.raw)?.segments).toHaveLength(3);
    expect(linkMatters(db).matters).toBe(0);
  });

  it('refreshes FTS and records a revision when only late transcript text changes', () => {
    ingestBody(db, source, xml);
    const revised = xml.replace('stormwater', 'groundwater');
    expect(ingestBody(db, source, revised)).toMatchObject({ revised: 1 });
    expect(queryEvents(db, { q: 'stormwater' })).toHaveLength(0);
    expect(queryEvents(db, { q: 'groundwater' })[0]?.revision).toBe(2);
  });

  it('preserves text beyond the PDF projection limit', () => {
    const long = xml.replace('stormwater', `${'discussion '.repeat(15000)}tailword`);
    ingestBody(db, source, long);
    expect(queryEvents(db, { q: 'tailword' })).toHaveLength(1);
    expect(queryEvents(db)[0]!.doc_text!.length).toBeGreaterThan(150000);
  });

  it('does not write transcript text or events during dry-run', () => {
    expect(ingestBody(db, source, xml, { dryRun: true })).toMatchObject({ items: 1, created: 0 });
    expect(queryEvents(db)).toHaveLength(0);
  });

  it('retains existing PDF extraction when revising an ordinary event', () => {
    const original = normalize(source, { title: 'Agenda', url: 'https://example.test/agenda' });
    upsertEvent(db, original);
    db.prepare('UPDATE events SET doc_text = ? WHERE id = ?').run('Previously extracted PDF', original.id);
    upsertEvent(db, normalize(source, { title: 'Amended agenda', url: 'https://example.test/agenda' }));
    expect(queryEvents(db)[0]?.doc_text).toBe('Previously extracted PDF');
  });

  it.each([
    ['HTML challenge', '<html><body>Checking your browser</body></html>'],
    ['excerpt only', xml.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, '')],
    ['missing board', xml.replace('<strong>Board:</strong>', '<strong>Other:</strong>')],
    ['invalid date', xml.replace('2026-07-21</p>', '2026-02-30</p>')],
    ['invalid timestamp', xml.replace('–01:06)', '–00:52)')],
    ['unsafe embed', xml.replace('https://www.youtube.com/embed/', 'https://untrusted.test/embed/')],
    ['unexpected heading', xml.replace('Speaker 2 (', 'Unknown (')],
  ])('fails visibly on %s rather than silently dropping speech', (_, body) => {
    expect(() => ingestBody(db, source, body)).toThrow();
    expect(queryEvents(db)).toHaveLength(0);
  });

  it('accepts a valid empty RSS channel', () => {
    expect(parse(xml.replace(/<item>[\s\S]*?<\/item>/, ''))).toEqual([]);
  });

  it('renders escaped passages with time links and publisher attribution', () => {
    ingestBody(db, source, xml);
    const html = renderEvent({
      row: queryEvents(db)[0]!,
      sampleData: false,
      town: { id: 'milton-ma', label: 'Milton', options: [], path: '/' },
    });
    expect(html).toContain('v=AbC_dEf1234&amp;t=3602s');
    expect(html).toContain('1:00:02–1:00:45');
    expect(html).toContain('Published by MATV');
    expect(html).toContain('Speaker 2');
    expect(html).toContain('That damn culvert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain("<script>alert('quoted text')</script>");
    expect(html).not.toContain('Posted by clerk');
    expect(html).not.toContain('No agenda items');
    expect(html).not.toContain('npm run extract');
  });
});
