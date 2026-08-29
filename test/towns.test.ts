import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import {
  getProfile,
  hasJurisdiction,
  listJurisdictions,
  listProfiles,
  loadSources,
  orphanJurisdictions,
  syncSources,
} from '../src/registry/index.ts';
import { canonicalBody, classifyBody, isVenueAddress } from '../src/registry/profile.ts';
import { miltonProfile, weymouthProfile, hullProfile } from '../src/registry/index.ts';
import { clearJurisdiction, clearOrphans } from '../src/commands/clear.ts';
import { countEvents, facetCounts, personalFeed, queryEvents } from '../src/db/repo.ts';
import { addSubscription, listSubscriptions } from '../src/web/accounts.ts';
import { extractAgendaCategories, categorySlug } from '../src/adapters/civicplus-agenda-center.ts';
import { href, withTown } from '../src/web/views.ts';
import type { TownView } from '../src/web/views.ts';

/**
 * What has to stay true once there is more than one town.
 *
 * The failures this guards against are all the same shape: something that was
 * unambiguous while there was one town silently means the wrong thing when
 * there are four. A board name, a source id, a subscription, a venue address,
 * a bounding box.
 */

let db: Db;
let seq = 0;

beforeEach(() => {
  db = openDb(':memory:');
  seq = 0;
});

function event(jurisdiction: string, overrides: { body?: string; title?: string } = {}): string {
  const id = `e${++seq}`;
  // `events.source_id` is a foreign key, so a record needs a source to hang off.
  db.prepare(
    `INSERT OR IGNORE INTO sources (id, jurisdiction, label, adapter, url, level, agency, channel,
                                    priority, tier, confidence, enabled)
     VALUES (?,?,'Test','rss','https://x','municipal','Agency','land-use','high',1,'verified',1)`,
  ).run(`${jurisdiction}:src`, jurisdiction);
  db.prepare(
    `INSERT INTO events (id, jurisdiction, source_id, level, agency, body, channel, event_type, priority,
                         title, url, first_seen_at, last_seen_at, subjects, tags, content_hash)
     VALUES (?,?,?,'municipal','Agency',?,'land-use','meeting_agenda','high',?,
             'https://x/1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','[]','[]',?)`,
  ).run(
    id,
    jurisdiction,
    `${jurisdiction}:src`,
    overrides.body ?? 'Planning Board',
    overrides.title ?? `A record in ${jurisdiction}`,
    `h${seq}`,
  );
  return id;
}

function matter(jurisdiction: string, label: string): string {
  const id = `m${++seq}`;
  db.prepare(
    `INSERT INTO matters (id, jurisdiction, kind, key, label, event_count, updated_at)
     VALUES (?,?,'address',?,?,1,'2026-01-01T00:00:00.000Z')`,
  ).run(id, jurisdiction, label.toLowerCase(), label);
  return id;
}

function user(email = 'a@example.com'): string {
  const id = `u${++seq}`;
  db.prepare(
    `INSERT INTO users (id, email, email_key, password_hash, password_salt, feed_token, created_at)
     VALUES (?,?,?,'h','s',?, '2026-01-01T00:00:00.000Z')`,
  ).run(id, email, email, `token${seq}`);
  return id;
}

/* ------------------------------------------------------------------ registry */

describe('the registry', () => {
  it('knows more than one town', () => {
    expect(listJurisdictions().length).toBeGreaterThan(1);
    expect(listJurisdictions()).toContain('milton-ma');
    expect(listJurisdictions()).toContain('weymouth-ma');
  });

  it('gives every source an id namespaced by its own jurisdiction', () => {
    // The bug this catches is real: the statewide sources used to be called
    // `ma:commbuys`, which is unique for exactly as long as there is one town.
    for (const profile of listProfiles()) {
      for (const source of profile.sources) {
        expect(source.jurisdiction).toBe(profile.id);
        expect(source.id.startsWith(`${profile.id}:`)).toBe(true);
      }
    }
  });

  it('has no duplicate source id across all towns at once', () => {
    const ids = loadSources().map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('parses every registered town’s sources', () => {
    for (const id of listJurisdictions()) expect(() => loadSources(id)).not.toThrow();
  });

  it('never enables a source it has not verified', () => {
    for (const source of loadSources()) {
      if (source.enabled) expect(source.confidence).toBe('verified');
    }
  });

  it('degrades to a usable profile for a town it has never heard of', () => {
    expect(hasJurisdiction('nowhere-zz')).toBe(false);
    const profile = getProfile('nowhere-zz');
    expect(profile.id).toBe('nowhere-zz');
    expect(profile.sources).toEqual([]);
    // Statewide defaults still classify, so an orphaned row still renders.
    expect(classifyBody(profile, 'Planning Board').channel).toBe('land-use');
  });
});

describe('per-town knowledge', () => {
  it('reads body aliases from the town the record came from', () => {
    expect(canonicalBody(miltonProfile, "Selectmen's Office")).toBe('Select Board');
    // Weymouth has no select board at all; its own alias table is what applies.
    expect(canonicalBody(weymouthProfile, 'Weymouth Town Council')).toBe('Town Council');
    expect(canonicalBody(weymouthProfile, "Selectmen's Office")).toBe("Selectmen's Office");
  });

  it('lets a town override how its own bodies are classified', () => {
    // Union Point's redevelopment authorities are the biggest land-use question
    // in Weymouth and nothing generic would recognise them as land use.
    expect(classifyBody(weymouthProfile, 'Southfield Redevelopment Authority').channel).toBe('land-use');
    expect(classifyBody(miltonProfile, 'Southfield Redevelopment Authority').channel).toBe('meetings');
  });

  it('knows a city’s ordinances are a town’s by-laws', () => {
    expect(classifyBody(weymouthProfile, 'Ordinance Review Committee').channel).toBe('law');
    expect(classifyBody(miltonProfile, 'Bylaw Review Committee').channel).toBe('law');
  });

  it('files an Advisory Board as the finance committee it is', () => {
    expect(classifyBody(hullProfile, 'Advisory Board').channel).toBe('money');
  });

  it('applies each town’s venue addresses only to that town', () => {
    // 525 Canton Avenue is Milton's town hall. In Weymouth it is just an
    // address, and treating it as a venue would drop a real subject.
    expect(isVenueAddress(miltonProfile, '525 Canton Avenue')).toBe(true);
    expect(isVenueAddress(weymouthProfile, '525 Canton Avenue')).toBe(false);
  });

  it('fences each town’s geocoding with its own box', () => {
    expect(miltonProfile.bbox).not.toEqual(weymouthProfile.bbox);
    for (const profile of listProfiles()) {
      expect(profile.bbox.north).toBeGreaterThan(profile.bbox.south);
      expect(profile.bbox.east).toBeGreaterThan(profile.bbox.west);
    }
  });
});

describe('Weymouth', () => {
  it('registers the Agenda Center and nothing this install does not publish', () => {
    const ids = weymouthProfile.sources.filter((s) => s.enabled).map((s) => s.id);
    expect(ids).toContain('weymouth-ma:agenda:index');
    expect(ids).toContain('weymouth-ma:agenda:town-council');
    // No /rss.aspx and no /bids.aspx on this install: a source pointing at a
    // page the town does not serve is a source that fails forever.
    expect(ids.some((id) => id.includes(':bids'))).toBe(false);
    expect(weymouthProfile.sources.some((s) => s.adapter === 'rss')).toBe(false);
  });

  it('points every source at the host that answers', () => {
    // The apex domain serves the site; the www host does not resolve.
    for (const source of weymouthProfile.sources) {
      if (source.level === 'municipal') expect(source.url.startsWith('https://weymouth.ma.us/')).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ storage */

describe('one database, several towns', () => {
  it('keeps each town’s records to itself', () => {
    event('milton-ma');
    event('milton-ma');
    event('weymouth-ma');

    expect(countEvents(db, { jurisdiction: 'milton-ma' })).toBe(2);
    expect(countEvents(db, { jurisdiction: 'weymouth-ma' })).toBe(1);
    expect(countEvents(db, {})).toBe(3);
    expect(queryEvents(db, { jurisdiction: 'weymouth-ma' }).map((r) => r.jurisdiction)).toEqual([
      'weymouth-ma',
    ]);
  });

  it('does not merge two towns’ boards behind one facet', () => {
    event('milton-ma', { body: 'Planning Board' });
    event('weymouth-ma', { body: 'Planning Board' });

    const milton = facetCounts(db, 'body', { jurisdiction: 'milton-ma' });
    expect(milton).toEqual([{ value: 'Planning Board', n: 1 }]);
  });

  it('materializes the registry so the switcher is a query', () => {
    syncSources(db, 'milton-ma');
    const rows = db.prepare('SELECT id, label FROM jurisdictions').all() as unknown as {
      id: string;
      label: string;
    }[];
    expect(rows.find((row) => row.id === 'milton-ma')?.label).toBe('Milton, Massachusetts');
  });

  it('reports records for a town the registry has dropped', () => {
    event('someplace-zz');
    expect(orphanJurisdictions(db)).toEqual([{ jurisdiction: 'someplace-zz', events: 1 }]);

    event('milton-ma');
    expect(orphanJurisdictions(db).map((o) => o.jurisdiction)).toEqual(['someplace-zz']);
  });
});

describe('subscriptions', () => {
  it('follows a board in one town, not the same name in every town', () => {
    const userId = user();
    event('milton-ma', { body: 'Planning Board', title: 'Milton planning' });
    event('weymouth-ma', { body: 'Planning Board', title: 'Weymouth planning' });

    addSubscription(db, userId, {
      kind: 'body',
      value: 'Planning Board',
      label: 'Planning Board',
      jurisdiction: 'milton-ma',
    });

    const rows = personalFeed(db, listSubscriptions(db, userId));
    expect(rows.map((row) => row.title)).toEqual(['Milton planning']);
  });

  it('lets the same board name be followed in two towns at once', () => {
    const userId = user();
    event('milton-ma', { body: 'Planning Board', title: 'Milton planning' });
    event('weymouth-ma', { body: 'Planning Board', title: 'Weymouth planning' });

    for (const town of ['milton-ma', 'weymouth-ma']) {
      addSubscription(db, userId, {
        kind: 'body',
        value: 'Planning Board',
        label: 'Planning Board',
        jurisdiction: town,
      });
    }

    // Two rows, not one: the old UNIQUE(user_id, kind, value) would have
    // collapsed these into a single subscription meaning both towns at once.
    expect(listSubscriptions(db, userId)).toHaveLength(2);
    expect(personalFeed(db, listSubscriptions(db, userId))).toHaveLength(2);
  });

  it('spans towns for a reader who follows things in several', () => {
    const userId = user();
    event('milton-ma', { body: 'Planning Board', title: 'Milton planning' });
    event('weymouth-ma', { body: 'Town Council', title: 'Weymouth council' });

    addSubscription(db, userId, {
      kind: 'body',
      value: 'Planning Board',
      label: 'Planning Board',
      jurisdiction: 'milton-ma',
    });
    addSubscription(db, userId, {
      kind: 'body',
      value: 'Town Council',
      label: 'Town Council',
      jurisdiction: 'weymouth-ma',
    });

    expect(personalFeed(db, listSubscriptions(db, userId))).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------- migration */

describe('migrating a database written before there were towns', () => {
  const require_ = createRequire(import.meta.url);
  const { DatabaseSync: Sqlite } = require_('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towncivic-migrate-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds the jurisdiction column and keeps the rows that were there', () => {
    const file = path.join(dir, 'legacy.db');
    const legacy = new Sqlite(file);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, email_key TEXT NOT NULL UNIQUE,
        display_name TEXT, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
        feed_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL,
        alerts TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL,
        UNIQUE(user_id, kind, value)
      );
      INSERT INTO users VALUES ('u1','a@b.c','a@b.c',NULL,'h','s','tok','2026-01-01');
      INSERT INTO subscriptions VALUES ('s1','u1','body','Planning Board','Planning Board','none','2026-01-01');
      CREATE INDEX idx_events_channel ON users(email);
    `);
    legacy.close();

    const upgraded = openDb(file);
    const rows = upgraded.prepare('SELECT id, jurisdiction, value FROM subscriptions').all() as unknown as {
      id: string;
      jurisdiction: string;
      value: string;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('Planning Board');
    // Backfilled with the town that was being served, never with the wildcard:
    // silently widening someone's subscriptions to every town is the one
    // outcome nobody asked for.
    expect(rows[0]!.jurisdiction).toBe('milton-ma');

    // And the new constraint is in force.
    upgraded
      .prepare(
        `INSERT INTO subscriptions (id, user_id, jurisdiction, kind, value, label, alerts, created_at)
         VALUES ('s2','u1','weymouth-ma','body','Planning Board','Planning Board','none','2026-01-01')`,
      )
      .run();
    expect((upgraded.prepare('SELECT count(*) AS n FROM subscriptions').get() as { n: number }).n).toBe(2);
    upgraded.close();
  });

  it('is safe to run twice', () => {
    const file = path.join(dir, 'twice.db');
    openDb(file).close();
    expect(() => openDb(file).close()).not.toThrow();
  });
});

/* -------------------------------------------------------------------- clear */

describe('clearing one town', () => {
  beforeEach(() => {
    event('milton-ma');
    event('weymouth-ma');
    matter('milton-ma', '39 Frothingham Street');
    matter('weymouth-ma', '75 Middle Street');
    syncSources(db, 'weymouth-ma');
  });

  it('removes derived rows and leaves the records alone', () => {
    const report = clearJurisdiction(db, { jurisdiction: 'weymouth-ma', scope: 'derived' });

    expect(report.removed['matters']).toBe(1);
    expect(countEvents(db, { jurisdiction: 'weymouth-ma' })).toBe(1);
    expect(countEvents(db, { jurisdiction: 'milton-ma' })).toBe(1);
    expect(
      (
        db.prepare("SELECT count(*) AS n FROM matters WHERE jurisdiction='milton-ma'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('removes one town’s records without touching the other’s', () => {
    clearJurisdiction(db, { jurisdiction: 'weymouth-ma', scope: 'records' });

    expect(countEvents(db, { jurisdiction: 'weymouth-ma' })).toBe(0);
    expect(countEvents(db, { jurisdiction: 'milton-ma' })).toBe(1);
    // Records went; the town, its sources and its fetch log did not.
    expect(
      (
        db.prepare("SELECT count(*) AS n FROM sources WHERE jurisdiction='weymouth-ma'").get() as {
          n: number;
        }
      ).n,
    ).toBeGreaterThan(0);
  });

  it('removes the town itself at the widest scope', () => {
    clearJurisdiction(db, { jurisdiction: 'weymouth-ma', scope: 'town' });

    for (const [table, column] of [
      ['events', 'jurisdiction'],
      ['sources', 'jurisdiction'],
      ['jurisdictions', 'id'],
    ] as const) {
      const n = (
        db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = 'weymouth-ma'`).get() as {
          n: number;
        }
      ).n;
      expect(n, `${table} still holds rows`).toBe(0);
    }
    expect(countEvents(db, { jurisdiction: 'milton-ma' })).toBe(1);
  });

  it('counts without deleting when asked to', () => {
    const report = clearJurisdiction(db, {
      jurisdiction: 'weymouth-ma',
      scope: 'town',
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.removed['events']).toBe(1);
    expect(countEvents(db, { jurisdiction: 'weymouth-ma' })).toBe(1);
  });

  it('clears only the towns the registry has dropped', () => {
    event('someplace-zz');
    const reports = clearOrphans(db);

    expect(reports.map((r) => r.jurisdiction)).toEqual(['someplace-zz']);
    expect(countEvents(db, { jurisdiction: 'someplace-zz' })).toBe(0);
    expect(countEvents(db, { jurisdiction: 'weymouth-ma' })).toBe(1);
  });
});

/* ----------------------------------------------------------------- the site */

describe('links', () => {
  const many: TownView = {
    id: 'weymouth-ma',
    label: 'Weymouth, Massachusetts',
    options: [
      { id: 'milton-ma', label: 'Milton, Massachusetts' },
      { id: 'weymouth-ma', label: 'Weymouth, Massachusetts' },
    ],
    path: '/',
  };
  const one: TownView = { ...many, id: 'milton-ma', options: [{ id: 'milton-ma', label: 'Milton' }] };

  it('carries the town on every internal link when there is more than one', () => {
    expect(withTown('/matters', many)).toBe('/matters?town=weymouth-ma');
    expect(href({ when: 'all', page: 1, town: 'weymouth-ma', channel: 'land-use' })).toBe(
      '/?town=weymouth-ma&channel=land-use',
    );
  });

  it('leaves a one-town install’s URLs exactly as they were', () => {
    expect(withTown('/matters', one)).toBe('/matters');
    expect(href({ when: 'all', page: 1, channel: 'land-use' })).toBe('/?channel=land-use');
  });
});

/* -------------------------------------------------------------- discovering */

describe('discovering a town whose Agenda Center is themed differently', () => {
  // Weymouth's install renders each category as a collapsible panel rather than
  // a link. The old parser found nothing here, which reads exactly like a town
  // that publishes nothing.
  const collapseLayout = `
    <div class="listing listingCollapse noHeader" id="cat4">
      <h2 tabindex="0" role="button" aria-controls="category-panel-4">Board of Health</h2>
      <span id="section4"><a href="/AgendaCenter/ViewFile/Agenda/_07212026-483">Agenda</a></span>
    </div>
    <div class="listing listingCollapse noHeader" id="cat18">
      <h2 tabindex="0" role="button">Planning &amp; Community Development</h2>
    </div>`;

  it('reads the category id off the panel and derives the slug from the name', () => {
    expect(extractAgendaCategories(collapseLayout)).toEqual([
      { slug: 'Board-of-Health', cid: 4, body: 'Board of Health' },
      { slug: 'Planning-Community-Development', cid: 18, body: 'Planning & Community Development' },
    ]);
  });

  it('still prefers the site’s own slug where the category is linked', () => {
    const linked = `<a href="/AgendaCenter/Select-Board-6">Select Board</a>
                    <div class="listing" id="cat6"><h2>Selectboard</h2></div>`;
    expect(extractAgendaCategories(linked)).toEqual([{ slug: 'Select-Board', cid: 6, body: 'Select Board' }]);
  });

  it('builds the slug CivicPlus uses', () => {
    expect(categorySlug('Board of Health')).toBe('Board-of-Health');
    expect(categorySlug('Planning & Community Development')).toBe('Planning-Community-Development');
    expect(categorySlug('Fourth of July Committee')).toBe('Fourth-of-July-Committee');
  });
});
