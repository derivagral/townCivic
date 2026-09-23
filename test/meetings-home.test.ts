import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { openDb, type Db } from '../src/db/index.ts';
import { createApp } from '../src/web/server.ts';
import { createSupabaseAccounts, SESSION_COOKIE } from '../src/accounts/index.ts';
import { fakeSupabase } from './helpers/fake-supabase.ts';

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  db.exec(`INSERT INTO sources (id,jurisdiction,label,adapter,url,level,agency,channel,priority,tier,confidence)
    VALUES ('src','milton-ma','Publisher','test','https://example.test','municipal','Town','meetings','high',1,'verified');`);
  app = createApp(db, { jurisdictions: ['milton-ma', 'hull-ma'], accessLog: false });
});
afterEach(() => db.close());
function event(id: string, type: string, town = 'milton-ma', date = '2026-01-01', body = 'Select Board') {
  const text = 'A discussion of the school budget and road safety. <unsafe>';
  const raw =
    type === 'meeting_transcript'
      ? JSON.stringify({
          transcript: {
            version: 1,
            origin: 'publisher-auto',
            videoId: 'dQw4w9WgXcQ',
            meetingDate: date,
            segments: [{ startSeconds: 0, endSeconds: 60, speakerLabel: 'Speaker 1', text }],
          },
        })
      : '{}';
  db.prepare(
    `INSERT INTO events (id,jurisdiction,source_id,level,agency,body,channel,event_type,priority,title,url,occurred_at,first_seen_at,last_seen_at,content_hash,doc_text,raw)
    VALUES (?,?,'src','municipal','Town',?,'schools',?,'high',?,'https://example.test',?,?,?, 'hash',?,?)`,
  ).run(
    id,
    town,
    body,
    type,
    `Record ${id}`,
    `${date}T12:00:00.000Z`,
    `${date}T12:00:00.000Z`,
    `${date}T12:00:00.000Z`,
    text,
    raw,
  );
}

describe('meeting-first browsing', () => {
  it('defaults to Milton transcripts, searches full text, and keeps the general feed available', async () => {
    event('transcript', 'meeting_transcript');
    event('minutes', 'meeting_minutes');
    event('bid', 'bid_posted');
    event('hull', 'meeting_transcript', 'hull-ma');
    const home = load(await (await app.request('/')).text());
    expect(home('article').text()).toContain('Record transcript');
    expect(home('article').text()).not.toMatch(/Record (minutes|bid|hull)/);
    expect(
      home('nav[aria-label="Explore"] a')
        .map((_, e) => home(e).text())
        .get(),
    ).toEqual(['Meetings', 'Timelines', 'General feed', 'Nearby', 'For me']);
    expect(home('aside')).toHaveLength(0);
    const results = load(await (await app.request('/meetings?q=budget')).text());
    expect(results('mark').text()).toBe('budget');
    expect(results('article script')).toHaveLength(0);
    const all = load(await (await app.request('/meetings?kind=all')).text());
    expect(all('article').text()).toContain('Record minutes');
    expect(all('article').text()).not.toContain('Record bid');
    const feed = load(await (await app.request('/activity')).text());
    expect(feed('article').text()).toContain('Record bid');
    expect(feed('details.filter-details').attr('open')).toBeUndefined();
    expect(feed('aside')).toHaveLength(0);
    expect((await app.request('/?q=budget')).status).toBe(200); // existing links
  });

  it('paginates in meeting-date order with the complete board list, and preserves filters', async () => {
    for (let i = 0; i < 63; i++)
      event(
        `t${String(i).padStart(2, '0')}`,
        'meeting_transcript',
        'milton-ma',
        i < 3 ? '2025-01-01' : '2026-01-01',
        `Board ${i}`,
      );
    const page = load(await (await app.request('/meetings?q=budget')).text());
    expect(page('article')).toHaveLength(60);
    expect(page('article').first().text()).toContain('Record t03');
    expect(page('select[name=body] option')).toHaveLength(64);
    const next = page('.pager a').attr('href')!;
    expect(next).toContain('q=budget');
    const last = load(await (await app.request(next)).text());
    expect(last('article')).toHaveLength(3);
    expect(last('.pager').text()).not.toContain('Next');
    const board = load(await (await app.request('/meetings?body=Board+0')).text());
    expect(board('article')).toHaveLength(1);
    expect(board('select[name=body] option')).toHaveLength(64);
  });

  it('handles towns without transcripts and supports upcoming events without labelling minutes as transcripts', async () => {
    event('future', 'meeting_notice', 'hull-ma', '2099-01-01');
    const empty = await (await app.request('/?town=hull-ma')).text();
    expect(empty).toContain('No transcripts have been collected for Hull');
    expect(empty).toContain('Explore Milton transcripts');
    const upcoming = load(await (await app.request('/meetings?town=hull-ma&kind=all&when=upcoming')).text());
    expect(upcoming('article').text()).toContain('Record future');
    expect(upcoming('article').text()).not.toContain('Read transcript');
    expect((await app.request('/start')).headers.get('location')).toContain('/meetings');
    expect(
      (await app.request('/start', { headers: { cookie: 'towncivic_start=activity' } })).headers.get(
        'location',
      ),
    ).toContain('/activity');
  });
});

it('keeps auth focused, carries the signup destination, and prompts after creating a local account', async () => {
  const form = load(await (await app.request('/login?next=%2Fmeetings%3Ftown%3Dhull-ma')).text());
  expect(form('nav[aria-label=Explore]')).toHaveLength(0);
  expect(form('a[href^="/signup"]').attr('href')).toContain('next=');
  const signed = await app.request('/signup', {
    method: 'POST',
    body: new URLSearchParams({
      email: 'new@example.test',
      password: 'long-test-password',
      next: '/meetings?town=hull-ma',
    }),
  });
  expect(signed.headers.get('location')).toBe('/meetings?town=hull-ma');
  const cookie = signed.headers.get('set-cookie')!.split(';')[0]!;
  expect(cookie).toContain(SESSION_COOKIE);
  expect(await (await app.request('/meetings?town=hull-ma', { headers: { cookie } })).text()).toContain(
    'Add your street?',
  );
});

it('reports confirmation success as 200 and does not show the local recovery warning on hosted accounts', async () => {
  const accounts = createSupabaseAccounts({
    url: 'https://project.supabase.test',
    anonKey: 'test',
    sessionSecret: 'test',
    fetchImpl: fakeSupabase({ confirmEmail: true }).fetch,
  });
  app = createApp(db, { accounts, accessLog: false });
  const response = await app.request('/signup', {
    method: 'POST',
    body: new URLSearchParams({
      email: 'new@example.test',
      password: 'long-test-password',
      next: '/meetings?q=budget',
    }),
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('Check your email');
  expect(html).not.toContain('Local accounts do not support password recovery');
  expect(load(html)('input[name=next]').val()).toBe('/meetings?q=budget');
});
