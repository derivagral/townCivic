import { XMLParser } from 'fast-xml-parser';
import type { Adapter, AdapterContext, RawItem } from '../types.ts';
import { parseFeedDate } from '../util/dates.ts';
import { clean, stripHtml, truncate } from '../util/text.ts';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Keep single-item feeds from collapsing into an object.
  isArray: (name) => ['item', 'entry'].includes(name),
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Node text may be a string, a number, or `{ '#text': ... }` depending on attributes. */
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return clean(node);
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return clean(String((node as Record<string, unknown>)['#text'] ?? ''));
  }
  return '';
}

/** Atom links are attribute-bearing and may repeat; prefer rel="alternate". */
function atomLink(node: unknown): string {
  const links = asArray(node as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const alternate = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return clean(String(alternate?.['@_href'] ?? ''));
}

export const rssAdapter: Adapter = {
  name: 'rss',
  parse(body: string, ctx: AdapterContext): RawItem[] {
    const doc = parser.parse(body) as Record<string, any>;
    const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'];
    const feed = doc?.feed;

    const nodes: Record<string, any>[] = channel
      ? asArray(channel.item ?? doc?.['rdf:RDF']?.item)
      : feed
        ? asArray(feed.entry)
        : [];

    const items: RawItem[] = [];
    for (const node of nodes) {
      const title = textOf(node.title);
      const link = clean(textOf(node.link)) || atomLink(node.link);
      const url = link ? ctx.resolve(link) : ctx.source.url;
      if (!title && !link) continue;

      const rawSummary =
        textOf(node.description) ||
        textOf(node.summary) ||
        textOf(node.content) ||
        textOf(node['content:encoded']);
      const summary = truncate(stripHtml(rawSummary));

      const published =
        parseFeedDate(textOf(node.pubDate)) ??
        parseFeedDate(textOf(node.published)) ??
        parseFeedDate(textOf(node.updated)) ??
        parseFeedDate(textOf(node['dc:date']));

      // CivicPlus emits guids like "<link>/<ticks>", which change every time an
      // item is touched. Treating that as identity would file each edit as a new
      // record, so the link wins whenever the guid is just the link plus a suffix.
      const guid = textOf(node.guid) || textOf(node.id);
      const stableId = guid && link && guid.startsWith(link) ? link : guid || link;

      const item: RawItem = {
        title: title || url,
        url,
        ...(summary ? { summary } : {}),
        ...(stableId ? { externalId: stableId } : {}),
        ...(published ? { publishedAt: new Date(published) } : {}),
        extra: { categories: asArray(node.category).map(textOf).filter(Boolean) },
      };
      items.push(item);
    }
    return items;
  },
};
