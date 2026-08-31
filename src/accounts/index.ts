import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { createSqliteAccounts } from './sqlite.ts';
import { createSupabaseAccounts } from './supabase.ts';
import { AccountsUnavailableError, type AccountStore } from './store.ts';

export * from './store.ts';
export * from './cookies.ts';
export { createSqliteAccounts } from './sqlite.ts';
export { createSupabaseAccounts } from './supabase.ts';

export const ACCOUNT_BACKENDS = ['sqlite', 'supabase'] as const;
export type AccountBackend = (typeof ACCOUNT_BACKENDS)[number];

export function isAccountBackend(value: string): value is AccountBackend {
  return (ACCOUNT_BACKENDS as readonly string[]).includes(value);
}

/**
 * Build the configured accounts backend.
 *
 * `sqlite` unless `TOWNCIVIC_ACCOUNTS=supabase` — the default has to be the one
 * that needs no account and no network, because that is what "npm install, npm
 * run serve" promises.
 *
 * A misconfigured hosted backend is a hard failure rather than a silent
 * fallback to the local one. Falling back would mean an operator who fat-fingers
 * an environment variable gets a working site whose readers are quietly in the
 * wrong database — one that their next deploy deletes.
 */
export function createAccounts(db: Db, backend: string = config.accountsBackend): AccountStore {
  if (backend === 'supabase') return createSupabaseAccounts();
  if (backend === 'sqlite') return createSqliteAccounts(db);
  throw new AccountsUnavailableError(
    `Unknown accounts backend "${backend}". Set TOWNCIVIC_ACCOUNTS to one of: ${ACCOUNT_BACKENDS.join(', ')}.`,
  );
}
