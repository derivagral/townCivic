/**
 * The document store port.
 *
 * `data/documents/` is the archive: the raw bytes of every listing page and
 * every PDF the pipeline has seen, keyed by the sha256 of the content. It is the
 * one thing in townCivic that is not derived from something else — the town can
 * take a document down, and then this is the only copy there is.
 *
 * It is also, today, **write-only**. Nothing reads it back: `serve` never opens
 * it, the UI links to the town's own URL, `extract` re-downloads rather than
 * re-reading, and `ingest` on a 304 does nothing at all. The searchable text was
 * denormalized into SQLite at extraction time. So this is provenance rather than
 * a hot path, and moving it somewhere else cannot break a page.
 *
 * Which is exactly why it can move. Two implementations:
 *
 *   local  the filesystem, unchanged and still the default. No account, no
 *          network, no credentials — the same promise the rest of the quick
 *          start makes.
 *   s3     any S3-compatible endpoint. Cloudflare R2, Tigris, Backblaze B2,
 *          MinIO, AWS itself. Deliberately not one provider's SDK: the whole
 *          point of an object store is that the API is the same everywhere, and
 *          a bundled per-platform integration is the thing to avoid if you ever
 *          want to move.
 *
 * What this buys operationally is that the pipeline stops needing a persistent
 * disk. With documents in object storage, `.github/workflows/refresh.yml`
 * running in Actions is durable on its own rather than depending on a cache
 * that can be evicted.
 */

/** Where a stored object lives, and whether this call is what put it there. */
export interface StoredObject {
  /** sha256 of the content, hex. Also the identity: same bytes, same id. */
  id: string;
  /** The store-relative key. Matches `documents.path` / `attachments.path`. */
  key: string;
  bytes: number;
  /** False when this exact content was already stored. */
  isNew: boolean;
}

export interface DocumentStore {
  readonly kind: 'local' | 's3';
  /** One line for `documents check` and the startup banner. */
  describe(): string;

  /**
   * Store bytes under a content-addressed key.
   *
   * Idempotent by construction: the key is derived from the content, so writing
   * the same document twice is a no-op that reports `isNew: false`. Skipping is
   * safe *because* of the addressing — the object already there is byte-identical
   * by definition.
   *
   * `overwrite` is for the one key that breaks that rule. The published database
   * lives at a fixed name so a deploy can ask for it without being told which
   * version to want, which means its content changes under a constant key and
   * the skip would freeze it at whatever was published first.
   */
  put(
    key: string,
    body: Uint8Array,
    contentType: string | null,
    options?: { overwrite?: boolean },
  ): Promise<StoredObject>;
  /** Whether this key is already stored. */
  has(key: string): Promise<boolean>;
  /**
   * Read an object back, or null if it is not there.
   *
   * Nothing in the pipeline calls this today. It exists because a store you
   * cannot read from is a store you cannot verify — `documents check` does a
   * round trip through it — and because serving an archived copy of a document
   * the town has since removed is the obvious next use.
   */
  get(key: string): Promise<Uint8Array | null>;

  /** Reachability, credentials and a write/read/delete round trip. */
  check(): Promise<StoreCheck>;
}

export interface StoreCheck {
  ok: boolean;
  findings: { label: string; ok: boolean; detail: string }[];
}

/**
 * Raised when a backend is selected but cannot be built — a missing bucket, a
 * missing key. Its own type so the CLI prints the message rather than a stack
 * trace for what is always a configuration mistake.
 */
export class DocumentStoreUnavailableError extends Error {
  override name = 'DocumentStoreUnavailableError';
}

/**
 * The key for a document, from its content hash.
 *
 * Two levels so no directory holds every object: the local backend cares
 * because filesystems get slow, and object stores do not care but the shared
 * layout means the same key works in both, which is what makes a backfill a
 * copy rather than a migration.
 */
export function keyFor(id: string, extension: string, prefix = ''): string {
  return `${prefix}${id.slice(0, 2)}/${id}.${extension}`;
}

export function extensionFor(contentType: string | null): string {
  if (!contentType) return 'bin';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('xml')) return 'xml';
  if (contentType.includes('html')) return 'html';
  if (contentType.includes('text/')) return 'txt';
  return 'bin';
}

/** Guessed back from a key, for setting `content-type` on an upload. */
export function contentTypeFor(key: string): string {
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      pdf: 'application/pdf',
      html: 'text/html; charset=utf-8',
      xml: 'application/xml; charset=utf-8',
      json: 'application/json',
      txt: 'text/plain; charset=utf-8',
    }[extension] ?? 'application/octet-stream'
  );
}
