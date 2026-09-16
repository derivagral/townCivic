import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { upsertDocument } from '../db/repo.ts';
import type { SourceDef } from '../types.ts';
import { createDocuments, createLocalDocuments, keyFor, type DocumentStore } from '../documents/index.ts';
import { makeContext } from '../adapters/index.ts';
import { parseWordpressPosts, wordpressTranscriptItem } from '../adapters/wordpress-transcripts.ts';
import { normalize } from '../pipeline/normalize.ts';
import { upsertWordpressTranscript } from '../pipeline/transcript-upsert.ts';

const referenceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string().url(),
  fetchedAt: z.string().datetime(),
});
const manifestSchema = z.object({
  version: z.literal(1),
  sourceId: z.string(),
  documents: z.array(referenceSchema).max(10_000),
});
type Reference = z.infer<typeof referenceSchema>;
const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export function transcriptManifestKey(source: SourceDef): string {
  if (source.adapter !== 'wordpress-transcripts' || !/^[a-z0-9:-]+$/.test(source.id))
    throw new Error('Transcript transfer requires a registered WordPress transcript source');
  return `transcript-imports/${source.id}/manifest.json`;
}

function isContentUrl(value: string, source: SourceDef): boolean {
  const url = new URL(value);
  const endpoint = new URL(source.url);
  return (
    url.origin === endpoint.origin &&
    url.pathname === endpoint.pathname &&
    url.searchParams.get('categories') === String(source.options['categoryId']) &&
    /^[1-9]\d*(,[1-9]\d*)*$/.test(url.searchParams.get('include') ?? '')
  );
}

async function readManifest(store: DocumentStore, source: SourceDef): Promise<Reference[]> {
  const body = await store.get(transcriptManifestKey(source));
  if (!body) return [];
  if (body.byteLength > 4 * 1024 * 1024) throw new Error('Transcript manifest exceeds 4 MiB');
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder().decode(body)));
  if (manifest.sourceId !== source.id || manifest.documents.some((d) => !isContentUrl(d.url, source)))
    throw new Error('Transcript manifest does not match the configured source');
  if (new Set(manifest.documents.map((d) => d.id)).size !== manifest.documents.length)
    throw new Error('Repeated document in transcript manifest');
  return manifest.documents.sort(
    (a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id),
  );
}

function parsePage(body: Uint8Array, ref: Reference, source: SourceDef) {
  if (body.byteLength > 64 * 1024 * 1024 || digest(body) !== ref.id)
    throw new Error(`Transcript document is oversized or corrupt: ${ref.id}`);
  const ids = new URL(ref.url).searchParams.get('include')!.split(',').map(Number);
  const posts = parseWordpressPosts(new TextDecoder().decode(body));
  if (posts.some((p) => !ids.includes(p.id)) || new Set(posts.map((p) => p.id)).size !== posts.length)
    throw new Error(`Unexpected posts in transcript document: ${ref.id}`);
  return posts.map((post) => normalize(source, wordpressTranscriptItem(post, makeContext(source))));
}

/** Upload raw successful content pages; publish the cumulative manifest last. */
export async function uploadTranscripts(
  db: Db,
  source: SourceDef,
  destination: DocumentStore = createDocuments(),
  archive: DocumentStore = createLocalDocuments(),
) {
  const key = transcriptManifestKey(source);
  const previous = await readManifest(destination, source);
  const references = new Map(previous.map((ref) => [ref.id, ref]));
  const rows = db
    .prepare(
      `
    SELECT f.document_id AS id, f.url, d.path, min(f.started_at) AS fetchedAt
    FROM fetches f JOIN documents d ON d.id = f.document_id
    WHERE f.source_id = ? AND f.ok = 1 AND f.http_status = 200
    GROUP BY f.document_id, f.url, d.path ORDER BY fetchedAt, f.document_id
  `,
    )
    .all(source.id) as unknown as (Reference & { path: string })[];
  let uploaded = 0;
  for (const row of rows) {
    if (!isContentUrl(row.url, source)) continue; // No inventory pages or bot challenges.
    const ref = referenceSchema.parse(row);
    if (references.has(ref.id)) continue;
    const objectKey = keyFor(ref.id, 'json');
    // Supports a local archive and local fetching directly into the configured R2 store.
    const body = (await archive.get(row.path)) ?? (await destination.get(row.path));
    if (!body) throw new Error(`Missing archived transcript document: ${objectKey}`);
    parsePage(body, ref, source);
    await destination.put(objectKey, body, 'application/json');
    references.set(ref.id, ref);
    uploaded++;
  }
  const documents = [...references.values()].sort(
    (a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id),
  );
  const manifest = manifestSchema.parse({ version: 1, sourceId: source.id, documents });
  const body = bytes(manifest);
  if (body.byteLength > 4 * 1024 * 1024) throw new Error('Transcript manifest exceeds 4 MiB');
  // A failed upload leaves the previous manifest intact. One uploader per source.
  if (uploaded) await destination.put(key, body, 'application/json', { overwrite: true });
  return { sourceId: source.id, uploaded, documents: documents.length, manifest: key };
}

/** Upsert each validated page and its import receipt in one transaction. No MATV fetches. */
export async function importTranscripts(
  db: Db,
  source: SourceDef,
  store: DocumentStore = createDocuments(),
  options: { dryRun?: boolean } = {},
) {
  const references = await readManifest(store, source);
  const report = {
    sourceId: source.id,
    documents: references.length,
    imported: 0,
    skipped: 0,
    items: 0,
    created: 0,
    revised: 0,
    unchanged: 0,
    duplicate: 0,
    stale: 0,
    dryRun: !!options.dryRun,
  };
  for (const ref of references) {
    if (
      db
        .prepare('SELECT 1 FROM transcript_imports WHERE source_id = ? AND document_id = ?')
        .get(source.id, ref.id)
    ) {
      report.skipped++;
      continue;
    }
    const key = keyFor(ref.id, 'json');
    const body = await store.get(key);
    if (!body) throw new Error(`Missing uploaded transcript document: ${key}`);
    const events = parsePage(body, ref, source); // Validate the entire page before any writes.
    report.items += events.length;
    if (options.dryRun) continue;
    db.exec('BEGIN');
    try {
      upsertDocument(db, {
        id: ref.id,
        sourceId: source.id,
        url: ref.url,
        contentType: 'application/json',
        bytes: body.byteLength,
        path: key,
      });
      for (const event of events) {
        const outcome = upsertWordpressTranscript(db, event);
        if (outcome === 'new') report.created++;
        else if (outcome === 'revised') report.revised++;
        else if (outcome === 'duplicate') report.duplicate++;
        else if (outcome === 'stale') report.stale++;
        else report.unchanged++;
      }
      db.prepare('INSERT INTO transcript_imports(source_id, document_id, imported_at) VALUES (?, ?, ?)').run(
        source.id,
        ref.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      report.imported++;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return report;
}
