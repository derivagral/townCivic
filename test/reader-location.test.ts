import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.ts';
import { createApp } from '../src/web/server.ts';
import {
  createSqliteAccounts,
  createSupabaseAccounts,
  SESSION_COOKIE,
  AccountsUnavailableError,
} from '../src/accounts/index.ts';
import { fakeSupabase } from './helpers/fake-supabase.ts';

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const password = 'a-long-test-password';

async function setup(hosted: boolean) {
  const db = openDb(':memory:');
  databases.push(db);
  const accounts = hosted
    ? createSupabaseAccounts({
        url: 'https://project.supabase.test',
        anonKey: 'test',
        sessionSecret: 'test',
        fetchImpl: fakeSupabase().fetch,
      })
    : createSqliteAccounts(db);
  const app = createApp(db, { accounts, jurisdictions: ['milton-ma', 'hull-ma'], accessLog: false });
  const signed = await accounts.signUp({ email: 'reader@example.test', password });
  if (!signed.ok || !signed.session) throw new Error('No session');
  const session = signed.session;
  const identity = (await accounts.resolve(session.value))!;
  const cookie = `${SESSION_COOKIE}=${session.value}`;
  const post = (fields: Record<string, string>, csrf = identity.csrfToken) =>
    app.request('/my/location', {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, ...fields }),
    });
  const read = async () => (await accounts.resolve(session.value))!.reader.location;
  return { db, app, accounts, cookie, identity, post, read };
}

describe.each([false, true])('street preference (hosted=%s)', (hosted) => {
  it('prompts after signup/login, persists decline across sessions, and can later save or clear a street', async () => {
    const { app, accounts, cookie, post, read } = await setup(hosted);
    const home = await app.request('/', { headers: { cookie } });
    expect(home.headers.get('cache-control')).toBe('private, no-store');
    expect(await home.text()).toContain('Add your street?');
    expect(await read()).toMatchObject({ status: 'unset', street: null, jurisdiction: null });
    expect(
      (
        await post({
          status: 'declined',
          street: 'Discard me',
          jurisdiction: 'hull-ma',
          next: '/meetings?q=budget',
        })
      ).headers.get('location'),
    ).toBe('/meetings?q=budget');
    expect(await read()).toMatchObject({ status: 'declined', street: null, jurisdiction: null });
    const fresh = (await accounts.signIn('reader@example.test', password))!;
    const noPrompt = await app.request('/meetings', {
      headers: { cookie: `${SESSION_COOKIE}=${fresh.value}` },
    });
    expect(await noPrompt.text()).not.toContain('Add your street?');
    await post({ status: 'provided', jurisdiction: 'milton-ma', street: '  Adams   Street  ' });
    expect(await read()).toMatchObject({
      status: 'provided',
      jurisdiction: 'milton-ma',
      street: 'Adams Street',
      updatedAt: expect.any(String),
    });
    await app.request('/?town=hull-ma', { headers: { cookie } });
    expect((await read()).jurisdiction).toBe('milton-ma');
    expect(await (await app.request('/my', { headers: { cookie } })).text()).toContain(
      'value="Adams Street"',
    );
    await post({ status: 'unset' });
    expect(await read()).toMatchObject({ status: 'unset', street: null, jurisdiction: null });
    expect(await (await app.request('/', { headers: { cookie } })).text()).toContain('Add your street?');
  });

  it('rejects missing authentication, wrong CSRF, invalid choices and blank streets without changing a saved value', async () => {
    const { app, post, read } = await setup(hosted);
    expect(
      (
        await app.request('/my/location', {
          method: 'POST',
          body: new URLSearchParams({ status: 'declined' }),
        })
      ).status,
    ).toBe(303);
    await post({ status: 'provided', jurisdiction: 'milton-ma', street: 'Adams Street' });
    expect((await post({ status: 'declined' }, 'bad')).status).toBe(403);
    for (const values of [
      { status: 'provided', jurisdiction: 'elsewhere', street: 'Main' },
      { status: 'provided', jurisdiction: 'milton-ma', street: '   ' },
      { status: 'provided', jurisdiction: 'milton-ma', street: 'x'.repeat(161) },
      { status: 'invented', jurisdiction: '', street: '' },
    ])
      expect((await post(values)).status).toBe(400);
    expect((await read()).street).toBe('Adams Street');
  });

  it('keeps profile data out of personal feeds and other readers, and escapes street text', async () => {
    const { accounts, app, post, read, cookie, identity } = await setup(hosted);
    await post({ status: 'provided', jurisdiction: 'milton-ma', street: '<script>private street</script>' });
    const profile = await (await app.request('/my', { headers: { cookie } })).text();
    expect(profile).toContain('&lt;script&gt;private street&lt;/script&gt;');
    expect(profile).not.toContain('<script>private street');
    const other = await accounts.signUp({ email: 'other@example.test', password });
    if (!other.ok || !other.session) throw new Error('No session');
    const otherIdentity = (await accounts.resolve(other.session.value))!;
    expect(otherIdentity.reader.location.status).toBe('unset');
    await accounts.updateLocation(otherIdentity, { status: 'declined' });
    expect((await read()).status).toBe('provided');
    expect(JSON.stringify(await accounts.feedFor(identity.reader.feedToken))).not.toContain('private street');
    expect(await (await app.request('/')).text()).not.toContain('private street');
  });

  it('does not claim a failed save succeeded and rejects external redirect destinations', async () => {
    const { accounts, post, read } = await setup(hosted);
    const result = await post({ status: 'declined', next: '/\\evil.test' });
    expect(result.headers.get('location')).toBe('/my?saved=1#location');
    accounts.updateLocation = async () => {
      throw new AccountsUnavailableError('unavailable');
    };
    const failed = await post({ status: 'provided', jurisdiction: 'milton-ma', street: 'Main Street' });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain('could not be saved');
    expect((await read()).status).toBe('declined');
  });
});

it('upgrades existing SQLite readers without changing their identity or follows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'towncivic-location-'));
  const file = join(dir, 'legacy.db');
  try {
    let db = openDb(file);
    const store = createSqliteAccounts(db);
    const signup = await store.signUp({ email: 'old@example.test', password });
    if (!signup.ok || !signup.session) throw new Error('No session');
    const before = (await store.resolve(signup.session.value))!;
    await store.addSubscription(before, { kind: 'search', value: 'schools', label: 'Schools' });
    for (const col of ['street_status', 'home_jurisdiction', 'street', 'location_updated_at'])
      db.exec(`ALTER TABLE users DROP COLUMN ${col}`);
    db.close();
    db = openDb(file);
    const after = createSqliteAccounts(db);
    const restored = (await after.resolve(signup.session.value))!;
    expect(restored.reader.id).toBe(before.reader.id);
    expect(restored.reader.feedToken).toBe(before.reader.feedToken);
    expect(restored.reader.location.status).toBe('unset');
    expect(await after.listSubscriptions(restored)).toHaveLength(1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
