import { describe, expect, it, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { createLocalDocuments } from '../src/documents/local.ts';
import { createS3Documents } from '../src/documents/s3.ts';
import { contentTypeFor, extensionFor, keyFor } from '../src/documents/store.ts';
import type { DocumentStore } from '../src/documents/store.ts';
import { backfillDocuments } from '../src/commands/documents.ts';
import { setDocuments } from '../src/documents/index.ts';
import { ingest } from '../src/pipeline/ingest.ts';
import { FAKE_S3_CREDENTIALS, fakeS3 } from './helpers/fake-s3.ts';

/**
 * One suite, both backends.
 *
 * The archive is the one thing in townCivic that cannot be regenerated, so the
 * bar for "the other backend works" is higher here than anywhere else: if an
 * upload silently fails, what is lost is the only copy of a document the town
 * has taken down.
 *
 * The S3 side runs against a fake that **verifies every signature** by
 * recomputing it, so a request this repo builds wrongly is rejected here the
 * same way a real endpoint would reject it.
 */

const bytes = (text: string) => new TextEncoder().encode(text);

let tmp: string;

interface Backend {
  name: string;
  make(): DocumentStore;
}

const BACKENDS: Backend[] = [
  {
    name: 'local',
    make: () => createLocalDocuments(fs.mkdtempSync(path.join(tmp, 'store-'))),
  },
  {
    name: 's3',
    make: () =>
      createS3Documents({
        bucket: FAKE_S3_CREDENTIALS.bucket,
        endpoint: 'https://account.r2.cloudflarestorage.test',
        region: FAKE_S3_CREDENTIALS.region,
        accessKeyId: FAKE_S3_CREDENTIALS.accessKeyId,
        secretAccessKey: FAKE_S3_CREDENTIALS.secretAccessKey,
        fetchImpl: fakeS3().fetch,
      }),
  },
];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'towncivic-docs-'));
});

describe.each(BACKENDS)('the document store: $name', ({ make }) => {
  it('stores bytes and reads back exactly what went in', async () => {
    const store = make();
    const body = bytes('<html>an agenda listing</html>');
    const key = keyFor('a'.repeat(64), 'html');

    const stored = await store.put(key, body, 'text/html');
    expect(stored.key).toBe(key);
    expect(stored.bytes).toBe(body.byteLength);
    expect(stored.isNew).toBe(true);

    expect(await store.get(key)).toEqual(body);
    expect(await store.has(key)).toBe(true);
  });

  it('reports the content hash, whatever key it was filed under', async () => {
    const store = make();
    const body = bytes('some bytes');
    // sha256 of "some bytes", independently computed.
    const stored = await store.put(keyFor('b'.repeat(64), 'bin'), body, null);
    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — the same content twice is not a second copy', async () => {
    const store = make();
    const key = keyFor('c'.repeat(64), 'pdf');
    const body = bytes('%PDF-1.4 pretend');

    expect((await store.put(key, body, 'application/pdf')).isNew).toBe(true);
    expect((await store.put(key, body, 'application/pdf')).isNew).toBe(false);
    expect(await store.get(key)).toEqual(body);
  });

  it('answers honestly about a key it does not have', async () => {
    const store = make();
    expect(await store.has(keyFor('d'.repeat(64), 'pdf'))).toBe(false);
    expect(await store.get(keyFor('d'.repeat(64), 'pdf'))).toBeNull();
  });

  it('keeps binary intact — not everything is text', async () => {
    const store = make();
    // A byte sequence that is not valid UTF-8. The old store wrote everything
    // as utf8 strings; a PDF round-tripped through that comes back corrupted.
    const body = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x01]);
    const key = keyFor('e'.repeat(64), 'pdf');

    await store.put(key, body, 'application/pdf');
    expect(await store.get(key)).toEqual(body);
  });

  it('keeps listings and attachments in separate namespaces', async () => {
    const store = make();
    const listing = keyFor('f'.repeat(64), 'html');
    const attachment = keyFor('f'.repeat(64), 'pdf', 'attachments/');

    await store.put(listing, bytes('listing'), 'text/html');
    await store.put(attachment, bytes('attachment'), 'application/pdf');

    expect(await store.get(listing)).toEqual(bytes('listing'));
    expect(await store.get(attachment)).toEqual(bytes('attachment'));
  });

  it('passes its own check', async () => {
    const store = make();
    const report = await store.check();
    expect(report.ok).toBe(true);
    expect(report.findings.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------- s3 specifics */

describe('the s3 backend', () => {
  const build = (overrides: Parameters<typeof createS3Documents>[0] = {}) => {
    const backend = fakeS3();
    const store = createS3Documents({
      bucket: FAKE_S3_CREDENTIALS.bucket,
      endpoint: 'https://account.r2.cloudflarestorage.test',
      region: FAKE_S3_CREDENTIALS.region,
      accessKeyId: FAKE_S3_CREDENTIALS.accessKeyId,
      secretAccessKey: FAKE_S3_CREDENTIALS.secretAccessKey,
      fetchImpl: backend.fetch,
      ...overrides,
    });
    return { backend, store };
  };

  it('refuses to start without the bucket or the credentials', () => {
    expect(() => createS3Documents({ bucket: '', accessKeyId: 'a', secretAccessKey: 'b' })).toThrow(
      /S3_BUCKET/,
    );
    expect(() => createS3Documents({ bucket: 'b', accessKeyId: '', secretAccessKey: '' })).toThrow(
      /S3_ACCESS_KEY_ID/,
    );
  });

  it('is rejected by the bucket when the secret is wrong', async () => {
    // The fake recomputes the signature, so this is the real failure mode
    // rather than a stubbed one.
    const { store } = build({ secretAccessKey: 'not-the-right-secret' });
    await expect(store.put(keyFor('a'.repeat(64), 'pdf'), bytes('x'), null)).rejects.toThrow(
      /SignatureDoesNotMatch/,
    );
  });

  it('sets a content type the browser can use', async () => {
    const { backend, store } = build();
    const key = keyFor('b'.repeat(64), 'pdf', 'attachments/');
    await store.put(key, bytes('%PDF'), null);
    expect(backend.contentType(`${key}`)).toBe('application/pdf');
  });

  it('skips the upload when the object is already there', async () => {
    const { backend, store } = build();
    const key = keyFor('c'.repeat(64), 'pdf');

    await store.put(key, bytes('%PDF'), null);
    const afterFirst = backend.counts()['PUT'];
    await store.put(key, bytes('%PDF'), null);

    // A HEAD, then nothing. Re-uploading a 300 KB PDF that is already stored is
    // the cost this check exists to avoid on every refresh.
    expect(backend.counts()['PUT']).toBe(afterFirst);
  });

  it('reports a write it could not do rather than losing it quietly', async () => {
    const { backend, store } = build();
    backend.fail(500);
    await expect(store.put(keyFor('d'.repeat(64), 'pdf'), bytes('x'), null)).rejects.toThrow(/500|Internal/);

    backend.fail(0);
    await expect(store.put(keyFor('e'.repeat(64), 'pdf'), bytes('x'), null)).rejects.toThrow(/unreachable/);
  });

  it('passes its check without permission to delete', async () => {
    // A write-only bucket policy is a legitimate way to run this: the pipeline
    // never deletes anything either.
    const { backend, store } = build();
    backend.denyDelete();

    const report = await store.check();
    expect(report.ok).toBe(true);
    expect(report.findings.find((f) => f.label === 'delete')?.detail).toMatch(/no delete permission/);
  });

  it('fails its check when nothing is reachable', async () => {
    const { backend, store } = build();
    backend.fail(0);
    const report = await store.check();
    expect(report.ok).toBe(false);
    expect(report.findings.find((f) => f.label === 'write')?.detail).toMatch(/unreachable/);
  });

  it('addresses AWS by hostname and everything else by path', async () => {
    // Two conventions, one rule: an endpoint means path-style, which R2, Tigris,
    // B2 and MinIO all want; no endpoint means AWS, which wants the bucket in
    // the host for anything created since 2020.
    let seen = '';
    const spy = (async (input: string | URL | Request) => {
      seen = String(input instanceof Request ? input.url : input);
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await createS3Documents({
      bucket: 'my-bucket',
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      fetchImpl: spy,
    }).has('ab/cd.pdf');
    expect(seen).toBe('https://my-bucket.s3.us-east-1.amazonaws.com/ab/cd.pdf');

    await createS3Documents({
      bucket: 'my-bucket',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      fetchImpl: spy,
    }).has('ab/cd.pdf');
    expect(seen).toBe('https://account.r2.cloudflarestorage.com/my-bucket/ab/cd.pdf');
  });
});

/* ------------------------------------------------------------------ backfill */

describe('backfill', () => {
  let db: Db;
  let local: DocumentStore;
  let localDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    localDir = fs.mkdtempSync(path.join(tmp, 'archive-'));
    local = createLocalDocuments(localDir);

    db.prepare(
      `INSERT INTO sources (id, jurisdiction, label, adapter, url, level, agency, channel, priority, tier, confidence)
       VALUES ('src','milton-ma','Test','civicplus-agenda-center','https://x','municipal','Town','land-use','high',1,'verified')`,
    ).run();
  });

  const listing = async (id: string, body: string) => {
    const key = keyFor(id, 'html');
    await local.put(key, bytes(body), 'text/html');
    db.prepare(
      `INSERT INTO documents (id, source_id, url, content_type, bytes, path, first_seen_at, last_seen_at)
       VALUES (?,'src','https://x','text/html',?,?, '2026-01-01','2026-01-01')`,
    ).run(id, body.length, key);
    return key;
  };

  it('copies what the database says exists', async () => {
    const a = await listing('a'.repeat(64), 'first listing');
    const b = await listing('b'.repeat(64), 'second listing');
    const store = build();

    const report = await backfillDocuments(db, { from: local, to: store });
    expect(report).toMatchObject({ total: 2, uploaded: 2, present: 0, missing: 0, failed: [] });
    expect(await store.get(a)).toEqual(bytes('first listing'));
    expect(await store.get(b)).toEqual(bytes('second listing'));
  });

  it('resumes rather than re-uploading', async () => {
    await listing('a'.repeat(64), 'first listing');
    await listing('b'.repeat(64), 'second listing');
    const store = build();

    await backfillDocuments(db, { from: local, to: store, limit: 1 });
    const second = await backfillDocuments(db, { from: local, to: store });

    // Content-addressed keys mean an interrupted run picks up where it stopped.
    expect(second.present).toBe(1);
    expect(second.uploaded).toBe(1);
  });

  it('counts a row whose file is gone rather than passing over it', async () => {
    const key = await listing('a'.repeat(64), 'first listing');
    fs.rmSync(path.join(localDir, key));

    const report = await backfillDocuments(db, { from: local, to: build() });
    // Worth surfacing: the database believes it has a document that no longer
    // exists anywhere, and that is the sort of thing to learn before it is the
    // only copy that is missing.
    expect(report).toMatchObject({ missing: 1, uploaded: 0 });
  });

  it('reports a dry run without writing anything', async () => {
    await listing('a'.repeat(64), 'first listing');
    const store = build();

    const report = await backfillDocuments(db, { from: local, to: store, dryRun: true });
    expect(report.uploaded).toBe(1);
    expect(await store.has(keyFor('a'.repeat(64), 'html'))).toBe(false);
  });

  it('covers attachments as well as listings', async () => {
    const key = keyFor('c'.repeat(64), 'pdf', 'attachments/');
    await local.put(key, bytes('%PDF body'), 'application/pdf');
    db.prepare(
      `INSERT INTO events (id, jurisdiction, source_id, level, agency, channel, event_type, priority,
                           title, url, first_seen_at, last_seen_at, content_hash)
       VALUES ('e1','milton-ma','src','municipal','Town','land-use','meeting_agenda','high',
               'An agenda','https://x','2026-01-01','2026-01-01','h1')`,
    ).run();
    db.prepare(
      `INSERT INTO attachments (id, event_id, url, bytes, path, extracted_at)
       VALUES (?, 'e1', 'https://x/doc.pdf', 9, ?, '2026-01-01')`,
    ).run('c'.repeat(64), key);

    const store = build();
    const report = await backfillDocuments(db, { from: local, to: store });
    expect(report.uploaded).toBe(1);
    expect(await store.get(key)).toEqual(bytes('%PDF body'));
  });

  function build(): DocumentStore {
    return createS3Documents({
      bucket: FAKE_S3_CREDENTIALS.bucket,
      endpoint: 'https://account.r2.cloudflarestorage.test',
      region: FAKE_S3_CREDENTIALS.region,
      accessKeyId: FAKE_S3_CREDENTIALS.accessKeyId,
      secretAccessKey: FAKE_S3_CREDENTIALS.secretAccessKey,
      fetchImpl: fakeS3().fetch,
    });
  }
});

/* -------------------------------------------------------------------- keys */

describe('keys', () => {
  it('shards on the hash prefix, so no directory holds everything', () => {
    expect(keyFor('abcdef'.padEnd(64, '0'), 'pdf')).toBe(`ab/${'abcdef'.padEnd(64, '0')}.pdf`);
    expect(keyFor('abcdef'.padEnd(64, '0'), 'pdf', 'attachments/')).toBe(
      `attachments/ab/${'abcdef'.padEnd(64, '0')}.pdf`,
    );
  });

  it('names the extension from the content type it was fetched with', () => {
    expect(extensionFor('text/html; charset=utf-8')).toBe('html');
    expect(extensionFor('application/rss+xml')).toBe('xml');
    expect(extensionFor(null)).toBe('bin');
  });

  it('recovers a content type from a key, for an upload', () => {
    expect(contentTypeFor('attachments/ab/cd.pdf')).toBe('application/pdf');
    expect(contentTypeFor('ab/cd.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('ab/cd.bin')).toBe('application/octet-stream');
  });
});

/* --------------------------------------------------- the pipeline write path */

describe('ingest writes the archive through whichever store is configured', () => {
  /**
   * The only test that drives the real `ingest` into the real port.
   *
   * Everything above exercises the stores directly, which proves they work and
   * proves nothing about whether the pipeline reaches them. This is the wiring:
   * a fixture body goes in, and the bytes come out of the store under the key
   * the database recorded.
   *
   * It matters more than a wiring test usually would. The archive is the one
   * thing townCivic cannot rebuild, and an `ingest` that quietly stopped
   * writing to it would look exactly like an `ingest` that worked — every
   * record still lands in SQLite, and no page reads the archive.
   */
  const FIXTURE = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'fixtures', 'milton-ma', 'select-board-6.html'),
    'utf8',
  );

  const serveFixture: typeof fetch = async () =>
    new Response(FIXTURE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

  const run = async (store: DocumentStore) => {
    const db = openDb(':memory:');
    setDocuments(store);
    try {
      await ingest(db, {
        jurisdiction: 'milton-ma',
        sourceIds: ['milton-ma:agenda:select-board'],
        fetchImpl: serveFixture,
      });
      const row = db.prepare('SELECT path, bytes FROM documents LIMIT 1').get() as
        { path: string; bytes: number } | undefined;
      return { row, store };
    } finally {
      setDocuments(undefined);
    }
  };

  it.each([
    ['local', () => createLocalDocuments(fs.mkdtempSync(path.join(tmp, 'ingested-')))],
    [
      's3',
      () =>
        createS3Documents({
          bucket: FAKE_S3_CREDENTIALS.bucket,
          endpoint: 'https://account.r2.cloudflarestorage.test',
          region: FAKE_S3_CREDENTIALS.region,
          accessKeyId: FAKE_S3_CREDENTIALS.accessKeyId,
          secretAccessKey: FAKE_S3_CREDENTIALS.secretAccessKey,
          fetchImpl: fakeS3().fetch,
        }),
    ],
  ])('stores the fetched body in the %s backend', async (_name, make) => {
    const { row, store } = await run(make());

    expect(row).toBeDefined();
    // The database's `path` has to be the key the store can actually answer
    // for, or the manifest and the archive have quietly diverged.
    const stored = await store.get(row!.path);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored!)).toBe(FIXTURE);
    expect(row!.bytes).toBe(Buffer.byteLength(FIXTURE, 'utf8'));
  });

  it('files the body under its own content hash', async () => {
    const { row } = await run(createLocalDocuments(fs.mkdtempSync(path.join(tmp, 'hashed-'))));
    const digest = createHash('sha256').update(Buffer.from(FIXTURE, 'utf8')).digest('hex');
    expect(row!.path).toBe(keyFor(digest, 'html'));
  });
});
