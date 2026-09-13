import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { openDb, type Db } from '../src/db/index.ts';
import { ROOT } from '../src/config.ts';
import { syncSources } from '../src/registry/index.ts';
import { MATV_TRANSCRIPTS } from '../src/registry/milton-ma.ts';
import { sourceSchema } from '../src/types.ts';
import { recordFetch, upsertDocument, queryEvents } from '../src/db/repo.ts';
import { seed } from '../src/commands/seed.ts';
import { clearJurisdiction } from '../src/commands/clear.ts';
import { createLocalDocuments, createS3Documents, type DocumentStore } from '../src/documents/index.ts';
import {
  uploadTranscripts,
  importTranscripts,
  transcriptManifestKey,
} from '../src/commands/transcript-transfer.ts';
import { transcriptSyncState } from '../src/pipeline/transcripts.ts';
import { FAKE_S3_CREDENTIALS, fakeS3 } from './helpers/fake-s3.ts';
import { createHash } from 'node:crypto';

const content = new XMLParser().parse(
  fs.readFileSync(path.join(ROOT, 'fixtures/milton-ma/matv-transcripts.xml'), 'utf8'),
).rss.channel.item['content:encoded'] as string;
const post = (id: number, modified = '2026-09-12T11:00:00', text = content) => ({
  id,
  link: `https://miltonaccesstv.org/post-${id}/`,
  date_gmt: '2026-09-12T10:00:00',
  modified_gmt: modified,
  categories: [36],
  title: { rendered: `Meeting ${id} Transcript` },
  content: { rendered: text },
});
const source = sourceSchema.parse(MATV_TRANSCRIPTS);
let dir: string;
let local: Db;
let target: Db;
let archive: DocumentStore;
let store: DocumentStore;
const manifestKey = transcriptManifestKey(source);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-transfer-'));
  local = openDb(path.join(dir, 'local.db'));
  target = openDb(path.join(dir, 'target.db'));
  syncSources(local, source.jurisdiction);
  syncSources(target, source.jurisdiction);
  archive = createLocalDocuments(path.join(dir, 'archive'));
  store = createLocalDocuments(path.join(dir, 'remote'));
});
afterEach(() => {
  local.close();
  target.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function page(posts: unknown[], options: { ok?: boolean; status?: number; inventory?: boolean } = {}) {
  const body = new TextEncoder().encode(JSON.stringify(posts));
  const id = createHash('sha256').update(body).digest('hex');
  const key = `${id.slice(0, 2)}/${id}.json`;
  const url = new URL(source.url);
  if (!options.inventory)
    url.searchParams.set('include', posts.map((p) => (p as { id: number }).id).join(','));
  await archive.put(key, body, 'application/json');
  upsertDocument(local, {
    id,
    sourceId: source.id,
    url: url.href,
    contentType: 'application/json',
    bytes: body.length,
    path: key,
  });
  recordFetch(local, {
    sourceId: source.id,
    url: url.href,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    httpStatus: options.status ?? 200,
    ok: options.ok ?? true,
    notModified: false,
    bytes: body.length,
    documentId: id,
    itemCount: posts.length,
    newCount: 0,
    error: null,
  });
  return { id, key, body, url: url.href };
}
const upload = () => uploadTranscripts(local, source, store, archive);
const ingest = () => importTranscripts(target, source, store);
const receipts = () =>
  (target.prepare('SELECT count(*) AS n FROM transcript_imports').get() as { n: number }).n;

describe('local transcript handoff', () => {
  it('runs the upload and import CLI against separate databases without publisher access', async () => {
    archive = createLocalDocuments(path.join(dir, 'documents'));
    await page([post(1)]);
    const run = (command: string, db: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', command, '--source', source.id], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOWNCIVIC_DATA_DIR: dir,
          TOWNCIVIC_DB: path.join(dir, db),
          TOWNCIVIC_DOCUMENTS: 'local',
          TOWNCIVIC_ACCOUNTS: 'sqlite',
          TOWNCIVIC_JURISDICTION: 'milton-ma',
        },
      });
    const uploaded = run('transcripts-upload', 'local.db');
    expect(uploaded.status, uploaded.stderr).toBe(0);
    expect(JSON.parse(uploaded.stdout)[0]).toMatchObject({ uploaded: 1 });
    const imported = run('transcripts-import', 'target.db');
    expect(imported.status, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)[0]).toMatchObject({ imported: 1, created: 1 });
    const text = queryEvents(target, { q: 'stormwater' });
    expect(text).toHaveLength(1);
    await archive.put(manifestKey, new TextEncoder().encode('not json'), 'application/json', {
      overwrite: true,
    });
    expect(run('transcripts-import', 'target.db').status).toBe(1);
  });

  it.each(['local', 's3'])(
    'uploads and upserts through %s, retaining other records and skipping replay after restart',
    async (backend) => {
      if (backend === 's3')
        store = createS3Documents({
          bucket: FAKE_S3_CREDENTIALS.bucket,
          endpoint: 'https://account.r2.cloudflarestorage.test',
          region: FAKE_S3_CREDENTIALS.region,
          accessKeyId: FAKE_S3_CREDENTIALS.accessKeyId,
          secretAccessKey: FAKE_S3_CREDENTIALS.secretAccessKey,
          fetchImpl: fakeS3().fetch,
        });
      seed(target, { jurisdiction: 'milton-ma' });
      const existing = queryEvents(target, { limit: 1000 }).map((r) => r.id);
      await page([post(1)]);
      expect(await upload()).toMatchObject({ uploaded: 1, documents: 1 });
      expect(await ingest()).toMatchObject({ imported: 1, created: 1 });
      expect(queryEvents(target, { q: 'stormwater' }).length).toBeGreaterThan(0);
      const ids = queryEvents(target, { limit: 1000 }).map((r) => r.id);
      expect(existing.every((id) => ids.includes(id))).toBe(true);
      expect(transcriptSyncState(target, source.id)).toMatchObject({ completedThrough: null, pending: null });
      target.close();
      target = openDb(path.join(dir, 'target.db'));
      const get = vi.spyOn(store, 'get');
      expect(await ingest()).toMatchObject({ imported: 0, skipped: 1 });
      expect(get).toHaveBeenCalledTimes(1); // Manifest only; receipts avoid downloading old pages.
      expect(await upload()).toMatchObject({ uploaded: 0, documents: 1 });
    },
  );

  it('imports corrections, advances metadata-only edits, and rejects older text from a later upload', async () => {
    await page([post(1)]);
    await upload();
    await ingest();
    const corrected = content.replace('stormwater', 'groundwater');
    await page([post(1, '2026-09-13T11:00:00', corrected)]);
    await upload();
    expect(await ingest()).toMatchObject({ revised: 1 });
    await page([post(1, '2026-09-15T11:00:00', corrected)]);
    await upload();
    expect(await ingest()).toMatchObject({ unchanged: 1, revised: 0 });
    // A stale local copy still merges the existing manifest, then is ignored per post.
    local.exec('DELETE FROM fetches');
    await page([post(1, '2026-09-14T11:00:00')]);
    expect(await upload()).toMatchObject({ documents: 4 });
    expect(await ingest()).toMatchObject({ stale: 1, revised: 0 });
    expect(queryEvents(target, { q: 'stormwater' })).toHaveLength(0);
    const event = queryEvents(target, { q: 'groundwater' })[0]!;
    expect(event.revision).toBe(2);
    expect(JSON.parse(event.raw).modifiedAt).toBe('2026-09-15T11:00:00Z');
  });

  it('omits inventory and failed requests, and leaves the old manifest on failed upload', async () => {
    await page([{ id: 1 }], { inventory: true });
    await page([post(2)], { ok: false, status: 202 });
    expect(await upload()).toMatchObject({ documents: 0 });
    await page([post(1)]);
    await upload();
    const previous = await store.get(manifestKey);
    const next = await page([post(3)]);
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, ...args) => {
      if (key === next.key) throw new Error('upload interrupted');
      return put(key, ...args);
    });
    await expect(upload()).rejects.toThrow('upload interrupted');
    expect(await store.get(manifestKey)).toEqual(previous);
    vi.restoreAllMocks();
    expect(await upload()).toMatchObject({ uploaded: 1, documents: 2 });
    expect(await ingest()).toMatchObject({ created: 2 });
  });

  it('validates pages before writing and retries missing or corrupt uploaded bytes', async () => {
    const ref = await page([post(1)]);
    await upload();
    const get = store.get.bind(store);
    const spy = vi.spyOn(store, 'get').mockImplementation(async (key) => (key === ref.key ? null : get(key)));
    await expect(ingest()).rejects.toThrow('Missing uploaded');
    expect(receipts()).toBe(0);
    spy.mockImplementation(async (key) => (key === ref.key ? new TextEncoder().encode('bad') : get(key)));
    await expect(ingest()).rejects.toThrow('corrupt');
    expect(queryEvents(target)).toHaveLength(0);
    spy.mockRestore();
    expect(await ingest()).toMatchObject({ created: 1 });
  });

  it('rolls back both page records and receipt if an upsert fails halfway', async () => {
    await page([post(1), post(2)]);
    await upload();
    target.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON events WHEN NEW.url LIKE '%post-2/'
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    await expect(ingest()).rejects.toThrow('simulated failure');
    expect(queryEvents(target)).toHaveLength(0);
    expect(receipts()).toBe(0);
    target.exec('DROP TRIGGER fail_second');
    expect(await ingest()).toMatchObject({ created: 2, imported: 1 });
  });

  it('previews without receipts and reconstructs from the manifest after records are cleared', async () => {
    await page([post(1)]);
    await upload();
    expect(await importTranscripts(target, source, store, { dryRun: true })).toMatchObject({
      items: 1,
      imported: 0,
      dryRun: true,
    });
    expect(queryEvents(target)).toHaveLength(0);
    expect(receipts()).toBe(0);
    await ingest();
    clearJurisdiction(target, { jurisdiction: source.jurisdiction, scope: 'records' });
    expect(receipts()).toBe(0);
    expect(await ingest()).toMatchObject({ created: 1 });
  });

  it('refuses malformed content before publishing a manifest and rejects another source manifest', async () => {
    await page([post(1), post(2, undefined, '<p>No transcript</p>')]);
    await expect(upload()).rejects.toThrow();
    expect(await store.get(manifestKey)).toBeNull();
    await store.put(
      manifestKey,
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          sourceId: 'another-town',
          documents: [],
        }),
      ),
      'application/json',
    );
    await expect(ingest()).rejects.toThrow('configured source');
  });
});
