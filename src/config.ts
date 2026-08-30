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
  /**
   * Mark the session cookie `Secure`. Off by default so `npm run serve` on
   * localhost works; turn it on for anything served over HTTPS.
   */
  secureCookies: process.env.TOWNCIVIC_SECURE_COOKIES === '1',

  /**
   * Where readers live: `sqlite` (the tables in `data/towncivic.db`) or
   * `supabase` (GoTrue and Postgres at a hosted endpoint).
   *
   * `sqlite` by default, and deliberately: the quick start is "npm install, npm
   * run serve" with no account to create, and a default that needed a hosted
   * project would end that. See `src/accounts/store.ts` for what each backend
   * can and cannot do, and `supabase/README.md` for the setup.
   */
  accountsBackend: process.env.TOWNCIVIC_ACCOUNTS ?? 'sqlite',
  /** `https://<project>.supabase.co`. Read only by the supabase backend. */
  supabaseUrl: process.env.SUPABASE_URL,
  /**
   * The publishable anon key — the one that is safe in a browser, and the only
   * one the web tier ever needs. Row-level security is what keeps one reader's
   * list out of another's, so the service role key (which bypasses it) is never
   * read here.
   */
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  /**
   * HMAC key for CSRF tokens under the supabase backend, which has no sessions
   * table to keep a per-session random value in. Required there, unused by the
   * local backend.
   */
  sessionSecret: process.env.TOWNCIVIC_SESSION_SECRET,
} as const;
