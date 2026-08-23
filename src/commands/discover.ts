import * as cheerio from 'cheerio';
import { fetchSource } from '../fetch/http.ts';
import { extractAgendaCategories } from '../adapters/index.ts';
import { classifyBody, MILTON_BASE, JURISDICTION } from '../registry/milton-ma.ts';
import { loadSources } from '../registry/index.ts';
import { clean } from '../util/text.ts';

export interface DiscoveredCategory {
  slug: string;
  cid: number;
  body: string;
  channel: string;
  priority: string;
  /** True when the registry already has a source for this category. */
  known: boolean;
}

export interface DiscoveredFeed {
  /** The CivicPlus module the feed belongs to — "Agenda Center", "News Flash". */
  module: string;
  /** The feed's own category — a board name, or "All". */
  label: string;
  url: string;
  modId: string | null;
  cid: string | null;
}

export interface DiscoverReport {
  base: string;
  categories: DiscoveredCategory[];
  feeds: DiscoveredFeed[];
  errors: string[];
}

/**
 * Read `/rss.aspx`, which lists every feed the CivicPlus install actually
 * publishes along with its module id. This is the honest alternative to
 * hard-coding `ModID=76` and hoping.
 */
/**
 * The page groups feeds under a module heading:
 *
 *   <div class="listing listingIcon agendaCenter">
 *     <h2><a name="agendaCenter">Agenda Center</a></h2>
 *     <span><a href="/RSSFeed.aspx?ModID=65&CID=Select-Board-6">Select Board</a></span>
 *
 * Walking headings and links in document order attributes each feed to the
 * module above it, which is what turns a bare `ModID=65` into "Agenda Center".
 */
export function extractRssFeeds(body: string, baseUrl: string): DiscoveredFeed[] {
  const $ = cheerio.load(body);
  const byUrl = new Map<string, DiscoveredFeed>();
  let currentModule = 'unknown';

  $('h1, h2, h3, a[href]').each((_, element) => {
    const tag = element.tagName?.toLowerCase() ?? '';

    if (tag !== 'a') {
      const text = clean($(element).text());
      // "Available Feeds:" heads the sidebar table of contents, not a module.
      if (text && text.length <= 60 && !/available feeds|rss feeds/i.test(text)) currentModule = text;
      return;
    }

    const href = $(element).attr('href') ?? '';
    if (!/RSSFeed\.aspx/i.test(href)) return;

    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (byUrl.has(url)) return;

    const params = new URL(url).searchParams;
    const text = clean($(element).text());
    const label =
      text && !/^(rss|subscribe|feed)$/i.test(text)
        ? text
        : clean($(element).closest('li, tr, div, p').first().text()).slice(0, 80) || 'unlabeled feed';

    byUrl.set(url, {
      module: currentModule,
      label,
      url,
      modId: params.get('ModID') ?? params.get('modid'),
      cid: params.get('CID') ?? params.get('cid'),
    });
  });

  return [...byUrl.values()];
}

/**
 * Agenda Center feeds carry `CID=<Board-Slug>-<id>`, and that id is the same one
 * the `/AgendaCenter/<Board-Slug>-<id>` listing uses. So the RSS index doubles
 * as a complete category listing — handy when the Agenda Center page itself is
 * slow, huge, or briefly refusing requests.
 */
export function categoriesFromFeeds(feeds: DiscoveredFeed[]): { slug: string; cid: number; body: string }[] {
  const byCid = new Map<number, { slug: string; cid: number; body: string }>();
  for (const feed of feeds) {
    if (!/agenda/i.test(feed.module)) continue;
    const match = /^(.+)-(\d+)$/.exec(feed.cid ?? '');
    if (!match) continue;
    const slug = match[1]!;
    const cid = Number(match[2]);
    // Every module also publishes a combined `CID=All-0` feed; that is not a board.
    if (slug.toLowerCase() === 'all' || cid === 0) continue;
    if (!byCid.has(cid)) byCid.set(cid, { slug, cid, body: feed.label });
  }
  return [...byCid.values()].sort((a, b) => a.cid - b.cid);
}

export interface DiscoverOptions {
  base?: string;
  jurisdiction?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Probe a CivicPlus site for the ids the registry cannot guess.
 *
 * Writes nothing. It prints what it found so a human decides what enters the
 * registry — the registry stays a reviewed artifact, not a crawl output.
 */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoverReport> {
  const base = options.base ?? MILTON_BASE;
  const jurisdiction = options.jurisdiction ?? JURISDICTION;
  const known = new Set(
    loadSources(jurisdiction)
      .map((s) => (typeof s.options['cid'] === 'number' ? (s.options['cid'] as number) : null))
      .filter((cid): cid is number => cid !== null),
  );

  const report: DiscoverReport = { base, categories: [], feeds: [], errors: [] };
  const fetchOpts = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};

  const rssResponse = await fetchSource('discover:rss', `${base}/rss.aspx`, fetchOpts);
  if (rssResponse.ok) {
    report.feeds = extractRssFeeds(rssResponse.body, base);
  } else {
    report.errors.push(`/rss.aspx: ${rssResponse.error ?? `HTTP ${rssResponse.status}`}`);
  }

  const agendaResponse = await fetchSource('discover:agenda-center', `${base}/AgendaCenter`, fetchOpts);
  if (!agendaResponse.ok) {
    report.errors.push(`/AgendaCenter: ${agendaResponse.error ?? `HTTP ${agendaResponse.status}`}`);
  }

  // Two independent views of the same list; either alone is enough.
  const merged = new Map<number, { slug: string; cid: number; body: string }>();
  for (const category of categoriesFromFeeds(report.feeds)) merged.set(category.cid, category);
  if (agendaResponse.ok) {
    for (const category of extractAgendaCategories(agendaResponse.body)) merged.set(category.cid, category);
  }

  report.categories = [...merged.values()]
    .sort((a, b) => a.body.localeCompare(b.body))
    .map((category) => {
      const { channel, priority } = classifyBody(category.body);
      return { ...category, channel, priority, known: known.has(category.cid) };
    });

  return report;
}

/** Render newly found categories as registry entries a human can paste in. */
export function toRegistrySnippet(categories: DiscoveredCategory[]): string {
  const fresh = categories.filter((c) => !c.known);
  if (!fresh.length) return '// nothing new — every discovered category is already registered';
  const lines = fresh.map(
    (c) => `  { slug: '${c.slug}', cid: ${c.cid}, body: ${JSON.stringify(c.body)} }, // → ${c.channel}`,
  );
  return `// add to CONFIRMED_AGENDA_CATEGORIES in src/registry/milton-ma.ts\n${lines.join('\n')}`;
}
