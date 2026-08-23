import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractPdf, looksLikePdf } from '../src/extract/pdf.ts';
import { parseMeetingNotice, splitAgenda, summarizeAgenda } from '../src/extract/meeting-notice.ts';
import { preferDocumentUrl } from '../src/pipeline/extract.ts';
import { hasRealTime, parseClockTime, parsePostingStamp, zonedToUtc } from '../src/util/dates.ts';
import { ROOT } from '../src/config.ts';

const NOTICE = path.join(ROOT, 'fixtures', 'milton-ma', 'meeting-notice.pdf');
const readNotice = () => new Uint8Array(fs.readFileSync(NOTICE));

describe('pdf extraction', () => {
  it('reads AcroForm field values', async () => {
    const extraction = await extractPdf(readNotice());

    expect(extraction.pages).toBe(1);
    expect(extraction.fields['BOARDCOMMITTEE']).toBe('Milton Board of Appeals');
    expect(extraction.fields['TIME']).toBe('7:30 PM');
    expect(extraction.fields['AGENDA']).toContain('271 Pleasant Street');
  });

  it('leaves the caller’s buffer intact', async () => {
    // pdf.js takes ownership of the buffer it is given and detaches it. When
    // that leaked, every document hashed to the hash of an empty array and the
    // whole attachments table collapsed onto one row.
    const bytes = readNotice();
    const before = bytes.length;

    await extractPdf(bytes);

    expect(bytes.length).toBe(before);
    expect(bytes.subarray(0, 5)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
  });

  it('does not flag a text PDF as scanned', async () => {
    expect((await extractPdf(readNotice())).likelyScanned).toBe(false);
  });

  it('recognizes a PDF by its magic bytes', () => {
    expect(looksLikePdf(readNotice())).toBe(true);
    expect(looksLikePdf(new Uint8Array(Buffer.from('<html><body>nope')))).toBe(false);
  });
});

describe('meeting notice', () => {
  it('reads the facts a listing row cannot give you', async () => {
    const notice = parseMeetingNotice(await extractPdf(readNotice()));

    expect(notice.structured).toBe(true);
    expect(notice.board).toBe('Board of Appeals');
    expect(notice.location).toBe('Milton Town Hall, Carol Blute Conference Room');
    expect(notice.timeText).toBe('7:30 PM');
    expect(notice.postingAuthority).toBe('A. Clerk');
  });

  it('resolves the meeting time in the town’s timezone', async () => {
    const notice = parseMeetingNotice(await extractPdf(readNotice()));
    // September 14, 2026, 7:30 PM EDT (UTC-4) is 23:30Z.
    expect(notice.meetingAt).toBe('2026-09-14T23:30:00.000Z');
  });

  it('resolves the clerk’s posting stamp, which starts the 48-hour clock', async () => {
    const notice = parseMeetingNotice(await extractPdf(readNotice()));
    expect(notice.postedAt).toBe('2026-09-04T18:15:00.000Z');
  });

  it('extracts the properties under discussion', async () => {
    const notice = parseMeetingNotice(await extractPdf(readNotice()));
    expect(notice.subjects).toContain('271 Pleasant Street');
    expect(notice.subjects).toContain('14 Adams Street');
  });

  it('does not report the town hall as a subject', async () => {
    // Every notice carries the clerk's address in its template. Treating that
    // as a subject would tag the entire town with one address.
    const notice = parseMeetingNotice(await extractPdf(readNotice()));
    expect(notice.subjects.some((s) => /525 Canton/i.test(s))).toBe(false);
  });

  it('reports plain PDFs as unstructured rather than failing', () => {
    const notice = parseMeetingNotice({
      pages: 2,
      text: 'Minutes of the meeting. Discussion of 8 Wharf Street.',
      fields: {},
      likelyScanned: false,
      charsPerPage: 500,
    });
    expect(notice.structured).toBe(false);
    expect(notice.subjects).toContain('8 Wharf Street');
  });
});

describe('agenda parsing', () => {
  it('folds sub-bullets into the item above', () => {
    const items = splitAgenda(
      '1. Call to Order\r\r2. Administrative Items\r* Minutes\r* Staff Update\r\r3. Adjourn',
    );
    expect(items).toEqual([
      '1. Call to Order',
      '2. Administrative Items — Minutes — Staff Update',
      '3. Adjourn',
    ]);
  });

  it('skips numbered boilerplate when summarizing', () => {
    // The numbering has to come off before the boilerplate test, or every
    // agenda summarizes to "Call to Order · Public Comment".
    const summary = summarizeAgenda([
      '1. Call to Order',
      '2. Public Comment',
      '3. Zoning Hearing - MBTA Communities Multi-Family Overlay District',
      '4. Adjournment',
    ]);
    expect(summary).toBe('3. Zoning Hearing - MBTA Communities Multi-Family Overlay District');
  });

  it('falls back to boilerplate rather than returning nothing', () => {
    expect(summarizeAgenda(['1. Call to Order', '2. Adjournment'])).toContain('Call to Order');
  });
});

describe('document urls', () => {
  it('asks for the file rather than the HTML view', () => {
    expect(
      preferDocumentUrl('https://www.miltonma.gov/AgendaCenter/ViewFile/Agenda/_02132017-2755?html=true'),
    ).toBe('https://www.miltonma.gov/AgendaCenter/ViewFile/Agenda/_02132017-2755');
  });

  it('leaves a normal document url alone', () => {
    const url = 'https://www.miltonma.gov/AgendaCenter/ViewFile/Agenda/_09102026-6844';
    expect(preferDocumentUrl(url)).toBe(url);
  });
});

describe('town-local time', () => {
  it('handles both sides of daylight saving', () => {
    // 7 PM in January is EST (UTC-5); in July it is EDT (UTC-4).
    expect(zonedToUtc(2026, 1, 14, 19, 0)).toBe('2026-01-15T00:00:00.000Z');
    expect(zonedToUtc(2026, 7, 14, 19, 0)).toBe('2026-07-14T23:00:00.000Z');
  });

  it('parses the clock formats municipal documents use', () => {
    expect(parseClockTime('7:00 PM')).toEqual({ hour: 19, minute: 0 });
    expect(parseClockTime('8:00 am')).toEqual({ hour: 8, minute: 0 });
    expect(parseClockTime('12:30 pm')).toEqual({ hour: 12, minute: 30 });
    expect(parseClockTime('no time here')).toBeNull();
  });

  it('parses a posting stamp', () => {
    expect(parsePostingStamp('08/17/2026 02:55 pm')).toBe('2026-08-17T18:55:00.000Z');
  });

  it('tells a real meeting time from a date with no time', () => {
    // `dateOnlyToIso` anchors undated records at noon UTC; the UI must not
    // render that as though the town told us the meeting starts at 8am.
    expect(hasRealTime('2026-09-10T12:00:00.000Z')).toBe(false);
    expect(hasRealTime('2026-09-10T23:00:00.000Z')).toBe(true);
    expect(hasRealTime(null)).toBe(false);
  });
});
