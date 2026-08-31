import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { createDocuments, createLocalDocuments, DocumentStoreUnavailableError } from '../documents/index.ts';
import { contentTypeFor, type DocumentStore, type StoreCheck } from '../documents/store.ts';

/**
 * `documents` — say where the archive lives, prove it works, and move it.
 *
 * The failure this exists to prevent is the same shape as the accounts one, and
 * worse in its consequences. A misconfigured object store does not look broken:
 * every page serves, because nothing reads the archive. It fails on the next
 * `ingest`, and what is lost is the one thing in townCivic that cannot be
 * rebuilt — the copy of a document the town has since taken down.
 *
 * So `check` does a real write, read and delete rather than a ping, and
 * `--backfill` exists because switching backends with an archive already on
 * disk is the normal case rather than the exotic one.
 */

export interface DocumentsReport extends StoreCheck {
  backend: string;
  description: string;
}

export async function checkDocuments(backend: string = config.documentsBackend): Promise<DocumentsReport> {
  try {
    const store = createDocuments(backend);
    return { backend: store.kind, description: store.describe(), ...(await store.check()) };
  } catch (error) {
    if (!(error instanceof DocumentStoreUnavailableError)) throw error;
    return {
      backend,
      description: 'not configured',
      ok: false,
      findings: [{ label: 'configuration', ok: false, detail: error.message }],
    };
  }
}

export interface BackfillReport {
  /** Rows the database knows about. */
  total: number;
  uploaded: number;
  /** Already in the destination — a re-run costs one HEAD per object. */
  present: number;
  /** In the database, but not on the local disk to copy. */
  missing: number;
  failed: { key: string; error: string }[];
  bytes: number;
}

export interface BackfillOptions {
  limit?: number | undefined;
  dryRun?: boolean | undefined;
  /** Where to copy from. Defaults to the local archive. */
  from?: DocumentStore | undefined;
  /** Where to copy to. Defaults to whatever `TOWNCIVIC_DOCUMENTS` selects. */
  to?: DocumentStore | undefined;
  onProgress?: ((done: number, total: number, key: string) => void) | undefined;
}

/**
 * Copy the archive into the configured store.
 *
 * The manifest is the database, not a directory walk: `documents.path` and
 * `attachments.path` already name every object, and their `id` is the content
 * hash. So this copies exactly what the pipeline believes it has, and a row
 * whose file is missing from disk is reported rather than passed over — that
 * gap is worth knowing about before it is the only copy that is gone.
 *
 * Restartable by construction. Keys are content-addressed, so an object already
 * at the destination is byte-identical and is skipped; interrupting this and
 * running it again resumes rather than re-uploading.
 */
export async function backfillDocuments(db: Db, options: BackfillOptions = {}): Promise<BackfillReport> {
  const from = options.from ?? createLocalDocuments();
  const to = options.to ?? createDocuments();

  const rows = db
    .prepare(
      `SELECT path, bytes FROM documents
       UNION
       SELECT path, bytes FROM attachments WHERE path IS NOT NULL
       ORDER BY path`,
    )
    .all() as unknown as { path: string; bytes: number }[];

  const capped = options.limit ? rows.slice(0, options.limit) : rows;
  const report: BackfillReport = {
    total: rows.length,
    uploaded: 0,
    present: 0,
    missing: 0,
    failed: [],
    bytes: 0,
  };

  let done = 0;
  for (const row of capped) {
    done += 1;
    options.onProgress?.(done, capped.length, row.path);

    if (await to.has(row.path)) {
      report.present += 1;
      continue;
    }

    const body = await from.get(row.path);
    if (!body) {
      report.missing += 1;
      continue;
    }
    if (options.dryRun) {
      report.uploaded += 1;
      report.bytes += body.byteLength;
      continue;
    }

    try {
      await to.put(row.path, body, contentTypeFor(row.path));
      report.uploaded += 1;
      report.bytes += body.byteLength;
    } catch (error) {
      report.failed.push({ key: row.path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return report;
}

export function formatDocuments(report: DocumentsReport, dim: (s: string) => string): string {
  const lines = [`  ${report.backend}  ${dim(report.description)}`, ''];
  for (const finding of report.findings) {
    const mark = finding.ok ? '[32m ok [0m' : '[31mfail[0m';
    lines.push(`  [${mark}] ${finding.label.padEnd(9)} ${dim(finding.detail)}`);
  }
  return lines.join('\n');
}
