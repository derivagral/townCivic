#!/usr/bin/env node
import './util/quiet.ts';
import './util/env.ts';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { getDb, closeDb } from './db/index.ts';
import {
  syncSources,
  syncJurisdictions,
  loadSources,
  listJurisdictions,
  listProfiles,
  getProfile,
  orphanJurisdictions,
} from './registry/index.ts';
import { ingest } from './pipeline/ingest.ts';
import { extractDocuments } from './pipeline/extract.ts';
import { linkMatters } from './pipeline/link.ts';
import { geocodeMatters } from './pipeline/geocode.ts';
import { PROVIDERS, interpretDocuments, isProvider } from './pipeline/interpret.ts';
import { verify } from './commands/verify.ts';
import { discover, toRegistrySnippet } from './commands/discover.ts';
import { status } from './commands/status.ts';
import { fetchBoundary } from './commands/boundary.ts';
import { seed, clearSampleData, hasSampleData } from './commands/seed.ts';
import { CLEAR_SCOPES, clearJurisdiction, clearOrphans, isClearScope } from './commands/clear.ts';
import { checkAccounts, formatAccounts } from './commands/accounts.ts';
import { backfillDocuments, checkDocuments, formatDocuments } from './commands/documents.ts';
import { formatPreflight, preflight } from './commands/preflight.ts';
import { formatSnapshot, pullSnapshot, pushSnapshot } from './commands/snapshot.ts';
import { createAccounts } from './accounts/index.ts';
import { createApp } from './web/server.ts';
import { countEvents, listJurisdictionRows, queryEvents } from './db/repo.ts';

const USAGE = `townCivic — a primary-source civic record for one town.

Usage: towncivic <command> [options]

Commands
  seed                 Load synthetic development fixtures so the UI has data
  ingest               Fetch every enabled source and normalize what changed
  extract              Open the linked PDFs and read agendas, locations and subjects
  link                 Group records about the same property or article into timelines
  interpret            Read votes and dispositions out of minutes, into a separate index
  geocode              Resolve linked addresses to coordinates for the map
  verify               Check every registered URL against the live site
  status               Report pipeline counts, source health and staleness (exit 1 on a problem)
  boundary             Refetch the town outline from MassGIS (maintenance; commit the result)
  discover             Probe the CivicPlus site for boards and feeds not yet registered
  serve                Run the web UI and the Atom / JSON feeds
  accounts             Report which accounts backend is configured, and probe it
  documents            Report where the document archive lives, probe it, and copy it
  preflight            Probe every external dependency at once; exit 1 if any is not ready
  snapshot             Publish the built database to the object store, or --pull it back
  towns                List every registered town and what the database holds for it
  sources              Print the source registry
  events               Print recent records as JSON
  clear                Delete one town's rows: derived data, records, or the town
  clear-samples        Delete every event loaded from fixtures
  help                 Show this message

Options
  --jurisdiction <id>  Town to operate on, or \`all\` (default: ${config.defaultJurisdiction})
  --source <id>        Restrict to one source; repeatable
  --all                Include sources marked disabled
  --force              Ignore stored ETag / Last-Modified and refetch
  --dry-run            Parse and report without writing events
  --json               Machine-readable output
  --port <n>           Port for serve (default: ${config.port})
  --limit <n>          Row limit for events / documents to extract
  --since <date>       Only extract records dated on or after this ISO date
  --provider <name>    Interpreter for \`interpret\`: ${PROVIDERS.join(' | ')} (default: rules)
  --scope <what>       For \`clear\`: ${CLEAR_SCOPES.join(' | ')} (default: derived)
  --orphans            For \`clear\`: every town in the database the registry has dropped
  --backfill           For \`documents\`: copy the local archive into the configured store
  --pull               For \`snapshot\`: download the published database instead of publishing

Towns
  ${listJurisdictions().join(', ')}

Examples
  npm run seed && npm run serve
  npx tsx src/cli.ts verify --all
  npx tsx src/cli.ts ingest --source milton-ma:agenda:planning-board
  npx tsx src/cli.ts ingest --jurisdiction all
  npx tsx src/cli.ts discover --jurisdiction weymouth-ma
  npx tsx src/cli.ts clear --jurisdiction weymouth-ma --scope records --dry-run
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    jurisdiction: { type: 'string' },
    source: { type: 'string', multiple: true },
    all: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    port: { type: 'string' },
    limit: { type: 'string' },
    since: { type: 'string' },
    provider: { type: 'string' },
    scope: { type: 'string' },
    orphans: { type: 'boolean', default: false },
    backfill: { type: 'boolean', default: false },
    pull: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const command = positionals[0] ?? 'help';
const jurisdiction = values.jurisdiction ?? config.defaultJurisdiction;
const sourceIds = values.source ?? [];

/**
 * Catch `npm run link --jurisdiction all`.
 *
 * Without a `--` separator, npm keeps the flag for itself: it sets
 * `npm_config_jurisdiction` in the environment and passes only the *value*
 * through as a bare positional. So the command runs, silently, against the
 * default town — which for `link` means a no-op and for
 *
 *     npm run clear --jurisdiction hull-ma --scope town
 *
 * means clearing Milton's derived data instead of dropping Hull. The CLI
 * receives `clear hull-ma` with no flags at all.
 *
 * Two signals, either of which is enough. A stray positional is the reliable
 * one — every value-taking flag leaves its value behind — and the environment
 * variable names which flag it was. Only flags npm has no config of its own for
 * are checked, so nobody's `.npmrc` can trigger this.
 */
const NPM_SWALLOWS = ['jurisdiction', 'source', 'limit', 'since', 'provider', 'port'] as const;

function npmAteTheFlags(): string[] {
  return NPM_SWALLOWS.filter(
    (flag) => process.env[`npm_config_${flag}`] !== undefined && values[flag] === undefined,
  );
}

/**
 * Which towns a command runs over.
 *
 * `--jurisdiction all` is what makes a scheduled refresh a single line no
 * matter how many towns are registered, and it is deliberately spelled out
 * rather than being the default: a command that quietly fetched four towns
 * because someone omitted a flag would be a bad surprise for four town
 * servers.
 */
const ALL = 'all';
const targets = jurisdiction === ALL ? listJurisdictions() : [jurisdiction];

const check = (ok: boolean) => (ok ? '[32mok[0m' : '[31mFAIL[0m');
const dim = (text: string) => `[2m${text}[0m`;
const bold = (text: string) => `[1m${text}[0m`;

/**
 * Machine-readable output, collected rather than printed as it goes.
 *
 * One town prints exactly what it printed before this file knew about several,
 * so anything parsing `--json` keeps working; `--jurisdiction all` prints an
 * array of `{ jurisdiction, report }`, which is the only shape that can say
 * which town each result came from.
 */
const jsonReports: { jurisdiction: string; report: unknown }[] = [];

function emitJson(town: string, report: unknown): number {
  jsonReports.push({ jurisdiction: town, report });
  return 0;
}

function flushJson(): void {
  if (!values.json || !jsonReports.length) return;
  const single = jsonReports.length === 1 && targets.length === 1;
  console.log(JSON.stringify(single ? jsonReports[0]!.report : jsonReports, null, 2));
}

/** Run a command body once per target town, returning the worst exit code. */
async function forEachTown(run: (town: string) => Promise<number>): Promise<number> {
  let worst = 0;
  for (const town of targets) {
    // Named even when there is only one, so a run that quietly fell back to the
    // default town says so. That is the difference between noticing
    // `npm run link --jurisdiction all` did nothing and not noticing.
    if (!values.json) console.log(`\n${bold(getProfile(town).label)} ${dim(town)}`);
    worst = Math.max(worst, await run(town));
  }
  return worst;
}

async function main(): Promise<number> {
  if (values.help || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const eaten = npmAteTheFlags();
  const strays = positionals.slice(1);
  if (eaten.length || strays.length) {
    console.error(
      `[31mnpm kept ${eaten.map((flag) => `--${flag}`).join(', ') || 'the flags you passed'} for itself — ` +
        `this command never saw ${eaten.length === 1 ? 'it' : 'them'}.[0m\n\n` +
        `  npm run ${command} [1m--[0m ${eaten.map((flag) => `--${flag} <value>`).join(' ') || '--flag value'}\n\n` +
        'The `--` is what tells npm that the rest belongs to the script. Without it npm reads the flag\n' +
        `as its own${strays.length ? `, passing on only the bare value (${strays.join(', ')})` : ''}, so this would have run against the default\n` +
        'town rather than the one you asked for. `npx tsx src/cli.ts` takes the flags directly.',
    );
    return 1;
  }

  // `clear` is the exception: its whole job can be to remove a town the
  // registry no longer knows, so it validates its own target.
  const unchecked = command === 'discover' || command === 'clear' || command === 'towns';
  if (jurisdiction !== ALL && !listJurisdictions().includes(jurisdiction) && !unchecked) {
    console.error(
      `Unknown jurisdiction "${jurisdiction}". Known: ${listJurisdictions().join(', ')}, or \`all\`.`,
    );
    return 1;
  }

  switch (command) {
    case 'seed': {
      const db = getDb();
      return forEachTown(async (town) => {
        const reports = seed(db, { jurisdiction: town });
        if (values.json) return emitJson(town, reports);
        for (const report of reports) {
          console.log(
            `${check(true)}  ${report.sourceId.padEnd(34)} ${String(report.items).padStart(3)} items  ` +
              dim(
                `${report.created} new, ${report.revised} revised, ${report.unchanged} unchanged  ← ${report.fixture}`,
              ),
          );
        }
        if (!reports.length) {
          console.log(dim(`No fixtures for ${town} — only towns with committed fixtures can be seeded.`));
        }
        console.log(`\n${countEvents(db, { jurisdiction: town })} records for ${town}.`);
        console.log(dim('These are synthetic fixtures, not real records. Run `ingest` for the live site.'));
        return 0;
      });
    }

    case 'ingest': {
      const db = getDb();
      return forEachTown(async (town) => {
        const reports = await ingest(db, {
          jurisdiction: town,
          ...(sourceIds.length ? { sourceIds } : {}),
          ...(values.all ? { includeDisabled: true } : {}),
          ...(values.force ? { force: true } : {}),
          ...(values['dry-run'] ? { dryRun: true } : {}),
          onProgress(report) {
            if (values.json) return;
            const state = report.notModified
              ? dim('not modified')
              : `${String(report.items).padStart(3)} items`;
            console.log(
              `${check(report.ok)}  ${report.sourceId.padEnd(40)} ${String(report.status).padStart(3)}  ${state}  ` +
                dim(`${report.created} new, ${report.revised} revised, ${report.duplicate} dup`) +
                (report.error ? `\n     [31m${report.error}[0m` : ''),
            );
          },
        });
        if (values.json) return emitJson(town, reports);
        const failed = reports.filter((r) => !r.ok);
        if (failed.length) {
          console.log(`\n${failed.length} of ${reports.length} sources failed.`);
        }
        if (!reports.length) {
          console.log(dim(`No enabled sources for ${town}. Run \`discover\` and \`verify\` first.`));
        }
        return failed.length === reports.length && reports.length > 0 ? 1 : 0;
      });
    }

    case 'extract': {
      const db = getDb();
      return forEachTown(async (town) => {
        let structured = 0;
        const reports = await extractDocuments(db, {
          jurisdiction: town,
          ...(sourceIds.length ? { sourceIds } : {}),
          ...(values.force ? { force: true } : {}),
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          ...(values.since ? { since: values.since } : {}),
          onProgress(report) {
            if (report.structured) structured++;
            if (values.json) return;
            const detail = report.ok
              ? `${String(report.pages).padStart(2)}p  ${String(report.agendaItems).padStart(2)} items  ` +
                `${report.structured ? '\u001b[32mstructured\u001b[0m' : dim((report.quality ?? 'text').padEnd(10))}` +
                (report.subjects.length ? `  ${dim(report.subjects.slice(0, 3).join(', '))}` : '')
              : `\u001b[31m${report.failureCode ? `[${report.failureCode}] ` : ''}${report.error ?? 'failed'}\u001b[0m`;
            console.log(`${check(report.ok)}  ${report.title.slice(0, 46).padEnd(46)} ${detail}`);
          },
        });
        if (values.json) return emitJson(town, reports);
        const failed = reports.filter((r) => !r.ok).length;
        const scanned = reports.filter((r) => r.likelyScanned).length;
        console.log(
          `\n${reports.length} documents: ${structured} structured, ${reports.length - structured - failed} text only, ${failed} failed.`,
        );
        if (scanned) console.log(dim(`${scanned} look scanned and would need OCR.`));
        return failed === reports.length && reports.length > 0 ? 1 : 0;
      });
    }

    case 'link': {
      const db = getDb();
      return forEachTown(async (town) => {
        const summary = linkMatters(db, { jurisdiction: town });
        if (values.json) return emitJson(town, summary);
        // Only the multi-record ones are worth printing — a matter with one
        // record is a subject, not a story.
        for (const report of summary.reports.filter((r) => r.events > 1).slice(0, 25)) {
          console.log(
            `  ${String(report.events).padStart(3)} records  ${report.label.slice(0, 44).padEnd(44)} ` +
              dim(`${report.kind}  ${report.status ?? ''}`),
          );
        }
        console.log(
          `\n${summary.eventsConsidered} records → ${summary.matters} matters, ${summary.links} links.`,
        );
        console.log(
          dim(
            `${summary.timelines} carry more than one record` +
              (summary.placed ? `; ${summary.placed} placed from the geocode cache, no network.` : '.'),
          ),
        );
        return 0;
      });
    }

    case 'interpret': {
      const db = getDb();
      const provider = values.provider ?? 'rules';
      if (!isProvider(provider)) {
        console.error(`Unknown provider "${provider}". Known: ${PROVIDERS.join(', ')}`);
        return 1;
      }

      return forEachTown(async (town) => {
        let found = 0;
        const reports = await interpretDocuments(db, {
          jurisdiction: town,
          provider,
          ...(values.force ? { force: true } : {}),
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          ...(values.since ? { since: values.since } : {}),
          onProgress(report) {
            found += report.found;
            if (values.json || report.skipped === 'unchanged') return;
            console.log(
              `${check(report.ok)}  ${report.title.slice(0, 52).padEnd(52)} ` +
                (report.ok
                  ? report.found
                    ? `${report.found} reading${report.found === 1 ? '' : 's'}`
                    : dim('nothing recorded')
                  : `[31m${report.error ?? 'failed'}[0m`),
            );
          },
        });

        if (values.json) return emitJson(town, reports);
        const skipped = reports.filter((r) => r.skipped === 'unchanged').length;
        const failed = reports.filter((r) => !r.ok).length;
        console.log(
          `\n${reports.length} documents read by \`${provider}\`: ${found} reading${found === 1 ? '' : 's'}, ${failed} failed` +
            (skipped ? `, ${skipped} already current` : '') +
            '.',
        );
        console.log(
          dim('Readings are derived, not the record. They are stored and shown separately, and searched'),
        );
        console.log(dim('only when a reader asks for them.'));
        return failed === reports.length && reports.length > 0 ? 1 : 0;
      });
    }

    case 'geocode': {
      const db = getDb();
      return forEachTown(async (town) => {
        const reports = await geocodeMatters(db, {
          jurisdiction: town,
          ...(values.force ? { force: true } : {}),
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          onProgress(report) {
            if (values.json) return;
            console.log(
              `${check(report.ok)}  ${report.label.slice(0, 40).padEnd(40)} ` +
                (report.ok
                  ? `${report.lat!.toFixed(5)}, ${report.lon!.toFixed(5)}  ${dim(report.matched ?? '')}`
                  : `[33m${report.failureCode ? `[${report.failureCode}] ` : ''}${report.error ?? 'no match'}[0m`),
            );
          },
        });
        if (values.json) return emitJson(town, reports);
        const placed = reports.filter((r) => r.ok).length;
        console.log(`\n${placed} of ${reports.length} addresses placed.`);
        if (placed < reports.length) {
          console.log(dim('Unplaced addresses are listed on /map rather than dropped.'));
        }
        return 0;
      });
    }

    case 'verify': {
      const db = getDb();
      return forEachTown(async (town) => {
        const results = await verify(db, {
          jurisdiction: town,
          ...(sourceIds.length ? { sourceIds } : {}),
          ...(values.all ? { includeDisabled: true } : {}),
          onResult(result) {
            if (values.json) return;
            const suggestion = result.suggestedConfidence
              ? `  [33m→ mark ${result.suggestedConfidence}[0m`
              : result.empty
                ? '  [33mempty[0m'
                : '';
            console.log(
              `${check(result.ok)}  ${result.sourceId.padEnd(40)} ${String(result.status).padStart(3)}  ` +
                `${String(result.items).padStart(4)} items  ${dim(result.confidence.padEnd(10))}${suggestion}` +
                (result.error ? `\n     [31m${result.error}[0m` : ''),
            );
          },
        });
        if (values.json) return emitJson(town, results);
        const broken = results.filter((r) => !r.ok);
        const empty = results.filter((r) => r.empty);
        console.log(
          broken.length
            ? `\n${broken.length} of ${results.length} sources failed. Try \`discover\` for the CivicPlus ids.`
            : `\nAll ${results.length} sources answered and parsed.`,
        );
        if (empty.length) {
          console.log(dim(`${empty.length} answered but published nothing — correct URL, unpopulated feed.`));
        }
        return broken.length ? 1 : 0;
      });
    }

    case 'discover': {
      return forEachTown(async (town) => {
        const report = await discover({ jurisdiction: town });
        if (values.json) return emitJson(town, report);
        console.log(`Probing ${report.base}\n`);

        console.log('Agenda Center categories');
        if (!report.categories.length) console.log(dim('  none found'));
        for (const category of report.categories) {
          console.log(
            `  ${category.known ? dim('known') : '[32mNEW  [0m'} ` +
              `cid=${String(category.cid).padStart(4)}  ${category.body.padEnd(34)} ${dim(`→ ${category.channel}`)}`,
          );
        }

        // Grouped by module, because the useful output is the ModID→module map.
        console.log('\nPublished RSS modules');
        const byModule = new Map<string, { modId: string | null; feeds: typeof report.feeds }>();
        for (const feed of report.feeds) {
          const entry = byModule.get(feed.module) ?? { modId: feed.modId, feeds: [] };
          entry.feeds.push(feed);
          byModule.set(feed.module, entry);
        }
        if (!byModule.size) console.log(dim('  none found'));
        for (const [module, entry] of byModule) {
          console.log(
            `  ModID=${(entry.modId ?? '?').padEnd(4)} ${module}  ${dim(`${entry.feeds.length} feed(s)`)}`,
          );
          for (const feed of entry.feeds.slice(0, 3))
            console.log(dim(`         ${feed.label} — ${feed.url}`));
          if (entry.feeds.length > 3) console.log(dim(`         … ${entry.feeds.length - 3} more`));
        }

        for (const error of report.errors) console.error(`\n[31m${error}[0m`);
        console.log(`\n${toRegistrySnippet(report.categories, town)}`);
        return report.errors.length ? 1 : 0;
      });
    }

    case 'status': {
      const db = getDb();
      return forEachTown(async (town) => {
        const report = status(db, town);
        if (values.json) {
          // Non-zero on a problem, so a cron job or a monitor can just check
          // the exit code without parsing anything.
          emitJson(town, report);
          return report.ok ? 0 : 1;
        }

        console.log(
          `${report.events} records · ${report.matters} matters · ` +
            `${report.placed.resolved}/${report.placed.total} addresses placed · ` +
            `${report.boundary ? `outline ${report.boundary.points} pts` : '[33mno outline[0m'} · ` +
            `${report.interpretations} derived reading${report.interpretations === 1 ? '' : 's'}`,
        );
        console.log(
          dim(`${report.documentsExtracted} documents read, ${report.documentsPending} pending extraction\n`),
        );

        for (const source of report.sources) {
          const state = !source.enabled
            ? dim('off       ')
            : source.lastError || (source.lastStatus ?? 0) >= 400
              ? '[31mFAIL      [0m'
              : source.stale
                ? `[33mstale ${String(source.staleDays).padStart(3)}d[0m`
                : '[32mok        [0m';
          console.log(
            `  ${state} ${source.sourceId.padEnd(40)} ${String(source.events).padStart(4)} records  ` +
              dim(source.lastFetchAt ? `last fetch ${source.lastFetchAt.slice(0, 10)}` : 'never fetched'),
          );
        }

        if (report.warnings.length) {
          console.log(`\n[33m${report.warnings.length} warning(s):[0m`);
          for (const warning of report.warnings) console.log(`  ${warning}`);
        }
        if (report.problems.length) {
          console.log(`\n[31m${report.problems.length} problem(s):[0m`);
          for (const problem of report.problems) console.log(`  ${problem}`);
        } else if (!report.warnings.length) {
          console.log(`\n[32mNothing to look at.[0m`);
        }
        return report.ok ? 0 : 1;
      });
    }

    case 'boundary': {
      return forEachTown(async (town) => {
        const report = await fetchBoundary({
          jurisdiction: town,
          ...(values['dry-run'] ? { dryRun: true } : {}),
        });
        if (values.json) {
          emitJson(town, report);
          return report.ok ? 0 : 1;
        }
        if (!report.ok) {
          console.error(`[31m${report.error ?? 'failed'}[0m`);
          return 1;
        }
        const area = report.landAreaSqM
          ? `  ${(report.landAreaSqM / 2_589_988).toFixed(2)} sq mi of land`
          : '';
        console.log(
          `${check(true)}  ${report.jurisdiction.padEnd(14)} ${report.change.padEnd(9)} ` +
            `${report.polygons} polygon(s), ${report.points} points, ${(report.bytes / 1024).toFixed(1)} KB${area}`,
        );
        console.log(dim(`  ${report.file}`));
        if (report.change === 'unchanged') {
          console.log(dim('  Identical to what is committed — nothing to do.'));
        } else if (values['dry-run']) {
          console.log(dim('  Dry run; nothing written.'));
        } else {
          console.log(dim('  Written. Review the diff before committing — this is source data.'));
        }
        return 0;
      });
    }

    case 'sources': {
      return forEachTown(async (town) => {
        const sources = loadSources(town);
        if (values.json) return emitJson(town, sources);
        for (const source of sources) {
          console.log(
            `${source.enabled ? ' ' : dim('·')} tier ${source.tier}  ${source.id.padEnd(34)} ` +
              `${source.channel.padEnd(14)} ${dim(source.confidence.padEnd(11))}${source.url}`,
          );
        }
        console.log(`\n${sources.length} sources (${sources.filter((s) => s.enabled).length} enabled).`);
        return 0;
      });
    }

    case 'events': {
      const db = getDb();
      const rows = queryEvents(db, {
        ...(jurisdiction === ALL ? {} : { jurisdiction }),
        limit: Number(values.limit ?? 25),
      });
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }

    case 'clear-samples': {
      const db = getDb();
      const removed = clearSampleData(db, jurisdiction === ALL ? undefined : jurisdiction);
      console.log(`Removed ${removed} sample record${removed === 1 ? '' : 's'}.`);
      return 0;
    }

    case 'clear': {
      const db = getDb();
      const scope = values.scope ?? 'derived';
      if (!isClearScope(scope)) {
        console.error(`Unknown scope "${scope}". Known: ${CLEAR_SCOPES.join(', ')}`);
        return 1;
      }

      const dryRun = Boolean(values['dry-run']);
      const reports = values.orphans
        ? clearOrphans(db, dryRun ? { dryRun: true } : {})
        : (jurisdiction === ALL ? listJurisdictions() : [jurisdiction]).map((town) =>
            clearJurisdiction(db, { jurisdiction: town, scope, ...(dryRun ? { dryRun: true } : {}) }),
          );

      if (values.json) {
        console.log(JSON.stringify(reports, null, 2));
        return 0;
      }
      if (!reports.length) {
        console.log('Nothing to clear.');
        return 0;
      }

      for (const report of reports) {
        const total = Object.values(report.removed).reduce((n, count) => n + count, 0);
        console.log(
          `${report.dryRun ? dim('would remove') : 'removed     '} ` +
            `${String(total).padStart(6)} rows  ${report.jurisdiction.padEnd(14)} ` +
            dim(`scope ${report.scope}${report.orphan ? ', not in the registry' : ''}`),
        );
        for (const [table, n] of Object.entries(report.removed)) {
          if (n) console.log(dim(`         ${String(n).padStart(6)}  ${table}`));
        }
        if (report.scope === 'town' && report.documentsKept) {
          console.log(
            dim(
              `         ${report.documentsKept} stored document(s) are left on disk — the content store is the ` +
                'authority and is never deleted here.',
            ),
          );
        }
      }
      console.log(
        dim(
          reports[0]!.dryRun
            ? '\nDry run; nothing written. Drop --dry-run to do it.'
            : '\nEverything removed is derivable: re-run the stage that fills it.',
        ),
      );
      return 0;
    }

    case 'towns': {
      const db = getDb();
      // Materialize first, so a town added to the registry since the last run
      // appears here — with its source counts — rather than only after the
      // next ingest.
      syncJurisdictions(db);
      for (const town of listJurisdictions()) syncSources(db, town);
      const rows = listJurisdictionRows(db);
      const orphans = new Set(orphanJurisdictions(db).map((o) => o.jurisdiction));

      if (values.json) {
        console.log(
          JSON.stringify(
            rows.map((row) => ({ ...row, registered: !orphans.has(row.id) })),
            null,
            2,
          ),
        );
        return 0;
      }

      for (const row of rows) {
        const state = orphans.has(row.id)
          ? '[31morphan   [0m'
          : row.enabled_sources === 0
            ? dim('registered')
            : row.events === 0
              ? '[33mnever ran [0m'
              : '[32mlive      [0m';
        console.log(
          `  ${state} ${row.id.padEnd(14)} ${String(row.events).padStart(6)} records  ` +
            `${String(row.matters).padStart(5)} matters  ` +
            dim(`${row.enabled_sources}/${row.sources} sources on  ${row.label}`),
        );
      }
      const registered = listProfiles();
      console.log(
        `\n${registered.length} town(s) registered; ${rows.filter((r) => r.events > 0).length} with records.`,
      );
      for (const profile of registered) {
        if (profile.sources.some((source) => source.enabled)) continue;
        console.log(dim(`  ${profile.id}: nothing enabled yet — \`discover\` for its ids, then \`verify\`.`));
      }
      return 0;
    }

    case 'accounts': {
      const db = getDb();
      const report = await checkAccounts(db);
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatAccounts(report, dim));
        console.log(
          dim(
            report.backend === 'sqlite'
              ? '\nSet TOWNCIVIC_ACCOUNTS=supabase to move readers out — see supabase/README.md.'
              : '\nA failure above is configuration, not code. supabase/README.md has the setup.',
          ),
        );
      }
      // Non-zero on a problem, so a deploy can gate on this rather than finding
      // out when somebody tries to sign in.
      return report.ok ? 0 : 1;
    }

    case 'snapshot': {
      // Deliberately does not open the database: `--pull` replaces the file
      // underneath, and holding a handle to what you are about to overwrite is
      // how you get a half-migrated database on the other side.
      const report = values.pull ? await pullSnapshot() : await pushSnapshot();
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
      }
      console.log(formatSnapshot(report, dim));
      return 0;
    }

    case 'preflight': {
      const report = await preflight(getDb());
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
        return report.ok ? 0 : 1;
      }
      console.log(formatPreflight(report, dim));
      console.log(
        report.ok
          ? '\n[32mReady.[0m Every configured dependency answered.'
          : '\n[31mNot ready.[0m Fix the failures above; each one is configuration rather than code.',
      );
      return report.ok ? 0 : 1;
    }

    case 'documents': {
      const report = await checkDocuments();
      if (values.json && !values.backfill) {
        console.log(JSON.stringify(report, null, 2));
        return report.ok ? 0 : 1;
      }
      console.log(formatDocuments(report, dim));

      if (!values.backfill) {
        // Only suggest a backfill into a store that just proved it can hold
        // something. Telling somebody to copy 500 MB into an endpoint that did
        // not answer is the least useful next step available.
        console.log(
          dim(
            report.backend === 'local'
              ? '\nSet TOWNCIVIC_DOCUMENTS=s3 to move the archive off this disk — see docs/operations.md.'
              : report.ok
                ? '\nRun with --backfill to copy an existing local archive into it.'
                : '\nA failure above is configuration, not code. docs/operations.md has the setup.',
          ),
        );
        return report.ok ? 0 : 1;
      }

      // Refuse to copy into a store that has not proved it can hold anything.
      // The archive is the one thing here that cannot be regenerated, and a
      // backfill that silently wrote nowhere would be the worst way to learn it.
      if (!report.ok) {
        console.error('\n[31mNot backfilling: the destination did not pass its own check.[0m');
        return 1;
      }

      const db = getDb();
      console.log(dim(`\nCopying the local archive into ${report.backend}…`));
      const moved = await backfillDocuments(db, {
        ...(values.limit ? { limit: Number(values.limit) } : {}),
        dryRun: values['dry-run'],
        onProgress: (done, total, key) => {
          if (done % 25 === 0 || done === total) {
            process.stdout.write(`\r  ${String(done).padStart(5)}/${total}  ${dim(key.slice(0, 48))}   `);
          }
        },
      });
      process.stdout.write('\n');

      console.log(
        `\n  ${moved.uploaded} copied · ${moved.present} already there · ` +
          `${moved.missing} missing locally · ${moved.failed.length} failed · ` +
          `${(moved.bytes / 1024 / 1024).toFixed(0)} MB`,
      );
      for (const failure of moved.failed.slice(0, 10)) {
        console.error(`  [31m${failure.key}[0m ${dim(failure.error)}`);
      }
      if (moved.missing) {
        console.log(
          dim('  "missing locally" is a row the database knows about with no file on disk to copy.'),
        );
      }
      if (values['dry-run']) {
        console.log(dim('\n  Dry run; nothing uploaded. Drop --dry-run to do it.'));
      }
      return moved.failed.length ? 1 : 0;
    }

    case 'serve': {
      const db = getDb();
      // Every town this build knows, so the switcher is the registry.
      for (const town of listJurisdictions()) syncSources(db, town);
      const port = Number(values.port ?? config.port);
      // Feed self-links have to match where the server actually is, not the
      // default port, or an --port run publishes URLs that do not resolve.
      const baseUrl = process.env.TOWNCIVIC_BASE_URL ?? `http://localhost:${port}`;
      // Built here rather than inside `createApp` so a misconfigured hosted
      // backend fails at startup, with its own message, instead of on the first
      // request that needs it.
      const accounts = createAccounts(db);
      const app = createApp(db, {
        ...(jurisdiction === ALL ? {} : { jurisdiction }),
        baseUrl,
        accounts,
      });
      serve({ fetch: app.fetch, port }, (info) => {
        console.log(`townCivic → http://localhost:${info.port}`);
        for (const town of listJurisdictions()) {
          console.log(
            dim(`  ${String(countEvents(db, { jurisdiction: town })).padStart(6)} records · ${town}`),
          );
        }
        console.log(dim(`  accounts: ${accounts.describe()}`));
        if (hasSampleData(db)) {
          console.log(dim('  database contains synthetic sample data (run `clear-samples` to drop it)'));
        }
      });
      return -1; // keep the process alive
    }

    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      return 1;
  }
}

const code = await main();
flushJson();
if (code >= 0) {
  closeDb();
  process.exit(code);
}
