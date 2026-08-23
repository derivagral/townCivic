import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  /** Everything the pipeline writes lives here. Safe to delete and rebuild. */
  dataDir: process.env.TOWNCIVIC_DATA_DIR ?? path.join(ROOT, 'data'),
  get dbPath() {
    return process.env.TOWNCIVIC_DB ?? path.join(config.dataDir, 'towncivic.db');
  },
  /** Content-addressed raw document store. The model is an indexer, not the authority. */
  get docStoreDir() {
    return path.join(config.dataDir, 'documents');
  },
  port: Number(process.env.PORT ?? 8787),
  /** Public base URL, used for absolute links in Atom feeds. */
  baseUrl: process.env.TOWNCIVIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /**
   * Identify the crawler honestly. These are public records and small town
   * servers; a contact URL costs nothing and prevents a lot of trouble.
   */
  userAgent:
    process.env.TOWNCIVIC_USER_AGENT ??
    'townCivic/0.1 (civic primary-source feed; +https://github.com/derivagral/towncivic)',
  requestTimeoutMs: Number(process.env.TOWNCIVIC_TIMEOUT_MS ?? 20_000),
  /** Politeness delay between requests to the same host. */
  perHostDelayMs: Number(process.env.TOWNCIVIC_HOST_DELAY_MS ?? 1_000),
  maxRetries: Number(process.env.TOWNCIVIC_MAX_RETRIES ?? 3),
  defaultJurisdiction: process.env.TOWNCIVIC_JURISDICTION ?? 'milton-ma',
} as const;
