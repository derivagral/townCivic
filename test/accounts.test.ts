import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { personalFeed } from '../src/db/repo.ts';
import { linkMatters } from '../src/pipeline/link.ts';
import {
  SESSION_COOKIE,
  addSubscription,
  authenticate,
  checkCsrf,
  clearedCookie,
  createSession,
  createUser,
  destroySession,
  getUserByFeedToken,
  isWatching,
  listSubscriptions,
  pruneSessions,
  readCookie,
  readSession,
  removeSubscription,
  rotateFeedToken,
  sessionCookie,
  validateSignup,
} from '../src/web/accounts.ts';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

const signup = (email = 'reader@example.com', password = 'correct-horse-battery') =>
  createUser(db, { email, password });

describe('passwords', () => {
  it('never stores the password itself', () => {
    const { user } = signup('reader@example.com', 'correct-horse-battery');
    expect(user!.password_hash).not.toContain('correct-horse-battery');
    expect(user!.password_hash).toHaveLength(128); // scrypt, 64 bytes as hex
    expect(user!.password_salt).toBeTruthy();
  });

  it('salts per user, so two identical passwords do not look identical', () => {
    const a = signup('a@example.com', 'the-same-password');
    const b = signup('b@example.com', 'the-same-password');
    expect(a.user!.password_hash).not.toBe(b.user!.password_hash);
  });

  it('accepts the right password and rejects the wrong one', () => {
    signup('reader@example.com', 'correct-horse-battery');
    expect(authenticate(db, 'reader@example.com', 'correct-horse-battery')).not.toBeNull();
    expect(authenticate(db, 'reader@example.com', 'correct-horse-batteryy')).toBeNull();
  });

  it('treats the address case-insensitively, both ways', () => {
    signup('Reader@Example.com', 'correct-horse-battery');
    expect(authenticate(db, 'reader@EXAMPLE.com', 'correct-horse-battery')).not.toBeNull();
    expect(createUser(db, { email: 'READER@example.com', password: 'another-password' }).ok).toBe(false);
  });

  it('does not reveal whether an account exists', () => {
    // Same answer either way. (The timing is equalised in `authenticate` by
    // hashing against a placeholder salt; this checks the visible half.)
    expect(authenticate(db, 'nobody@example.com', 'anything-at-all')).toBeNull();
  });

  it('rejects what would break rather than enforcing a password policy', () => {
    expect(validateSignup('not-an-email', 'correct-horse-battery')).toBeTruthy();
    expect(validateSignup('reader@example.com', 'short')).toBeTruthy();
    expect(validateSignup('reader@example.com', 'correct-horse-battery')).toBeNull();
  });
});

describe('sessions', () => {
  it('issues an opaque cookie that scripts cannot read', () => {
    const { user } = signup();
    const session = createSession(db, user!.id);
    const cookie = sessionCookie(session, false);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    // The cookie carries a random id, never the user id or the email.
    expect(cookie).not.toContain(user!.id);
    expect(cookie).not.toContain(user!.email);
  });

  it('marks the cookie Secure when asked, for anything served over HTTPS', () => {
    const { user } = signup();
    expect(sessionCookie(createSession(db, user!.id), true)).toContain('Secure');
    expect(clearedCookie(true)).toContain('Secure');
  });

  it('expires the cookie on sign-out', () => {
    expect(clearedCookie(false)).toContain('Max-Age=0');
  });

  it('resolves a live session and forgets a destroyed one', () => {
    const { user } = signup();
    const session = createSession(db, user!.id);
    expect(readSession(db, session.id)?.userId).toBe(user!.id);

    destroySession(db, session.id);
    expect(readSession(db, session.id)).toBeNull();
  });

  it('refuses an expired session and cleans it up', () => {
    const { user } = signup();
    const session = createSession(db, user!.id);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', session.id);

    expect(readSession(db, session.id)).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('prunes expired sessions and leaves live ones', () => {
    const { user } = signup();
    const stale = createSession(db, user!.id);
    createSession(db, user!.id);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', stale.id);

    expect(pruneSessions(db)).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });

  it('drops a user’s sessions with the user', () => {
    const { user } = signup();
    createSession(db, user!.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user!.id);
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('reads one cookie out of a header without tripping on the others', () => {
    const header = `theme=dark; ${SESSION_COOKIE}=abc123; other=x`;
    expect(readCookie(header, SESSION_COOKIE)).toBe('abc123');
    expect(readCookie(header, 'missing')).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});

describe('csrf', () => {
  it('accepts this session’s token and nothing else', () => {
    const { user } = signup();
    const session = createSession(db, user!.id);
    const other = createSession(db, user!.id);

    expect(checkCsrf(session, session.csrfToken)).toBe(true);
    expect(checkCsrf(session, other.csrfToken)).toBe(false);
    expect(checkCsrf(session, '')).toBe(false);
    expect(checkCsrf(session, undefined)).toBe(false);
    expect(checkCsrf(null, session.csrfToken)).toBe(false);
  });
});

describe('feed tokens', () => {
  it('is not the password and not guessable from the account', () => {
    const { user } = signup();
    expect(user!.feed_token).not.toBe(user!.id);
    expect(user!.feed_token.length).toBeGreaterThan(20);
    expect(getUserByFeedToken(db, user!.feed_token)?.id).toBe(user!.id);
  });

  it('can be rotated without touching the password', () => {
    const { user } = signup('reader@example.com', 'correct-horse-battery');
    const before = user!.feed_token;
    const after = rotateFeedToken(db, user!.id);

    expect(after).not.toBe(before);
    expect(getUserByFeedToken(db, before)).toBeUndefined();
    expect(authenticate(db, 'reader@example.com', 'correct-horse-battery')).not.toBeNull();
  });
});

/* ------------------------------------------------------------ subscriptions */

let seq = 0;

function event(opts: { title: string; body?: string; channel?: string; subjects?: string[] }): string {
  const id = `event-${++seq}`;
  db.prepare(
    `INSERT INTO events (id, jurisdiction, source_id, level, agency, body, channel, event_type, priority,
                         title, url, occurred_at, first_seen_at, last_seen_at, subjects, tags, content_hash)
     VALUES (?,'milton-ma','src','municipal','Town of Milton',?,?,'meeting_agenda','high',?,
             'https://x/1','2026-06-02T12:00:00.000Z','2026-06-02T12:00:00.000Z','2026-06-02T12:00:00.000Z',?,'[]',?)`,
  ).run(
    id,
    opts.body ?? 'Planning Board',
    opts.channel ?? 'land-use',
    opts.title,
    JSON.stringify(opts.subjects ?? []),
    `hash-${seq}`,
  );
  return id;
}

describe('subscriptions and the personal feed', () => {
  beforeEach(() => {
    seq = 0;
    db.prepare(
      `INSERT INTO sources (id, jurisdiction, label, adapter, url, level, agency, channel, priority, tier, confidence)
       VALUES ('src','milton-ma','Test','civicplus-agenda-center','https://x','municipal','Town of Milton','land-use','high',1,'verified')`,
    ).run();
  });

  it('is a union, not an intersection', () => {
    // Following a board and a property means both, not the overlap.
    event({ title: 'Planning Board agenda', body: 'Planning Board' });
    event({ title: 'Select Board agenda', body: 'Select Board', channel: 'meetings' });
    event({ title: 'Health agenda', body: 'Board of Health', channel: 'public-safety' });

    const { user } = signup();
    addSubscription(db, user!.id, { kind: 'body', value: 'Planning Board', label: 'Planning Board' });
    addSubscription(db, user!.id, { kind: 'channel', value: 'meetings', label: 'Meetings' });

    const rows = personalFeed(db, listSubscriptions(db, user!.id), { jurisdiction: 'milton-ma' });
    expect(rows.map((r) => r.title).sort()).toEqual(['Planning Board agenda', 'Select Board agenda']);
  });

  it('follows a matter across whichever board publishes next', () => {
    event({ title: 'ZBA agenda', body: 'Board of Appeals', subjects: ['271 Pleasant Street'] });
    event({ title: 'Planning agenda', body: 'Planning Board', subjects: ['271 Pleasant Street'] });
    event({ title: 'Unrelated', body: 'Planning Board', subjects: ['8 Wharf Street'] });
    linkMatters(db, { jurisdiction: 'milton-ma' });

    const matter = db.prepare("SELECT id FROM matters WHERE label = '271 Pleasant Street'").get() as {
      id: string;
    };
    const { user } = signup();
    addSubscription(db, user!.id, { kind: 'matter', value: matter.id, label: '271 Pleasant Street' });

    const rows = personalFeed(db, listSubscriptions(db, user!.id), { jurisdiction: 'milton-ma' });
    expect(rows.map((r) => r.title).sort()).toEqual(['Planning agenda', 'ZBA agenda']);
  });

  it('gives an empty feed to someone following nothing', () => {
    event({ title: 'Something' });
    const { user } = signup();
    expect(personalFeed(db, listSubscriptions(db, user!.id), { jurisdiction: 'milton-ma' })).toEqual([]);
  });

  it('keeps routine administration out unless it was asked for', () => {
    event({ title: 'A licence renewal', body: 'Planning Board', channel: 'admin' });
    const { user } = signup();
    addSubscription(db, user!.id, { kind: 'body', value: 'Planning Board', label: 'Planning Board' });
    expect(personalFeed(db, listSubscriptions(db, user!.id), { jurisdiction: 'milton-ma' })).toHaveLength(0);

    addSubscription(db, user!.id, { kind: 'channel', value: 'admin', label: 'Routine Administration' });
    expect(personalFeed(db, listSubscriptions(db, user!.id), { jurisdiction: 'milton-ma' })).toHaveLength(1);
  });

  it('does not duplicate a subscription added twice', () => {
    const { user } = signup();
    addSubscription(db, user!.id, { kind: 'body', value: 'Planning Board', label: 'Planning Board' });
    addSubscription(db, user!.id, { kind: 'body', value: 'Planning Board', label: 'Planning Board' });
    expect(listSubscriptions(db, user!.id)).toHaveLength(1);
  });

  it('reports and removes what a reader is watching', () => {
    const { user } = signup();
    addSubscription(db, user!.id, { kind: 'matter', value: 'm1', label: 'A property' });
    expect(isWatching(db, user!.id, 'matter', 'm1')).toBe(true);

    removeSubscription(db, user!.id, 'matter', 'm1');
    expect(isWatching(db, user!.id, 'matter', 'm1')).toBe(false);
  });

  it('keeps one reader’s list out of another’s feed', () => {
    event({ title: 'Planning Board agenda', body: 'Planning Board' });
    const a = signup('a@example.com');
    const b = signup('b@example.com');
    addSubscription(db, a.user!.id, { kind: 'body', value: 'Planning Board', label: 'Planning Board' });

    expect(personalFeed(db, listSubscriptions(db, a.user!.id), { jurisdiction: 'milton-ma' })).toHaveLength(
      1,
    );
    expect(personalFeed(db, listSubscriptions(db, b.user!.id), { jurisdiction: 'milton-ma' })).toHaveLength(
      0,
    );
  });

  it('does not let a search subscription throw on punctuation', () => {
    event({ title: 'Special permit at 39 Frothingham Street' });
    const { user } = signup();
    addSubscription(db, user!.id, { kind: 'search', value: '"special permit" (39)', label: 'permits' });
    expect(() =>
      personalFeed(db, listSubscriptions(db, user!.id), { jurisdiction: 'milton-ma' }),
    ).not.toThrow();
  });
});
