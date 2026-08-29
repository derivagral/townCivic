import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import type { Db } from '../db/index.ts';
import { listProfiles, syncSources } from '../registry/index.ts';
import { ingestBody } from '../pipeline/ingest.ts';

/**
 * Which fixture stands in for which source.
 *
 * Seeding runs the real adapters over synthetic bodies, so the UI has something
 * to render and the pipeline is exercised end to end with no network.
 *
 * The mapping lives on each town's profile rather than in one table here: a
 * town brings its own fixtures, and a town with none simply seeds nothing.
 * Milton is the only one with fixtures today, which is itself the honest state
 * of things — the other towns have not been fetched yet, so there is nothing
 * real to build a fixture from and inventing one would be fiction twice over.
 */
export function fixtureMap(jurisdiction?: string): Record<string, string> {
  const profiles = jurisdiction ? listProfiles().filter((p) => p.id === jurisdiction) : listProfiles();
  return Object.assign({}, ...profiles.map((profile) => profile.fixtures)) as Record<string, string>;
}

export interface SeedReport {
  sourceId: string;
  fixture: string;
  items: number;
  created: number;
  revised: number;
  unchanged: number;
}

/** Mark seeded events so the UI can say plainly that they are not real records. */
function tagAsSample(db: Db, sourceId: string): void {
  db.prepare(
    `UPDATE events
        SET tags = json_insert(tags, '$[#]', 'sample')
      WHERE source_id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(events.tags) WHERE value = 'sample')`,
  ).run(sourceId);
}

export function seed(db: Db, options: { jurisdiction?: string; fixturesDir?: string } = {}): SeedReport[] {
  const fixturesDir = options.fixturesDir ?? path.join(ROOT, 'fixtures');
  const sources = new Map(syncSources(db, options.jurisdiction).map((s) => [s.id, s]));
  const reports: SeedReport[] = [];

  for (const [sourceId, fixture] of Object.entries(fixtureMap(options.jurisdiction))) {
    const source = sources.get(sourceId);
    if (!source) continue;
    const file = path.join(fixturesDir, fixture);
    if (!fs.existsSync(file)) continue;

    const result = ingestBody(db, source, fs.readFileSync(file, 'utf8'));
    tagAsSample(db, sourceId);
    reports.push({ sourceId, fixture, ...result });
  }

  return reports;
}

/**
 * True when the database holds anything loaded from fixtures.
 *
 * Scoped to a town when one is given: with several towns in one database, a
 * page about Hull should not carry a banner about Milton's sample data.
 */
export function hasSampleData(db: Db, jurisdiction?: string): boolean {
  const sql = `SELECT count(*) AS n FROM events
                WHERE EXISTS (SELECT 1 FROM json_each(events.tags) WHERE value = 'sample')
                ${jurisdiction ? 'AND jurisdiction = ?' : ''}`;
  const row = (jurisdiction ? db.prepare(sql).get(jurisdiction) : db.prepare(sql).get()) as { n: number };
  return row.n > 0;
}

export function clearSampleData(db: Db, jurisdiction?: string): number {
  const where = `EXISTS (SELECT 1 FROM json_each(events.tags) WHERE value = 'sample')
                 ${jurisdiction ? 'AND jurisdiction = ?' : ''}`;
  const params = (jurisdiction ? [jurisdiction] : []) as never[];

  const before = db.prepare(`SELECT count(*) AS n FROM events WHERE ${where}`).get(...params) as {
    n: number;
  };
  db.prepare(`DELETE FROM events WHERE ${where}`).run(...params);
  return before.n;
}
