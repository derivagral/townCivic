import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { createDocuments } from '../documents/index.ts';
import type { DocumentStore } from '../documents/store.ts';

/**
 * `snapshot` — move the built database between the pipeline and the web tier.
 *
 * These are two different machines now. The pipeline runs in GitHub Actions and
 * produces `towncivic.db`; the web tier runs somewhere else entirely and only
 * ever reads it. Something has to carry the file across, and the obvious
 * candidates are both wrong: an Actions artifact expires and needs a GitHub
 * token to fetch, and committing a binary that changes twice a day is exactly
 * what `refresh.yml` has always refused to do.
 *
 * So it goes in the object store that already exists, at a stable key. Push
 * after a refresh, pull at deploy time, and neither side needs to know anything
 * about the other beyond a bucket.
 *
 * The database is genuinely a cache — the archive is the authority and the
 * pipeline rebuilds this from it — so a single overwritten key is the right
 * shape. There is no history to keep here, and the checksum beside it exists to
 * catch a truncated transfer rather than to identify a version.
 */

/** One well-known key, overwritten each run. */
export const SNAPSHOT_KEY = 'db/towncivic.db';
export const SNAPSHOT_DIGEST_KEY = 'db/towncivic.db.sha256';

export interface SnapshotReport {
  action: 'push' | 'pull';
  key: string;
  bytes: number;
  sha256: string;
  /** True when the store already held these exact bytes. */
  unchanged: boolean;
  store: string;
}

const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

/** Upload the local database to the configured store. */
export async function pushSnapshot(store: DocumentStore = createDocuments()): Promise<SnapshotReport> {
  const file = config.dbPath;
  if (!fs.existsSync(file)) {
    throw new Error(`No database at ${file}. Run the pipeline before publishing a snapshot.`);
  }

  const body = new Uint8Array(fs.readFileSync(file));
  const sha256 = digest(body);

  // Not content-addressed, unlike everything else in the store: the whole point
  // is a key the deploy can name without being told. So `put` cannot skip on
  // identity, and the digest beside it is what says whether anything moved.
  const previous = await store.get(SNAPSHOT_DIGEST_KEY);
  const unchanged = previous ? new TextDecoder().decode(previous).trim() === sha256 : false;

  if (!unchanged) {
    // `overwrite` is not optional here. Both stores skip a write to a key they
    // already hold — correct everywhere else, because every other key is the
    // hash of its own content — and without this the published database would
    // freeze at whatever was uploaded first while every run cheerfully reported
    // success.
    const replace = { overwrite: true };
    await store.put(SNAPSHOT_KEY, body, 'application/vnd.sqlite3', replace);
    await store.put(SNAPSHOT_DIGEST_KEY, new TextEncoder().encode(`${sha256}\n`), 'text/plain', replace);
  }

  return { action: 'push', key: SNAPSHOT_KEY, bytes: body.byteLength, sha256, unchanged, store: store.kind };
}

/**
 * Download the published database over the local one.
 *
 * Verifies the checksum before replacing anything, and writes through a
 * temporary file so an interrupted transfer cannot leave a half-written
 * database where the server expects a whole one.
 */
export async function pullSnapshot(store: DocumentStore = createDocuments()): Promise<SnapshotReport> {
  const body = await store.get(SNAPSHOT_KEY);
  if (!body) {
    throw new Error(
      `No snapshot at ${SNAPSHOT_KEY} in the ${store.kind} store. Run \`snapshot\` after a pipeline run to publish one.`,
    );
  }

  const sha256 = digest(body);
  const expected = await store.get(SNAPSHOT_DIGEST_KEY);
  if (expected) {
    const want = new TextDecoder().decode(expected).trim();
    if (want !== sha256) {
      throw new Error(`Snapshot is corrupt: expected sha256 ${want}, got ${sha256}. Refusing to install it.`);
    }
  }

  const file = config.dbPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.incoming`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, file);

  // A WAL and shared-memory file beside a database that was just replaced
  // wholesale describe transactions that no longer exist. SQLite would either
  // refuse the file or apply them over the top of the new one.
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }

  return {
    action: 'pull',
    key: SNAPSHOT_KEY,
    bytes: body.byteLength,
    sha256,
    unchanged: false,
    store: store.kind,
  };
}

export function formatSnapshot(report: SnapshotReport, dim: (s: string) => string): string {
  const megabytes = (report.bytes / 1024 / 1024).toFixed(1);
  const verb =
    report.action === 'push' ? (report.unchanged ? 'already published' : 'published') : 'installed';
  return [
    `  ${verb} ${megabytes} MB  ${dim(`${report.store}:${report.key}`)}`,
    `  ${dim(`sha256 ${report.sha256.slice(0, 16)}…`)}`,
    ...(report.unchanged ? [dim('  Byte-identical to what was already there; nothing uploaded.')] : []),
  ].join('\n');
}
