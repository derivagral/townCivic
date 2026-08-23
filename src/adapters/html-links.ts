import * as cheerio from 'cheerio';
import type { Adapter, AdapterContext, RawItem } from '../types.ts';
import { parseLooseDate } from '../util/dates.ts';
import { clean, truncate } from '../util/text.ts';

/**
 * Generic link harvester for pages that publish documents without a feed.
 *
 * This is the "fetch page → notice a new PDF → emit an item" fallback, and it
 * covers a surprising amount of .gov publishing. Options:
 *
 *   selector     container to search within (default: whole document)
 *   linkPattern  case-insensitive regex an href must match (default: PDFs)
 *   maxItems     cap per fetch, to stop a nav-heavy page flooding the feed
 */
const DEFAULT_LINK_PATTERN = String.raw`\.pdf($|\?)`;

export const htmlLinksAdapter: Adapter = {
  name: 'html-links',
  parse(body: string, ctx: AdapterContext): RawItem[] {
    const options = ctx.source.options ?? {};
    const selector = typeof options['selector'] === 'string' ? options['selector'] : undefined;
    const pattern = new RegExp(
      typeof options['linkPattern'] === 'string' ? options['linkPattern'] : DEFAULT_LINK_PATTERN,
      'i',
    );
    const maxItems = typeof options['maxItems'] === 'number' ? options['maxItems'] : 100;

    const $ = cheerio.load(body);
    const scope = selector ? $(selector) : $.root();
    const items: RawItem[] = [];
    const seen = new Set<string>();

    scope.find('a[href]').each((_, element) => {
      if (items.length >= maxItems) return false;

      const href = $(element).attr('href') ?? '';
      if (!pattern.test(href)) return;

      const url = ctx.resolve(href);
      if (seen.has(url)) return;
      seen.add(url);

      const text = clean($(element).text());
      const context = clean($(element).closest('tr, li, p, div').first().text()).slice(0, 400);
      const dated = parseLooseDate(text) ?? parseLooseDate(context);

      items.push({
        externalId: url,
        title: text || decodeURIComponent(url.split('/').pop() ?? url),
        url,
        documentUrl: url,
        eventType: ctx.source.eventType ?? 'document_posted',
        ...(dated ? { publishedAt: new Date(dated) } : {}),
        ...(context && context !== text ? { summary: truncate(context) } : {}),
      });
      return;
    });

    return items;
  },
};
