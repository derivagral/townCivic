# Readers in Supabase

The optional accounts backend. Nothing here is needed to run townCivic — the
default is still the SQLite tables in `data/towncivic.db`, and `npm install &&
npm run seed && npm run serve` needs no account anywhere.

## What moves, and what does not

**Moves.** Identity and the per-person state: who a reader is, their password,
their session, and the list of what they follow. Everything that cannot be
regenerated.

**Stays.** Every civic record — events, matters, documents, geocodes, the
boundary files, the source registry. Those are derived from the town's own
website by the pipeline, they are the same for every reader, and they are
rebuildable by re-running `ingest`. Putting them in a hosted database would pay a
network round trip per page to store something the deploy can carry.

That split is what the change is for. It is the sentence in
[docs/operations.md](../docs/operations.md) that used to read _"if you run
accounts, the database stops being disposable"_ — with readers somewhere else,
`data/towncivic.db` goes back to being a cache you can delete, and the web tier
goes back to being something you can deploy onto ephemeral disk.

## What you get that the local backend does not have

The README's [Accounts](../README.md#accounts) section has always carried a list
of what is missing before this could face the internet. This is that list,
supplied by somebody whose job it is:

|                                        | local                 | supabase          |
| -------------------------------------- | --------------------- | ----------------- |
| password hashing                       | scrypt, per-user salt | bcrypt, in GoTrue |
| email confirmation                     | no                    | yes               |
| password reset                         | no                    | yes               |
| rate limiting and lockout              | no                    | yes               |
| a second factor                        | no                    | available         |
| OAuth / magic links                    | no                    | available         |
| readers survive `rm data/towncivic.db` | no                    | yes               |

`npm run accounts` prints the same table for whatever is actually configured,
and probes the project rather than assuming.

## Setup

### 1. A project, and its two public values

Create a project at [supabase.com](https://supabase.com). From **Project
Settings → API**, take the **Project URL** and the **anon** (publishable) key.

You will also see a **service role** key. townCivic never reads it, and you
should not put it in the web tier's environment: it bypasses row-level security,
which would make every policy in `migrations/` decorative.

### 2. Apply the migration

With the [Supabase CLI](https://supabase.com/docs/guides/local-development):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste `migrations/20260830120000_accounts.sql` into the dashboard's SQL
editor. It is idempotent — running it twice is harmless, which is also what
makes it safe to re-run after editing.

It creates two tables (`readers`, `subscriptions`), the policies that restrict
each to its own reader, a trigger that gives every account a feed token, and one
`security definer` function that lets an anonymous feed reader exchange a token
for the feed it names.

### 3. Point townCivic at it

```bash
export TOWNCIVIC_ACCOUNTS=supabase
export SUPABASE_URL=https://<project-ref>.supabase.co
export SUPABASE_ANON_KEY=<the anon key>
export TOWNCIVIC_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
export TOWNCIVIC_SECURE_COOKIES=1   # anything served over HTTPS
export TOWNCIVIC_BASE_URL=https://…
```

`TOWNCIVIC_SESSION_SECRET` is not optional here. There is no sessions table to
keep a per-session CSRF token in, so the token is an HMAC under this key —
see the comment on `csrfFor` in `../src/accounts/supabase.ts` for what that
trades away. Keep it stable across restarts (a new one invalidates every
in-flight form) and out of the repository.

### 4. Check it before a reader does

```bash
npm run accounts
```

It reports the backend, whether auth answers, whether the migration has been
applied, and whether the feed function is callable — and exits non-zero if any
of that is wrong, so a deploy can gate on it.

This is the whole reason the command exists. A misconfigured hosted backend does
not look broken: every public record still serves perfectly, because none of
them need an account. It fails on the first sign-in, which happens after the
deploy and usually not to you.

### 5. Settings worth deciding on

In the dashboard, under **Authentication**:

- **Confirm email.** On by default, and townCivic handles it: sign-up says
  "check your email" instead of signing anyone in. Turn it off only if you want
  the local backend's behaviour back.
- **Site URL and redirect URLs.** Must include `TOWNCIVIC_BASE_URL`, or the
  confirmation link lands nowhere.
- **Rate limits.** The defaults are sane and are one of the things you came here
  for.

## Existing local readers

There is no import command, and that is deliberate rather than an omission.

GoTrue stores bcrypt; the local backend stores scrypt. Password hashes cannot be
converted between them by anyone, including Supabase, so no migration can carry
an account over without the reader taking part. The choices are to invite each
one (`POST /auth/v1/admin/users` with the service role key, from a script run by
hand, then have them set a password) or to let them sign up again.

The local backend is a proof of concept. If it has no readers yet — check with
`npm run accounts` — switch now and there is nothing to migrate. If it does,
their subscriptions can be copied once the accounts exist:

```bash
# What each reader follows, keyed by the address rather than by the local id —
# the uuids are different on the other side.
sqlite3 -json data/towncivic.db \
  'SELECT u.email, s.jurisdiction, s.kind, s.value, s.label, s.alerts
     FROM subscriptions s JOIN users u ON u.id = s.user_id'
```

Then insert them against the new accounts with the service role key, once, from
somewhere that is not the web tier.

## Cost

The free tier is far more than this needs: readers and subscriptions are two
narrow tables with a row per person and a row per thing they follow. There are no
documents, no records and no full-text index in here — those stayed in SQLite.

The thing to watch is not storage but the pause: Supabase pauses free projects
after a week of inactivity, and a paused project means nobody can sign in. The
public records keep serving, because they do not go through here.

## What this costs in latency

One round trip per signed-in request, to resolve the session cookie. That call
both authenticates the token and fetches the reader, so it is one rather than
two — but it is one more than a local file, and it is the honest price of
putting state at a single point.

Signed-out readers pay nothing: every public page is served entirely from the
local database. If the round trip ever matters, the fix is a short-lived cache in
front of `resolve()` in `../src/accounts/supabase.ts`, with the caveat that it
would delay a sign-out taking effect on another device.

## Going further

Two doors this opens that are not walked through here:

- **Other sign-in methods.** Magic links and OAuth providers are dashboard
  switches. The trigger in the migration runs for every account however it was
  created, so a reader arriving through Google gets a reader row and a feed
  token with no code change. What is missing is the buttons.
- **Mirroring records into Postgres.** Would make the web tier stateless
  entirely, and let a static front end query records over PostgREST. It is a
  different change with a different budget — the events table and its full-text
  index are the large ones, and Supabase's free tier is 500 MB — and nothing
  here assumes it. See "Deliberately not built yet" in the main README.
