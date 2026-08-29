import * as cheerio from 'cheerio';
import type { Adapter, AdapterContext, RawItem } from '../types.ts';
import type { EventType } from '../taxonomy.ts';
import { parseCivicPlusStamp, parseLooseDate } from '../util/dates.ts';
import { clean, extractSubjects } from '../util/text.ts';

/**
 * CivicPlus Agenda Center.
 *
 * Deliberately keyed off the href, not the page's CSS classes:
 *
 *   /AgendaCenter/ViewFile/Agenda/_09092025-1234
 *   /AgendaCenter/ViewFile/Minutes/_03242026-6593
 *
 * The meeting date (MMDDYYYY), the file id, and the agenda/minutes distinction
 * are all in the path. A theme change can restyle the listing without breaking
 * ingestion, and the parser degrades to "found nothing" rather than to garbage.
 */
const VIEW_FILE_RE = /\/AgendaCenter\/ViewFile\/(Agenda|Minutes)\/_(\d{8})-(\d+)/i;

const TYPE_MAP: Record<string, EventType> = {
  agenda: 'meeting_agenda',
  minutes: 'meeting_minutes',
};

/** Headings that are chrome, not a board name. */
const HEADING_NOISE = /^(agenda center|agendas?|minutes|search|view more|categories|archive)$/i;

export const civicPlusAgendaCenterAdapter: Adapter = {
  name: 'civicplus-agenda-center',
  parse(body: string, ctx: AdapterContext): RawItem[] {
    const $ = cheerio.load(body);
    // CivicPlus duplicates link text inside screen-reader-only spans; leaving
    // them in doubles every title and breaks the date heuristics below.
    $('.visuallyHidden, .hidden, .sr-only, .screenReaderOnly').remove();

    const items: RawItem[] = [];
    const seen = new Set<string>();

    // The index page interleaves board headings with file links; per-board pages
    // just have links. Walking both in document order handles each the same way.
    const fromSource = ctx.source.body ?? null;
    let currentBoard: string | null = ctx.source.options?.['isIndex'] ? null : fromSource;

    $('h1, h2, h3, h4, a[href]').each((_, element) => {
      const tag = element.tagName?.toLowerCase() ?? '';

      if (tag !== 'a') {
        const text = clean($(element).text());
        // Row headings are meeting dates ("September 9, 2025"), not board names.
        if (!text || text.length > 80 || HEADING_NOISE.test(text) || parseLooseDate(text)) return;
        currentBoard = text.replace(/\s*archives?$/i, '');
        return;
      }

      const href = $(element).attr('href') ?? '';
      const match = VIEW_FILE_RE.exec(href);
      if (!match) return;

      const [, kindRaw, stamp, fileId] = match;
      const kind = kindRaw!.toLowerCase();
      const key = `${kind}-${fileId}`;
      if (seen.has(key)) return;
      seen.add(key);

      const occurred = parseCivicPlusStamp(stamp!);
      const board = currentBoard ?? fromSource ?? ctx.source.agency;
      const label = kind === 'minutes' ? 'Minutes' : 'Agenda';
      const linkText = clean($(element).text());
      // Row text carries the useful extras — "Amended", hearing subjects, addresses.
      const context = clean($(element).closest('tr, li, div.catAgendaRow, div').first().text()).slice(0, 400);

      const dateLabel = occurred
        ? new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          }).format(new Date(occurred))
        : linkText || 'undated';

      // "Posted Aug 21, 2026 12:20 PM" is the notice date, which is a different
      // and independently meaningful fact from the meeting date — under the Open
      // Meeting Law it is what makes the notice timely.
      const postedMatch = /Posted\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})/i.exec(context);
      const posted = postedMatch ? parseLooseDate(postedMatch[1]!) : null;

      const summary = cleanRowText(context, linkText, board);
      const subjects = extractSubjects(`${summary} ${linkText}`);

      items.push({
        externalId: `agenda-center:${kind}:${fileId}`,
        title: `${board} — ${label}, ${dateLabel}`,
        url: ctx.resolve(href),
        documentUrl: ctx.resolve(href),
        eventType: TYPE_MAP[kind] ?? 'document_posted',
        ...(occurred ? { occurredAt: new Date(occurred) } : {}),
        ...(posted ? { publishedAt: new Date(posted) } : {}),
        ...(subjects.length ? { subjects } : {}),
        ...(summary ? { summary } : {}),
        // An amended agenda is a real event in its own right — the town changed
        // what it said it would discuss, after posting the notice.
        extra: { board, fileId, kind, linkText, ...(/\bAmended\b/i.test(context) ? { amended: true } : {}) },
      });
    });

    return items;
  },
};

/**
 * Strip a listing row down to whatever it says beyond the boilerplate.
 *
 * On the live site a row is usually nothing but a date, a posted stamp and
 * "Download ▼ Agenda" — the subject matter lives inside the PDF. Returning an
 * empty string for those keeps the feed from being wall-to-wall chrome, and
 * leaves real text (which some boards do include) intact.
 */
function cleanRowText(context: string, linkText: string, board: string): string {
  const result = clean(
    context
      // Longest, most specific strings first, or their fragments survive.
      .replaceAll(linkText, ' ')
      .replace(/Posted\s+[A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4}(\s+\d{1,2}:\d{2}\s*[AP]M)?/gi, ' ')
      .replace(/Download\s*[▼▾]?\s*(Agenda|Minutes|Packet)?/gi, ' ')
      .replace(/Previous\s+Versions?/gi, ' ')
      .replace(/\b(Agenda|Minutes|Packet)\s*\(PDF\)/gi, ' ')
      .replace(/^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4}\s*[—–-]?\s*/, ' ')
      .replace(/^[\s—–\-·|]+|[\s—–\-·|]+$/g, ''),
  );

  // What is left is often just the board's own name repeated, or a stray label.
  if (result.toLowerCase() === board.toLowerCase()) return '';
  return result.length >= 12 ? result : '';
}

/**
 * The slug CivicPlus builds a category URL from.
 *
 * `/AgendaCenter/Board-of-Health-4` is the category name with spaces hyphenated
 * and punctuation dropped. Deriving it is what lets the collapse layout below —
 * which prints the name and the id but never the URL — still produce a source a
 * town file can use. `verify` is what confirms the guess against the live site.
 */
export function categorySlug(name: string): string {
  return clean(name)
    .replace(/&/g, ' ')
    .replace(/[^A-Za-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
}

/**
 * Read the Agenda Center index for the categories it publishes.
 *
 * Category ids are assigned per site and are not guessable, so this is how the
 * registry learns about boards nobody hard-coded. Two layouts, because two of
 * these towns' installs are themed differently and both are current CivicPlus:
 *
 *   1. Milton links each board — `<a href="/AgendaCenter/Select-Board-6">`.
 *   2. Weymouth renders each board as a collapsible panel whose id carries the
 *      category id — `<div class="listing" id="cat4"><h2>Board of Health</h2>` —
 *      and never links the category at all.
 *
 * Reading both matters more than it looks: on layout 2 the old parser found
 * zero categories and `discover` reported a town with no boards, which is
 * indistinguishable from a town that publishes nothing.
 */
export function extractAgendaCategories(body: string): { slug: string; cid: number; body: string }[] {
  const $ = cheerio.load(body);
  const byCid = new Map<number, { slug: string; cid: number; body: string }>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') ?? '';
    const match = /\/AgendaCenter\/([A-Za-z0-9-]+?)-(\d+)(?:[/?#]|$)/.exec(href);
    if (!match) return;
    const slug = match[1]!;
    const cid = Number(match[2]);
    if (slug.toLowerCase() === 'viewfile' || slug.toLowerCase() === 'previousversions') return;

    const text = clean($(element).text());
    const name = text && text.length <= 80 ? text : slug.replace(/-/g, ' ');
    if (!byCid.has(cid)) byCid.set(cid, { slug, cid, body: name });
  });

  // Layout 2. Only fills gaps: where a category is linked, the site's own slug
  // is the truth and beats anything derived from the heading.
  $('[id^="cat"]').each((_, element) => {
    const id = $(element).attr('id') ?? '';
    const match = /^cat(\d+)$/.exec(id);
    if (!match) return;
    const cid = Number(match[1]);
    if (byCid.has(cid)) return;

    const name = clean($(element).find('h1, h2, h3, h4').first().text());
    if (!name || name.length > 100) return;
    byCid.set(cid, { slug: categorySlug(name), cid, body: name });
  });

  return [...byCid.values()].sort((a, b) => a.cid - b.cid);
}
