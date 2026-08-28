#!/usr/bin/env node
import './util/quiet.ts';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { getDb, closeDb } from './db/index.ts';
import { syncSources, loadSources, listJurisdictions } from './registry/index.ts';
import { ingest } from './pipeline/ingest.ts';
import { extractDocuments } from './pipeline/extract.ts';
import { linkMatters } from './pipeline/link.ts';
import { geocodeMatters } from './pipeline/geocode.ts';
import { PROVIDERS, interpretDocuments, isProvider } from './pipeline/interpret.ts';
import { extractEventImpacts } from './pipeline/impacts.ts';
import { defaultPreferences } from './profile/preferences.ts';
import { TEMPLATES } from './profile/templates.ts';
import { formatProposal, proposeFromText } from './profile/setup.ts';
import { verify } from './commands/verify.ts';
import { discover, toRegistrySnippet } from './commands/discover.ts';
import { status } from './commands/status.ts';
import { fetchBoundary } from './commands/boundary.ts';
import { seed, clearSampleData, hasSampleData } from './commands/seed.ts';
import { createApp } from './web/server.ts';
import { countEvents, queryEvents } from './db/repo.ts';

const USAGE = `townCivic — a primary-source civic record for one town.

Usage: towncivic <command> [options]

Commands
  seed                 Load synthetic development fixtures so the UI has data
  ingest               Fetch every enabled source and normalize what changed
  extract              Open the linked PDFs and read agendas, locations and subjects
  link                 Group records about the same property or article into timelines
  interpret            Read votes and dispositions out of minutes, into a separate index
  impacts              Extract who a record affects — services, school tiers, costs, eligibility
  profile              Preview what a sentence would change in a profile, and save nothing
  geocode              Resolve linked addresses to coordinates for the map
  verify               Check every registered URL against the live site
  status               Report pipeline counts, source health and staleness (exit 1 on a problem)
  boundary             Refetch the town outline from MassGIS (maintenance; commit the result)
  discover             Probe the CivicPlus site for boards and feeds not yet registered
  serve                Run the web UI and the Atom / JSON feeds
  sources              Print the source registry
  events               Print recent records as JSON
  clear-samples        Delete every event loaded from fixtures
  help                 Show this message

Options
  --jurisdiction <id>  Town to operate on (default: ${config.defaultJurisdiction})
  --source <id>        Restrict to one source; repeatable
  --all                Include sources marked disabled
  --force              Ignore stored ETag / Last-Modified and refetch
  --dry-run            Parse and report without writing events
  --json               Machine-readable output
  --port <n>           Port for serve (default: ${config.port})
  --limit <n>          Row limit for events / documents to extract
  --since <date>       Only extract records dated on or after this ISO date
  --provider <name>    Interpreter for \`interpret\`: ${PROVIDERS.join(' | ')} (default: rules)
  --templates          List the starter profile templates instead of parsing a sentence

Examples
  npm run seed && npm run serve
  npx tsx src/cli.ts verify --all
  npx tsx src/cli.ts ingest --source milton-ma:agenda:planning-board
  npx tsx src/cli.ts profile "set me up as a parent with kids in elementary school"
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
    templates: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const command = positionals[0] ?? 'help';
const jurisdiction = values.jurisdiction ?? config.defaultJurisdiction;
const sourceIds = values.source ?? [];

const check = (ok: boolean) => (ok ? '[32mok[0m' : '[31mFAIL[0m');
const dim = (text: string) => `[2m${text}[0m`;

async function main(): Promise<number> {
  if (values.help || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  if (!listJurisdictions().includes(jurisdiction) && command !== 'discover') {
    console.error(`Unknown jurisdiction "${jurisdiction}". Known: ${listJurisdictions().join(', ')}`);
    return 1;
  }

  switch (command) {
    case 'seed': {
      const db = getDb();
      const reports = seed(db);
      if (values.json) {
        console.log(JSON.stringify(reports, null, 2));
        return 0;
      }
      for (const report of reports) {
        console.log(
          `${check(true)}  ${report.sourceId.padEnd(34)} ${String(report.items).padStart(3)} items  ` +
            dim(
              `${report.created} new, ${report.revised} revised, ${report.unchanged} unchanged  ← ${report.fixture}`,
            ),
        );
      }
      console.log(`\n${countEvents(db, { jurisdiction })} records in the database.`);
      console.log(dim('These are synthetic fixtures, not real records. Run `ingest` for the live site.'));
      return 0;
    }

    case 'ingest': {
      const db = getDb();
      const reports = await ingest(db, {
        jurisdiction,
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
      if (values.json) console.log(JSON.stringify(reports, null, 2));
      const failed = reports.filter((r) => !r.ok);
      if (failed.length && !values.json) {
        console.log(`\n${failed.length} of ${reports.length} sources failed.`);
      }
      return failed.length === reports.length && reports.length > 0 ? 1 : 0;
    }

    case 'extract': {
      const db = getDb();
      let structured = 0;
      const reports = await extractDocuments(db, {
        jurisdiction,
        ...(sourceIds.length ? { sourceIds } : {}),
        ...(values.force ? { force: true } : {}),
        ...(values.limit ? { limit: Number(values.limit) } : {}),
        ...(values.since ? { since: values.since } : {}),
        onProgress(report) {
          if (report.structured) structured++;
          if (values.json) return;
          const detail = report.ok
            ? `${String(report.pages).padStart(2)}p  ${String(report.agendaItems).padStart(2)} items  ` +
              `${report.structured ? '\u001b[32mstructured\u001b[0m' : dim('text only ')}` +
              (report.subjects.length ? `  ${dim(report.subjects.slice(0, 3).join(', '))}` : '')
            : `\u001b[31m${report.error ?? 'failed'}\u001b[0m`;
          console.log(`${check(report.ok)}  ${report.title.slice(0, 46).padEnd(46)} ${detail}`);
        },
      });
      if (values.json) {
        console.log(JSON.stringify(reports, null, 2));
        return 0;
      }
      const failed = reports.filter((r) => !r.ok).length;
      const scanned = reports.filter((r) => r.likelyScanned).length;
      console.log(
        `\n${reports.length} documents: ${structured} structured, ${reports.length - structured - failed} text only, ${failed} failed.`,
      );
      if (scanned) console.log(dim(`${scanned} look scanned and would need OCR.`));
      return failed === reports.length && reports.length > 0 ? 1 : 0;
    }

    case 'link': {
      const db = getDb();
      const summary = linkMatters(db, { jurisdiction });
      if (values.json) {
        console.log(JSON.stringify(summary, null, 2));
        return 0;
      }
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
      console.log(dim(`${summary.timelines} carry more than one record.`));
      return 0;
    }

    case 'interpret': {
      const db = getDb();
      const provider = values.provider ?? 'rules';
      if (!isProvider(provider)) {
        console.error(`Unknown provider "${provider}". Known: ${PROVIDERS.join(', ')}`);
        return 1;
      }

      let found = 0;
      const reports = await interpretDocuments(db, {
        jurisdiction,
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

      if (values.json) {
        console.log(JSON.stringify(reports, null, 2));
        return 0;
      }
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
    }

    case 'impacts': {
      const db = getDb();
      const summary = extractEventImpacts(db, {
        jurisdiction,
        ...(values.force ? { force: true } : {}),
        ...(values.limit ? { limit: Number(values.limit) } : {}),
        ...(values.since ? { since: values.since } : {}),
        onProgress(report) {
          if (values.json || report.skipped) return;
          console.log(
            `${check(true)}  ${report.title.slice(0, 52).padEnd(52)} ` +
              (report.found ? `${report.found} impact${report.found === 1 ? '' : 's'}` : dim('none')),
          );
        },
      });

      if (values.json) {
        console.log(JSON.stringify(summary, null, 2));
        return 0;
      }
      console.log(`\n${summary.eventsConsidered} records → ${summary.impacts} impacts.`);
      for (const [dimension, count] of Object.entries(summary.byDimension).sort((a, b) => b[1] - a[1])) {
        console.log(dim(`  ${String(count).padStart(5)}  ${dimension}`));
      }
      console.log(
        dim('Impacts are properties of the document, not of any reader. Ranking reads them; / does not.'),
      );
      return 0;
    }

    case 'profile': {
      if (values.templates) {
        for (const template of TEMPLATES) {
          console.log(`  ${template.id.padEnd(16)} ${dim(template.version.padEnd(12))} ${template.label}`);
          console.log(dim(`    ${template.description}`));
        }
        return 0;
      }

      const request = positionals.slice(1).join(' ').trim();
      if (!request) {
        console.error('Say what you want, e.g. `profile "set me up as a parent"`, or pass --templates.');
        return 1;
      }

      // Deliberately does not open the database: previewing a proposal is a
      // pure function of the sentence and the current profile, and the CLI has
      // no reader to be. Nothing here can save anything.
      const proposal = proposeFromText(request, defaultPreferences());
      if (values.json) {
        console.log(JSON.stringify(proposal, null, 2));
        return 0;
      }
      console.log(formatProposal(proposal));
      console.log(dim('\nNothing was saved. On the web this is a preview you accept, decline, or edit.'));
      return 0;
    }

    case 'geocode': {
      const db = getDb();
      const reports = await geocodeMatters(db, {
        jurisdiction,
        ...(values.force ? { force: true } : {}),
        ...(values.limit ? { limit: Number(values.limit) } : {}),
        onProgress(report) {
          if (values.json) return;
          console.log(
            `${check(report.ok)}  ${report.label.slice(0, 40).padEnd(40)} ` +
              (report.ok
                ? `${report.lat!.toFixed(5)}, ${report.lon!.toFixed(5)}  ${dim(report.matched ?? '')}`
                : `[33m${report.error ?? 'no match'}[0m`),
          );
        },
      });
      if (values.json) {
        console.log(JSON.stringify(reports, null, 2));
        return 0;
      }
      const placed = reports.filter((r) => r.ok).length;
      console.log(`\n${placed} of ${reports.length} addresses placed.`);
      if (placed < reports.length) {
        console.log(dim('Unplaced addresses are listed on /map rather than dropped.'));
      }
      return 0;
    }

    case 'verify': {
      const db = getDb();
      const results = await verify(db, {
        jurisdiction,
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
      if (values.json) {
        console.log(JSON.stringify(results, null, 2));
        return 0;
      }
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
    }

    case 'discover': {
      const report = await discover({ jurisdiction });
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
      }
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
        for (const feed of entry.feeds.slice(0, 3)) console.log(dim(`         ${feed.label} — ${feed.url}`));
        if (entry.feeds.length > 3) console.log(dim(`         … ${entry.feeds.length - 3} more`));
      }

      for (const error of report.errors) console.error(`\n[31m${error}[0m`);
      console.log(`\n${toRegistrySnippet(report.categories)}`);
      return report.errors.length ? 1 : 0;
    }

    case 'status': {
      const db = getDb();
      const report = status(db, jurisdiction);
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
        // Non-zero on a problem, so a cron job or a monitor can just check
        // the exit code without parsing anything.
        return report.ok ? 0 : 1;
      }

      console.log(
        `${report.events} records · ${report.matters} matters · ` +
          `${report.placed.resolved}/${report.placed.total} addresses placed · ` +
          `${report.boundary ? `outline ${report.boundary.points} pts` : '[33mno outline[0m'} · ` +
          `${report.interpretations} derived reading${report.interpretations === 1 ? '' : 's'} · ` +
          `${report.impacts.events} records with impacts`,
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

      if (report.problems.length) {
        console.log(`\n[33m${report.problems.length} thing(s) to look at:[0m`);
        for (const problem of report.problems) console.log(`  ${problem}`);
      } else {
        console.log(`\n[32mNothing to look at.[0m`);
      }
      return report.ok ? 0 : 1;
    }

    case 'boundary': {
      const report = await fetchBoundary({
        jurisdiction,
        ...(values['dry-run'] ? { dryRun: true } : {}),
      });
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
        return report.ok ? 0 : 1;
      }
      if (!report.ok) {
        console.error(`[31m${report.error ?? 'failed'}[0m`);
        return 1;
      }
      const area = report.landAreaSqM ? `  ${(report.landAreaSqM / 2_589_988).toFixed(2)} sq mi of land` : '';
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
    }

    case 'sources': {
      const sources = loadSources(jurisdiction);
      if (values.json) {
        console.log(JSON.stringify(sources, null, 2));
        return 0;
      }
      for (const source of sources) {
        console.log(
          `${source.enabled ? ' ' : dim('·')} tier ${source.tier}  ${source.id.padEnd(34)} ` +
            `${source.channel.padEnd(14)} ${dim(source.confidence.padEnd(11))}${source.url}`,
        );
      }
      console.log(`\n${sources.length} sources (${sources.filter((s) => s.enabled).length} enabled).`);
      return 0;
    }

    case 'events': {
      const db = getDb();
      const rows = queryEvents(db, { jurisdiction, limit: Number(values.limit ?? 25) });
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }

    case 'clear-samples': {
      const db = getDb();
      const removed = clearSampleData(db);
      console.log(`Removed ${removed} sample record${removed === 1 ? '' : 's'}.`);
      return 0;
    }

    case 'serve': {
      const db = getDb();
      syncSources(db, jurisdiction);
      const port = Number(values.port ?? config.port);
      // Feed self-links have to match where the server actually is, not the
      // default port, or an --port run publishes URLs that do not resolve.
      const baseUrl = process.env.TOWNCIVIC_BASE_URL ?? `http://localhost:${port}`;
      const app = createApp(db, { jurisdiction, baseUrl });
      serve({ fetch: app.fetch, port }, (info) => {
        console.log(`townCivic → http://localhost:${info.port}`);
        console.log(dim(`  ${countEvents(db, { jurisdiction })} records · ${jurisdiction}`));
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
if (code >= 0) {
  closeDb();
  process.exit(code);
}
