import { createHash } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { SourceDef } from '../types.ts';
import { parseWithSource } from '../adapters/index.ts';
import { normalize } from './normalize.ts';
import { fetchSource } from '../fetch/http.ts';
import { getDocuments } from '../documents/index.ts';
import { extensionFor, keyFor } from '../documents/store.ts';
import {
  getConditionalHeaders,
  recordFetch,
  updateSourceFetchState,
  upsertDocument,
  upsertEvent,
} from '../db/repo.ts';
import { syncSources } from '../registry/index.ts';

const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface IngestReport {
  sourceId: string;
  label: string;
  ok: boolean;
  status: number;
  notModified: boolean;
  items: number;
  created: number;
  revised: number;
  unchanged: number;
  /** Seen, but already owned by a more authoritative source. */
  duplicate: number;
  error?: string;
}

export interface IngestOptions {
  jurisdiction?: string;
  /** Restrict to these source ids. */
  sourceIds?: string[];
  /** Parse and report, but write nothing to `events`. */
  dryRun?: boolean;
  /** Ignore stored ETag / Last-Modified and refetch in full. */
  force?: boolean;
  /** Also run sources marked `enabled: false`. */
  includeDisabled?: boolean;
  fetchImpl?: typeof fetch;
  onProgress?: (report: IngestReport) => void;
}

/**
 * Parse one already-fetched body and write the events.
 *
 * Split out from `ingest` so fixtures, tests and the seed command exercise the
 * exact same normalization path as a live fetch.
 */
export function ingestBody(
  db: Db,
  source: SourceDef,
  body: string,
  options: { dryRun?: boolean } = {},
): { items: number; created: number; revised: number; unchanged: number; duplicate: number } {
  const items = parseWithSource(source, body);
  const counts = { created: 0, revised: 0, unchanged: 0, duplicate: 0 };

  for (const item of items) {
    const event = normalize(source, item);
    if (options.dryRun) continue;
    const outcome = upsertEvent(db, event);
    if (outcome === 'new') counts.created++;
    else if (outcome === 'revised') counts.revised++;
    else if (outcome === 'duplicate') counts.duplicate++;
    else counts.unchanged++;
  }

  return { items: items.length, ...counts };
}

export async function ingest(db: Db, options: IngestOptions = {}): Promise<IngestReport[]> {
  const sources = syncSources(db, options.jurisdiction).filter((source) => {
    if (options.sourceIds?.length) return options.sourceIds.includes(source.id);
    return source.enabled || options.includeDisabled;
  });

  const reports: IngestReport[] = [];

  for (const source of sources) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const conditional = options.force ? {} : getConditionalHeaders(db, source.id);

    const result = await fetchSource(source.id, source.url, {
      ...conditional,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    const report: IngestReport = {
      sourceId: source.id,
      label: source.label,
      ok: result.ok,
      status: result.status,
      notModified: result.notModified,
      items: 0,
      created: 0,
      revised: 0,
      unchanged: 0,
      duplicate: 0,
    };

    let documentId: string | null = null;

    if (result.ok && !result.notModified) {
      // The key is the content hash, so this is the same key in either
      // backend — which is what makes `documents --backfill` a copy rather
      // than a migration.
      const body = new TextEncoder().encode(result.body);
      const id = sha256Bytes(body);
      const stored = await getDocuments().put(
        keyFor(id, extensionFor(result.contentType)),
        body,
        result.contentType,
      );
      documentId = stored.id;
      upsertDocument(db, {
        id: stored.id,
        sourceId: source.id,
        url: result.url,
        contentType: result.contentType,
        bytes: stored.bytes,
        path: stored.key,
      });

      try {
        Object.assign(report, ingestBody(db, source, result.body, { dryRun: options.dryRun ?? false }));
      } catch (error) {
        report.ok = false;
        report.error = `parse failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else if (!result.ok) {
      report.error = result.error ?? `HTTP ${result.status}`;
    }

    updateSourceFetchState(db, source.id, {
      etag: result.etag,
      lastModified: result.lastModified,
      status: result.status,
      error: report.error ?? null,
    });

    recordFetch(db, {
      sourceId: source.id,
      url: source.url,
      startedAt,
      durationMs: Date.now() - started,
      httpStatus: result.status || null,
      ok: report.ok,
      notModified: result.notModified,
      bytes: Buffer.byteLength(result.body, 'utf8'),
      documentId,
      itemCount: report.items,
      newCount: report.created,
      error: report.error ?? null,
    });

    reports.push(report);
    options.onProgress?.(report);
  }

  return reports;
}
