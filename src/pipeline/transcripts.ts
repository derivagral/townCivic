import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import type { SourceDef } from '../types.ts';
import type { IngestOptions, IngestReport } from './ingest.ts';
import { fetchSource } from '../fetch/http.ts';
import { getDocuments } from '../documents/index.ts';
import { extensionFor, keyFor } from '../documents/store.ts';
import { recordFetch, updateSourceFetchState, upsertDocument, upsertEvent } from '../db/repo.ts';
import { makeContext } from '../adapters/index.ts';
import { parseWordpressPosts, wordpressTranscriptItem } from '../adapters/wordpress-transcripts.ts';
import { normalize } from './normalize.ts';

const pendingSchema = z.object({
  through: z.string().datetime(),
  ids: z.array(z.number().int().positive()),
  next: z.number().int().nonnegative(),
});
const stateSchema = z.object({
  version: z.literal(1),
  completedThrough: z.string().datetime().nullable(),
  pending: pendingSchema.nullable(),
});
type State = z.infer<typeof stateSchema>;

export function transcriptSyncState(db: Db, sourceId: string): State {
  const row = db.prepare('SELECT state FROM transcript_sync WHERE source_id = ?').get(sourceId) as
    { state: string } | undefined;
  const state = row
    ? stateSchema.parse(JSON.parse(row.state))
    : { version: 1 as const, completedThrough: null, pending: null };
  if (state.pending && state.pending.next > state.pending.ids.length)
    throw new Error('Invalid transcript checkpoint');
  return state;
}

function saveState(db: Db, sourceId: string, state: State): void {
  db.prepare(
    `INSERT INTO transcript_sync(source_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run(sourceId, JSON.stringify(state), new Date().toISOString());
}

/** Freeze an ID inventory, then fetch content by ID. Never resume a moving page offset. */
export async function syncWordpressTranscripts(
  db: Db,
  source: SourceDef,
  options: IngestOptions & { now?: Date } = {},
): Promise<IngestReport> {
  const report: IngestReport = {
    sourceId: source.id,
    label: source.label,
    ok: true,
    status: 0,
    notModified: false,
    items: 0,
    created: 0,
    revised: 0,
    unchanged: 0,
    duplicate: 0,
    pages: 0,
    pending: 0,
    completedThrough: null,
    unavailableIds: [],
  };
  const pageSize = Number(source.options['pageSize'] ?? 20);
  const maxPages = options.maxPages ?? 5;
  const category = Number(source.options['categoryId']);
  const endpoint = new URL(source.url);
  endpoint.search = '';
  const urlFor = (params: Record<string, string | number>): string => {
    const url = new URL(endpoint);
    url.searchParams.set('categories', String(category));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.toString();
  };

  // Every response is archived before use, even a 200/202 challenge. Fetch logs
  // keep the exact page URL and failure. Validators are not shared across URLs.
  async function read<T>(
    url: string,
    parse: (body: string, total?: number, pages?: number) => T,
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const response = await fetchSource(source.id, url, {
      accept: 'application/json',
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    report.status = response.status;
    let documentId: string | null = null;
    let failure: string | null = null;
    let count = 0;
    try {
      if (response.body) {
        const bytes = new TextEncoder().encode(response.body);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const stored = await getDocuments().put(
          keyFor(hash, extensionFor(response.contentType)),
          bytes,
          response.contentType,
        );
        documentId = stored.id;
        upsertDocument(db, {
          id: stored.id,
          sourceId: source.id,
          url,
          contentType: response.contentType,
          bytes: stored.bytes,
          path: stored.key,
        });
      }
      if (!response.ok || response.status !== 200 || response.notModified) {
        throw new Error(
          `WordPress request failed: ${response.error ?? `HTTP ${response.status} (expected 200 JSON)`}`,
        );
      }
      const result = parse(response.body, response.totalItems, response.totalPages);
      if (Array.isArray(result)) count = result.length;
      return result;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      recordFetch(db, {
        sourceId: source.id,
        url,
        startedAt,
        durationMs: Date.now() - start,
        httpStatus: response.status || null,
        ok: failure === null,
        notModified: false,
        bytes: Buffer.byteLength(response.body),
        documentId,
        itemCount: count,
        newCount: 0,
        error: failure,
      });
    }
  }

  try {
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 100 ||
      !Number.isInteger(category) ||
      category < 1
    )
      throw new Error('Invalid transcript batch/category configuration');
    const state = transcriptSyncState(db, source.id);
    report.completedThrough = state.completedThrough;
    if (!state.pending) {
      // Lag five minutes for publisher clock skew; overlap a day to catch boundary edits.
      const through = new Date((options.now ?? new Date()).getTime() - 5 * 60_000).toISOString();
      const after =
        state.completedThrough && !options.backfill && !options.force
          ? new Date(Date.parse(state.completedThrough) - 86_400_000).toISOString()
          : null;
      const ids: number[] = [];
      let expectedTotal: number | undefined;
      let pageCount = 1;
      for (let page = 1; page <= pageCount; page++) {
        const url = urlFor({
          per_page: 100,
          page,
          orderby: 'id',
          order: 'asc',
          _fields: 'id',
          modified_before: through,
          ...(after ? { modified_after: after } : {}),
        });
        const batch = await read(url, (body, total, pages) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            throw new Error('Expected WordPress JSON inventory; received a bot challenge or invalid JSON');
          }
          const rows = z
            .array(z.object({ id: z.number().int().positive() }))
            .max(100)
            .parse(parsed);
          if (
            !Number.isInteger(total) ||
            total! < 0 ||
            !Number.isInteger(pages) ||
            pages! < 0 ||
            pages !== Math.ceil(total! / 100) ||
            pages! > 100
          ) {
            throw new Error(
              'Missing/invalid WordPress pagination headers, or inventory exceeds 10,000 posts',
            );
          }
          if (expectedTotal !== undefined && total !== expectedTotal)
            throw new Error('Transcript inventory changed during discovery; retry');
          expectedTotal = total;
          pageCount = pages!;
          return rows;
        });
        for (const row of batch) {
          if (ids.length && row.id <= ids.at(-1)!)
            throw new Error('Repeated or unordered WordPress inventory page; retry');
          ids.push(row.id);
        }
      }
      if (ids.length !== expectedTotal) throw new Error('Incomplete WordPress inventory; retry');
      state.pending = { through, ids, next: 0 };
      // Discovery can be retried from scratch. Content resumes by this frozen list.
      if (!options.dryRun) saveState(db, source.id, state);
    }

    const pending = state.pending;
    report.pending = pending.ids.length - pending.next;
    for (let page = 0; page < maxPages && pending.next < pending.ids.length; page++) {
      const ids = pending.ids.slice(pending.next, pending.next + pageSize);
      const url = urlFor({
        include: ids.join(','),
        per_page: pageSize,
        orderby: 'include',
        _fields: 'id,link,date_gmt,modified_gmt,title,content,categories',
      });
      const posts = await read(url, (body, total, pages) => {
        const result = parseWordpressPosts(body);
        if (
          total !== result.length ||
          pages !== (result.length ? 1 : 0) ||
          result.some((p) => !ids.includes(p.id)) ||
          new Set(result.map((p) => p.id)).size !== result.length
        ) {
          throw new Error('Unexpected/incomplete WordPress include response');
        }
        // Parse the whole batch before writing any event or advancing the cursor.
        return result.map((post) => ({
          postId: post.id,
          event: normalize(source, wordpressTranscriptItem(post, makeContext(source))),
        }));
      });
      const missing = ids.filter((id) => !posts.some((post) => post.postId === id));
      const counts = { created: 0, revised: 0, unchanged: 0, duplicate: 0 };
      if (!options.dryRun) {
        db.exec('BEGIN');
        try {
          for (const { event } of posts) {
            const outcome = upsertEvent(db, event);
            if (outcome === 'new') counts.created++;
            else if (outcome === 'revised') counts.revised++;
            else if (outcome === 'duplicate') counts.duplicate++;
            else counts.unchanged++;
          }
          pending.next += ids.length;
          saveState(db, source.id, state);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } else pending.next += ids.length;
      report.items += posts.length;
      for (const key of ['created', 'revised', 'unchanged', 'duplicate'] as const) report[key] += counts[key];
      report.unavailableIds!.push(...missing);
      report.pages!++;
      report.pending = pending.ids.length - pending.next;
    }
    if (pending.next === pending.ids.length) {
      state.completedThrough = pending.through;
      state.pending = null;
      if (!options.dryRun) saveState(db, source.id, state);
    }
    // Dry-run reports candidate progress but never claims a committed watermark.
    if (!options.dryRun) report.completedThrough = state.completedThrough;
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
  }
  updateSourceFetchState(db, source.id, {
    clearValidators: true,
    status: report.status,
    error: report.error ?? null,
  });
  return report;
}
