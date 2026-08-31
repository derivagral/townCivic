#!/usr/bin/env node
/**
 * Turn a `preflight --json` report into a GitHub job summary.
 *
 * Its own file rather than a `node -e` string in the workflow, for two reasons
 * that both showed up the first time this ran. Inline JavaScript inside YAML
 * inside a shell heredoc has three layers of quoting and no way to test any of
 * them, and the failure mode is a stack trace in the middle of a job that was
 * only ever meant to be decoration.
 *
 * So this is defensive on purpose: it is the *reporting* step, and a reporting
 * step that can fail the run it is reporting on is worse than no reporting at
 * all. Anything unexpected becomes text in the summary rather than an exception.
 */

import fs from 'node:fs';

const file = process.argv[2];
const out = [];

let report;
try {
  const raw = fs.readFileSync(file, 'utf8');
  report = JSON.parse(raw);
} catch (error) {
  // Most likely `npm run` without `--silent`, whose banner lands on stdout
  // ahead of the JSON. Print what was actually there — the first line of it
  // names the problem far better than a parse error does.
  const head = (() => {
    try {
      return fs.readFileSync(file, 'utf8').slice(0, 400);
    } catch {
      return '(no output at all)';
    }
  })();
  out.push('### Preflight', '', 'Could not read the report.', '', '```', head.trim(), '```');
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(0);
}

const yes = (ok) => (ok ? 'yes' : '**no**');

out.push('### Preflight', '');
out.push(report.ok ? '**Ready.** Every configured dependency answered.' : '**Not ready.**', '');
out.push('| Subsystem | Backend | Ready |', '| --- | --- | --- |');
out.push(`| documents | \`${report.documents?.backend ?? '?'}\` | ${yes(report.documents?.ok)} |`);
out.push(`| accounts | \`${report.accounts?.backend ?? '?'}\` | ${yes(report.accounts?.ok)} |`);
out.push(`| settings | — | ${yes(report.settings?.ok)} |`);

// Every finding, not only the failures: on a green run the details are the
// useful part — which bucket, which project, whether RLS is actually on.
for (const [section, part] of Object.entries(report)) {
  if (!part?.findings?.length) continue;
  out.push('', `<details><summary>${section}</summary>`, '');
  for (const finding of part.findings) {
    out.push(`- ${finding.ok ? '✓' : '✗'} **${finding.label}** — ${finding.detail}`);
  }
  out.push('', '</details>');
}

process.stdout.write(`${out.join('\n')}\n`);
