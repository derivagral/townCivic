import type { Db } from '../db/index.ts';
import { bestLabel, bidRef, extractBidNumbers, matterId, matterRef } from '../matters/key.ts';
import type { MatterKind, MatterRef } from '../matters/key.ts';
import { readStage, rollupStatus, sentencesMentioning } from '../matters/stages.ts';
import type { Stage } from '../matters/stages.ts';

/**
 * Third pass: work out which records are about the same thing.
 *
 * `ingest` records that a meeting exists, `extract` records what it is about,
 * and this groups the records that are about the same property, warrant article
 * or procurement into one matter with a timeline.
 *
 * Everything here is derived from `events`, so the tables it writes can be
 * dropped and rebuilt at any time. It reads nothing from the network.
 *
 * Every run is a full rebuild of this jurisdiction's matters, which is why —
 * unlike the network stages — `link` takes no `--force`. There is no
 * incremental state to invalidate, and a change to the normalization rules
 * takes effect everywhere on the next run rather than only on new records.
 */

export interface LinkOptions {
  jurisdiction?: string;
  onProgress?: (report: LinkReport) => void;
}

export interface LinkReport {
  matterId: string;
  kind: MatterKind;
  label: string;
  events: number;
  status: Stage | null;
}

export interface LinkSummary {
  eventsConsidered: number;
  links: number;
  matters: number;
  /** Matters carrying more than one record — the ones that are actually timelines. */
  timelines: number;
  reports: LinkReport[];
}

interface LinkableEvent {
  id: string;
  event_type: string;
  title: string;
  summary: string | null;
  doc_text: string | null;
  subjects: string;
  jurisdiction: string;
  sort_date: string | null;
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Everything the stage rules are allowed to read, most specific first. */
function searchableText(event: LinkableEvent): string {
  return [event.title, event.summary ?? '', event.doc_text ?? ''].filter(Boolean).join('\n');
}

/**
 * Every matter one record touches.
 *
 * Addresses and article numbers are read from `subjects`, not re-derived from
 * the text: extraction already found them *and* applied the venue filter, so
 * re-scanning here would put the Town Clerk's own address on every record in
 * town. Bid numbers are the exception — nothing extracts those yet, and they
 * live in prose, so an agenda saying "award of contract, SB26-9" is the only
 * thing tying a contract award back to the bid posting it answers.
 */
export function refsForEvent(event: LinkableEvent, knownBids: Iterable<string> = []): MatterRef[] {
  const year = event.sort_date ? new Date(event.sort_date).getUTCFullYear() : null;
  const found = new Map<string, MatterRef>();

  const add = (ref: MatterRef | null) => {
    if (ref) found.set(`${ref.kind}|${ref.key}`, ref);
  };

  for (const subject of parseJsonArray(event.subjects)) add(matterRef(subject, year));
  for (const number of extractBidNumbers(searchableText(event), knownBids)) add(bidRef(number));

  return [...found.values()];
}

/**
 * The bid numbers this jurisdiction has actually published, read from the
 * records that label them as such.
 *
 * Collected up front so the linking pass can recognise a bare number later in
 * the corpus — see `extractBidNumbers`.
 */
function bidVocabulary(events: LinkableEvent[]): Set<string> {
  const known = new Set<string>();
  for (const event of events) {
    for (const number of extractBidNumbers(searchableText(event))) known.add(number);
  }
  return known;
}

function selectEvents(db: Db, options: LinkOptions): LinkableEvent[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.jurisdiction) {
    conditions.push('jurisdiction = ?');
    params.push(options.jurisdiction);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT id, event_type, title, summary, doc_text, subjects, jurisdiction,
              coalesce(occurred_at, published_at, first_seen_at) AS sort_date
         FROM events
         ${where}
        ORDER BY sort_date ASC`,
    )
    .all(...(params as never[])) as unknown as LinkableEvent[];
}

export function linkMatters(db: Db, options: LinkOptions = {}): LinkSummary {
  const events = selectEvents(db, options);
  const now = new Date().toISOString();

  // Accumulate in memory, then write once. The whole table is derived, so a
  // rebuild is cheaper and more predictable than incremental reconciliation —
  // and it means a change to the normalization rules takes effect everywhere
  // on the next run rather than only on records seen since.
  interface Accumulated {
    ref: MatterRef;
    labels: string[];
    jurisdiction: string;
    links: { eventId: string; stage: Stage; evidence: string | null; sortDate: string | null }[];
  }
  const accumulated = new Map<string, Accumulated>();
  const knownBids = bidVocabulary(events);

  for (const event of events) {
    const text = searchableText(event);
    for (const ref of refsForEvent(event, knownBids)) {
      const id = matterId(event.jurisdiction, ref.kind, ref.key);

      // Scope the stage reading to the sentences that name this subject, so one
      // decided item on a crowded agenda does not decide every other item on it.
      const scoped = sentencesMentioning(text, ref.label);
      const reading = readStage(scoped.length ? scoped.join(' ') : text, event.event_type);

      const entry = accumulated.get(id) ?? {
        ref,
        labels: [],
        jurisdiction: event.jurisdiction,
        links: [],
      };
      entry.labels.push(ref.label);
      entry.links.push({
        eventId: event.id,
        stage: reading.stage,
        evidence: reading.evidence,
        sortDate: event.sort_date,
      });
      accumulated.set(id, entry);
    }
  }

  const scopeParams = options.jurisdiction ? [options.jurisdiction] : [];
  const scopeClause = options.jurisdiction ? 'WHERE jurisdiction = ?' : '';

  const reports: LinkReport[] = [];
  let links = 0;

  // `node:sqlite` has no transaction helper, so drive it with statements. If a
  // run dies partway the next one rebuilds from scratch anyway.
  db.exec('BEGIN');
  try {
    db.prepare(
      `DELETE FROM matter_events
        WHERE matter_id IN (SELECT id FROM matters ${scopeClause})`,
    ).run(...(scopeParams as never[]));
    db.prepare(`DELETE FROM matters ${scopeClause}`).run(...(scopeParams as never[]));

    const insertMatter = db.prepare(
      `INSERT INTO matters (id, jurisdiction, kind, key, label, event_count, first_at, last_at,
                            bodies, channels, status, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertLink = db.prepare(
      `INSERT INTO matter_events (matter_id, event_id, stage, evidence, confidence, linked_at)
       VALUES (?,?,?,?,?,?)`,
    );
    const facetsFor = db.prepare(
      `SELECT DISTINCT body, channel FROM events WHERE id IN (SELECT event_id FROM matter_events WHERE matter_id = ?)`,
    );

    for (const [id, entry] of accumulated) {
      const ordered = [...entry.links].sort((a, b) => (a.sortDate ?? '').localeCompare(b.sortDate ?? ''));
      const dates = ordered.map((l) => l.sortDate).filter((d): d is string => Boolean(d));

      insertMatter.run(
        id,
        entry.jurisdiction,
        entry.ref.kind,
        entry.ref.key,
        bestLabel(entry.labels),
        ordered.length,
        dates[0] ?? null,
        dates.at(-1) ?? null,
        '[]',
        '[]',
        rollupStatus(ordered.map((l) => l.stage)),
        now,
      );

      for (const link of ordered) {
        insertLink.run(id, link.eventId, link.stage, link.evidence, 'exact', now);
        links++;
      }

      // Bodies and channels are read back rather than accumulated, so they stay
      // consistent with whatever the events table actually says right now.
      const facets = facetsFor.all(id) as unknown as { body: string | null; channel: string }[];
      db.prepare('UPDATE matters SET bodies = ?, channels = ? WHERE id = ?').run(
        JSON.stringify([...new Set(facets.map((f) => f.body).filter(Boolean))].sort()),
        JSON.stringify([...new Set(facets.map((f) => f.channel))].sort()),
        id,
      );

      const report: LinkReport = {
        matterId: id,
        kind: entry.ref.kind,
        label: bestLabel(entry.labels),
        events: ordered.length,
        status: rollupStatus(ordered.map((l) => l.stage)),
      };
      reports.push(report);
      options.onProgress?.(report);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  reports.sort((a, b) => b.events - a.events || a.label.localeCompare(b.label));

  return {
    eventsConsidered: events.length,
    links,
    matters: accumulated.size,
    timelines: reports.filter((r) => r.events > 1).length,
    reports,
  };
}
