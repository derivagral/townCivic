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
  /**
   * `https://<project-ref>.supabase.co`. Read only by the supabase backend.
   *
   * The `NEXT_PUBLIC_` spellings are accepted because they are what Supabase's
   * own dashboard hands you to paste into an `.env`, so they are what people
   * already have set. townCivic is not Next.js and does not otherwise know what
   * that prefix means; it is here to save retyping a value that is already
   * right.
   */
  supabaseUrl: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  /**
   * The public project key — safe in a browser, and the only one the web tier
   * ever needs. Row-level security is what keeps one reader's list out of
   * another's, so the service role (or `sb_secret_…`) key, which bypasses it, is
   * never read here.
   *
   * Either generation works: the legacy `anon` key (a JWT, `eyJ…`) or the
   * publishable key that replaces it (`sb_publishable_…`). They are the same
   * role; see `isLegacyJwtKey` in `accounts/supabase.ts` for the one place the
   * difference shows.
   */
  supabaseAnonKey:
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  /**
   * HMAC key for CSRF tokens under the supabase backend, which has no sessions
   * table to keep a per-session random value in.
   *
   * Optional: one is generated per process when this is unset. It is not a
   * session store — sessions live in Supabase — so a new key signs nobody out,
   * it only expires forms already open in a browser. Set it to stop that
   * happening on every restart, and to let several instances accept each
   * other's forms. Unused by the local backend.
   */
  sessionSecret: process.env.TOWNCIVIC_SESSION_SECRET,

  /**
   * Where the raw document archive lives: `local` (a directory under
   * `dataDir`) or `s3` (any S3-compatible object store).
   *
   * `local` by default, and for the same reason as everything else here: the
   * quick start must work with no account and no credentials. The archive is
   * the one thing in townCivic that cannot be regenerated, so an S3 backend is
   * about durability rather than scale — see `docs/operations.md`.
   */
  documentsBackend: process.env.TOWNCIVIC_DOCUMENTS ?? 'local',
  s3Bucket: process.env.S3_BUCKET,
  /**
   * The S3 API endpoint, without a bucket: `https://<account>.r2.cloudflarestorage.com`,
   * `https://fly.storage.tigris.dev`, a MinIO host. Set it and addressing is
   * path-style, which every S3-compatible store accepts; leave it unset for AWS
   * proper, where the bucket goes in the hostname.
   *
   * Deliberately a plain endpoint rather than a provider name. The reason to use
   * object storage instead of a platform's bundled add-on is that the bucket
   * should outlive the decision about where the app runs.
   */
  s3Endpoint: process.env.S3_ENDPOINT,
  /** `auto` for R2 and most compatible stores; a real region for AWS. */
  s3Region: process.env.S3_REGION,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  /** Only for temporary credentials; most setups leave this unset. */
  s3SessionToken: process.env.S3_SESSION_TOKEN,
} as const;
