import { randomBytes } from 'node:crypto';

/**
 * A Supabase project, in memory.
 *
 * Enough GoTrue and PostgREST to drive `src/accounts/supabase.ts` through its
 * whole surface without an endpoint: token grants and rotation, bearer
 * authorization, `?column=eq."value"` filters, `Prefer: resolution=merge-
 * duplicates` upserts, `Prefer: return=minimal` 204s, and the `feed_for_token`
 * function.
 *
 * What it is not is Postgres. It cannot tell you the policies in
 * `supabase/migrations/` are right — it enforces "only your own rows" in
 * TypeScript, which is the thing those policies exist to stop anyone from
 * having to do. `towncivic accounts` is what asks the real project. This is for
 * the layer above: the request this repo builds, and what it does with the
 * answer.
 *
 * It is deliberately strict about the things a real project is strict about —
 * an unknown table is a 404 with PostgREST's own error shape, an expired token
 * is a 401, an insert whose `user_id` is not the caller's is a 403 — because a
 * fake that says yes to everything tests nothing.
 */

const ANON_KEY = 'anon-key';
const ACCESS_TOKEN_SECONDS = 3600;

interface User {
  id: string;
  email: string;
  password: string;
}

interface ReaderRow {
  user_id: string;
  email: string;
  display_name: string | null;
  feed_token: string;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  jurisdiction: string;
  kind: string;
  value: string;
  label: string;
  alerts: string;
}

interface Session {
  userId: string;
  refresh: string;
  expiresAt: number;
}

export interface FakeSupabaseOptions {
  /** The project requires a confirmed address, so sign-up issues no session. */
  confirmEmail?: boolean;
}

export interface FakeSupabase {
  fetch: typeof fetch;
  /** Invalidate every session, as a password change or a project reset would. */
  revokeEverything(): void;
  /** Pretend the migrations were never run. */
  dropSchema(): void;
  /** Answer every request with this status; 0 means the connection fails. */
  fail(status: number): void;
  /** Every distinct `apikey` header the client has sent. */
  seenKeys(): string[];
}

/**
 * Undo the quoting `src/accounts/supabase.ts` applies to a filter value.
 *
 * Written out rather than skipped, because it is half of the round trip the
 * punctuation test is checking: a client that quotes and a fake that ignores
 * quoting would agree with each other and disagree with PostgREST.
 */
function filterValue(raw: string): string {
  if (!raw.startsWith('eq.')) throw new Error(`the fake only implements eq., got: ${raw}`);
  const body = raw.slice(3);
  if (!body.startsWith('"') || !body.endsWith('"')) return body;
  return body.slice(1, -1).replace(/\\(.)/g, '$1');
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'grant_type', 'scope']);

export function fakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  const users = new Map<string, User>();
  const usersByEmail = new Map<string, string>();
  const readers = new Map<string, ReaderRow>();
  let subscriptions: SubscriptionRow[] = [];

  const sessions = new Map<string, Session>(); // access token -> session
  const refreshIndex = new Map<string, string>(); // refresh token -> access token

  const apiKeys = new Set<string>();
  let failStatus: number | null = null;
  let schema = true;

  // The same clock the client reads, so a test that moves time forward expires
  // the token on both sides. A skew of its own here would let the fake believe
  // a token is dead while the client still thinks it is good — which is a real
  // situation, but not the one the refresh path is for.
  const now = () => Math.floor(Date.now() / 1000);
  const id = () => randomBytes(16).toString('hex');

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const noContent = () => new Response(null, { status: 204 });

  function issue(userId: string) {
    const access = randomBytes(24).toString('base64url');
    const refresh = randomBytes(16).toString('base64url');
    sessions.set(access, { userId, refresh, expiresAt: now() + ACCESS_TOKEN_SECONDS });
    refreshIndex.set(refresh, access);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: ACCESS_TOKEN_SECONDS,
      token_type: 'bearer',
    };
  }

  /** Null for the anonymous role, a user id for a valid bearer, undefined for a bad one. */
  function roleOf(request: Request): string | null | undefined {
    const header = request.headers.get('authorization') ?? '';
    const bearer = header.replace(/^Bearer\s+/i, '');
    if (bearer === ANON_KEY) return null;
    const session = sessions.get(bearer);
    if (!session) return undefined;
    if (session.expiresAt <= now()) return undefined;
    return session.userId;
  }

  function readerFor(userId: string): ReaderRow {
    const row = readers.get(userId);
    if (!row) throw new Error(`no reader row for ${userId} — the trigger did not run`);
    return row;
  }

  function matches(row: SubscriptionRow, url: URL): boolean {
    for (const [key, raw] of url.searchParams) {
      if (RESERVED.has(key)) continue;
      if ((row as unknown as Record<string, string>)[key] !== filterValue(raw)) return false;
    }
    return true;
  }

  const missingTable = (name: string) =>
    json(
      {
        code: 'PGRST205',
        message: `Could not find the table 'public.${name}' in the schema cache`,
        hint: null,
        details: null,
      },
      404,
    );

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const body =
      request.body || ['POST', 'PATCH', 'PUT'].includes(request.method)
        ? await request
            .clone()
            .text()
            .then((text) => (text ? (JSON.parse(text) as Record<string, unknown>) : {}))
        : {};

    /* ------------------------------------------------------------- gotrue */

    if (path === '/auth/v1/settings') {
      return json({ disable_signup: false, mailer_autoconfirm: !options.confirmEmail, external: {} });
    }

    if (path === '/auth/v1/signup') {
      const email = String(body['email'] ?? '').toLowerCase();
      if (usersByEmail.has(email)) return json({ msg: 'User already registered' }, 400);

      const user: User = { id: id(), email, password: String(body['password'] ?? '') };
      users.set(user.id, user);
      usersByEmail.set(email, user.id);

      // The trigger in supabase/migrations/ — every account gets a reader row
      // and a feed token, however it was created.
      const meta = (body['data'] ?? {}) as Record<string, unknown>;
      readers.set(user.id, {
        user_id: user.id,
        email: user.email,
        display_name: (meta['display_name'] as string | null) || null,
        feed_token: randomBytes(24).toString('hex'),
      });

      if (options.confirmEmail) return json({ id: user.id, email: user.email, confirmed_at: null });
      return json({ ...issue(user.id), user: { id: user.id, email: user.email } });
    }

    if (path === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');

      if (grant === 'password') {
        const userId = usersByEmail.get(String(body['email'] ?? '').toLowerCase());
        const user = userId ? users.get(userId) : undefined;
        if (!user || user.password !== String(body['password'] ?? '')) {
          return json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400);
        }
        return json({ ...issue(user.id), user: { id: user.id, email: user.email } });
      }

      if (grant === 'refresh_token') {
        const previous = refreshIndex.get(String(body['refresh_token'] ?? ''));
        const session = previous ? sessions.get(previous) : undefined;
        if (!session) {
          return json({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }, 400);
        }
        // Rotation: the old pair stops working once the new one is issued.
        sessions.delete(previous!);
        refreshIndex.delete(session.refresh);
        return json(issue(session.userId));
      }

      return json({ error: 'unsupported_grant_type' }, 400);
    }

    if (path === '/auth/v1/logout') {
      const role = roleOf(request);
      if (typeof role !== 'string') return json({ msg: 'invalid claim' }, 401);
      for (const [access, session] of sessions) {
        if (session.userId !== role) continue;
        const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
        // scope=local: only the session that asked, not every device.
        if (url.searchParams.get('scope') === 'local' && access !== bearer) continue;
        sessions.delete(access);
        refreshIndex.delete(session.refresh);
      }
      return noContent();
    }

    /* ----------------------------------------------------------- postgrest */

    if (path === '/rest/v1/rpc/feed_for_token') {
      if (!schema) return json({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      const row = [...readers.values()].find((reader) => reader.feed_token === String(body['token'] ?? ''));
      if (!row) return json([]);

      const name = row.display_name || row.email.split('@')[0];
      const mine = subscriptions.filter((s) => s.user_id === row.user_id);
      // A left join: no subscriptions is one row of nulls, not no rows.
      if (!mine.length) {
        return json([{ name, jurisdiction: null, kind: null, value: null, label: null, alerts: null }]);
      }
      return json(
        mine.map((s) => ({
          name,
          jurisdiction: s.jurisdiction,
          kind: s.kind,
          value: s.value,
          label: s.label,
          alerts: s.alerts,
        })),
      );
    }

    if (path === '/rest/v1/readers') {
      if (!schema) return missingTable('readers');
      const role = roleOf(request);
      if (role === undefined) return json({ message: 'JWT expired', code: 'PGRST301' }, 401);
      // The anon role sees no rows: that is the policy, and it is what
      // `accounts check` relies on to distinguish "RLS is on" from "no table".
      if (role === null) return json([]);

      if (request.method === 'PATCH') {
        const row = readerFor(role);
        if (typeof body['feed_token'] === 'string') row.feed_token = body['feed_token'];
        if ('display_name' in body) row.display_name = (body['display_name'] as string | null) ?? null;
        return json([row]);
      }
      return json([readerFor(role)]);
    }

    if (path === '/rest/v1/subscriptions') {
      if (!schema) return missingTable('subscriptions');
      const role = roleOf(request);
      if (role === undefined) return json({ message: 'JWT expired', code: 'PGRST301' }, 401);
      if (role === null) return json([]);

      if (request.method === 'POST') {
        if (body['user_id'] !== role) {
          return json({ message: 'new row violates row-level security policy', code: '42501' }, 403);
        }
        const row: SubscriptionRow = {
          id: id(),
          user_id: role,
          jurisdiction: String(body['jurisdiction'] ?? '*'),
          kind: String(body['kind']),
          value: String(body['value']),
          label: String(body['label']),
          alerts: String(body['alerts'] ?? 'none'),
        };
        const merge = (request.headers.get('prefer') ?? '').includes('resolution=merge-duplicates');
        const existing = subscriptions.find(
          (s) =>
            s.user_id === row.user_id &&
            s.jurisdiction === row.jurisdiction &&
            s.kind === row.kind &&
            s.value === row.value,
        );
        if (existing && !merge) {
          return json({ message: 'duplicate key value violates unique constraint', code: '23505' }, 409);
        }
        if (existing) {
          existing.label = row.label;
          existing.alerts = row.alerts;
        } else {
          subscriptions.push(row);
        }
        return noContent();
      }

      if (request.method === 'DELETE') {
        subscriptions = subscriptions.filter((s) => !(s.user_id === role && matches(s, url)));
        return noContent();
      }

      const mine = subscriptions
        .filter((s) => s.user_id === role && matches(s, url))
        .map(({ jurisdiction, kind, value, label, alerts }) => ({
          jurisdiction,
          kind,
          value,
          label,
          alerts,
        }));
      const limit = Number(url.searchParams.get('limit') ?? mine.length);
      return json(mine.slice(0, limit));
    }

    return json({ message: `the fake has no route for ${request.method} ${path}` }, 404);
  };

  return {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input as Request, init);
      const key = request.headers.get('apikey');
      if (key) apiKeys.add(key);

      if (failStatus === 0) throw new TypeError('fetch failed');
      if (failStatus !== null) return json({ message: `upstream said ${failStatus}` }, failStatus);
      return handle(request);
    }) as typeof fetch,

    revokeEverything() {
      sessions.clear();
      refreshIndex.clear();
    },
    dropSchema() {
      schema = false;
    },
    fail(status) {
      failStatus = status;
    },
    seenKeys() {
      return [...apiKeys].sort();
    },
  };
}
