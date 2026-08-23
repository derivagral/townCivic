#!/usr/bin/env node
import './util/quiet.ts';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { getDb, closeDb } from './db/index.ts';
import { syncSources, loadSources, listJurisdictions } from './registry/index.ts';
import { ingest } from './pipeline/ingest.ts';
import { verify } from './commands/verify.ts';
import { discover, toRegistrySnippet } from './commands/discover.ts';
import { seed, clearSampleData, hasSampleData } from './commands/seed.ts';
import { createApp } from './web/server.ts';
import { countEvents, queryEvents } from './db/repo.ts';

const USAGE = `townCivic — a primary-source civic record for one town.

Usage: towncivic <command> [options]

Commands
  seed                 Load synthetic development fixtures so the UI has data
  ingest               Fetch every enabled source and normalize what changed
  verify               Check every registered URL against the live site
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
  --limit <n>          Row limit for events

Examples
  npm run seed && npm run serve
  npx tsx src/cli.ts verify --all
  npx tsx src/cli.ts ingest --source milton-ma:agenda:planning-board
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
