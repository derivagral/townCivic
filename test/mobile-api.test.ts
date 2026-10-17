import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EventPage,
  EventDetail,
  MatterSummary,
  MatterDetail,
  Page,
  LoginResponse,
  Following,
} from '../packages/api-contracts/src/index.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { createApp } from '../src/web/server.ts';
import { createAccounts, createSupabaseAccounts, SESSION_COOKIE } from '../src/accounts/index.ts';
import { fakeSupabase } from './helpers/fake-supabase.ts';

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  db.exec(`INSERT INTO sources (id,jurisdiction,label,adapter,url,level,agency,channel,priority,tier,confidence)
    VALUES ('src','milton-ma','Publisher','test','https://example.test','municipal','Town','meetings','high',1,'verified');`);
  app = createApp(db, { jurisdictions: ['milton-ma', 'hull-ma'], accessLog: false });
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});
function event(id: string, type = 'meeting_transcript', town = 'milton-ma') {
  const text = 'School budget and road safety. <unsafe>';
  const raw = JSON.stringify({
    internalNote: 'not a public contract',
    transcript: {
      version: 1,
      origin: 'publisher-auto',
      videoId: 'dQw4w9WgXcQ',
      meetingDate: '2026-01-01',
      segments: [{ startSeconds: 12, endSeconds: 60, speakerLabel: 'Speaker 1', text }],
    },
  });
  db.prepare(
    `INSERT INTO events (id,jurisdiction,source_id,level,agency,body,channel,event_type,priority,title,url,occurred_at,first_seen_at,last_seen_at,content_hash,doc_text,raw)
    VALUES (?,?,'src','municipal','Town','Select Board','schools',?,'high',?,'https://example.test','2026-01-01T12:00:00Z','2026-01-01','2026-01-01','hash',?,?)`,
  ).run(id, town, type, `Record ${id}`, text, raw);
}
function matter(id = 'matter', town = 'milton-ma') {
  db.prepare(
    `INSERT INTO matters (id,jurisdiction,kind,key,label,event_count,first_at,last_at,bodies,channels,status,updated_at)
    VALUES (?,?,'property',?,'14 Adams Street',2,'2026-01-01','2026-02-01','[]','[]','heard','2026-02-01')`,
  ).run(id, town, id);
}
async function json<T = EventPage>(path: string): Promise<T> {
  return (await (await app.request(`/api/v1${path}`)).json()) as T;
}

describe('mobile reader API', () => {
  it('shares transcript filters and evidence with HTML and limits payloads', async () => {
    event('transcript');
    event('minutes', 'meeting_minutes');
    event('bid', 'bid_posted');
    event('hull', 'meeting_transcript', 'hull-ma');
    const results = await json('/events?q=budget');
    expect(results.items.map((r: { id: string }) => r.id)).toEqual(['transcript']);
    expect(results.items[0]!.excerpt).toContain('budget');
    expect(results.items[0]!.matchingPassage).toBe(true);
    expect(results.items[0]).not.toHaveProperty('raw');
    expect(results.items[0]).not.toHaveProperty('doc_text');
    expect(await (await app.request('/meetings?q=budget')).text()).toContain('Record transcript');
    expect((await json('/events?view=meetings')).items).toHaveLength(2);
    expect((await json('/events?view=activity')).items).toHaveLength(3);
    expect((await json('/events?town=hull-ma')).items[0]!.id).toBe('hull');
    const detail = await json<EventDetail>('/events/transcript');
    expect(detail.transcript!.segments[0]).toMatchObject({ startSeconds: 12, speakerLabel: 'Speaker 1' });
    expect(detail.transcript!.videoUrl).toContain('dQw4w9WgXcQ');
    expect(JSON.stringify(detail)).not.toContain('internalNote');
    expect((await json<EventDetail>('/events/minutes')).transcript).toBeNull();
    expect((await json('/events?when=upcoming')).items).toHaveLength(0);
  });
  it('paginates without repeating a page and rejects invalid inputs or unserved towns', async () => {
    for (let i = 0; i < 32; i++) event(`t${String(i).padStart(2, '0')}`);
    const first = await json('/events');
    const second = await json('/events?page=2');
    expect(first.items).toHaveLength(30);
    expect(first.nextPage).toBe(2);
    expect(second.items).toHaveLength(2);
    expect(second.nextPage).toBeNull();
    expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(32);
    for (const query of [
      'page=-1',
      'page=NaN',
      'page=1.5',
      'page=Infinity',
      'view=secret',
      'town=bogus',
      `q=${'x'.repeat(301)}`,
    ]) {
      expect((await app.request(`/api/v1/events?${query}`)).status).toBe(400);
    }
    event('unserved', 'meeting_transcript', 'weymouth-ma');
    expect((await app.request('/api/v1/events/unserved')).status).toBe(404);
    expect((await app.request('/api/v1/events/missing')).headers.get('content-type')).toContain(
      'application/json',
    );
  });
  it('links timelines back to the same event records, oldest first', async () => {
    event('first');
    event('second');
    matter();
    db.prepare(
      `INSERT INTO matter_events (matter_id,event_id,stage,evidence,linked_at) VALUES ('matter',?,'heard','Public hearing','2026-01-01')`,
    ).run('first');
    db.prepare(
      `INSERT INTO matter_events (matter_id,event_id,stage,evidence,linked_at) VALUES ('matter',?,'decided','Approved','2026-01-01')`,
    ).run('second');
    const list = await json<Page<MatterSummary>>('/matters?q=Adams');
    expect(list.items[0]!.label).toBe('14 Adams Street');
    const detail = await json<MatterDetail>('/matters/matter');
    expect(detail.events.map((r: { id: string }) => r.id)).toEqual(['first', 'second']);
    expect(detail.events[1]!.evidence).toBe('Approved');
    expect((await json<EventDetail>('/events/first')).matters[0]!.id).toBe('matter');
  });
});

describe.each(['sqlite', 'supabase'] as const)('mobile sessions: %s', (backend) => {
  it('isolates follows, ignores ambient cookies, rotates sessions, and revokes sign-out', async () => {
    const fake = fakeSupabase();
    const accounts =
      backend === 'sqlite'
        ? createAccounts(db)
        : createSupabaseAccounts({
            url: 'https://project.supabase.test',
            anonKey: 'anon-key',
            sessionSecret: 'test',
            fetchImpl: fake.fetch,
          });
    for (const email of ['one@example.test', 'two@example.test'])
      await accounts.signUp({ email, password: 'test-password-long' });
    app = createApp(db, { accounts, accessLog: false });
    matter();
    const login = async (email: string) =>
      app.request('/api/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-password-long' }),
      });
    const first = await login('one@example.test');
    expect(first.headers.get('cache-control')).toContain('no-store');
    expect(first.headers.get('set-cookie')).toBeNull();
    let { token } = (await first.json()) as LoginResponse;
    const other = ((await (await login('two@example.test')).json()) as LoginResponse).token;
    expect(
      (await app.request('/api/v1/session', { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).status,
    ).toBe(401);
    const call = (path: string, method = 'GET', credential = token) =>
      app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${credential}` } });
    expect((await call('/following/matter', 'PUT')).status).toBe(200);
    expect(((await (await call('/following')).json()) as Following).items).toHaveLength(1);
    expect(((await (await call('/following', 'GET', other)).json()) as Following).items).toHaveLength(0);
    expect((await call('/following/missing', 'PUT')).status).toBe(404);
    if (backend === 'supabase') {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 3700000);
      const renewed = await call('/session');
      expect(renewed.status).toBe(200);
      expect(renewed.headers.get('x-towncivic-session')).toBeTruthy();
      token = renewed.headers.get('x-towncivic-session')!;
    }
    const profile = await (await call('/session')).json();
    expect(profile).toEqual({ name: 'one', email: 'one@example.test' });
    expect((await call('/following/matter', 'DELETE')).status).toBe(200);
    expect(((await (await call('/following')).json()) as Following).items).toHaveLength(0);
    expect((await call('/session', 'DELETE')).status).toBe(200);
    expect((await call('/session')).status).toBe(401);
    expect(
      (
        await app.request('/api/v1/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{broken',
        })
      ).status,
    ).toBe(400);
  });
});
