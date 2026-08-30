import { config } from '../config.ts';
import { createLocalDocuments } from './local.ts';
import { createS3Documents } from './s3.ts';
import { DocumentStoreUnavailableError, type DocumentStore } from './store.ts';

export * from './store.ts';
export { createLocalDocuments } from './local.ts';
export { createS3Documents } from './s3.ts';

export const DOCUMENT_BACKENDS = ['local', 's3'] as const;
export type DocumentBackend = (typeof DOCUMENT_BACKENDS)[number];

export function isDocumentBackend(value: string): value is DocumentBackend {
  return (DOCUMENT_BACKENDS as readonly string[]).includes(value);
}

let cached: DocumentStore | undefined;

/**
 * Build the configured document store.
 *
 * `local` unless `TOWNCIVIC_DOCUMENTS=s3` — the default has to be the one that
 * needs no account and no credentials, because that is what "npm install, npm
 * run ingest" promises.
 *
 * A misconfigured S3 backend is a hard failure rather than a silent fallback to
 * the local disk. Falling back would mean an operator who fat-fingers a
 * variable gets a pipeline that appears to work while writing the archive to a
 * container filesystem that the next deploy throws away — and the archive is
 * the one thing here that cannot be regenerated.
 */
export function createDocuments(backend: string = config.documentsBackend): DocumentStore {
  if (backend === 's3') return createS3Documents();
  if (backend === 'local') return createLocalDocuments();
  throw new DocumentStoreUnavailableError(
    `Unknown document backend "${backend}". Set TOWNCIVIC_DOCUMENTS to one of: ${DOCUMENT_BACKENDS.join(', ')}.`,
  );
}

/** Process-wide handle, so the pipeline stages share one store. */
export function getDocuments(): DocumentStore {
  cached ??= createDocuments();
  return cached;
}

/** Point the pipeline at a specific store. For tests and for `documents --backfill`. */
export function setDocuments(store: DocumentStore | undefined): void {
  cached = store;
}
