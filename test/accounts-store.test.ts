import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.ts';
import { createSqliteAccounts } from '../src/accounts/sqlite.ts';
import { createSupabaseAccounts } from '../src/accounts/supabase.ts';
import type { AccountStore, StartedSession } from '../src/accounts/store.ts';
import { fakeSupabase } from './helpers/fake-supabase.ts';

/**
 * One suite, both backends.
 *
 * A port with a single implementation is a guess about what the second one will
 * need. This is the file that stops it being one: every expectation below runs
 * against the local SQLite backend and against the Supabase backend, and the
 * Supabase one is driven through a fake that speaks the real GoTrue and
 * PostgREST wire protocol — token grants, `Authorization` bearers,
 * `?column=eq."value"` filters, `Prefer: resolution=merge-duplicates` upserts,
 * and the `feed_for_token` function.
 *
 * The fake is not Postgres and does not pretend to be: it cannot tell us the
 * row-level security policies in `supabase/migrations/` are right, which is why
 * it enforces "only your own rows" itself and why `accounts check` exists to
 * ask the real project. What it does catch is the layer this repo actually
 * wrote — a filter that loses everything after a comma, an upsert that inserts
 * a duplicate, a refresh that drops the new cookie — and every one of those is
 * invisible until someone has an endpoint.
 */

interface Backend {
  name: string;
  make(): AccountStore;
}

const BACKENDS: Backend[] = [
  {
    name: 'sqlite',
    make: () => createSqliteAccounts(openDb(':memory:')),
  },
  {
    name: 'supabase',
    make: () =>
      createSupabaseAccounts({
        url: 'https://project.supabase.test',
        anonKey: 'anon-key',
        sessionSecret: 'test-session-secret',
        fetchImpl: fakeSupabase().fetch,
      }),
  },
];

const PASSWORD = 'correct-horse-battery';

/** Sign up and resolve, which is what every test below starts from. */
async function reader(store: AccountStore, email = 'reader@example.com') {
  const result = await store.signUp({ email, password: PASSWORD, displayName: 'A Reader' });
  if (!result.ok || !result.session) throw new Error('sign-up did not produce a session');
  const identity = await store.resolve(result.session.value);
  if (!identity) throw new Error('the session it just issued did not resolve');
  return { identity, session: result.session };
}

describe.each(BACKENDS)('the accounts port: $name', ({ make }) => {
  it('signs a reader up, and back in', async () => {
    const store = make();
    const created = await store.signUp({ email: 'reader@example.com', password: PASSWORD });
    expect(created.ok).toBe(true);

    const session = await store.signIn('reader@example.com', PASSWORD);
    expect(session).not.toBeNull();
    expect((await store.resolve(session!.value))?.reader.email).toBe('reader@example.com');
  });

  it('rejects what would break, before it reaches the backend', async () => {
    const store = make();
    expect((await store.signUp({ email: 'not-an-email', password: PASSWORD })).ok).toBe(false);
    expect((await store.signUp({ email: 'reader@example.com', password: 'short' })).ok).toBe(false);
  });

  it('gives one answer for a wrong password and for no such account', async () => {
    const store = make();
    await store.signUp({ email: 'reader@example.com', password: PASSWORD });

    expect(await store.signIn('reader@example.com', 'not-the-password')).toBeNull();
    expect(await store.signIn('nobody@example.com', PASSWORD)).toBeNull();
  });

  it('refuses a cookie it did not issue', async () => {
    const store = make();
    await reader(store);

    expect(await store.resolve(undefined)).toBeNull();
    expect(await store.resolve('')).toBeNull();
    expect(await store.resolve('not-a-session')).toBeNull();
    // Shaped like a real envelope, signed by nobody.
    expect(
      await store.resolve(
        Buffer.from(JSON.stringify({ a: 'forged', r: 'forged', e: 1e10 })).toString('base64url'),
      ),
    ).toBeNull();
  });

  it('forgets a session on sign-out', async () => {
    const store = make();
    const { identity, session } = await reader(store);

    await store.signOut(identity);
    expect(await store.resolve(session.value)).toBeNull();
  });

  it('accepts this reader’s csrf token and nothing else', async () => {
    const store = make();
    const { identity } = await reader(store);
    const other = (await reader(store, 'other@example.com')).identity;

    expect(store.verifyCsrf(identity, identity.csrfToken)).toBe(true);
    expect(store.verifyCsrf(identity, other.csrfToken)).toBe(false);
    expect(store.verifyCsrf(identity, '')).toBe(false);
    expect(store.verifyCsrf(identity, undefined)).toBe(false);
    expect(store.verifyCsrf(null, identity.csrfToken)).toBe(false);
  });

  it('adds, lists and removes what a reader follows', async () => {
    const store = make();
    const { identity } = await reader(store);

    await store.addSubscription(identity, {
      kind: 'body',
      value: 'Planning Board',
      label: 'Planning Board',
      jurisdiction: 'milton-ma',
    });
    expect(await store.listSubscriptions(identity)).toEqual([
      {
        kind: 'body',
        value: 'Planning Board',
        label: 'Planning Board',
        jurisdiction: 'milton-ma',
        alerts: 'none',
      },
    ]);
    expect(await store.isWatching(identity, 'body', 'Planning Board', 'milton-ma')).toBe(true);

    await store.removeSubscription(identity, 'body', 'Planning Board', 'milton-ma');
    expect(await store.listSubscriptions(identity)).toEqual([]);
    expect(await store.isWatching(identity, 'body', 'Planning Board', 'milton-ma')).toBe(false);
  });

  it('does not duplicate a subscription added twice', async () => {
    const store = make();
    const { identity } = await reader(store);
    const input = {
      kind: 'body',
      value: 'Planning Board',
      label: 'Planning Board',
      jurisdiction: 'milton-ma',
    } as const;

    await store.addSubscription(identity, input);
    await store.addSubscription(identity, { ...input, label: 'The Planning Board' });

    const rows = await store.listSubscriptions(identity);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('The Planning Board');
  });

  it('keeps the same board in two towns as two subscriptions', async () => {
    const store = make();
    const { identity } = await reader(store);
    const board = { kind: 'body', value: 'Planning Board', label: 'Planning Board' } as const;

    await store.addSubscription(identity, { ...board, jurisdiction: 'milton-ma' });
    await store.addSubscription(identity, { ...board, jurisdiction: 'hull-ma' });

    expect(await store.listSubscriptions(identity)).toHaveLength(2);
    // Removing one town's leaves the other's, which is the whole reason the
    // column is part of the key.
    await store.removeSubscription(identity, 'body', 'Planning Board', 'milton-ma');
    expect((await store.listSubscriptions(identity)).map((s) => s.jurisdiction)).toEqual(['hull-ma']);
  });

  it('survives a search subscription full of punctuation', async () => {
    const store = make();
    const { identity } = await reader(store);
    // Commas separate a PostgREST list; `&` and `#` are query-string syntax.
    // All three are things a reader can type into a search box.
    const value = '"special permit", 39 (Frothingham) & #4';

    await store.addSubscription(identity, {
      kind: 'search',
      value,
      label: 'permits',
      jurisdiction: 'milton-ma',
    });
    expect((await store.listSubscriptions(identity))[0]!.value).toBe(value);
    expect(await store.isWatching(identity, 'search', value, 'milton-ma')).toBe(true);

    await store.removeSubscription(identity, 'search', value, 'milton-ma');
    expect(await store.listSubscriptions(identity)).toEqual([]);
  });

  it('keeps one reader’s list out of another’s', async () => {
    const store = make();
    const a = (await reader(store, 'a@example.com')).identity;
    const b = (await reader(store, 'b@example.com')).identity;

    await store.addSubscription(a, {
      kind: 'body',
      value: 'Planning Board',
      label: 'Planning Board',
      jurisdiction: 'milton-ma',
    });

    expect(await store.listSubscriptions(a)).toHaveLength(1);
    expect(await store.listSubscriptions(b)).toHaveLength(0);
    expect(await store.isWatching(b, 'body', 'Planning Board', 'milton-ma')).toBe(false);
  });

  it('trades a feed token for that reader’s list, and nothing for a wrong one', async () => {
    const store = make();
    const { identity } = await reader(store);
    await store.addSubscription(identity, {
      kind: 'body',
      value: 'Planning Board',
      label: 'Planning Board',
      jurisdiction: 'milton-ma',
    });

    const feed = await store.feedFor(identity.reader.feedToken);
    expect(feed?.name).toBe('A Reader');
    expect(feed?.subscriptions).toHaveLength(1);

    expect(await store.feedFor('not-anyone-s-token')).toBeNull();
  });

  it('tells an empty list apart from a token nobody holds', async () => {
    const store = make();
    const { identity } = await reader(store);

    // A reader who follows nothing has a feed; it is empty. That has to be a
    // 200 with no entries rather than the 404 an unknown token gets.
    expect(await store.feedFor(identity.reader.feedToken)).toEqual({ name: 'A Reader', subscriptions: [] });
  });

  it('rotates a feed token, and the old one stops working', async () => {
    const store = make();
    const { identity, session } = await reader(store);
    const before = identity.reader.feedToken;

    const after = await store.rotateFeedToken(identity);
    expect(after).not.toBe(before);
    expect(await store.feedFor(before)).toBeNull();
    expect(await store.feedFor(after)).not.toBeNull();

    // Rotating the feed token is not a sign-out, and it is not the password.
    expect(await store.resolve(session.value)).not.toBeNull();
  });

  it('reports what it can and cannot do', async () => {
    const store = make();
    const report = await store.check();
    expect(report.findings.length).toBeGreaterThan(0);
    expect(store.describe()).toContain(store.kind === 'sqlite' ? 'local' : 'supabase');
  });
});

/* --------------------------------------------------- the hosted backend only */

describe('the supabase backend', () => {
  /**
   * Run `fn` with the clock that far ahead.
   *
   * Both sides read `Date.now()`, so this is what actually expires an access
   * token: the store decides to refresh from the expiry in its own cookie, and
   * the fake decides to reject a stale bearer from the same clock. Only `Date`
   * is faked — timers stay real, so `AbortSignal.timeout` still behaves.
   */
  const laterBy = async (seconds: number, fn: () => Promise<void>) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + seconds * 1000);
    try {
      await fn();
    } finally {
      vi.useRealTimers();
    }
  };

  const build = () => {
    const backend = fakeSupabase();
    const store = createSupabaseAccounts({
      url: 'https://project.supabase.test',
      anonKey: 'anon-key',
      sessionSecret: 'test-session-secret',
      fetchImpl: backend.fetch,
    });
    return { backend, store };
  };

  it('refuses to start without the project it points at', () => {
    expect(() => createSupabaseAccounts({ url: '', anonKey: '', sessionSecret: 's' })).toThrow(
      /SUPABASE_URL/,
    );
    expect(() => createSupabaseAccounts({ url: 'https://x.test', anonKey: '' })).toThrow(/PUBLISHABLE/);
  });

  it('generates a CSRF key rather than refusing to start without one', () => {
    // Losing this key signs nobody out — sessions live in Supabase — so a
    // missing one costs an expired form, not a configuration error.
    const store = createSupabaseAccounts({
      url: 'https://x.test',
      anonKey: 'anon-key',
      sessionSecret: undefined,
      fetchImpl: fakeSupabase().fetch,
    });
    expect(store.kind).toBe('supabase');
  });

  it('sends a publishable key only as apikey, never as a bearer', async () => {
    // A publishable key is not a JWT, and Supabase rejects one in an
    // `Authorization` header. Signed out, there is nothing to put there at all.
    const key = 'sb_publishable_abc123';
    const backend = fakeSupabase({ projectKey: key });
    const store = createSupabaseAccounts({
      url: 'https://project.supabase.test',
      anonKey: key,
      sessionSecret: 'test-session-secret',
      fetchImpl: backend.fetch,
    });

    const { identity } = await reader(store);
    await store.feedFor(identity.reader.feedToken);

    expect(backend.seenKeys()).toEqual([key]);
    expect(backend.seenAuthorization()).toContain(null);
    for (const header of backend.seenAuthorization()) {
      expect(header ?? '').not.toContain(key);
    }
    // And the reader's own token still goes where it belongs.
    expect(backend.seenAuthorization()).toContain(`Bearer ${identity.credential}`);
  });

  it('still sends a legacy anon key as a bearer, the way it always has', async () => {
    const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.legacy.anon';
    const backend = fakeSupabase({ projectKey: key });
    const store = createSupabaseAccounts({
      url: 'https://project.supabase.test',
      anonKey: key,
      sessionSecret: 'test-session-secret',
      fetchImpl: backend.fetch,
    });

    await reader(store);
    expect(backend.seenAuthorization()).toContain(`Bearer ${key}`);
  });

  it('refreshes an expired access token and hands back a new cookie', async () => {
    const { backend, store } = build();
    const created = await store.signUp({ email: 'reader@example.com', password: PASSWORD });
    const session = (created as { session: StartedSession }).session;

    // Past the hour the access token is good for.
    await laterBy(3_700, async () => {
      const identity = await store.resolve(session.value);
      expect(identity?.reader.email).toBe('reader@example.com');
      // The new envelope has to reach the browser, or the next request arrives
      // with the expired one again and the reader is silently signed out.
      expect(identity?.refreshedCookie?.value).toBeTruthy();
      expect(identity!.refreshedCookie!.value).not.toBe(session.value);

      // And the refreshed cookie is itself good.
      expect(await store.resolve(identity!.refreshedCookie!.value)).not.toBeNull();
    });
  });

  it('signs a reader out when the refresh token is no longer accepted', async () => {
    const { backend, store } = build();
    const created = await store.signUp({ email: 'reader@example.com', password: PASSWORD });
    const session = (created as { session: StartedSession }).session;

    backend.revokeEverything();
    await laterBy(3_700, async () => {
      expect(await store.resolve(session.value)).toBeNull();
    });
  });

  it('reports a backend that is up but has no schema', async () => {
    const { backend, store } = build();
    backend.dropSchema();

    const report = await store.check();
    expect(report.ok).toBe(false);
    expect(report.findings.find((f) => f.label === 'schema')?.detail).toMatch(/migrations/);
  });

  it('says the store is unavailable rather than blaming the password', async () => {
    const { backend, store } = build();
    backend.fail(503);

    // A 503 is not "that email and password did not match", and reporting it as
    // one would have readers resetting a password that is fine.
    await expect(store.signIn('reader@example.com', PASSWORD)).rejects.toThrow(/503|reach/);
  });

  it('serves pages signed-out rather than erroring when the store is unreachable', async () => {
    const { backend, store } = build();
    const created = await store.signUp({ email: 'reader@example.com', password: PASSWORD });
    const session = (created as { session: StartedSession }).session;

    backend.fail(0);
    // Almost everything townCivic serves is a public record. When the one
    // hosted thing is down, showing them signed-out beats a 500 on every page.
    expect(await store.resolve(session.value)).toBeNull();
  });

  it('creates the account without a session when the project confirms addresses', async () => {
    const backend = fakeSupabase({ confirmEmail: true });
    const store = createSupabaseAccounts({
      url: 'https://project.supabase.test',
      anonKey: 'anon-key',
      sessionSecret: 'test-session-secret',
      fetchImpl: backend.fetch,
    });

    const result = await store.signUp({ email: 'reader@example.com', password: PASSWORD });
    expect(result).toEqual({ ok: true, session: null, message: expect.stringMatching(/email/i) });
  });

  it('never sends the service role key, and never asks for one', async () => {
    const { backend, store } = build();
    const { identity } = await reader(store);
    await store.listSubscriptions(identity);
    await store.feedFor(identity.reader.feedToken);

    // Every call is made either as the anon role or as the reader themselves.
    // A service role key would bypass every policy in supabase/migrations/.
    expect(backend.seenKeys()).toEqual(['anon-key']);
  });
});
