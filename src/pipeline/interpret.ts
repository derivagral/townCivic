import { createHash } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { rulesInterpreter } from '../interpret/rules.ts';
import { createAnthropicInterpreter } from '../interpret/anthropic.ts';
import { InterpreterUnavailableError } from '../interpret/provider.ts';
import type { Interpreter } from '../interpret/provider.ts';
import { getProfile } from '../registry/index.ts';

/**
 * Fourth pass: read the prose the parsers cannot structure.
 *
 * Agendas arrive as form fields, so `extract` gets everything from them. Minutes
 * are paragraphs, and the votes and conditions in them are the part of the
 * civic record people most often want and least often get. This stage reads
 * those into a separate, clearly-labelled table so search can reach them.
 *
 * It is the only stage that may involve a model, and it is off the default path.
 * Nothing downstream treats its output as a fact about what the town did.
 */

export const PROVIDERS = ['rules', 'anthropic'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function interpreterFor(name: ProviderName): Interpreter {
  return name === 'anthropic' ? createAnthropicInterpreter() : rulesInterpreter;
}

export function isProvider(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

export interface InterpretOptions {
  jurisdiction?: string;
  provider?: ProviderName;
  interpreter?: Interpreter;
  /**
   * Which records to read. Minutes by default: agendas are already structured,
   * so running a model over them buys nothing and costs something.
   */
  eventTypes?: string[];
  eventIds?: string[];
  /** Re-read documents whose reading is already current. */
  force?: boolean;
  limit?: number;
  since?: string;
  onProgress?: (report: InterpretReport) => void;
}

export interface InterpretReport {
  eventId: string;
  title: string;
  ok: boolean;
  found: number;
  skipped?: 'unchanged' | 'no-text';
  error?: string;
}

interface Candidate {
  id: string;
  jurisdiction: string;
  title: string;
  body: string | null;
  event_type: string;
  occurred_at: string | null;
  /**
   * The extracted document where there is one, and the listing's own
   * description where there is not. Both are text the town published; the
   * listing line for a set of minutes often carries the disposition outright
   * ("Minutes — subdivision approval, 8 Wharf Street, 4-1 vote"), and reading
   * it means this stage is useful before `extract` has been run.
   */
  source_text: string | null;
}

const DEFAULT_TYPES = ['meeting_minutes'];

/** Identity of a reading: same document, same provider, same prompt → same row. */
function interpretationId(eventId: string, kind: string, provider: string, version: string): string {
  return createHash('sha256').update(`${eventId}|${kind}|${provider}|${version}`).digest('hex').slice(0, 32);
}

export function docHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function selectCandidates(db: Db, options: InterpretOptions, interpreter: Interpreter): Candidate[] {
  const conditions = ["coalesce(doc_text, summary, '') <> ''"];
  const params: unknown[] = [];

  if (options.jurisdiction) {
    conditions.push('jurisdiction = ?');
    params.push(options.jurisdiction);
  }
  if (options.eventIds?.length) {
    conditions.push(`id IN (${options.eventIds.map(() => '?').join(',')})`);
    params.push(...options.eventIds);
  } else {
    const types = options.eventTypes ?? DEFAULT_TYPES;
    conditions.push(`event_type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  if (options.since) {
    conditions.push('coalesce(occurred_at, published_at, first_seen_at) >= ?');
    params.push(options.since);
  }

  return db
    .prepare(
      `SELECT id, jurisdiction, title, body, event_type, occurred_at, coalesce(doc_text, summary) AS source_text
         FROM events
        WHERE ${conditions.join(' AND ')}
        ORDER BY coalesce(occurred_at, published_at, first_seen_at) DESC
        LIMIT ?`,
    )
    .all(...(params as never[]), options.limit ?? interpreter.suggestedLimit) as unknown as Candidate[];
}

/** True when this document already has a current reading from this interpreter. */
function isCurrent(db: Db, eventId: string, interpreter: Interpreter, hash: string): boolean {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM interpretations
        WHERE event_id = ? AND provider = ? AND prompt_version = ? AND doc_hash = ?`,
    )
    .get(eventId, interpreter.name, interpreter.promptVersion, hash) as { n: number };
  return row.n > 0;
}

export async function interpretDocuments(db: Db, options: InterpretOptions = {}): Promise<InterpretReport[]> {
  const interpreter = options.interpreter ?? interpreterFor(options.provider ?? 'rules');
  const candidates = selectCandidates(db, options, interpreter);
  const reports: InterpretReport[] = [];

  for (const candidate of candidates) {
    const text = candidate.source_text ?? '';
    const report: InterpretReport = { eventId: candidate.id, title: candidate.title, ok: false, found: 0 };

    if (!text.trim()) {
      report.ok = true;
      report.skipped = 'no-text';
      reports.push(report);
      options.onProgress?.(report);
      continue;
    }

    const hash = docHash(text);
    if (!options.force && isCurrent(db, candidate.id, interpreter, hash)) {
      report.ok = true;
      report.skipped = 'unchanged';
      reports.push(report);
      options.onProgress?.(report);
      continue;
    }

    try {
      const results = await interpreter.interpret({
        eventId: candidate.id,
        // Which town this is comes off the record, not off the run: it is part
        // of what the model is being asked to read, and a document read as the
        // wrong town's is worse than one not read at all.
        jurisdictionLabel: getProfile(candidate.jurisdiction).label,
        title: candidate.title,
        body: candidate.body,
        eventType: candidate.event_type,
        occurredAt: candidate.occurred_at,
        text,
      });

      // Replace this provider's previous reading rather than accumulating: a
      // reading is a view of the current document, not a history of views.
      db.prepare('DELETE FROM interpretations WHERE event_id = ? AND provider = ?').run(
        candidate.id,
        interpreter.name,
      );

      for (const result of results) {
        db.prepare(
          `INSERT INTO interpretations (id, event_id, kind, provider, model, prompt_version,
                                        doc_hash, text, data, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          interpretationId(candidate.id, result.kind, interpreter.name, interpreter.promptVersion),
          candidate.id,
          result.kind,
          interpreter.name,
          interpreter.model,
          interpreter.promptVersion,
          hash,
          result.text,
          JSON.stringify(result.data),
          new Date().toISOString(),
        );
      }

      // A document with no decisions in it is a real answer, and one worth
      // remembering — otherwise every run re-reads every quiet meeting. Record
      // the empty reading so `isCurrent` can skip it next time.
      if (!results.length) {
        db.prepare(
          `INSERT INTO interpretations (id, event_id, kind, provider, model, prompt_version,
                                        doc_hash, text, data, created_at)
           VALUES (?,?,?,?,?,?,?,'','{"empty":true}',?)`,
        ).run(
          interpretationId(candidate.id, 'summary', interpreter.name, interpreter.promptVersion),
          candidate.id,
          'summary',
          interpreter.name,
          interpreter.model,
          interpreter.promptVersion,
          hash,
          new Date().toISOString(),
        );
      }

      report.ok = true;
      report.found = results.length;
    } catch (error) {
      // An unavailable provider is a configuration problem, not a bad document:
      // stop rather than logging the same message once per record.
      if (error instanceof InterpreterUnavailableError) throw error;
      report.error = error instanceof Error ? error.message : String(error);
    }

    reports.push(report);
    options.onProgress?.(report);
  }

  return reports;
}
