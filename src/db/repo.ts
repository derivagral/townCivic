import type { Db } from './index.ts';
import type { NormalizedEvent, SourceDef } from '../types.ts';
import type { JurisdictionProfile } from '../registry/profile.ts';
import type { Channel, Level, Priority } from '../taxonomy.ts';

export interface EventRow {
  id: string;
  jurisdiction: string;
  source_id: string;
  level: Level;
  agency: string;
  body: string | null;
  channel: Channel;
  event_type: string;
  priority: Priority;
  title: string;
  summary: string | null;
  url: string;
  document_url: string | null;
  occurred_at: string | null;
  published_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  revised_at: string | null;
  revision: number;
  subjects: string;
  tags: string;
  content_hash: string;
  raw: string;
  doc_text: string | null;
  extracted_at: string | null;
  source_label?: string;
}

/** What extraction found in the document behind a record. */
export interface AttachmentRow {
  id: string;
  event_id: string;
  url: string;
  content_type: string | null;
  bytes: number;
  path: string | null;
  pages: number | null;
  chars_per_page: number | null;
  likely_scanned: number;
  fields: string;
  notice: string | null;
  extracted_at: string;
  error: string | null;
}

export function getAttachment(db: Db, eventId: string): AttachmentRow | undefined {
  return db
    .prepare('SELECT * FROM attachments WHERE event_id = ? ORDER BY extracted_at DESC LIMIT 1')
    .get(eventId) as unknown as AttachmentRow | undefined;
}

export interface SourceRow {
  id: string;
  jurisdiction: string;
  label: string;
  adapter: string;
  url: string;
  level: Level;
  agency: string;
  body: string | null;
  channel: Channel;
  event_type: string | null;
  priority: Priority;
  tier: number;
  confidence: string;
  enabled: number;
  options: string;
  notes: string | null;
  etag: string | null;
  last_modified: string | null;
  last_fetch_at: string | null;
  last_status: number | null;
  last_error: string | null;
}

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------ jurisdictions */

export interface JurisdictionRow {
  id: string;
  name: string;
  label: string;
  state: string;
  time_zone: string;
  platform: string;
  base_url: string;
  bbox: string;
  boundary: string | null;
  notes: string | null;
  updated_at: string;
}

/** One town, as the UI sees it: the registry row plus what is actually in the db. */
export interface JurisdictionSummary extends JurisdictionRow {
  events: number;
  matters: number;
  sources: number;
  enabled_sources: number;
  last_fetch_at: string | null;
  last_event_at: string | null;
}

export function upsertJurisdiction(db: Db, profile: JurisdictionProfile): void {
  db.prepare(
    `INSERT INTO jurisdictions (id, name, label, state, time_zone, platform, base_url, bbox, boundary, notes, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, label = excluded.label, state = excluded.state,
       time_zone = excluded.time_zone, platform = excluded.platform, base_url = excluded.base_url,
       bbox = excluded.bbox, boundary = excluded.boundary, notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).run(
    profile.id,
    profile.name,
    profile.label,
    profile.state,
    profile.timeZone,
    profile.platform,
    profile.baseUrl,
    JSON.stringify(profile.bbox),
    profile.boundary ? JSON.stringify(profile.boundary) : null,
    profile.notes ?? null,
    nowIso(),
  );
}

/**
 * Every town in the database, with the counts the switcher and `/towns` show.
 *
 * One query rather than one per town: the numbers are what tell a reader which
 * towns are live and which are registered but not yet ingested, so they are on
 * the hot path for the town list.
 */
export function listJurisdictionRows(db: Db): JurisdictionSummary[] {
  const rows = db
    .prepare(
      `SELECT j.*,
              (SELECT count(*) FROM events e WHERE e.jurisdiction = j.id) AS events,
              (SELECT count(*) FROM matters m WHERE m.jurisdiction = j.id) AS matters,
              (SELECT count(*) FROM sources s WHERE s.jurisdiction = j.id) AS sources,
              (SELECT count(*) FROM sources s WHERE s.jurisdiction = j.id AND s.enabled = 1) AS enabled_sources,
              (SELECT max(s.last_fetch_at) FROM sources s WHERE s.jurisdiction = j.id) AS last_fetch_at,
              (SELECT max(coalesce(e.occurred_at, e.published_at, e.first_seen_at))
                 FROM events e WHERE e.jurisdiction = j.id) AS last_event_at
         FROM jurisdictions j
        ORDER BY events DESC, j.label`,
    )
    .all();
  return rows as unknown as JurisdictionSummary[];
}

export function getJurisdictionRow(db: Db, id: string): JurisdictionRow | undefined {
  return db.prepare('SELECT * FROM jurisdictions WHERE id = ?').get(id) as unknown as
    JurisdictionRow | undefined;
}

/* ------------------------------------------------------------------ sources */

export function upsertSource(db: Db, source: SourceDef): void {
  db.prepare(
    `INSERT INTO sources (id, jurisdiction, label, adapter, url, level, agency, body, channel,
                          event_type, priority, tier, precedence, confidence, enabled, options, notes, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       jurisdiction = excluded.jurisdiction,
       label        = excluded.label,
       adapter      = excluded.adapter,
       url          = excluded.url,
       level        = excluded.level,
       agency       = excluded.agency,
       body         = excluded.body,
       channel      = excluded.channel,
       event_type   = excluded.event_type,
       priority     = excluded.priority,
       tier         = excluded.tier,
       precedence   = excluded.precedence,
       confidence   = excluded.confidence,
       enabled      = excluded.enabled,
       options      = excluded.options,
       notes        = excluded.notes,
       updated_at   = excluded.updated_at`,
  ).run(
    source.id,
    source.jurisdiction,
    source.label,
    source.adapter,
    source.url,
    source.level,
    source.agency,
    source.body ?? null,
    source.channel,
    source.eventType ?? null,
    source.priority,
    source.tier,
    source.precedence,
    source.confidence,
    source.enabled ? 1 : 0,
    JSON.stringify(source.options),
    source.notes ?? null,
    nowIso(),
  );
}

export function listSourceRows(db: Db, jurisdiction?: string): SourceRow[] {
  const sql = jurisdiction
    ? 'SELECT * FROM sources WHERE jurisdiction = ? ORDER BY tier, label'
    : 'SELECT * FROM sources ORDER BY tier, label';
  const stmt = db.prepare(sql);
  return (jurisdiction ? stmt.all(jurisdiction) : stmt.all()) as unknown as SourceRow[];
}

export function getConditionalHeaders(db: Db, sourceId: string): { etag?: string; lastModified?: string } {
  const row = db.prepare('SELECT etag, last_modified FROM sources WHERE id = ?').get(sourceId) as
    { etag: string | null; last_modified: string | null } | undefined;
  return {
    ...(row?.etag ? { etag: row.etag } : {}),
    ...(row?.last_modified ? { lastModified: row.last_modified } : {}),
  };
}

export function updateSourceFetchState(
  db: Db,
  sourceId: string,
  state: { etag?: string | null; lastModified?: string | null; status?: number; error?: string | null },
): void {
  db.prepare(
    `UPDATE sources
        SET etag = coalesce(?, etag),
            last_modified = coalesce(?, last_modified),
            last_fetch_at = ?,
            last_status = ?,
            last_error = ?
      WHERE id = ?`,
  ).run(
    state.etag ?? null,
    state.lastModified ?? null,
    nowIso(),
    state.status ?? null,
    state.error ?? null,
    sourceId,
  );
}

/* ------------------------------------------------------------------ fetches */

export interface FetchLog {
  sourceId: string;
  url: string;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  ok: boolean;
  notModified: boolean;
  bytes: number;
  documentId: string | null;
  itemCount: number;
  newCount: number;
  error: string | null;
}

export function recordFetch(db: Db, log: FetchLog): void {
  db.prepare(
    `INSERT INTO fetches (source_id, url, started_at, duration_ms, http_status, ok,
                          not_modified, bytes, document_id, item_count, new_count, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    log.sourceId,
    log.url,
    log.startedAt,
    log.durationMs,
    log.httpStatus,
    log.ok ? 1 : 0,
    log.notModified ? 1 : 0,
    log.bytes,
    log.documentId,
    log.itemCount,
    log.newCount,
    log.error,
  );
}

/* ---------------------------------------------------------------- documents */

export function upsertDocument(
  db: Db,
  doc: { id: string; sourceId: string; url: string; contentType: string | null; bytes: number; path: string },
): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO documents (id, source_id, url, content_type, bytes, path, first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(doc.id, doc.sourceId, doc.url, doc.contentType, doc.bytes, doc.path, ts, ts);
}

/* ------------------------------------------------------------------- events */

export type UpsertOutcome = 'new' | 'revised' | 'unchanged' | 'duplicate';

/**
 * Insert or update one event.
 *
 * Identity is the stable id, which is scoped to the jurisdiction rather than to
 * the source — the same agenda PDF found via a board's page and via the
 * site-wide index is one record, not two.
 *
 * When two sources disagree about a record they both carry, `precedence`
 * settles it: the lower number wins and may take the record over, the higher
 * number is logged as a duplicate and changes nothing. That is deterministic
 * regardless of the order sources are fetched in, so repeated ingests do not
 * ping-pong the same row between two owners.
 *
 * Within one source, `content_hash` decides whether a re-fetch is a revision
 * (agenda amended, bid updated) or a no-op. Nothing is ever deleted: a record
 * that drops off a listing stays in the feed, because it was published.
 */
export function upsertEvent(db: Db, event: NormalizedEvent): UpsertOutcome {
  const existing = db
    .prepare('SELECT source_id, content_hash, revision, precedence FROM events WHERE id = ?')
    .get(event.id) as
    { source_id: string; content_hash: string; revision: number; precedence: number } | undefined;
  const ts = nowIso();

  if (!existing) {
    db.prepare(
      `INSERT INTO events (id, jurisdiction, source_id, level, agency, body, channel, event_type,
                           priority, title, summary, url, document_url, occurred_at, published_at,
                           first_seen_at, last_seen_at, subjects, tags, precedence, content_hash, raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      event.id,
      event.jurisdiction,
      event.sourceId,
      event.level,
      event.agency,
      event.body,
      event.channel,
      event.eventType,
      event.priority,
      event.title,
      event.summary,
      event.url,
      event.documentUrl,
      event.occurredAt,
      event.publishedAt,
      ts,
      ts,
      JSON.stringify(event.subjects),
      JSON.stringify(event.tags),
      event.precedence,
      event.contentHash,
      JSON.stringify(event.raw),
    );
    return 'new';
  }

  // A less authoritative source may confirm the record still exists, nothing more.
  if (existing.source_id !== event.sourceId && event.precedence >= existing.precedence) {
    db.prepare('UPDATE events SET last_seen_at = ? WHERE id = ?').run(ts, event.id);
    return 'duplicate';
  }

  if (existing.source_id === event.sourceId && existing.content_hash === event.contentHash) {
    db.prepare('UPDATE events SET last_seen_at = ? WHERE id = ?').run(ts, event.id);
    return 'unchanged';
  }

  db.prepare(
    `UPDATE events
        SET source_id = ?, agency = ?, level = ?, title = ?, summary = ?, url = ?, document_url = ?,
            occurred_at = ?, published_at = ?, channel = ?, event_type = ?, priority = ?, body = ?,
            subjects = ?, tags = ?, precedence = ?, content_hash = ?, raw = ?,
            last_seen_at = ?, revised_at = ?, revision = revision + 1
      WHERE id = ?`,
  ).run(
    event.sourceId,
    event.agency,
    event.level,
    event.title,
    event.summary,
    event.url,
    event.documentUrl,
    event.occurredAt,
    event.publishedAt,
    event.channel,
    event.eventType,
    event.priority,
    event.body,
    JSON.stringify(event.subjects),
    JSON.stringify(event.tags),
    event.precedence,
    event.contentHash,
    JSON.stringify(event.raw),
    ts,
    ts,
    event.id,
  );
  return 'revised';
}

export interface EventQuery {
  jurisdiction?: string;
  channels?: string[];
  sources?: string[];
  bodies?: string[];
  levels?: string[];
  /** Restrict to the records linked to these matters. */
  matters?: string[];
  /** Full-text query across title, summary, subjects and agency. */
  q?: string;
  /** Also match text produced by the interpretation stage, not just the record. */
  includeDerived?: boolean;
  /** ISO date lower/upper bounds on the sort date. */
  since?: string;
  until?: string;
  /** `upcoming` keeps only future-dated events; `past` keeps the rest. */
  when?: 'upcoming' | 'past' | 'all';
  includeAdmin?: boolean;
  limit?: number;
  offset?: number;
}

/** The one expression everything sorts and filters on. */
const SORT_DATE = 'coalesce(e.occurred_at, e.published_at, e.first_seen_at)';

function buildWhere(query: EventQuery): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (query.jurisdiction) {
    conds.push('e.jurisdiction = ?');
    params.push(query.jurisdiction);
  }
  for (const [column, values] of [
    ['e.channel', query.channels],
    ['e.source_id', query.sources],
    ['e.body', query.bodies],
    ['e.level', query.levels],
  ] as const) {
    if (values?.length) {
      conds.push(`${column} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
  }
  if (!query.includeAdmin && !query.channels?.includes('admin')) {
    conds.push("e.channel <> 'admin'");
  }
  if (query.since) {
    conds.push(`${SORT_DATE} >= ?`);
    params.push(query.since);
  }
  if (query.until) {
    conds.push(`${SORT_DATE} <= ?`);
    params.push(query.until);
  }
  if (query.when === 'upcoming') {
    conds.push(`${SORT_DATE} > ?`);
    params.push(new Date().toISOString());
  } else if (query.when === 'past') {
    conds.push(`${SORT_DATE} <= ?`);
    params.push(new Date().toISOString());
  }
  if (query.matters?.length) {
    conds.push(
      `e.id IN (SELECT event_id FROM matter_events WHERE matter_id IN (${query.matters.map(() => '?').join(',')}))`,
    );
    params.push(...query.matters);
  }
  if (query.q?.trim()) {
    const match = toMatchQuery(query.q);
    if (query.includeDerived) {
      // Opt-in, and an OR rather than a replacement: the default search stays
      // over what the town published, and asking for derived text widens it
      // rather than substituting for it.
      conds.push(
        `(e.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)
          OR e.id IN (SELECT i.event_id FROM interpretations i
                       WHERE i.rowid IN (SELECT rowid FROM interpretations_fts
                                          WHERE interpretations_fts MATCH ?)))`,
      );
      params.push(match, match);
    } else {
      conds.push('e.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)');
      params.push(match);
    }
  }
  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/**
 * FTS5 treats a lot of punctuation as syntax, so quote each bare word and let
 * a trailing `*` through as a prefix match. Keeps a search box from throwing.
 */
export function toMatchQuery(input: string): string {
  const terms = input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ''))
    .filter(Boolean)
    .map((t) => (t.endsWith('*') ? `"${t.slice(0, -1)}"*` : `"${t}"`));
  return terms.join(' AND ') || '""';
}

export function queryEvents(db: Db, query: EventQuery = {}): EventRow[] {
  const { clause, params } = buildWhere(query);
  const limit = Math.min(query.limit ?? 100, 500);
  const offset = query.offset ?? 0;
  const order = query.when === 'upcoming' ? 'ASC' : 'DESC';
  const rows = db
    .prepare(
      `SELECT e.*, s.label AS source_label
         FROM events e
         LEFT JOIN sources s ON s.id = e.source_id
         ${clause}
        ORDER BY ${SORT_DATE} ${order}, e.title ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[]), limit, offset);
  return rows as unknown as EventRow[];
}

export function countEvents(db: Db, query: EventQuery = {}): number {
  const { clause, params } = buildWhere(query);
  const row = db.prepare(`SELECT count(*) AS n FROM events e ${clause}`).get(...(params as never[])) as {
    n: number;
  };
  return row.n;
}

/** Facet counts for the filter rail, computed under the current filters. */
export function facetCounts(
  db: Db,
  column: 'channel' | 'source_id' | 'body' | 'level',
  query: EventQuery = {},
): { value: string; n: number }[] {
  // Drop the facet's own filter so its list does not collapse to one row.
  const scoped: EventQuery = { ...query };
  if (column === 'channel') delete scoped.channels;
  if (column === 'source_id') delete scoped.sources;
  if (column === 'body') delete scoped.bodies;
  if (column === 'level') delete scoped.levels;

  const { clause, params } = buildWhere(scoped);
  const rows = db
    .prepare(
      `SELECT e.${column} AS value, count(*) AS n
         FROM events e ${clause}
        GROUP BY e.${column}
        HAVING value IS NOT NULL
        ORDER BY n DESC, value ASC`,
    )
    .all(...(params as never[]));
  return rows as unknown as { value: string; n: number }[];
}

export function latestEventTimestamp(db: Db, query: EventQuery = {}): string | null {
  const { clause, params } = buildWhere(query);
  const row = db
    .prepare(`SELECT max(e.last_seen_at) AS ts FROM events e ${clause}`)
    .get(...(params as never[])) as { ts: string | null };
  return row?.ts ?? null;
}

export function getEvent(db: Db, id: string): EventRow | undefined {
  const row = db
    .prepare(
      `SELECT e.*, s.label AS source_label
         FROM events e LEFT JOIN sources s ON s.id = e.source_id
        WHERE e.id = ?`,
    )
    .get(id);
  return row as unknown as EventRow | undefined;
}

/* ------------------------------------------------------------ personal feed */

export interface FeedSubscription {
  kind: string;
  value: string;
  /** The town it was made in, or `*` for every town. Absent behaves as `*`. */
  jurisdiction?: string;
}

/**
 * One reader's feed: the union of everything they follow.
 *
 * Different from every other query here, which narrows by ANDing filters
 * together. A person following the Planning Board *and* 39 Frothingham Street
 * wants both, not the intersection — so the subscriptions are ORed and the
 * jurisdiction is the only thing ANDed on top.
 */
export function personalFeed(
  db: Db,
  subscriptions: FeedSubscription[],
  options: { jurisdiction?: string; limit?: number; includeAdmin?: boolean } = {},
): EventRow[] {
  if (!subscriptions.length) return [];

  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const subscription of subscriptions) {
    let clause: string | null = null;
    switch (subscription.kind) {
      case 'matter':
        clause = 'e.id IN (SELECT event_id FROM matter_events WHERE matter_id = ?)';
        params.push(subscription.value);
        break;
      case 'body':
        clause = 'e.body = ?';
        params.push(subscription.value);
        break;
      case 'channel':
        clause = 'e.channel = ?';
        params.push(subscription.value);
        break;
      case 'search':
        clause = 'e.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)';
        params.push(toMatchQuery(subscription.value));
        break;
      default:
        break;
    }
    if (!clause) continue;

    // Each subscription carries its own town, so "the Planning Board" means the
    // one the reader was looking at when they followed it. A matter id is
    // already globally unique, but scoping it too costs nothing and keeps the
    // rule "a subscription is a town plus a thing" true without exceptions.
    const town = subscription.jurisdiction;
    if (town && town !== '*') {
      clause = `(${clause} AND e.jurisdiction = ?)`;
      params.push(town);
    }
    clauses.push(clause);
  }
  if (!clauses.length) return [];

  const conds = [`(${clauses.join(' OR ')})`];
  if (options.jurisdiction) {
    conds.push('e.jurisdiction = ?');
    params.push(options.jurisdiction);
  }
  // A reader who explicitly followed the admin channel gets it; nobody else does.
  if (!options.includeAdmin && !subscriptions.some((s) => s.kind === 'channel' && s.value === 'admin')) {
    conds.push("e.channel <> 'admin'");
  }

  const rows = db
    .prepare(
      `SELECT e.*, s.label AS source_label
         FROM events e
         LEFT JOIN sources s ON s.id = e.source_id
        WHERE ${conds.join(' AND ')}
        ORDER BY ${SORT_DATE} DESC, e.title ASC
        LIMIT ?`,
    )
    .all(...(params as never[]), Math.min(options.limit ?? 100, 500));
  return rows as unknown as EventRow[];
}

/* ---------------------------------------------------------- interpretations */

export interface InterpretationRow {
  id: string;
  event_id: string;
  kind: string;
  provider: string;
  model: string | null;
  prompt_version: string;
  doc_hash: string;
  text: string;
  data: string;
  created_at: string;
}

/** Readings of one record. Empty rows are placeholders for "nothing found". */
export function interpretationsForEvent(db: Db, eventId: string): InterpretationRow[] {
  const rows = db
    .prepare("SELECT * FROM interpretations WHERE event_id = ? AND text <> '' ORDER BY kind")
    .all(eventId);
  return rows as unknown as InterpretationRow[];
}

/**
 * How many derived readings exist, optionally for one town.
 *
 * `interpretations` hangs off `events` rather than carrying its own
 * jurisdiction — a reading belongs to a document, and the document already
 * knows what town it is from — so the scoping is a join rather than a column.
 */
export function countInterpretations(db: Db, jurisdiction?: string): number {
  const row = jurisdiction
    ? (db
        .prepare(
          `SELECT count(*) AS n FROM interpretations i
             JOIN events e ON e.id = i.event_id
            WHERE i.text <> '' AND e.jurisdiction = ?`,
        )
        .get(jurisdiction) as { n: number })
    : (db.prepare("SELECT count(*) AS n FROM interpretations WHERE text <> ''").get() as { n: number });
  return row.n;
}

/* ------------------------------------------------------------------ matters */

export interface MatterRow {
  id: string;
  jurisdiction: string;
  kind: string;
  key: string;
  label: string;
  event_count: number;
  first_at: string | null;
  last_at: string | null;
  bodies: string;
  channels: string;
  status: string | null;
  updated_at: string;
}

/** One record on a matter's timeline: the event, plus where it sits in the story. */
export interface TimelineRow extends EventRow {
  stage: string;
  evidence: string | null;
}

export interface MatterQuery {
  jurisdiction?: string;
  kinds?: string[];
  /** Only matters carrying at least this many records. 2 = actual timelines. */
  minEvents?: number;
  /** Substring match on the label, for the matter search box. */
  q?: string;
  /** Only matters touched on or after this ISO date. */
  since?: string;
  limit?: number;
  offset?: number;
}

function matterWhere(query: MatterQuery): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (query.jurisdiction) {
    conds.push('m.jurisdiction = ?');
    params.push(query.jurisdiction);
  }
  if (query.kinds?.length) {
    conds.push(`m.kind IN (${query.kinds.map(() => '?').join(',')})`);
    params.push(...query.kinds);
  }
  if (query.minEvents && query.minEvents > 1) {
    conds.push('m.event_count >= ?');
    params.push(query.minEvents);
  }
  if (query.q?.trim()) {
    conds.push('lower(m.label) LIKE ?');
    params.push(`%${query.q.trim().toLowerCase()}%`);
  }
  if (query.since) {
    conds.push('m.last_at >= ?');
    params.push(query.since);
  }
  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

export function listMatters(db: Db, query: MatterQuery = {}): MatterRow[] {
  const { clause, params } = matterWhere(query);
  const rows = db
    .prepare(
      `SELECT m.* FROM matters m
        ${clause}
        ORDER BY m.event_count DESC, m.last_at DESC, m.label ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[]), Math.min(query.limit ?? 100, 500), query.offset ?? 0);
  return rows as unknown as MatterRow[];
}

export function countMatters(db: Db, query: MatterQuery = {}): number {
  const { clause, params } = matterWhere(query);
  const row = db.prepare(`SELECT count(*) AS n FROM matters m ${clause}`).get(...(params as never[])) as {
    n: number;
  };
  return row.n;
}

export function getMatter(db: Db, id: string): MatterRow | undefined {
  return db.prepare('SELECT * FROM matters WHERE id = ?').get(id) as unknown as MatterRow | undefined;
}

/** A matter's records, oldest first — the timeline reads forwards. */
export function matterTimeline(db: Db, matterId: string): TimelineRow[] {
  const rows = db
    .prepare(
      `SELECT e.*, s.label AS source_label, me.stage, me.evidence
         FROM matter_events me
         JOIN events e ON e.id = me.event_id
         LEFT JOIN sources s ON s.id = e.source_id
        WHERE me.matter_id = ?
        ORDER BY coalesce(e.occurred_at, e.published_at, e.first_seen_at) ASC`,
    )
    .all(matterId);
  return rows as unknown as TimelineRow[];
}

/** The matters one record belongs to, for the chips on an event page. */
export function mattersForEvent(db: Db, eventId: string): (MatterRow & { stage: string })[] {
  const rows = db
    .prepare(
      `SELECT m.*, me.stage FROM matter_events me
         JOIN matters m ON m.id = me.matter_id
        WHERE me.event_id = ?
        ORDER BY m.event_count DESC, m.label ASC`,
    )
    .all(eventId);
  return rows as unknown as (MatterRow & { stage: string })[];
}

export interface PlacedMatterRow extends MatterRow {
  lat: number;
  lon: number;
  matched: string | null;
}

/** Address matters that resolved to a point, with the channel to colour them by. */
export function listPlacedMatters(
  db: Db,
  jurisdiction?: string,
): (PlacedMatterRow & { channel: string | null })[] {
  const rows = db
    .prepare(
      `SELECT m.*, p.lat, p.lon, p.matched,
              (SELECT value FROM json_each(m.channels) LIMIT 1) AS channel
         FROM matters m
         JOIN places p ON p.matter_id = m.id
        WHERE p.lat IS NOT NULL${jurisdiction ? ' AND m.jurisdiction = ?' : ''}
        ORDER BY m.event_count DESC`,
    )
    .all(...((jurisdiction ? [jurisdiction] : []) as never[]));
  return rows as unknown as (PlacedMatterRow & { channel: string | null })[];
}

/** Address matters with no usable point — either not tried, or tried and failed. */
export function listUnplacedMatters(
  db: Db,
  jurisdiction?: string,
): { id: string; label: string; failure: string | null }[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.label, p.failure
         FROM matters m
         LEFT JOIN places p ON p.matter_id = m.id
        WHERE m.kind = 'address' AND (p.matter_id IS NULL OR p.lat IS NULL)
          ${jurisdiction ? 'AND m.jurisdiction = ?' : ''}
        ORDER BY m.event_count DESC, m.label ASC`,
    )
    .all(...((jurisdiction ? [jurisdiction] : []) as never[]));
  return rows as unknown as { id: string; label: string; failure: string | null }[];
}

export function getPlace(
  db: Db,
  matterId: string,
): { lat: number; lon: number; matched: string | null } | undefined {
  const row = db
    .prepare('SELECT lat, lon, matched FROM places WHERE matter_id = ? AND lat IS NOT NULL')
    .get(matterId);
  return row as unknown as { lat: number; lon: number; matched: string | null } | undefined;
}

export function matterKindCounts(db: Db, query: MatterQuery = {}): { value: string; n: number }[] {
  const scoped = { ...query };
  delete scoped.kinds;
  const { clause, params } = matterWhere(scoped);
  const rows = db
    .prepare(`SELECT m.kind AS value, count(*) AS n FROM matters m ${clause} GROUP BY m.kind ORDER BY n DESC`)
    .all(...(params as never[]));
  return rows as unknown as { value: string; n: number }[];
}
