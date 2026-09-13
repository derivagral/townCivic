import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { ROOT } from '../src/config.ts';
import { sourceSchema } from '../src/types.ts';
import { MATV_TRANSCRIPTS } from '../src/registry/milton-ma.ts';
import { createLocalDocuments, setDocuments } from '../src/documents/index.ts';
import { queryEvents, upsertSource } from '../src/db/repo.ts';
import { ingest } from '../src/pipeline/ingest.ts';
import { syncWordpressTranscripts, transcriptSyncState } from '../src/pipeline/transcripts.ts';
import { clearJurisdiction } from '../src/commands/clear.ts';
import { parseWithSource } from '../src/adapters/index.ts';
import { normalize } from '../src/pipeline/normalize.ts';

const source = sourceSchema.parse({ ...MATV_TRANSCRIPTS, options: { categoryId: 36, pageSize: 2 } });
const rss = fs.readFileSync(path.join(ROOT, 'fixtures/milton-ma/matv-transcripts.xml'), 'utf8');
const content = new XMLParser().parse(rss).rss.channel.item['content:encoded'] as string;
const post = (id: number, text = content) => ({
  id,
  link: `https://miltonaccesstv.org/post-${id}/`,
  date_gmt: '2026-09-12T10:00:00',
  modified_gmt: '2026-09-12T11:00:00',
  categories: [36],
  title: { rendered: `Meeting ${id} &#8211; Transcript` },
  content: { rendered: text },
});
const response = (rows: unknown[], total = rows.length, pages = total ? 1 : 0) =>
  new Response(JSON.stringify(rows), {
    headers: {
      'content-type': 'application/json',
      'x-wp-total': String(total),
      'x-wp-totalpages': String(pages),
    },
  });
const now = new Date('2026-09-13T12:00:00Z');
let db: Db;
let dir: string;
beforeEach(() => {
  db = openDb(':memory:');
  upsertSource(db, source);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matv-sync-'));
  setDocuments(createLocalDocuments(dir));
});
afterEach(() => {
  setDocuments(undefined);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// No real network and no host-delay sleeps in these tests.
vi.mock('../src/fetch/http.ts', async (original) => {
  const real = await original<typeof import('../src/fetch/http.ts')>();
  return {
    ...real,
    fetchSource: async (id: string, url: string, options: { fetchImpl: typeof fetch }) => {
      const r = await options.fetchImpl(url);
      return {
        sourceId: id,
        url,
        ok: r.ok,
        status: r.status,
        notModified: r.status === 304,
        body: await r.text(),
        contentType: r.headers.get('content-type'),
        etag: null,
        lastModified: null,
        ...(r.headers.has('x-wp-total') ? { totalItems: Number(r.headers.get('x-wp-total')) } : {}),
        ...(r.headers.has('x-wp-totalpages') ? { totalPages: Number(r.headers.get('x-wp-totalpages')) } : {}),
      };
    },
  };
});

describe('WordPress transcript sync', () => {
  it('resumes a frozen ID queue after reopening the database without advancing the watermark halfway', async () => {
    const file = path.join(dir, 'towncivic.db');
    db.close();
    db = openDb(file);
    upsertSource(db, source);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: 1 }, { id: 2 }, { id: 3 }]))
      .mockResolvedValueOnce(response([post(1), post(2)]))
      .mockResolvedValueOnce(response([post(3)]));
    const options = { maxPages: 1, fetchImpl, now };
    const first = await syncWordpressTranscripts(db, source, options);
    expect(first).toMatchObject({ ok: true, created: 2, pending: 1, completedThrough: null });
    expect(transcriptSyncState(db, source.id).pending).toMatchObject({ ids: [1, 2, 3], next: 2 });

    // A later CLI invocation opens the file again; no in-process state survives.
    db.close();
    db = openDb(file);
    const second = await syncWordpressTranscripts(db, source, options);
    expect(second).toMatchObject({
      ok: true,
      created: 1,
      pending: 0,
      completedThrough: '2026-09-13T11:55:00.000Z',
    });
    expect(new URL(String(fetchImpl.mock.calls[2]![0])).searchParams.get('include')).toBe('3');
    expect(queryEvents(db, { q: 'stormwater' })).toHaveLength(3);
    expect(db.prepare('SELECT count(*) AS n FROM documents').get()).toMatchObject({ n: 3 });
  });

  it('pages the complete inventory before fetching full content', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })),
          101,
          2,
        ),
      )
      .mockResolvedValueOnce(response([{ id: 101 }], 101, 2))
      .mockResolvedValueOnce(response([post(1), post(2)]));
    expect(await syncWordpressTranscripts(db, source, { maxPages: 1, fetchImpl, now })).toMatchObject({
      ok: true,
      pending: 99,
    });
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get('page')).toBe('2');
  });

  it('retries the failed batch and applies correction text from a bounded modified window', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: 1 }]))
      .mockResolvedValueOnce(new Response('<html>challenge</html>', { status: 202 }))
      .mockResolvedValueOnce(response([post(1)]))
      .mockResolvedValueOnce(response([{ id: 1 }]))
      .mockResolvedValueOnce(response([post(1, content.replace('stormwater', 'groundwater'))]));
    expect(await syncWordpressTranscripts(db, source, { fetchImpl, now })).toMatchObject({ ok: false });
    expect(transcriptSyncState(db, source.id).pending?.next).toBe(0);
    expect(await syncWordpressTranscripts(db, source, { fetchImpl, now })).toMatchObject({
      ok: true,
      created: 1,
    });
    expect(
      await syncWordpressTranscripts(db, source, { fetchImpl, now: new Date('2026-09-14T12:00:00Z') }),
    ).toMatchObject({ ok: true, revised: 1 });
    const delta = new URL(String(fetchImpl.mock.calls[3]![0]));
    expect(delta.searchParams.get('modified_after')).toBe('2026-09-12T11:55:00.000Z');
    expect(delta.searchParams.get('modified_before')).toBe('2026-09-14T11:55:00.000Z');
    expect(queryEvents(db, { q: 'stormwater' })).toHaveLength(0);
    expect(queryEvents(db, { q: 'groundwater' })[0]?.revision).toBe(2);
  });

  it('does not checkpoint or insert records during dry-run', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: 1 }]))
      .mockResolvedValueOnce(response([post(1)]));
    expect(await syncWordpressTranscripts(db, source, { fetchImpl, now, dryRun: true })).toMatchObject({
      ok: true,
      items: 1,
      created: 0,
      completedThrough: null,
    });
    expect(transcriptSyncState(db, source.id).pending).toBeNull();
    expect(queryEvents(db)).toHaveLength(0);
  });

  it.each([
    ['HTML', () => new Response('<html>captcha</html>')],
    ['missing pagination', () => new Response('[{"id":1}]')],
    ['repeated IDs', () => response([{ id: 1 }, { id: 1 }])],
    ['missing IDs', () => response([{ id: 1 }], 2, 1)],
  ])('fails incomplete discovery (%s) without saving a cursor', async (_, makeResponse) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(makeResponse());
    expect(await syncWordpressTranscripts(db, source, { fetchImpl, now })).toMatchObject({ ok: false });
    expect(transcriptSyncState(db, source.id).pending).toBeNull();
    expect(queryEvents(db)).toHaveLength(0);
  });

  it('does not partially insert or checkpoint a batch with malformed transcript content', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: 1 }, { id: 2 }]))
      .mockResolvedValueOnce(response([post(1), post(2, '<p>Excerpt only</p>')]));
    expect(await syncWordpressTranscripts(db, source, { fetchImpl, now })).toMatchObject({ ok: false });
    expect(queryEvents(db)).toHaveLength(0);
    expect(transcriptSyncState(db, source.id).pending?.next).toBe(0);
  });

  it('reports posts removed after discovery without deleting stored records or blocking the queue', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: 1 }, { id: 2 }]))
      .mockResolvedValueOnce(response([post(2)]));
    expect(await syncWordpressTranscripts(db, source, { fetchImpl, now })).toMatchObject({
      ok: true,
      created: 1,
      unavailableIds: [1],
      pending: 0,
    });
  });

  it('explicit backfill removes the delta filter and clear records removes the checkpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response([]));
    await syncWordpressTranscripts(db, source, { fetchImpl, now });
    await syncWordpressTranscripts(db, source, { fetchImpl, now, backfill: true });
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.has('modified_after')).toBe(false);
    clearJurisdiction(db, { jurisdiction: 'milton-ma', scope: 'records' });
    expect(transcriptSyncState(db, source.id).completedThrough).toBeNull();
  });

  it('reuses permalink identity across the old RSS transport and the API', () => {
    const oldSource = sourceSchema.parse({
      ...source,
      adapter: 'matv-transcripts',
      url: 'https://miltonaccesstv.org/category/transcript/feed/',
    });
    const [rssItem] = parseWithSource(oldSource, rss);
    const [apiItem] = parseWithSource(source, JSON.stringify([{ ...post(1), link: rssItem!.url }]));
    expect(normalize(source, apiItem!).id).toBe(normalize(oldSource, rssItem!).id);
  });

  it('routes explicit ingest through the API and leaves unattended ingestion disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response([]));
    const [report] = await ingest(db, { jurisdiction: 'milton-ma', sourceIds: [source.id], fetchImpl });
    expect(report).toMatchObject({ ok: true, pending: 0 });
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).pathname).toBe('/wp-json/wp/v2/posts');
    expect(MATV_TRANSCRIPTS.enabled).toBe(false);
  });
});
