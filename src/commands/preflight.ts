import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { checkAccounts, formatAccounts, type AccountsReport } from './accounts.ts';
import { checkDocuments, formatDocuments, type DocumentsReport } from './documents.ts';

/**
 * `preflight` — is this deployment wired up?
 *
 * townCivic has exactly two dependencies on somebody else's computer: a bucket
 * for the archive, and a Postgres for the readers. Both are optional, both
 * default to something local, and both fail in the same quiet way when
 * misconfigured — the site serves every public record perfectly, because none
 * of them need either one. The archive stops being written, or sign-in stops
 * working, and nobody finds out until after the deploy.
 *
 * Two commands already answer that question one subsystem at a time. This one
 * asks both at once and gives a single exit code, because the thing an operator
 * actually wants to know is "can I deploy", not "is the bucket reachable".
 *
 * It also checks the two settings that have to agree with each other rather
 * than with a remote service. Those are cheap to get wrong and expensive to
 * notice: a `Secure` cookie over plain HTTP is never sent, so signing in
 * silently does nothing.
 */

export interface PreflightReport {
  ok: boolean;
  documents: DocumentsReport;
  accounts: AccountsReport;
  settings: { ok: boolean; findings: { label: string; ok: boolean; detail: string }[] };
}

/**
 * The settings that are only wrong in combination.
 *
 * Nothing here talks to a network. These are the mistakes that look fine in
 * isolation and only contradict each other — which is exactly the kind a
 * per-subsystem check cannot see.
 */
function checkSettings(): PreflightReport['settings'] {
  const findings: PreflightReport['settings']['findings'] = [];
  const baseUrl = config.baseUrl;
  const https = baseUrl.startsWith('https://');
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$|\/)/.test(baseUrl);

  findings.push({
    label: 'base url',
    ok: true,
    detail: `${baseUrl}${local ? ' (local; feed links will only work on this machine)' : ''}`,
  });

  // A `Secure` cookie is simply not sent over plain HTTP, so the browser drops
  // the session and signing in appears to do nothing at all — no error, no
  // redirect loop, just a login form that keeps coming back.
  findings.push({
    label: 'cookies',
    ok: local || https === config.secureCookies,
    detail: local
      ? config.secureCookies
        ? 'Secure is on against a localhost URL — sign-in will not work over plain HTTP'
        : 'Secure is off, which is right for localhost'
      : https && !config.secureCookies
        ? 'serving HTTPS without TOWNCIVIC_SECURE_COOKIES=1 — the session cookie is not marked Secure'
        : !https && config.secureCookies
          ? 'TOWNCIVIC_SECURE_COOKIES=1 against a non-HTTPS base URL — the cookie will never be sent'
          : 'Secure is on, matching an HTTPS base URL',
  });

  // Only meaningful for the hosted accounts backend, and only as advice: an
  // unset key is generated per process, which is fine until there are two.
  if (config.accountsBackend === 'supabase') {
    findings.push({
      label: 'csrf key',
      ok: true,
      detail: config.sessionSecret
        ? 'TOWNCIVIC_SESSION_SECRET is set, so open forms survive a restart'
        : 'TOWNCIVIC_SESSION_SECRET is unset — fine for one instance, not for two behind a load balancer',
    });
  }

  return { ok: findings.every((finding) => finding.ok), findings };
}

export async function preflight(db: Db): Promise<PreflightReport> {
  // Sequential rather than parallel: each prints a section, and interleaved
  // network failures in a CI log are harder to read than they are slow.
  const documents = await checkDocuments();
  const accounts = await checkAccounts(db);
  const settings = checkSettings();

  return { ok: documents.ok && accounts.ok && settings.ok, documents, accounts, settings };
}

export function formatPreflight(report: PreflightReport, dim: (s: string) => string): string {
  const section = (title: string, body: string) =>
    `${dim(`── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)}\n${body}`;

  const settings = report.settings.findings
    .map((finding) => {
      const mark = finding.ok ? '[32m ok [0m' : '[33mwarn[0m';
      return `  [${mark}] ${finding.label.padEnd(9)} ${dim(finding.detail)}`;
    })
    .join('\n');

  return [
    section('documents', formatDocuments(report.documents, dim)),
    '',
    section('accounts', formatAccounts(report.accounts, dim)),
    '',
    section('settings', settings),
  ].join('\n');
}
