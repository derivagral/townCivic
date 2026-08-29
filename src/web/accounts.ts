import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';

/**
 * Accounts, at proof-of-concept scale.
 *
 * The question this exists to answer is "what do *I* want to see" — a reader
 * following one property, one board, or one search, rather than the whole
 * town's output. That needs somewhere to keep a list per person, which needs
 * the smallest honest login.
 *
 * "Smallest honest" means the security primitives are the real ones — scrypt
 * with a per-user salt, constant-time comparison, an opaque session cookie with
 * HttpOnly and SameSite, a per-session CSRF token on every state change — and
 * everything above them is missing: no email verification, no password reset,
 * no rate limiting, no lockout, no second factor. Those are the difference
 * between this and something that faces the internet, and they are listed in
 * the README rather than left to be discovered.
 */

export const SESSION_COOKIE = 'towncivic_session';
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

/** A subscription that applies to every town, rather than to one. */
export const ALL_JURISDICTIONS = '*';

export const SUBSCRIPTION_KINDS = ['matter', 'body', 'channel', 'search'] as const;
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];

export function isSubscriptionKind(value: string): value is SubscriptionKind {
  return (SUBSCRIPTION_KINDS as readonly string[]).includes(value);
}

const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
const nowIso = () => new Date().toISOString();

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * length, so both sides are hashed to a fixed width first.
 */
function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/* -------------------------------------------------------------------- users */

export interface SignupResult {
  ok: boolean;
  user?: UserRow;
  error?: string;
}

/** Rejects only what would break: the rest is the reader's business. */
export function validateSignup(email: string, password: string): string | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return 'That does not look like an email address.';
  if (password.length < 10) return 'Use at least 10 characters.';
  return null;
}

export function createUser(
  db: Db,
  input: { email: string; password: string; displayName?: string },
): SignupResult {
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
 * The `Set-Cookie` value for a session.
 *
 * `Secure` is conditional because the documented way to run this is
 * `npm run serve` on localhost, where a Secure cookie is simply never sent and
 * login would appear to silently fail. Anything reachable over HTTPS should set
 * `TOWNCIVIC_SECURE_COOKIES=1`.
 */
export function sessionCookie(session: Session, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE}=${session.id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Pull one cookie out of a `Cookie` header without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
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

export function addSubscription(
  db: Db,
  userId: string,
  input: {
    kind: SubscriptionKind;
    value: string;
    label: string;
    /** The town it was followed in. Defaults to every town. */
    jurisdiction?: string;
    alerts?: string;
  },
): void {
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
  jurisdiction?: string,
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
  jurisdiction?: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM subscriptions
        WHERE user_id = ? AND kind = ? AND value = ?${jurisdiction ? ' AND jurisdiction = ?' : ''}`,
    )
    .get(...([userId, kind, value, ...(jurisdiction ? [jurisdiction] : [])] as never[]));
  return Boolean(row);
}
