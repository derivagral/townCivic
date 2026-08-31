/**
 * The accounts port.
 *
 * Everything in townCivic except accounts is derived: the document store is the
 * authority, and `data/towncivic.db` can be deleted and rebuilt from it. Readers
 * are the exception — `users`, `sessions` and `subscriptions` are the one thing
 * in that file nobody can regenerate — and that exception is what makes the
 * database undeletable, the deployment stateful, and every "just point it at a
 * fresh volume" answer wrong.
 *
 * This interface is the seam that lets those rows live somewhere else. There are
 * two implementations:
 *
 *   sqlite    the tables that are already there. Default, no account, no
 *             network, and the only backend the test suite and CI ever use.
 *   supabase  a hosted Postgres with GoTrue in front of it. Identity, password
 *             hashing, email confirmation and reset stop being ours.
 *
 * The point of the port is not portability for its own sake. It is that the two
 * backends have genuinely different capabilities — one cannot send a
 * confirmation email and the other can — and the honest way to have both is to
 * name the difference (`capabilities`) rather than to pretend a lowest common
 * denominator exists.
 *
 * Every method is async even where SQLite answers instantly, because the
 * alternative is a synchronous interface that the network backend cannot
 * implement, which is not an interface at all.
 */

/** A reader, as both backends describe one. */
export interface Reader {
  id: string;
  email: string;
  displayName: string | null;
  /** Bearer token for the personal feed. Rotatable, and not the password. */
  feedToken: string;
}

/** One thing a reader follows. Mirrors the `subscriptions` table's columns. */
export interface Subscription {
  kind: string;
  value: string;
  label: string;
  /** The town it was followed in, or `*` for every town. */
  jurisdiction: string;
  /** none | digest | immediate. Recorded intent; nothing sends mail yet. */
  alerts: string;
}

/** A subscription that applies to every town, rather than to one. */
export const ALL_JURISDICTIONS = '*';

export const SUBSCRIPTION_KINDS = ['matter', 'body', 'channel', 'search'] as const;
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];

export function isSubscriptionKind(value: string): value is SubscriptionKind {
  return (SUBSCRIPTION_KINDS as readonly string[]).includes(value);
}

/** What to put in the session cookie, and how long it should live. */
export interface StartedSession {
  /** Opaque to every caller: a session id here, a token envelope there. */
  value: string;
  maxAgeSeconds: number;
}

/**
 * A resolved session.
 *
 * `credential` is the backend's own handle on this session — the SQLite session
 * id, or the Supabase access token — and is passed straight back to the store on
 * every call that acts on the reader's behalf. It never leaves the server and is
 * never rendered.
 */
export interface Identity {
  reader: Reader;
  csrfToken: string;
  readonly credential: string;
  /**
   * Set when resolving the session produced a *new* cookie value, which the
   * caller must send back to the browser.
   *
   * Only the hosted backend does this: a Supabase access token lives about an
   * hour, so reading a month-old session routinely means refreshing it. The
   * local backend's session id never changes, so this is always absent there.
   */
  refreshedCookie?: StartedSession;
}

export type SignUpResult =
  | { ok: true; session: StartedSession }
  /** Created, but not signed in — the backend wants the address confirmed first. */
  | { ok: true; session: null; message: string }
  | { ok: false; error: string };

/**
 * What a backend can actually do.
 *
 * Read by the UI so that a page never offers a password reset that goes
 * nowhere, and read by `accounts check` so an operator can see which half of
 * the README's "what is missing" list still applies to them.
 */
export interface AccountCapabilities {
  /** The backend mails a confirmation link and will not sign in until it is used. */
  emailConfirmation: boolean;
  /** There is a password reset path. */
  passwordReset: boolean;
  /** Failed sign-ins are rate limited somewhere other than in our code. */
  rateLimiting: boolean;
  /** Reader rows survive `rm -f data/towncivic.db`. */
  survivesDatabaseReset: boolean;
}

export interface SignUpInput {
  email: string;
  password: string;
  displayName?: string | undefined;
}

export interface SubscriptionInput {
  kind: SubscriptionKind;
  value: string;
  label: string;
  /** The town it was followed in. Defaults to every town. */
  jurisdiction?: string | undefined;
  alerts?: string | undefined;
}

export interface AccountStore {
  readonly kind: 'sqlite' | 'supabase';
  readonly capabilities: AccountCapabilities;
  /** One line for `accounts check` and the startup banner. */
  describe(): string;

  signUp(input: SignUpInput): Promise<SignUpResult>;
  /** Null for both "no such account" and "wrong password" — the caller must not learn which. */
  signIn(email: string, password: string): Promise<StartedSession | null>;
  signOut(identity: Identity): Promise<void>;

  /** Turn a cookie value into a reader, or null. Also the authentication check. */
  resolve(cookieValue: string | undefined): Promise<Identity | null>;
  /** Constant-time check of a form's CSRF field against this session. */
  verifyCsrf(identity: Identity | null, supplied: string | undefined): boolean;

  listSubscriptions(identity: Identity): Promise<Subscription[]>;
  addSubscription(identity: Identity, input: SubscriptionInput): Promise<void>;
  removeSubscription(
    identity: Identity,
    kind: string,
    value: string,
    jurisdiction?: string | undefined,
  ): Promise<void>;
  isWatching(
    identity: Identity,
    kind: string,
    value: string,
    jurisdiction?: string | undefined,
  ): Promise<boolean>;

  /**
   * Everything the personal-feed route needs, in one call.
   *
   * That route has a bearer token in the URL and nothing else — no cookie, no
   * session, no reader id — so it cannot use any of the methods above. One
   * method rather than "look up the reader, then list their subscriptions"
   * because on the hosted backend this is a single `security definer` function:
   * the anonymous role is allowed to exchange a feed token for exactly this and
   * nothing more, which is a much smaller grant than read access to the tables.
   *
   * `name` rather than a whole `Reader` for the same reason: the feed needs a
   * title, so that is all the token buys.
   */
  feedFor(feedToken: string): Promise<{ name: string; subscriptions: Subscription[] } | null>;
  rotateFeedToken(identity: Identity): Promise<string>;

  /** Reachability and schema probe for `accounts check`. */
  check(): Promise<AccountCheck>;
}

export interface AccountCheck {
  ok: boolean;
  /** One line per thing probed, in the order it was probed. */
  findings: { label: string; ok: boolean; detail: string }[];
}

/**
 * Raised when a backend is selected but cannot be built — a missing URL, a
 * missing key, a missing session secret.
 *
 * Its own type so the CLI can print the message and exit rather than showing a
 * stack trace for what is always a configuration mistake.
 */
export class AccountsUnavailableError extends Error {
  override name = 'AccountsUnavailableError';
}

/**
 * Rejects only what would break, and does it before any network call.
 *
 * Both backends run this first: the hosted one has its own password policy, but
 * a local check gives a better message and saves a round trip on a typo. It is
 * deliberately not a password policy — length is the only rule that survives
 * contact with the evidence.
 */
export function validateSignup(email: string, password: string): string | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return 'That does not look like an email address.';
  if (password.length < 10) return 'Use at least 10 characters.';
  return null;
}

/** The display name to show for a reader, from whichever of the two fields exists. */
export function readerName(reader: Pick<Reader, 'email' | 'displayName'>): string {
  return reader.displayName || reader.email.split('@')[0] || reader.email;
}
