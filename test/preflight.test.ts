import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db/index.ts';
import { ROOT } from '../src/config.ts';
import { preflight } from '../src/commands/preflight.ts';

/**
 * `preflight`, and the workflow that runs it.
 *
 * The command mostly composes two checks that have their own tests, so what is
 * worth pinning here is the part it adds: the settings that are only wrong in
 * *combination*, and the exit code an operator gates a deploy on.
 *
 * The workflow assertions matter for a different reason. A workflow cannot be
 * unit-tested, and the two mistakes worth catching in one — leaking credentials
 * to a `pull_request` trigger, or forgetting a key so the job silently probes
 * the local defaults — are both invisible in a green run.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env['TOWNCIVIC_BASE_URL'];
  delete process.env['TOWNCIVIC_SECURE_COOKIES'];
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('preflight', () => {
  it('reports every subsystem and is ready on the defaults', async () => {
    const report = await preflight(openDb(':memory:'));

    expect(report.documents.backend).toBe('local');
    expect(report.accounts.backend).toBe('sqlite');
    // The whole point of the defaults: nothing configured, nothing broken.
    expect(report.ok).toBe(true);
  });

  it('accepts a plain-HTTP localhost with cookies left insecure', async () => {
    const report = await preflight(openDb(':memory:'));
    const cookies = report.settings.findings.find((f) => f.label === 'cookies');
    expect(cookies?.ok).toBe(true);
    expect(cookies?.detail).toMatch(/right for localhost/);
  });
});

/**
 * The settings check reads `config`, which is evaluated once when the module is
 * first imported — so these run the CLI in a child process, which is the only
 * way to observe a different environment.
 */
describe('settings that are only wrong together', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(ROOT, 'src', 'cli.ts'), 'preflight', '--json'],
      { encoding: 'utf8', env: { ...process.env, TOWNCIVIC_DB: ':memory:', ...env } },
    );

  it('flags an HTTPS base URL served without a Secure cookie', () => {
    const { stdout, status } = run({ TOWNCIVIC_BASE_URL: 'https://towncivic.example' });
    const report = JSON.parse(stdout) as Awaited<ReturnType<typeof preflight>>;

    const cookies = report.settings.findings.find((f) => f.label === 'cookies');
    expect(cookies?.ok).toBe(false);
    expect(cookies?.detail).toMatch(/not marked Secure/);
    // Non-zero, because this is the shape of "deployed and sign-in silently
    // does nothing" — the session cookie is dropped by every browser.
    expect(status).toBe(1);
  });

  it('flags a Secure cookie promised over plain HTTP', () => {
    const { stdout, status } = run({
      TOWNCIVIC_BASE_URL: 'http://towncivic.example',
      TOWNCIVIC_SECURE_COOKIES: '1',
    });
    const report = JSON.parse(stdout) as Awaited<ReturnType<typeof preflight>>;

    expect(report.settings.findings.find((f) => f.label === 'cookies')?.ok).toBe(false);
    expect(status).toBe(1);
  });

  it('is happy when HTTPS and Secure agree', () => {
    const { stdout, status } = run({
      TOWNCIVIC_BASE_URL: 'https://towncivic.example',
      TOWNCIVIC_SECURE_COOKIES: '1',
    });
    const report = JSON.parse(stdout) as Awaited<ReturnType<typeof preflight>>;

    expect(report.settings.ok).toBe(true);
    expect(status).toBe(0);
  });
});

describe('the preflight workflow', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'preflight.yml'), 'utf8');

  it('never runs on a pull request', () => {
    // The one rule that keeps credentials out of reach of a fork or a branch.
    // Every workflow that carries them has to hold it.
    expect(yaml).not.toMatch(/^\s*pull_request:/m);
    expect(yaml).toMatch(/^\s*workflow_dispatch:/m);
  });

  it('passes through every variable the checks actually read', () => {
    // A missing key here does not fail the job — it silently probes the local
    // defaults and reports a cheerful green, which is the worst outcome
    // available for a command whose entire purpose is to catch that.
    for (const key of [
      'S3_BUCKET',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'TOWNCIVIC_BASE_URL',
      'TOWNCIVIC_SECURE_COOKIES',
    ]) {
      expect(yaml, `preflight.yml does not pass ${key}`).toMatch(new RegExp(`^\\s*${key}:`, 'm'));
    }
  });

  it('keeps credentials in secrets and locators in variables', () => {
    // "The locator is a variable, the credential is a secret" — stated in the
    // docs and in the sync script, so it should be true of the workflow too.
    for (const locator of ['S3_BUCKET', 'S3_ENDPOINT', 'SUPABASE_URL']) {
      expect(yaml).toMatch(new RegExp(`${locator}:\\s*\\$\\{\\{\\s*vars\\.`));
    }
    for (const credential of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'SUPABASE_ANON_KEY']) {
      expect(yaml).toMatch(new RegExp(`${credential}:\\s*\\$\\{\\{\\s*secrets\\.`));
    }
  });
});

describe('the sync script', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-github-config.sh'), 'utf8');

  it('does nothing without --apply', () => {
    expect(script).toMatch(/APPLY=0/);
    expect(script).toMatch(/\[ "\$APPLY" -eq 1 \] && gh (variable|secret) set/);
  });

  it('syncs from an allowlist rather than whatever the file happens to hold', () => {
    // A `.env` is a working file. Uploading it wholesale is how a credential
    // ends up somewhere nobody meant to put it.
    expect(script).toMatch(/VARIABLES=\(/);
    expect(script).toMatch(/SECRETS=\(/);
    expect(script).toMatch(/not synced/);
  });

  it('never prints a secret value', () => {
    // The dry run has to be readable without being a way to shoulder-surf a key.
    expect(script).toMatch(/tr ' ' '\*'/);
    expect(script).not.toMatch(/printf.*secret.*%s\\n' "\$key" "\$value"/);
  });
});
