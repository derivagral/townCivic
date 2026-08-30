import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { createAccounts, AccountsUnavailableError, type AccountCheck } from '../accounts/index.ts';

/**
 * `accounts check` — say which backend is configured, and whether it works.
 *
 * The failure this exists to prevent is the quiet one. A misconfigured hosted
 * backend does not look broken: the site serves every public record perfectly,
 * because none of them need an account. It only fails when somebody tries to
 * sign in, which is after the deploy and usually not the operator. So there has
 * to be a command that asks the questions ahead of time — is the URL right, is
 * the key right, has the migration actually been run, does the feed function
 * exist — and answers them before a reader does it for you.
 */

export interface AccountsReport extends AccountCheck {
  backend: string;
  description: string;
  capabilities: Record<string, boolean>;
}

export async function checkAccounts(
  db: Db,
  backend: string = config.accountsBackend,
): Promise<AccountsReport> {
  try {
    const store = createAccounts(db, backend);
    const result = await store.check();
    return {
      backend: store.kind,
      description: store.describe(),
      capabilities: { ...store.capabilities },
      ...result,
    };
  } catch (error) {
    if (!(error instanceof AccountsUnavailableError)) throw error;
    // A configuration mistake, not a crash: report it in the same shape as any
    // other finding so `--json` stays parseable and the exit code still means
    // what it means.
    return {
      backend,
      description: 'not configured',
      capabilities: {},
      ok: false,
      findings: [{ label: 'configuration', ok: false, detail: error.message }],
    };
  }
}

/** What each capability means, for the humans reading the table. */
const CAPABILITY_LABELS: Record<string, string> = {
  emailConfirmation: 'confirms the email address',
  passwordReset: 'password reset',
  rateLimiting: 'rate limits failed sign-ins',
  survivesDatabaseReset: 'readers survive deleting data/towncivic.db',
};

export function formatAccounts(report: AccountsReport, dim: (s: string) => string): string {
  const lines = [`  ${report.backend}  ${dim(report.description)}`, ''];

  for (const finding of report.findings) {
    const mark = finding.ok ? '[32m ok [0m' : '[31mfail[0m';
    lines.push(`  [${mark}] ${finding.label.padEnd(9)} ${dim(finding.detail)}`);
  }

  if (Object.keys(report.capabilities).length) {
    lines.push('');
    for (const [name, enabled] of Object.entries(report.capabilities)) {
      lines.push(`  ${enabled ? '[32m yes[0m' : dim('  no')}  ${CAPABILITY_LABELS[name] ?? name}`);
    }
  }

  return lines.join('\n');
}
