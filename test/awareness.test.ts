import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.ts';
import { createApp } from '../src/web/server.ts';
import { createSqliteAccounts, createSupabaseAccounts, SESSION_COOKIE } from '../src/accounts/index.ts';
import { fakeSupabase } from './helpers/fake-supabase.ts';

async function setup(hosted: boolean) {
  const db = openDb(':memory:');
  db.exec(`INSERT INTO sources (id,jurisdiction,label,adapter,url,level,agency,channel,priority,tier,confidence)
    VALUES ('s','milton-ma','Town','test','https://example.test','municipal','Town','schools','high',1,'verified');
    INSERT INTO events (id,jurisdiction,source_id,level,agency,channel,event_type,priority,title,url,first_seen_at,last_seen_at,content_hash)
    VALUES ('e','milton-ma','s','municipal','Town','schools','meeting_minutes','high','School budget','https://example.test','2026-01-01','2026-01-01','h');`);
  const accounts = hosted
    ? createSupabaseAccounts({
        url: 'https://project.supabase.test',
        anonKey: 'test',
        sessionSecret: 'test-secret',
        fetchImpl: fakeSupabase().fetch,
      })
    : createSqliteAccounts(db);
  const app = createApp(db, { accounts, jurisdictions: ['milton-ma', 'hull-ma'] });
  const signup = await accounts.signUp({ email: 'tester@example.test', password: 'long-test-password' });
  if (!signup.ok || !signup.session) throw new Error('Missing session');
  const identity = (await accounts.resolve(signup.session.value))!;
  const cookie = `${SESSION_COOKIE}=${signup.session.value}`;
  const post = (path: string, values: Record<string, string>, csrf = identity.csrfToken) =>
    app.request(path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...values }),
    });
  return { db, accounts, app, identity, cookie, post };
}

describe.each([false, true])('awareness workflows (hosted=%s)', (hosted) => {
  it('previews publicly, saves one town, explains a match, and unfollows', async () => {
    const { db, app, post, cookie, accounts, identity } = await setup(hosted);
    try {
      const preview = await app.request('/interests?town=milton-ma&kind=channel&value=schools');
      expect(preview.status).toBe(200);
      expect(await preview.text()).toContain('School budget');
      expect(await accounts.listSubscriptions(identity)).toHaveLength(0);
      expect(
        (await post('/interests/follow?town=hull-ma', { kind: 'channel', value: 'schools' })).status,
      ).toBe(303);
      const hullOnly = await app.request('/for-me', { headers: { cookie } });
      expect(await hullOnly.text()).not.toContain('School budget');
      await post('/interests/follow?town=milton-ma', { kind: 'channel', value: 'schools' });
      const personal = await app.request('/for-me', { headers: { cookie } });
      expect(personal.headers.get('cache-control')).toBe('private, no-store');
      const html = await personal.text();
      expect(html).toContain('Following: Schools (milton-ma)');
      expect(html).toContain('School budget');
      await post('/interests/follow?town=milton-ma', { kind: 'channel', value: 'schools', remove: '1' });
      expect(await accounts.listSubscriptions(identity)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('rejects expired forms and invalid values before saving', async () => {
    const { db, post, accounts, identity } = await setup(hosted);
    try {
      expect((await post('/interests/follow', { kind: 'channel', value: 'schools' }, 'bad')).status).toBe(
        403,
      );
      expect((await post('/interests/follow', { kind: 'channel', value: 'made-up' })).status).toBe(400);
      expect(await accounts.listSubscriptions(identity)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('saves a browser starting view and preserves direct browsing', async () => {
    const { db, post, app } = await setup(hosted);
    try {
      const saved = await post('/interests/start', { view: 'nearby' });
      expect(saved.status).toBe(303);
      expect(saved.headers.get('set-cookie')).toContain('towncivic_start=nearby');
      const headers = { cookie: 'towncivic_start=nearby' };
      expect((await app.request('/start?town=hull-ma', { headers })).headers.get('location')).toBe(
        '/nearby?town=hull-ma',
      );
      expect((await app.request('/', { headers })).status).toBe(200);
      expect((await post('/interests/start', { view: 'https://evil.test' })).status).toBe(400);
    } finally {
      db.close();
    }
  });
});
