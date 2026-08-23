import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { extractPdf, looksLikePdf } from '../extract/pdf.ts';
import type { PdfExtraction } from '../extract/pdf.ts';
import { parseMeetingNotice, summarizeAgenda } from '../extract/meeting-notice.ts';
import type { MeetingNotice } from '../extract/meeting-notice.ts';
import { extractSubjects, stripHtml, truncate } from '../util/text.ts';
import { canonicalBody, isVenueAddress } from '../registry/milton-ma.ts';

/**
 * Second pass: open the document each record points at and read what is inside.
 *
 * Ingestion records *that* a meeting exists; this records what it is about. It
 * is a separate stage on purpose — documents are large and slow relative to
 * listings, and re-extracting is independent of re-fetching a listing.
 *
 * No model is involved. Milton's modern notices are AcroForm templates, so the
 * agenda arrives as a named field; older ones fall back to the text layer.
 */

export interface ExtractReport {
  eventId: string;
  title: string;
  url: string;
  ok: boolean;
  /** Facts came from form fields rather than from loose text. */
  structured: boolean;
  agendaItems: number;
  subjects: string[];
  pages: number;
  likelyScanned: boolean;
  skipped?: 'no-document' | 'already-extracted' | 'not-a-document';
  error?: string;
}

export interface ExtractOptions {
  jurisdiction?: string;
  eventIds?: string[];
  sourceIds?: string[];
  /** Re-extract documents already processed. */
  force?: boolean;
  limit?: number;
  /** Only look at records whose meeting is on or after this ISO date. */
  since?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (report: ExtractReport) => void;
}

interface Candidate {
  id: string;
  title: string;
  document_url: string;
  body: string | null;
  summary: string | null;
  subjects: string;
  tags: string;
}

/**
 * Some Agenda Center links carry `?html=true`, which returns a web page instead
 * of the file. The PDF is the record, so ask for it directly.
 */
export function preferDocumentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('html');
    return parsed.toString();
  } catch {
    return url;
  }
}

function selectCandidates(db: Db, options: ExtractOptions): Candidate[] {
  const conditions = ['document_url IS NOT NULL'];
  const params: unknown[] = [];

  if (options.jurisdiction) {
    conditions.push('jurisdiction = ?');
    params.push(options.jurisdiction);
  }
  if (!options.force) conditions.push('extracted_at IS NULL');
  if (options.eventIds?.length) {
    conditions.push(`id IN (${options.eventIds.map(() => '?').join(',')})`);
    params.push(...options.eventIds);
  }
  if (options.sourceIds?.length) {
    conditions.push(`source_id IN (${options.sourceIds.map(() => '?').join(',')})`);
    params.push(...options.sourceIds);
  }
  if (options.since) {
    conditions.push('coalesce(occurred_at, published_at, first_seen_at) >= ?');
    params.push(options.since);
  }

  // Newest first: the agenda for next week's meeting is worth more than one
  // from 2018, and a run interrupted halfway should have done the useful part.
  return db
    .prepare(
      `SELECT id, title, document_url, body, summary, subjects, tags
         FROM events
        WHERE ${conditions.join(' AND ')}
        ORDER BY coalesce(occurred_at, published_at, first_seen_at) DESC
        LIMIT ?`,
    )
    .all(...(params as never[]), options.limit ?? 200) as unknown as Candidate[];
}

function storeBytes(bytes: Uint8Array, extension: string): { id: string; relative: string } {
  const id = createHash('sha256').update(bytes).digest('hex');
  const relative = path.join('attachments', id.slice(0, 2), `${id}.${extension}`);
  const absolute = path.join(config.docStoreDir, relative);
  if (!fs.existsSync(absolute)) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }
  return { id, relative };
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function extractDocuments(db: Db, options: ExtractOptions = {}): Promise<ExtractReport[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const candidates = selectCandidates(db, options);
  const reports: ExtractReport[] = [];

  for (const candidate of candidates) {
    const url = preferDocumentUrl(candidate.document_url);
    const report: ExtractReport = {
      eventId: candidate.id,
      title: candidate.title,
      url,
      ok: false,
      structured: false,
      agendaItems: 0,
      subjects: [],
      pages: 0,
      likelyScanned: false,
    };

    try {
      const response = await doFetch(url, {
        headers: { 'user-agent': config.userAgent },
        redirect: 'follow',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get('content-type');
      const bytes = new Uint8Array(await response.arrayBuffer());

      if (!looksLikePdf(bytes)) {
        // Not a PDF — usually the HTML view. Keep its text so search still works.
        const text = stripHtml(Buffer.from(bytes).toString('utf8'));
        applyExtraction(db, candidate, {
          url,
          text,
          contentType,
          bytes,
          pages: 0,
          charsPerPage: text.length,
          likelyScanned: false,
          fields: {},
          notice: null,
        });
        report.ok = true;
        report.skipped = 'not-a-document';
        reports.push(report);
        options.onProgress?.(report);
        await new Promise((resolve) => setTimeout(resolve, config.perHostDelayMs));
        continue;
      }

      const extraction: PdfExtraction = await extractPdf(bytes);
      const notice = parseMeetingNotice(extraction);

      applyExtraction(db, candidate, {
        url,
        text: [Object.values(extraction.fields).join('\n'), extraction.text].filter(Boolean).join('\n\n'),
        contentType,
        bytes,
        pages: extraction.pages,
        charsPerPage: extraction.charsPerPage,
        likelyScanned: extraction.likelyScanned,
        fields: extraction.fields,
        notice,
      });

      report.ok = true;
      report.structured = notice.structured;
      report.agendaItems = notice.agendaItems.length;
      report.subjects = notice.subjects;
      report.pages = extraction.pages;
      report.likelyScanned = extraction.likelyScanned;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      db.prepare(
        `INSERT INTO attachments (id, event_id, url, bytes, extracted_at, error)
         VALUES (?,?,?,0,?,?)
         ON CONFLICT(id) DO UPDATE SET error = excluded.error, extracted_at = excluded.extracted_at`,
      ).run(
        createHash('sha256').update(`error:${candidate.id}:${url}`).digest('hex'),
        candidate.id,
        url,
        new Date().toISOString(),
        report.error,
      );
      // Mark it attempted so a failing document does not block every later run.
      db.prepare('UPDATE events SET extracted_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        candidate.id,
      );
    }

    reports.push(report);
    options.onProgress?.(report);
    await new Promise((resolve) => setTimeout(resolve, config.perHostDelayMs));
  }

  return reports;
}

interface Applied {
  url: string;
  text: string;
  contentType: string | null;
  bytes: Uint8Array;
  pages: number;
  charsPerPage: number;
  likelyScanned: boolean;
  fields: Record<string, string>;
  notice: MeetingNotice | null;
}

/**
 * Write what the document said back onto the record.
 *
 * The listing already gave a title and a date; extraction adds the things only
 * the document knows — what the meeting is about, where it is, exactly when the
 * clerk posted it, and which properties it concerns.
 */
function applyExtraction(db: Db, candidate: Candidate, applied: Applied): void {
  const now = new Date().toISOString();
  const extension = applied.pages > 0 ? 'pdf' : 'html';
  const stored = storeBytes(applied.bytes, extension);

  db.prepare(
    `INSERT INTO attachments (id, event_id, url, content_type, bytes, path, pages,
                              chars_per_page, likely_scanned, fields, notice, extracted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       event_id = excluded.event_id, url = excluded.url, pages = excluded.pages,
       chars_per_page = excluded.chars_per_page, likely_scanned = excluded.likely_scanned,
       fields = excluded.fields, notice = excluded.notice,
       extracted_at = excluded.extracted_at, error = NULL`,
  ).run(
    stored.id,
    candidate.id,
    applied.url,
    applied.contentType,
    applied.bytes.length,
    stored.relative,
    applied.pages,
    applied.charsPerPage,
    applied.likelyScanned ? 1 : 0,
    JSON.stringify(applied.fields),
    applied.notice ? JSON.stringify(applied.notice) : null,
    now,
  );

  const notice = applied.notice;

  // Union rather than replace: the listing row and the document each see things
  // the other does not. The venue filter is applied to the union as well as to
  // the notice, so re-extracting can *remove* a bad subject an earlier run
  // wrote — otherwise the union would make extraction a one-way ratchet.
  const subjects = [
    ...new Set([
      ...parseJsonArray(candidate.subjects),
      ...(notice?.subjects ?? extractSubjects(applied.text)),
    ]),
  ].filter((subject) => !isVenueAddress(subject));

  const agendaSummary = notice?.agendaItems.length ? summarizeAgenda(notice.agendaItems) : '';
  const summary = agendaSummary ? truncate(agendaSummary, 400) : candidate.summary;

  const tags = new Set(parseJsonArray(candidate.tags));
  if (notice?.structured) tags.add('structured');
  if (applied.likelyScanned) tags.add('scanned');

  db.prepare(
    `UPDATE events
        SET doc_text = ?,
            summary = ?,
            subjects = ?,
            tags = ?,
            body = coalesce(?, body),
            occurred_at = coalesce(?, occurred_at),
            published_at = coalesce(?, published_at),
            extracted_at = ?
      WHERE id = ?`,
  ).run(
    truncate(applied.text, 20_000),
    summary,
    JSON.stringify(subjects),
    JSON.stringify([...tags].sort()),
    notice?.board ? canonicalBody(notice.board) : null,
    // The notice carries the real start time; the listing only had the date.
    notice?.meetingAt ?? null,
    notice?.postedAt ?? null,
    now,
    candidate.id,
  );
}
