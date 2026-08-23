import * as cheerio from 'cheerio';
import type { Adapter, AdapterContext, RawItem } from '../types.ts';
import { parseLooseDate } from '../util/dates.ts';
import { clean, truncate } from '../util/text.ts';

/**
 * CivicPlus bid postings (`/bids.aspx`).
 *
 * The real markup, which this is written against:
 *
 *   div.listItemsRow.bid
 *     div.bidTitle    span > a[href="bids.aspx?bidID=42"]   the title
 *                     span > strong "Bid No."              the bid number
 *                     span                                  teaser text + a "Read on" link
 *     div.bidStatus   div > span "Status:" "Closes:"        labels
 *                     div > span "Open"   "9/3/2026 ..."    values, paired by position
 *
 * Status and closing date are split across two sibling columns and only line up
 * by index, so they are read positionally rather than by scraping row text.
 */
const BID_LINK_RE = /bids\.aspx\?bidid=(\d+)/i;
const BID_DOC_RE = /\/DocumentCenter\/View\/(\d+)\//i;

/** CivicPlus repeats the title inside "Read on" links for screen readers. */
const HIDDEN_SELECTOR = '.visuallyHidden, .hidden, .sr-only, .screenReaderOnly';

export const civicPlusBidsAdapter: Adapter = {
  name: 'civicplus-bids',
  parse(body: string, ctx: AdapterContext): RawItem[] {
    const $ = cheerio.load(body);
    $(HIDDEN_SELECTOR).remove();

    const byBid = new Map<string, RawItem>();

    const rows = $('div.listItemsRow, tr').toArray();
    // Fall back to scanning bare links if the listing markup is not recognized.
    const scopes = rows.length ? rows : $('a[href]').toArray();

    for (const element of scopes) {
      const row = $(element);
      const titleLink = row
        .find('a[href]')
        .filter((_, a) => BID_LINK_RE.test($(a).attr('href') ?? ''))
        .first();
      if (!titleLink.length) continue;

      const href = titleLink.attr('href') ?? '';
      const bidId = BID_LINK_RE.exec(href)?.[1];
      if (!bidId || byBid.has(bidId)) continue;

      const titleBlock = row.find('.bidTitle').first();
      const title = clean(titleLink.text());
      if (!title) continue;

      const { status, closes } = readStatusBlock($, row);

      const spans = titleBlock.length ? titleBlock.find('> span').toArray() : [];
      const bidNumber = spans
        .map((s) => clean($(s).text()))
        .find((t) => /^Bid No\./i.test(t))
        ?.replace(/^Bid No\.\s*/i, '');
      // The teaser is the last span; drop the trailing "[Read on]" affordance.
      const teaser = spans.length
        ? clean($(spans.at(-1)!).text())
            .replace(/\[?\s*Read\s*on\s*\]?\.*$/i, '')
            .replace(/\.\.\.$/, '…')
        : '';

      let documentUrl: string | undefined;
      row.find('a[href]').each((_, link) => {
        const docHref = $(link).attr('href') ?? '';
        if (BID_DOC_RE.test(docHref)) documentUrl ??= ctx.resolve(docHref);
      });

      const summaryParts = [
        teaser,
        bidNumber ? `Bid No. ${bidNumber}` : '',
        closes ? `Closes ${closes}` : '',
        status,
      ]
        .filter(Boolean)
        .join(' · ');

      const closesIso = closes ? parseLooseDate(closes) : null;

      byBid.set(bidId, {
        externalId: `bid:${bidId}`,
        title,
        url: ctx.resolve(href),
        ...(documentUrl ? { documentUrl } : {}),
        eventType: 'bid_posted',
        // A bid's meaningful date is when it closes — that is the deadline a
        // reader is deciding against.
        ...(closesIso ? { occurredAt: new Date(closesIso) } : {}),
        ...(summaryParts ? { summary: truncate(summaryParts) } : {}),
        extra: {
          bidId,
          ...(bidNumber ? { bidNumber } : {}),
          ...(status ? { status: status.toLowerCase() } : {}),
          ...(closes ? { closes } : {}),
        },
      });
    }

    return [...byBid.values()];
  },
};

/**
 * Read `.bidStatus`, where labels and values live in two sibling columns and
 * correspond only by position.
 */
function readStatusBlock(
  $: cheerio.CheerioAPI,
  row: ReturnType<cheerio.CheerioAPI>,
): { status?: string; closes?: string } {
  const block = row.find('.bidStatus').first();
  if (!block.length) return {};

  const columns = block.children().toArray();
  if (columns.length < 2) return {};

  const labels = $(columns[0]!)
    .find('span')
    .map((_, s) => clean($(s).text()))
    .toArray();
  const values = $(columns[1]!)
    .find('span')
    .map((_, s) => clean($(s).text()))
    .toArray();

  const out: { status?: string; closes?: string } = {};
  labels.forEach((label, index) => {
    const value = values[index];
    if (!value) return;
    if (/status/i.test(label)) out.status = value;
    else if (/clos/i.test(label)) out.closes = value;
  });
  return out;
}
