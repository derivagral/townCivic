import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseWithSource } from '../src/adapters/index.ts';
import { extractAgendaCategories } from '../src/adapters/civicplus-agenda-center.ts';
import { extractRssFeeds, categoriesFromFeeds } from '../src/commands/discover.ts';
import { sourceSchema } from '../src/types.ts';
import type { SourceInput } from '../src/types.ts';
import { ROOT } from '../src/config.ts';

const FIXTURES = path.join(ROOT, 'fixtures', 'milton-ma');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function source(overrides: Partial<SourceInput> & Pick<SourceInput, 'adapter' | 'url'>) {
  return sourceSchema.parse({
    id: 'test:source',
    jurisdiction: 'milton-ma',
    label: 'Test source',
    level: 'municipal',
    agency: 'Town of Milton',
    channel: 'meetings',
    tier: 1,
    ...overrides,
  });
}

describe('civicplus-agenda-center', () => {
  const boardSource = source({
    adapter: 'civicplus-agenda-center',
    url: 'https://www.miltonma.gov/AgendaCenter/Planning-Board-39',
    body: 'Planning Board',
    channel: 'land-use',
  });

  it('reads the meeting date and record type out of the href', () => {
    const items = parseWithSource(boardSource, read('planning-board-39.html'));
    const august = items.find((i) => i.externalId === 'agenda-center:agenda:7431');

    expect(august).toBeDefined();
    expect(august!.eventType).toBe('meeting_agenda');
    // _08262026-7431 → August 26, 2026, read from the URL, not the page text.
    expect(august!.occurredAt?.toISOString().slice(0, 10)).toBe('2026-08-26');
    expect(august!.url).toBe('https://www.miltonma.gov/AgendaCenter/ViewFile/Agenda/_08262026-7431');
  });

  it('distinguishes minutes from agendas', () => {
    const items = parseWithSource(boardSource, read('planning-board-39.html'));
    const minutes = items.filter((i) => i.eventType === 'meeting_minutes');
    expect(minutes.length).toBeGreaterThan(0);
    expect(minutes.every((i) => i.externalId?.includes(':minutes:'))).toBe(true);
  });

  it('attributes each file to its board on the site-wide index', () => {
    const items = parseWithSource(
      source({
        adapter: 'civicplus-agenda-center',
        url: 'https://www.miltonma.gov/AgendaCenter',
        options: { isIndex: true },
      }),
      read('agenda-center-index.html'),
    );

    const boards = new Set(items.map((i) => i.extra?.['board']));
    expect(boards).toContain('Board of Appeals');
    expect(boards).toContain('Conservation Commission');
    expect(boards).toContain('Warrant Committee');
    // A row heading is a meeting date, and must never be mistaken for a board.
    expect([...boards].some((b) => /\d{4}/.test(String(b)))).toBe(false);
  });

  it('pulls addresses and article numbers out of row text', () => {
    const items = parseWithSource(boardSource, read('planning-board-39.html'));
    const subjects = items.flatMap((i) => i.subjects ?? []);
    expect(subjects).toContain('14 Adams Street');
    expect(subjects).toContain('271 Pleasant Street');
  });

  it('does not emit the same file twice', () => {
    const items = parseWithSource(boardSource, read('planning-board-39.html'));
    const ids = items.map((i) => i.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds category ids on the index', () => {
    const categories = extractAgendaCategories(read('agenda-center-index.html'));
    expect(categories).toContainEqual({ slug: 'Select-Board', cid: 6, body: 'Select Board' });
    expect(categories).toContainEqual({ slug: 'Planning-Board', cid: 39, body: 'Planning Board' });
    // ViewFile and PreviousVersions look like categories but are not.
    expect(categories.some((c) => /viewfile|previousversions/i.test(c.slug))).toBe(false);
  });
});

describe('civicplus-bids', () => {
  const bidsSource = source({
    adapter: 'civicplus-bids',
    url: 'https://www.miltonma.gov/bids.aspx',
    channel: 'money',
    body: 'Procurement Department',
  });

  it('takes the title from the title link, not the "Read on" duplicate', () => {
    const items = parseWithSource(bidsSource, read('bids.html'));
    expect(items.every((i) => !/read\s*on/i.test(i.title))).toBe(true);
    expect(items.map((i) => i.title)).toContain('IFB — Central Avenue Roadway Resurfacing');
  });

  it('reads status and closing date from the paired status columns', () => {
    const items = parseWithSource(bidsSource, read('bids.html'));
    const resurfacing = items.find((i) => i.externalId === 'bid:211');

    expect(resurfacing?.extra?.['status']).toBe('open');
    expect(resurfacing?.occurredAt?.toISOString().slice(0, 10)).toBe('2026-09-04');
    expect(resurfacing?.documentUrl).toContain('/DocumentCenter/View/11388/');
  });

  it('emits one item per bid even though each row links twice', () => {
    const items = parseWithSource(bidsSource, read('bids.html'));
    expect(items).toHaveLength(4);
    expect(new Set(items.map((i) => i.externalId)).size).toBe(4);
  });
});

describe('rss', () => {
  const rssSource = source({
    adapter: 'rss',
    url: 'https://www.miltonma.gov/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml',
  });

  it('parses titles, links and dates', () => {
    const items = parseWithSource(rssSource, read('newsflash.xml'));
    expect(items).toHaveLength(4);
    expect(items[0]!.title).toContain('Blue Hill Avenue');
    expect(items[0]!.publishedAt?.toISOString().slice(0, 10)).toBe('2026-08-19');
  });

  it('strips HTML out of descriptions', () => {
    const items = parseWithSource(rssSource, read('newsflash.xml'));
    expect(items.every((i) => !i.summary?.includes('<'))).toBe(true);
  });

  it('prefers the link over a guid that merely extends it', () => {
    // CivicPlus emits "<link>/<ticks>", which changes on every edit.
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><item>
      <title>Notice</title>
      <link>https://www.miltonma.gov/CivicAlerts.aspx?aid=262</link>
      <guid isPermaLink="false">https://www.miltonma.gov/CivicAlerts.aspx?aid=262/639225777360000000</guid>
    </item></channel></rss>`;

    const items = parseWithSource(rssSource, feed);
    expect(items[0]!.externalId).toBe('https://www.miltonma.gov/CivicAlerts.aspx?aid=262');
  });

  it('keeps a guid that is genuinely its own identifier', () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><item>
      <title>Notice</title><link>https://example.gov/a</link><guid>urn:uuid:abc-123</guid>
    </item></channel></rss>`;
    expect(parseWithSource(rssSource, feed)[0]!.externalId).toBe('urn:uuid:abc-123');
  });

  it('survives a feed with no items', () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
    expect(parseWithSource(rssSource, feed)).toEqual([]);
  });
});

describe('rss.aspx discovery', () => {
  // Mirrors the real page: module headings, then that module's feeds.
  const page = `<html><body>
    <div class="sidebar"><h2>Available Feeds:</h2><ol><li><a href="#agendaCenter">Agenda Center</a></li></ol></div>
    <div class="listing pages"><h2><a name="pages">Pages</a></h2>
      <span><a href="/RSSFeed.aspx?ModID=76&CID=All-0">All</a></span></div>
    <div class="listing agendaCenter"><h2><a name="agendaCenter">Agenda Center</a></h2>
      <span><a href="/RSSFeed.aspx?ModID=65&CID=All-0">All</a></span>
      <span><a href="/RSSFeed.aspx?ModID=65&CID=Select-Board-6">Select Board</a></span>
      <span><a href="/RSSFeed.aspx?ModID=65&CID=Planning-Board-39">Planning Board</a></span></div>
    <div class="listing newsFlash"><h2><a name="newsFlash">News Flash</a></h2>
      <span><a href="/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml">All</a></span></div>
  </body></html>`;

  it('attributes every feed to the module heading above it', () => {
    const feeds = extractRssFeeds(page, 'https://www.miltonma.gov');
    const modules = new Map(feeds.map((f) => [f.url.split('CID=')[1], f.module]));

    expect(modules.get('Select-Board-6')).toBe('Agenda Center');
    expect(modules.get('All-newsflash.xml')).toBe('News Flash');
    // The sidebar's table of contents must not become a module.
    expect(feeds.every((f) => f.module !== 'Available Feeds:')).toBe(true);
  });

  it('recovers agenda category ids from the feed list alone', () => {
    const categories = categoriesFromFeeds(extractRssFeeds(page, 'https://www.miltonma.gov'));
    expect(categories).toContainEqual({ slug: 'Select-Board', cid: 6, body: 'Select Board' });
    expect(categories).toContainEqual({ slug: 'Planning-Board', cid: 39, body: 'Planning Board' });
    // "All-0" is not a board.
    expect(categories.some((c) => c.slug === 'All')).toBe(false);
  });
});
