import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import type { Db } from '../db/index.ts';
import { syncSources } from '../registry/index.ts';
import { ingestBody } from '../pipeline/ingest.ts';

/**
 * Which fixture stands in for which source.
 *
 * Seeding runs the real adapters over synthetic bodies, so the UI has something
 * to render and the pipeline is exercised end to end with no network.
 */
export const FIXTURE_MAP: Record<string, string> = {
  'milton-ma:agenda:index': 'milton-ma/agenda-center-index.html',
  'milton-ma:agenda:select-board': 'milton-ma/select-board-6.html',
  'milton-ma:agenda:planning-board': 'milton-ma/planning-board-39.html',
  'milton-ma:agenda:board-of-health': 'milton-ma/board-of-health-42.html',
  'milton-ma:bids': 'milton-ma/bids.html',
  'milton-ma:news': 'milton-ma/newsflash.xml',
  'milton-ma:calendar': 'milton-ma/calendar.xml',
};

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

export function seed(db: Db, fixturesDir = path.join(ROOT, 'fixtures')): SeedReport[] {
  const sources = new Map(syncSources(db).map((s) => [s.id, s]));
  const reports: SeedReport[] = [];

  for (const [sourceId, fixture] of Object.entries(FIXTURE_MAP)) {
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

/** True when the database holds anything loaded from fixtures. */
export function hasSampleData(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM events
        WHERE EXISTS (SELECT 1 FROM json_each(events.tags) WHERE value = 'sample')`,
    )
    .get() as { n: number };
  return row.n > 0;
}

export function clearSampleData(db: Db): number {
  const before = db.prepare('SELECT count(*) AS n FROM events').get() as { n: number };
  db.prepare(
    `DELETE FROM events WHERE EXISTS (SELECT 1 FROM json_each(events.tags) WHERE value = 'sample')`,
  ).run();
  const after = db.prepare('SELECT count(*) AS n FROM events').get() as { n: number };
  return before.n - after.n;
}
