import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { createLocalDocuments } from '../src/documents/local.ts';
import type { DocumentStore } from '../src/documents/store.ts';
import { setDocuments } from '../src/documents/index.ts';
import { extractDocuments } from '../src/pipeline/extract.ts';

let db: Db;
let store: DocumentStore;

beforeEach(() => {
  db = openDb(':memory:');
  store = createLocalDocuments(fs.mkdtempSync(path.join(os.tmpdir(), 'towncivic-extract-')));
  setDocuments(store);
  db.prepare(
    `INSERT INTO sources
       (id, jurisdiction, label, adapter, url, level, agency, channel, priority, tier, confidence)
     VALUES
       ('src','milton-ma','Test','civicplus-agenda-center','https://town.test',
        'municipal','Town','government','high',1,'verified')`,
  ).run();
  db.prepare(
    `INSERT INTO events
       (id, jurisdiction, source_id, level, agency, channel, event_type, priority,
        title, url, document_url, first_seen_at, last_seen_at, content_hash)
     VALUES
       ('event','milton-ma','src','municipal','Town','government','meeting_minutes','high',
        'Minutes','https://town.test/item','https://town.test/minutes',
        '2026-01-01','2026-01-01','hash')`,
  ).run();
});

afterEach(() => setDocuments(undefined));

describe('extraction quality and retry state', () => {
  it('keeps complete searchable text and a lossless extracted-text artifact', async () => {
    const sourceText = `Decision ${'continued discussion '.repeat(1_500)}`;
    const html = `<html><body>${sourceText}</body></html>`;
    const reports = await extractDocuments(db, {
      jurisdiction: 'milton-ma',
      fetchImpl: async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });

    expect(reports[0]).toMatchObject({ ok: true, quality: 'html' });
    const event = db.prepare('SELECT doc_text, extracted_at FROM events WHERE id = ?').get('event') as {
      doc_text: string;
      extracted_at: string | null;
    };
    expect(event.doc_text.length).toBeGreaterThan(20_000);
    expect(event.doc_text).toContain(sourceText.slice(-1_000));
    expect(event.extracted_at).toBeTruthy();

    const attachment = db
      .prepare('SELECT text_path, text_chars, page_stats, quality FROM attachments WHERE event_id = ?')
      .get('event') as {
      text_path: string;
      text_chars: number;
      page_stats: string;
      quality: string;
    };
    expect(attachment).toMatchObject({ quality: 'html', text_chars: event.doc_text.length });
    expect(JSON.parse(attachment.page_stats)).toEqual([
      expect.objectContaining({ page: 1, needsOcr: false }),
    ]);
    expect(new TextDecoder().decode((await store.get(attachment.text_path))!)).toBe(event.doc_text);
  });

  it('keeps a failed document pending and backs off unattended retries', async () => {
    let calls = 0;
    const missing = async () => {
      calls += 1;
      return new Response('gone', { status: 404 });
    };

    const first = await extractDocuments(db, { jurisdiction: 'milton-ma', fetchImpl: missing });
    expect(first[0]).toMatchObject({ ok: false, failureCode: 'http_not_found' });
    expect(db.prepare('SELECT extracted_at FROM events WHERE id = ?').get('event')).toEqual({
      extracted_at: null,
    });

    const second = await extractDocuments(db, { jurisdiction: 'milton-ma', fetchImpl: missing });
    expect(second).toEqual([]);
    expect(calls).toBe(1);

    await extractDocuments(db, { jurisdiction: 'milton-ma', fetchImpl: missing, force: true });
    expect(calls).toBe(2);
    expect(db.prepare('SELECT attempts, failure_code FROM attachments').get()).toEqual({
      attempts: 2,
      failure_code: 'http_not_found',
    });
  });
});
