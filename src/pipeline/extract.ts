import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { getDocuments } from '../documents/index.ts';
import { keyFor } from '../documents/store.ts';
import { extractPdf, looksLikePdf } from '../extract/pdf.ts';
import type { PdfExtraction, PdfPageStat } from '../extract/pdf.ts';
import { parseMeetingNotice, summarizeAgenda } from '../extract/meeting-notice.ts';
import type { MeetingNotice } from '../extract/meeting-notice.ts';
import { extractSubjects, stripHtml, truncate } from '../util/text.ts';
import { getProfile } from '../registry/index.ts';
import { canonicalBody, isVenueAddress } from '../registry/profile.ts';
import type { JurisdictionProfile } from '../registry/profile.ts';

/**
 * Second pass: open the document each record points at and read what is inside.
 *
 * Ingestion records *that* a meeting exists; this records what it is about. It
 * is a separate stage on purpose — documents are large and slow relative to
 * listings, and re-extracting is independent of re-fetching a listing.
 *
 * No model is involved. Modern notices are AcroForm templates, so the agenda
 * arrives as a named field; older ones fall back to the text layer.
 *
 * The town is read off each record rather than off the run, so `extract` with
 * no `--jurisdiction` walks the oldest unread documents in every town in one
 * pass and still applies each town's own venue and body rules.
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
  quality?: ExtractionQuality;
  skipped?: 'no-document' | 'already-extracted' | 'not-a-document';
  error?: string;
  failureCode?: ExtractionFailureCode;
  retryAfter?: string;
}

export type ExtractionQuality = 'structured' | 'text' | 'mixed' | 'scanned' | 'empty' | 'html';
export type ExtractionFailureCode =
  'http_not_found' | 'http_error' | 'network_error' | 'parse_error' | 'storage_error';

class ExtractionError extends Error {
  readonly code: ExtractionFailureCode;

  constructor(code: ExtractionFailureCode, message: string) {
    super(message);
    this.code = code;
  }
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
  jurisdiction: string;
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
  if (!options.force) {
    conditions.push('extracted_at IS NULL');
    // A failed document stays pending, but a hot 404 or broken PDF should not
    // consume the front of every limited refresh until its backoff expires.
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM attachments a
                    WHERE a.event_id = events.id AND a.url = events.document_url
                      AND a.error IS NOT NULL
                      AND a.retry_after > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    );
  }
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
      `SELECT id, jurisdiction, title, document_url, body, summary, subjects, tags
         FROM events
        WHERE ${conditions.join(' AND ')}
        ORDER BY coalesce(occurred_at, published_at, first_seen_at) DESC
        LIMIT ?`,
    )
    .all(...(params as never[]), options.limit ?? 200) as unknown as Candidate[];
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
    const profile = getProfile(candidate.jurisdiction);
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

    let phase: ExtractionFailureCode = 'network_error';
    try {
      let response: Response;
      try {
        response = await doFetch(url, {
          headers: { 'user-agent': config.userAgent },
          redirect: 'follow',
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch (error) {
        throw new ExtractionError('network_error', error instanceof Error ? error.message : String(error));
      }

      if (!response.ok) {
        throw new ExtractionError(
          response.status === 404 || response.status === 410 ? 'http_not_found' : 'http_error',
          `HTTP ${response.status}`,
        );
      }

      const contentType = response.headers.get('content-type');
      const bytes = new Uint8Array(await response.arrayBuffer());
      phase = 'parse_error';

      if (!looksLikePdf(bytes)) {
        // Not a PDF — usually the HTML view. Keep its text so search still works.
        const text = stripHtml(Buffer.from(bytes).toString('utf8'));
        phase = 'storage_error';
        await applyExtraction(db, candidate, profile, {
          url,
          text,
          contentType,
          bytes,
          pages: 0,
          charsPerPage: text.length,
          likelyScanned: false,
          pageStats: [{ page: 1, chars: text.replace(/\s/g, '').length, images: 0, needsOcr: false }],
          fields: {},
          notice: null,
        });
        report.ok = true;
        report.skipped = 'not-a-document';
        report.quality = text.trim() ? 'html' : 'empty';
        reports.push(report);
        options.onProgress?.(report);
        await new Promise((resolve) => setTimeout(resolve, config.perHostDelayMs));
        continue;
      }

      const extraction: PdfExtraction = await extractPdf(bytes);
      const notice = parseMeetingNotice(extraction, profile);
      const extractedText = [Object.values(extraction.fields).join('\n'), extraction.text]
        .filter(Boolean)
        .join('\n\n');

      phase = 'storage_error';
      await applyExtraction(db, candidate, profile, {
        url,
        text: extractedText,
        contentType,
        bytes,
        pages: extraction.pages,
        charsPerPage: extraction.charsPerPage,
        likelyScanned: extraction.likelyScanned,
        pageStats: extraction.pageStats,
        fields: extraction.fields,
        notice,
      });

      report.ok = true;
      report.structured = notice.structured;
      report.agendaItems = notice.agendaItems.length;
      report.subjects = notice.subjects;
      report.pages = extraction.pages;
      report.likelyScanned = extraction.likelyScanned;
      report.quality = qualityOf({
        text: extractedText,
        pages: extraction.pages,
        pageStats: extraction.pageStats,
        structured: notice.structured,
        html: false,
      });
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      report.failureCode = error instanceof ExtractionError ? error.code : phase;
      const retryMs = report.failureCode === 'http_not_found' ? 7 * 86_400_000 : 6 * 3_600_000;
      report.retryAfter = new Date(Date.now() + retryMs).toISOString();
      db.prepare(
        `INSERT INTO attachments
           (id, event_id, url, bytes, quality, extracted_at, error, failure_code, retry_after, attempts)
         VALUES (?,?,?,0,'error',?,?,?,?,1)
         ON CONFLICT(id) DO UPDATE SET
           error = excluded.error, failure_code = excluded.failure_code,
           retry_after = excluded.retry_after, extracted_at = excluded.extracted_at,
           attempts = attachments.attempts + 1`,
      ).run(
        createHash('sha256').update(`error:${candidate.id}:${url}`).digest('hex'),
        candidate.id,
        // Keep the exact listing URL here so a corrected document_url bypasses
        // this row's backoff immediately. Successful attachments record the
        // preferred/downloaded URL instead.
        candidate.document_url,
        new Date().toISOString(),
        report.error,
        report.failureCode,
        report.retryAfter,
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
  pageStats: PdfPageStat[];
  fields: Record<string, string>;
  notice: MeetingNotice | null;
}

function qualityOf(input: {
  text: string;
  pages: number;
  pageStats: PdfPageStat[];
  structured: boolean;
  html: boolean;
}): ExtractionQuality {
  if (!input.text.trim()) return 'empty';
  if (input.html) return 'html';
  const ocrPages = input.pageStats.filter((page) => page.needsOcr).length;
  if (ocrPages && ocrPages === input.pages) return 'scanned';
  if (ocrPages) return 'mixed';
  return input.structured ? 'structured' : 'text';
}

/**
 * Write what the document said back onto the record.
 *
 * The listing already gave a title and a date; extraction adds the things only
 * the document knows — what the meeting is about, where it is, exactly when the
 * clerk posted it, and which properties it concerns.
 */
async function applyExtraction(
  db: Db,
  candidate: Candidate,
  profile: JurisdictionProfile,
  applied: Applied,
): Promise<void> {
  const now = new Date().toISOString();
  const extension = applied.pages > 0 ? 'pdf' : 'html';
  const documents = getDocuments();
  // `attachments/` keeps the documents a reader could open separate from the
  // listing pages they were found on, in whichever backend holds them.
  const stored = await documents.put(
    keyFor(createHash('sha256').update(applied.bytes).digest('hex'), extension, 'attachments/'),
    applied.bytes,
    applied.contentType,
  );

  const textBytes = new TextEncoder().encode(applied.text);
  const textHash = createHash('sha256').update(textBytes).digest('hex');
  const storedText = applied.text
    ? await documents.put(keyFor(textHash, 'txt', 'extracted/'), textBytes, 'text/plain; charset=utf-8')
    : null;
  const quality = qualityOf({
    text: applied.text,
    pages: applied.pages,
    pageStats: applied.pageStats,
    structured: Boolean(applied.notice?.structured),
    html: applied.pages === 0,
  });

  db.prepare(
    `INSERT INTO attachments (id, event_id, url, content_type, bytes, path, text_path, text_chars,
                              pages, chars_per_page, likely_scanned, page_stats, quality,
                              fields, notice, extracted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       event_id = excluded.event_id, url = excluded.url, pages = excluded.pages,
       text_path = excluded.text_path, text_chars = excluded.text_chars,
       chars_per_page = excluded.chars_per_page, likely_scanned = excluded.likely_scanned,
       page_stats = excluded.page_stats, quality = excluded.quality,
       fields = excluded.fields, notice = excluded.notice,
       extracted_at = excluded.extracted_at, error = NULL, failure_code = NULL,
       retry_after = NULL, attempts = 0`,
  ).run(
    stored.id,
    candidate.id,
    applied.url,
    applied.contentType,
    applied.bytes.length,
    stored.key,
    storedText?.key ?? null,
    applied.text.length,
    applied.pages,
    applied.charsPerPage,
    applied.likelyScanned ? 1 : 0,
    JSON.stringify(applied.pageStats),
    quality,
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
  ].filter((subject) => !isVenueAddress(profile, subject));

  const agendaSummary = notice?.agendaItems.length ? summarizeAgenda(notice.agendaItems) : '';
  const summary = agendaSummary ? truncate(agendaSummary, 400) : candidate.summary;

  const tags = new Set(parseJsonArray(candidate.tags));
  if (notice?.structured) tags.add('structured');
  else tags.delete('structured');
  tags.delete('scanned');
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
    // Keep the complete extracted record. The lossless copy in the document
    // store preserves provenance; this copy is what makes every page searchable
    // and prevents interpretation from silently seeing only the first 20k.
    applied.text,
    summary,
    JSON.stringify(subjects),
    JSON.stringify([...tags].sort()),
    notice?.board ? canonicalBody(profile, notice.board) : null,
    // The notice carries the real start time; the listing only had the date.
    notice?.meetingAt ?? null,
    notice?.postedAt ?? null,
    now,
    candidate.id,
  );
}
