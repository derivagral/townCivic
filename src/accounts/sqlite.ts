import { randomBytes, scryptSync } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { sameSecret } from './cookies.ts';
import {
  ALL_JURISDICTIONS,
  validateSignup,
  type AccountCheck,
  type AccountStore,
  type Identity,
  type Reader,
  type SignUpInput,
  type SignUpResult,
  type StartedSession,
  type Subscription,
  type SubscriptionInput,
} from './store.ts';

/**
 * Accounts in the local database, at proof-of-concept scale.
 *
 * This is the code that has always been here, moved behind the port and
 * otherwise unchanged. It stays the default because townCivic's quick start is
 * "npm install, npm run seed, npm run serve" with no account to create and
 * nothing to configure, and a hosted backend would quietly end that.
 *
 * "Smallest honest" means the security primitives are the real ones — scrypt
 * with a per-user salt, constant-time comparison, an opaque session cookie with
 * HttpOnly and SameSite, a per-session CSRF token on every state change — and
 * everything above them is missing: no email verification, no password reset,
 * no rate limiting, no lockout, no second factor. That list is what
 * `capabilities` reports and what the Supabase backend exists to supply.
 */

const SESSION_DAYS = 30;

/** Deliberately slow. These are the parameters Node documents as a sane default. */
const SCRYPT_KEYLEN = 64;

export interface UserRow {
  id: string;
  email: string;
  email_key: string;
  display_name: string | null;
  password_hash: string;
  password_salt: string;
  feed_token: string;
  created_at: string;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  /** The town this was followed in, or `*` for every town. */
  jurisdiction: string;
  kind: string;
  value: string;
  label: string;
  alerts: string;
  created_at: string;
}

const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
const nowIso = () => new Date().toISOString();

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

/* -------------------------------------------------------------------- users */

export interface SignupResult {
  ok: boolean;
  user?: UserRow;
  error?: string;
}

export function createUser(db: Db, input: SignUpInput): SignupResult {
  const problem = validateSignup(input.email, input.password);
  if (problem) return { ok: false, error: problem };

  const emailKey = input.email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email_key = ?').get(emailKey);
  if (existing) return { ok: false, error: 'There is already an account for that address.' };

  const salt = token(16);
  const user: UserRow = {
    id: token(16),
    email: input.email.trim(),
    email_key: emailKey,
    display_name: input.displayName?.trim() || null,
    password_hash: hashPassword(input.password, salt),
    password_salt: salt,
    feed_token: token(24),
    created_at: nowIso(),
  };

  db.prepare(
    `INSERT INTO users (id, email, email_key, display_name, password_hash, password_salt, feed_token, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    user.id,
    user.email,
    user.email_key,
    user.display_name,
    user.password_hash,
    user.password_salt,
    user.feed_token,
    user.created_at,
  );

  return { ok: true, user };
}

export function authenticate(db: Db, email: string, password: string): UserRow | null {
  const user = db.prepare('SELECT * FROM users WHERE email_key = ?').get(email.trim().toLowerCase()) as
    UserRow | undefined;

  // Hash even when there is no such user, so a missing account and a wrong
  // password take the same time and cannot be told apart from outside.
  const salt = user?.password_salt ?? 'absent-user-placeholder-salt';
  const candidate = hashPassword(password, salt);
  if (!user) return null;

  return sameSecret(candidate, user.password_hash) ? user : null;
}

export function getUser(db: Db, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByFeedToken(db: Db, feedToken: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE feed_token = ?').get(feedToken) as UserRow | undefined;
}

export function rotateFeedToken(db: Db, userId: string): string {
  const next = token(24);
  db.prepare('UPDATE users SET feed_token = ? WHERE id = ?').run(next, userId);
  return next;
}

/* ----------------------------------------------------------------- sessions */

export interface Session {
  id: string;
  userId: string;
  csrfToken: string;
  expiresAt: string;
}

export function createSession(db: Db, userId: string): Session {
  const session: Session = {
    id: token(24),
    userId,
    csrfToken: token(16),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
  };
  db.prepare('INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?)').run(
    session.id,
    session.userId,
    session.csrfToken,
    nowIso(),
    session.expiresAt,
  );
  return session;
}

export function readSession(db: Db, sessionId: string | undefined): Session | null {
  if (!sessionId) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    { id: string; user_id: string; csrf_token: string; expires_at: string } | undefined;
  if (!row) return null;

  if (row.expires_at <= nowIso()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  return { id: row.id, userId: row.user_id, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}

export function destroySession(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/** Expired rows are dead weight; clearing them is cheap and never wrong. */
export function pruneSessions(db: Db): number {
  const before = db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number };
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  const after = db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number };
  return before.n - after.n;
}

/**
 * SameSite=Lax already blocks cross-site form posts in current browsers, so
 * this token is the second layer rather than the only one — and the one that
 * still holds if the site is ever served somewhere SameSite does not apply.
 */
export function checkCsrf(session: Session | null, supplied: string | undefined): boolean {
  if (!session || !supplied) return false;
  return sameSecret(session.csrfToken, supplied);
}

/* ------------------------------------------------------------ subscriptions */

/**
 * What one reader follows, across every town.
 *
 * Deliberately not scoped to a jurisdiction: an account is a person, and a
 * person who follows a property in Milton and the school committee in Hull has
 * one list, not two. The town lives on each row, so the feed query knows which
 * "Planning Board" each subscription meant — see `personalFeed`.
 */
export function listSubscriptions(db: Db, userId: string): SubscriptionRow[] {
  return db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY jurisdiction, kind, label')
    .all(userId) as unknown as SubscriptionRow[];
}

export function addSubscription(db: Db, userId: string, input: SubscriptionInput): void {
  db.prepare(
    `INSERT INTO subscriptions (id, user_id, jurisdiction, kind, value, label, alerts, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, jurisdiction, kind, value)
       DO UPDATE SET label = excluded.label, alerts = excluded.alerts`,
  ).run(
    token(12),
    userId,
    input.jurisdiction ?? ALL_JURISDICTIONS,
    input.kind,
    input.value,
    input.label,
    input.alerts ?? 'none',
    nowIso(),
  );
}

/** Omit `jurisdiction` to remove the subscription whichever town it was made in. */
export function removeSubscription(
  db: Db,
  userId: string,
  kind: string,
  value: string,
  jurisdiction?: string | undefined,
): void {
  db.prepare(
    `DELETE FROM subscriptions
      WHERE user_id = ? AND kind = ? AND value = ?${jurisdiction ? ' AND jurisdiction = ?' : ''}`,
  ).run(...([userId, kind, value, ...(jurisdiction ? [jurisdiction] : [])] as never[]));
}

export function isWatching(
  db: Db,
  userId: string,
  kind: string,
  value: string,
  jurisdiction?: string | undefined,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM subscriptions
        WHERE user_id = ? AND kind = ? AND value = ?${jurisdiction ? ' AND jurisdiction = ?' : ''}`,
    )
    .get(...([userId, kind, value, ...(jurisdiction ? [jurisdiction] : [])] as never[]));
  return Boolean(row);
}

/* -------------------------------------------------------------------- store */

const toReader = (row: UserRow): Reader => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  feedToken: row.feed_token,
});

const toSubscription = (row: SubscriptionRow): Subscription => ({
  kind: row.kind,
  value: row.value,
  label: row.label,
  jurisdiction: row.jurisdiction,
  alerts: row.alerts,
});

/**
 * What goes in the cookie: the session id and nothing else.
 *
 * The id is opaque and random, so the cookie never carries the reader's id or
 * their address — everything about who they are stays on this side of the wire.
 */
export const startedSession = (session: Session): StartedSession => ({
  value: session.id,
  maxAgeSeconds: Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000)),
});

/** The local backend, behind the port. */
export function createSqliteAccounts(db: Db): AccountStore {
  /** Every method that acts for a reader gets the session id back in `credential`. */
  const sessionOf = (identity: Identity): Session | null => readSession(db, identity.credential);

  return {
    kind: 'sqlite',

    capabilities: {
      emailConfirmation: false,
      passwordReset: false,
      rateLimiting: false,
      // The whole reason the other backend exists.
      survivesDatabaseReset: false,
    },

    describe() {
      return 'local — readers live in data/towncivic.db, which stops being disposable';
    },

    async signUp(input) {
      const result = createUser(db, input);
      if (!result.ok || !result.user)
        return { ok: false, error: result.error ?? 'Could not create that account.' };
      return { ok: true, session: startedSession(createSession(db, result.user.id)) };
    },

    async signIn(email, password) {
      const user = authenticate(db, email, password);
      return user ? startedSession(createSession(db, user.id)) : null;
    },

    async signOut(identity) {
      destroySession(db, identity.credential);
    },

    async resolve(cookieValue) {
      const session = readSession(db, cookieValue);
      if (!session) return null;
      const user = getUser(db, session.userId);
      if (!user) return null;
      return { reader: toReader(user), csrfToken: session.csrfToken, credential: session.id };
    },

    verifyCsrf(identity, supplied) {
      if (!identity) return false;
      return checkCsrf(sessionOf(identity), supplied);
    },

    async listSubscriptions(identity) {
      return listSubscriptions(db, identity.reader.id).map(toSubscription);
    },

    async addSubscription(identity, input) {
      addSubscription(db, identity.reader.id, input);
    },

    async removeSubscription(identity, kind, value, jurisdiction) {
      removeSubscription(db, identity.reader.id, kind, value, jurisdiction);
    },

    async isWatching(identity, kind, value, jurisdiction) {
      return isWatching(db, identity.reader.id, kind, value, jurisdiction);
    },

    async feedFor(feedToken) {
      const user = getUserByFeedToken(db, feedToken);
      if (!user) return null;
      return {
        name: user.display_name || user.email.split('@')[0] || user.email,
        subscriptions: listSubscriptions(db, user.id).map(toSubscription),
      };
    },

    async rotateFeedToken(identity) {
      return rotateFeedToken(db, identity.reader.id);
    },

    async check(): Promise<AccountCheck> {
      const readers = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
      const live = (
        db.prepare('SELECT count(*) AS n FROM sessions WHERE expires_at > ?').get(nowIso()) as { n: number }
      ).n;
      return {
        ok: true,
        findings: [
          { label: 'backend', ok: true, detail: 'sqlite (the default; nothing to configure)' },
          { label: 'readers', ok: true, detail: `${readers} account(s), ${live} live session(s)` },
          {
            label: 'durability',
            ok: readers === 0,
            detail:
              readers === 0
                ? 'no accounts yet, so the database is still disposable'
                : 'deleting data/towncivic.db signs everybody out and loses their subscriptions',
          },
        ],
      };
    },
  };
}
