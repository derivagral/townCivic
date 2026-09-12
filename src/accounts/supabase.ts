import { createHmac, randomBytes } from 'node:crypto';
// Imported for its side effect: installing the proxy dispatcher on the global
// `fetch`. Its own `fetchSource` is not used here — that one waits a second
// between requests to the same host, which is right for a town's web server and
// very wrong for the database behind every page render.
import '../fetch/http.ts';
import { config } from '../config.ts';
import { sameSecret } from './cookies.ts';
import {
  ALL_JURISDICTIONS,
  AccountsUnavailableError,
  validateSignup,
  type AccountCheck,
  type AccountStore,
  type Identity,
  type Reader,
  type SignUpResult,
  type StartedSession,
  type Subscription,
} from './store.ts';

/**
 * Accounts in Supabase: GoTrue for identity, PostgREST for the reader's list.
 *
 * The trade this makes is the whole point of the port. It gives up "runs with
 * no account and no network" and gets back the entire list the README has
 * always carried as *what is missing*: email confirmation, password reset, rate
 * limiting, lockout, recovery, and a second factor. None of that is code here;
 * it is configuration in someone else's dashboard, which is the correct place
 * for it. What comes with it is that `data/towncivic.db` goes back to being
 * derived and disposable — the property every other table in this repo has.
 *
 * Three decisions worth stating, because each of them has a tempting wrong
 * answer:
 *
 * **No SDK.** `@supabase/supabase-js` would add a realtime websocket client and
 * a storage client to serve six REST endpoints. townCivic's default install has
 * no accounts at all, so paying for that in every install is a bad deal. The
 * endpoints below are the stable, documented GoTrue and PostgREST surface.
 *
 * **The anon key, never the service role key.** The service role key bypasses
 * row-level security, so a web tier holding one makes every policy in
 * `supabase/migrations/` decorative — the only thing standing between one
 * reader and another's list would be our own `WHERE` clauses, which is exactly
 * the situation moving to Postgres was supposed to end. Every call here is made
 * *as the reader*, with their own access token, and Postgres decides what they
 * can see.
 *
 * **The database is the authentication check.** Resolving a session does not
 * verify the JWT locally — no JWKS fetch, no HS256 secret, no signature code of
 * ours to get wrong. It asks PostgREST for the reader's own row using the token
 * in the cookie. A forged or expired token gets a 401 from Supabase and no
 * identity here. The cost is one network round trip per signed-in request,
 * which is the honest price of putting state at a single point; see
 * `docs/operations.md`.
 */

const AUTH = '/auth/v1';
const REST = '/rest/v1';

/** Refresh this far before the access token actually expires. */
const REFRESH_MARGIN_SECONDS = 60;

/**
 * How long the browser keeps the cookie. Supabase decides whether the session
 * inside it is still good; this only decides when to stop asking.
 */
const COOKIE_DAYS = 30;

const READER_COLUMNS = 'user_id,email,display_name,feed_token';
const SUBSCRIPTION_COLUMNS = 'jurisdiction,kind,value,label,alerts';

/** What GoTrue hands back on a successful sign-in, sign-up or refresh. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface ReaderRow {
  user_id: string;
  email: string | null;
  display_name: string | null;
  feed_token: string;
}

interface SubscriptionRow {
  jurisdiction: string;
  kind: string;
  value: string;
  label: string;
  alerts: string;
}

/** The token envelope kept in the session cookie. Short keys: cookies are small. */
interface Envelope {
  /** access token */
  a: string;
  /** refresh token */
  r: string;
  /** access token expiry, epoch seconds */
  e: number;
}

function encodeEnvelope(envelope: Envelope): string {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

function decodeEnvelope(value: string | undefined): Envelope | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Envelope>;
    if (typeof parsed.a !== 'string' || typeof parsed.r !== 'string' || typeof parsed.e !== 'number') {
      return null;
    }
    return { a: parsed.a, r: parsed.r, e: parsed.e };
  } catch {
    return null;
  }
}

/**
 * One `column=eq.value` term of a PostgREST filter, quoted and encoded.
 *
 * Both halves matter, and both are about the same input: a subscription's
 * `value` is a board name, a matter id, or a reader's own search string, and
 * that last one is arbitrary text they typed.
 *
 * Quoted always, rather than only when it looks necessary, because PostgREST
 * reads a bare comma as a list separator — an unquoted one would silently turn
 * one filter into two. Encoded because `&` and `#` are query-string syntax that
 * `URL` will not escape for us: a reader following the search `permits & fees`
 * would otherwise send a filter that ends at the ampersand.
 */
function eq(column: string, value: string): string {
  const quoted = `eq."${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `${column}=${encodeURIComponent(quoted)}`;
}

export interface SupabaseAccountsOptions {
  url?: string | undefined;
  /** The `anon` or publishable key — the public one. Never the service role key. */
  anonKey?: string | undefined;
  /** HMAC key for CSRF tokens. Generated per process when absent. */
  sessionSecret?: string | undefined;
  /** Injected by tests. Production uses the global, proxy-aware `fetch`. */
  fetchImpl?: typeof fetch;
}

interface Response_<T> {
  status: number;
  ok: boolean;
  body: T;
  /** A human-readable message pulled out of whichever error shape came back. */
  error: string | null;
}

/**
 * Whether a project key is a legacy `anon` key rather than a new publishable one.
 *
 * The two are the same role and go in the same place, but they differ in one way
 * that matters here. A legacy `anon` key is a JWT, and every Supabase example
 * ever written sends it in `Authorization: Bearer` as well as `apikey`. A
 * publishable key (`sb_publishable_…`) is not a JWT, and Supabase's migration
 * guidance is explicit that it does not belong in an `Authorization` header at
 * all — the point of the redesign being that a misplaced key now fails loudly
 * instead of working silently.
 *
 * So: `apikey` always, and the `Authorization` header only when there is
 * something that actually belongs there — the reader's own JWT, or a legacy key
 * on the path it has always taken.
 */
const isLegacyJwtKey = (key: string): boolean => key.startsWith('eyJ');

export function createSupabaseAccounts(options: SupabaseAccountsOptions = {}): AccountStore {
  const baseUrl = (options.url ?? config.supabaseUrl ?? '').replace(/\/+$/, '');
  const projectKey = options.anonKey ?? config.supabaseAnonKey;
  const doFetch = options.fetchImpl ?? fetch;

  if (!baseUrl || !projectKey) {
    throw new AccountsUnavailableError(
      'The supabase accounts backend needs SUPABASE_URL and SUPABASE_ANON_KEY (or ' +
        'SUPABASE_PUBLISHABLE_KEY). Unset TOWNCIVIC_ACCOUNTS to fall back to the local backend.',
    );
  }

  /**
   * The key CSRF tokens are derived from.
   *
   * Generated per process when nothing supplies one, rather than refused. It is
   * not a session store and losing it does not sign anybody out — sessions live
   * in Supabase, in the cookie. All a new key costs is that forms already
   * rendered in somebody's browser come back "this form has expired, reload the
   * page", which is a fine trade for one less thing to configure.
   *
   * Set `TOWNCIVIC_SESSION_SECRET` when that matters: across restarts, and
   * across instances if there is ever more than one behind a load balancer,
   * where an unset key means each instance rejects the others' forms.
   */
  const generated = !options.sessionSecret && !config.sessionSecret;
  const sessionSecret =
    options.sessionSecret ?? config.sessionSecret ?? randomBytes(32).toString('base64url');
  if (generated) {
    console.warn(
      'TOWNCIVIC_SESSION_SECRET is not set; using a new one for this process. ' +
        'Readers stay signed in across a restart, but any form left open in a browser ' +
        'will need reloading. Set it to keep them working.',
    );
  }

  async function request<T>(
    path: string,
    init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response_<T>> {
    // The reader's own token when signed in. Postgres reads `auth.uid()` out of
    // it, and that is what every policy in supabase/migrations/ is written
    // against; signed out, there is nothing to say and the header is omitted.
    const bearer = init.token ?? (isLegacyJwtKey(projectKey!) ? projectKey : undefined);

    const headers: Record<string, string> = {
      apikey: projectKey!,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    };

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { status: 0, ok: false, body: undefined as T, error: `could not reach Supabase: ${detail}` };
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    // GoTrue and PostgREST disagree about which key holds the message, and
    // GoTrue has changed its mind across versions. Try all of them.
    const shape = (parsed ?? {}) as Record<string, unknown>;
    const message =
      [shape['error_description'], shape['msg'], shape['message'], shape['error']].find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
      ) ?? null;

    return {
      status: response.status,
      ok: response.ok,
      body: parsed as T,
      error: response.ok ? null : (message ?? `HTTP ${response.status}`),
    };
  }

  const envelopeFrom = (tokens: TokenResponse): Envelope | null =>
    tokens.access_token && tokens.refresh_token
      ? {
          a: tokens.access_token,
          r: tokens.refresh_token,
          e: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600),
        }
      : null;

  const asSession = (envelope: Envelope): StartedSession => ({
    value: encodeEnvelope(envelope),
    maxAgeSeconds: COOKIE_DAYS * 86_400,
  });

  /**
   * The CSRF token for a reader.
   *
   * There is no sessions table to keep a per-session random value in, so it is
   * derived: an HMAC of the reader's id under a key only this deployment holds.
   * An attacker who cannot read the response body cannot produce it, which is
   * what a double-submit token has to be.
   *
   * The trade against the local backend's per-session token, stated rather than
   * buried: this one is stable for a reader across sessions and devices, so it
   * does not rotate on sign-in. That is a weaker binding, and it is why it is
   * the second layer rather than the only one — `SameSite=Lax` on the session
   * cookie is the first.
   */
  const csrfFor = (readerId: string): string =>
    createHmac('sha256', sessionSecret).update(`csrf:${readerId}`).digest('base64url');

  /** Exchange a refresh token for a new pair. */
  async function refresh(envelope: Envelope): Promise<Envelope | null> {
    const response = await request<TokenResponse>(`${AUTH}/token?grant_type=refresh_token`, {
      method: 'POST',
      body: { refresh_token: envelope.r },
    });
    return response.ok ? envelopeFrom(response.body ?? {}) : null;
  }

  const toReader = (row: ReaderRow): Reader => ({
    id: row.user_id,
    email: row.email ?? '',
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

  return {
    kind: 'supabase',

    capabilities: {
      // All three are true of the *product*, and each is a switch in the
      // Supabase dashboard rather than something this code can guarantee.
      // `accounts check` reports what the project is actually configured to do.
      emailConfirmation: true,
      passwordReset: true,
      rateLimiting: true,
      survivesDatabaseReset: true,
    },

    describe() {
      return `supabase — readers live at ${baseUrl}, so data/towncivic.db stays disposable`;
    },

    async signUp(input): Promise<SignUpResult> {
      const problem = validateSignup(input.email, input.password);
      if (problem) return { ok: false, error: problem };

      const response = await request<TokenResponse>(`${AUTH}/signup`, {
        method: 'POST',
        body: {
          email: input.email.trim(),
          password: input.password,
          // Read by the trigger in supabase/migrations/ when it creates the
          // reader row, so a display name survives without a second write.
          data: { display_name: input.displayName?.trim() || null },
        },
      });
      if (!response.ok) return { ok: false, error: response.error ?? 'Could not create that account.' };

      const envelope = envelopeFrom(response.body ?? {});
      if (envelope) return { ok: true, session: asSession(envelope) };

      // No tokens means the project requires a confirmed address before it will
      // issue a session. That is a success, not a failure, and the difference
      // has to reach the page or the reader sees a form that appears to do
      // nothing.
      return {
        ok: true,
        session: null,
        message: 'Check your email — the account is created once you follow the confirmation link.',
      };
    },

    async signIn(email, password) {
      const response = await request<TokenResponse>(`${AUTH}/token?grant_type=password`, {
        method: 'POST',
        body: { email: email.trim(), password },
      });

      if (response.ok) {
        const envelope = envelopeFrom(response.body ?? {});
        return envelope ? asSession(envelope) : null;
      }

      // 400 and 401 are "that email and password did not match", which is the
      // one answer this method is allowed to give for a failed sign-in.
      // Anything else — rate limited, unreachable, project paused — is not the
      // reader's mistake and must not be reported to them as one.
      if (response.status === 400 || response.status === 401 || response.status === 403) return null;
      throw new AccountsUnavailableError(response.error ?? `sign-in failed with HTTP ${response.status}`);
    },

    async signOut(identity) {
      // `scope=local` rather than the default `global`: signing out of this
      // browser should not sign the reader out of their phone.
      await request(`${AUTH}/logout?scope=local`, { method: 'POST', token: identity.credential });
    },

    async resolve(cookieValue) {
      let envelope = decodeEnvelope(cookieValue);
      if (!envelope) return null;

      let refreshed: StartedSession | undefined;
      if (envelope.e - REFRESH_MARGIN_SECONDS <= Math.floor(Date.now() / 1000)) {
        // Supabase rotates refresh tokens, with a short reuse window so that
        // two requests racing to refresh the same session do not invalidate
        // each other. Nothing to serialize here, therefore, beyond letting the
        // loser of the race use the answer it gets back.
        const next = await refresh(envelope);
        if (!next) return null;
        envelope = next;
        refreshed = asSession(next);
      }

      // No filter and no user id: row-level security is what restricts this to
      // the caller's own row, and letting Postgres apply it is the difference
      // between a policy and a comment.
      const response = await request<ReaderRow[]>(`${REST}/readers?select=${READER_COLUMNS}&limit=1`, {
        token: envelope.a,
      });

      // A transport failure resolves to "signed out" rather than throwing. The
      // site is almost entirely public records; when the single point of state
      // is unreachable, serving them signed-out is a much better outcome than
      // a 500 on every page.
      const row = response.ok ? response.body?.[0] : undefined;
      if (!row) return null;

      const reader = toReader(row);
      return {
        reader,
        csrfToken: csrfFor(reader.id),
        credential: envelope.a,
        ...(refreshed ? { refreshedCookie: refreshed } : {}),
      };
    },

    verifyCsrf(identity, supplied) {
      if (!identity || !supplied) return false;
      return sameSecret(identity.csrfToken, supplied);
    },

    async listSubscriptions(identity) {
      const response = await request<SubscriptionRow[]>(
        `${REST}/subscriptions?select=${SUBSCRIPTION_COLUMNS}&order=jurisdiction,kind,label`,
        { token: identity.credential },
      );
      if (!response.ok) throw new Error('Could not load your follows. Please try again.');
      return (response.body ?? []).map(toSubscription);
    },

    async addSubscription(identity, input) {
      // An upsert, to match the local backend's `ON CONFLICT ... DO UPDATE`:
      // following the same board twice edits the label rather than failing.
      const response = await request(`${REST}/subscriptions?on_conflict=user_id,jurisdiction,kind,value`, {
        method: 'POST',
        token: identity.credential,
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: {
          user_id: identity.reader.id,
          jurisdiction: input.jurisdiction ?? ALL_JURISDICTIONS,
          kind: input.kind,
          value: input.value,
          label: input.label,
          alerts: input.alerts ?? 'none',
        },
      });
      if (!response.ok) throw new Error('Could not save this follow. Please try again.');
    },

    async removeSubscription(identity, kind, value, jurisdiction) {
      const filters = [
        eq('user_id', identity.reader.id),
        eq('kind', kind),
        eq('value', value),
        ...(jurisdiction ? [eq('jurisdiction', jurisdiction)] : []),
      ];
      const response = await request(`${REST}/subscriptions?${filters.join('&')}`, {
        method: 'DELETE',
        token: identity.credential,
        headers: { prefer: 'return=minimal' },
      });
      if (!response.ok) throw new Error('Could not remove this follow. Please try again.');
    },

    async isWatching(identity, kind, value, jurisdiction) {
      const filters = [
        'select=kind',
        eq('kind', kind),
        eq('value', value),
        ...(jurisdiction ? [eq('jurisdiction', jurisdiction)] : []),
        'limit=1',
      ];
      const response = await request<SubscriptionRow[]>(`${REST}/subscriptions?${filters.join('&')}`, {
        token: identity.credential,
      });
      return response.ok && (response.body ?? []).length > 0;
    },

    async feedFor(feedToken) {
      // One `security definer` function rather than two table reads, because
      // the caller here is anonymous: a feed reader has a bearer token in a URL
      // and no session. Granting `anon` select on `readers` would let anyone
      // enumerate readers; granting it this function lets them exchange a token
      // they already hold for the one feed it names.
      const response = await request<
        {
          name: string;
          jurisdiction: string | null;
          kind: string | null;
          value: string | null;
          label: string | null;
          alerts: string | null;
        }[]
      >(`${REST}/rpc/feed_for_token`, { method: 'POST', body: { token: feedToken } });
      if (!response.ok || !response.body?.length) return null;

      // The function left-joins subscriptions, so a reader who follows nothing
      // comes back as one row of nulls rather than as no rows — which is how
      // "no such token" stays distinguishable from "an empty list".
      const rows = response.body;
      return {
        name: rows[0]!.name,
        subscriptions: rows
          .filter((row) => row.kind !== null)
          .map((row) => ({
            kind: row.kind!,
            value: row.value!,
            label: row.label ?? row.value!,
            jurisdiction: row.jurisdiction ?? ALL_JURISDICTIONS,
            alerts: row.alerts ?? 'none',
          })),
      };
    },

    async rotateFeedToken(identity) {
      const next = randomBytes(24).toString('hex');
      const response = await request<ReaderRow[]>(`${REST}/readers?select=feed_token`, {
        method: 'PATCH',
        token: identity.credential,
        headers: { prefer: 'return=representation' },
        body: { feed_token: next },
      });
      if (!response.ok) {
        throw new AccountsUnavailableError(`Could not rotate the feed token: ${response.error}`);
      }
      return next;
    },

    async check(): Promise<AccountCheck> {
      const findings: AccountCheck['findings'] = [
        { label: 'backend', ok: true, detail: `supabase at ${baseUrl}` },
      ];

      // Public, and the fastest way to tell a wrong URL from a wrong key.
      const settings = await request<{
        external?: Record<string, boolean>;
        disable_signup?: boolean;
        mailer_autoconfirm?: boolean;
      }>(`${AUTH}/settings`);
      findings.push({
        label: 'auth',
        ok: settings.ok,
        detail: settings.ok
          ? `reachable; sign-ups ${settings.body?.disable_signup ? 'disabled' : 'enabled'}, ` +
            `email confirmation ${settings.body?.mailer_autoconfirm ? 'off (auto-confirm)' : 'on'}`
          : (settings.error ?? 'unreachable'),
      });

      // Ask, as `anon`, for a row nobody anonymous should ever see. There are
      // four possible answers and only two of them are good:
      //
      //   permission denied  the table is there and `anon` has no grant on it,
      //                      which is what supabase/migrations/ sets up. Postgres
      //                      checks the table grant *before* it consults RLS, so
      //                      this is the strongest of the passes.
      //   200, no rows       also fine: the grant exists but a policy filtered
      //                      everything out.
      //   200, with rows     row-level security is off, or a policy is wrong.
      //                      The one answer that must be loud.
      //   404                the migration has not been run.
      //
      // The first version of this check treated anything non-2xx as a failure,
      // which called a correctly locked-down project broken — and, worse, called
      // a project with RLS *disabled* healthy.
      const readers = await request<ReaderRow[]>(`${REST}/readers?select=user_id&limit=1`);
      const denied =
        readers.status === 401 || readers.status === 403 || /permission denied/i.test(readers.error ?? '');
      const rows = Array.isArray(readers.body) ? readers.body.length : 0;

      findings.push({
        label: 'schema',
        ok: denied || (readers.ok && rows === 0),
        detail: denied
          ? 'public.readers exists and anon has no grant on it — locked down as intended'
          : readers.ok && rows === 0
            ? 'public.readers exists and returns nothing anonymously — RLS is filtering'
            : readers.ok
              ? 'public.readers returned rows to an anonymous caller — row-level security is OFF'
              : readers.status === 404
                ? `${readers.error} — run the migrations in supabase/migrations/`
                : // Not a 404, so do not send anyone to re-run migrations that
                  // are probably fine; this is more likely the project being
                  // unreachable.
                  (readers.error ?? 'unreachable'),
      });

      // A token nobody holds. The function should answer, and answer nothing.
      const rpc = await request<unknown[]>(`${REST}/rpc/feed_for_token`, {
        method: 'POST',
        body: { token: 'accounts-check-probe-not-a-real-token' },
      });
      findings.push({
        label: 'feed rpc',
        ok: rpc.ok && Array.isArray(rpc.body) && rpc.body.length === 0,
        detail: rpc.ok
          ? Array.isArray(rpc.body) && rpc.body.length === 0
            ? 'feed_for_token answers, and answers nothing for an unknown token'
            : 'feed_for_token returned rows for a token that does not exist'
          : (rpc.error ?? 'unreachable'),
      });

      findings.push({
        label: 'csrf key',
        // Not a failure either way: a generated key works, it just does not
        // survive a restart or reach a second instance.
        ok: true,
        detail: generated
          ? 'TOWNCIVIC_SESSION_SECRET is unset — generated per process, so open forms expire on restart'
          : 'TOWNCIVIC_SESSION_SECRET is set',
      });

      return { ok: findings.every((finding) => finding.ok), findings };
    },
  };
}
