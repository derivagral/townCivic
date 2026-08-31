-- townCivic readers, in Supabase.
--
-- This is the hosted half of `src/accounts/`: the two tables that hold what a
-- reader is, plus the policies that decide who may see them. Identity itself is
-- not here — `auth.users` is GoTrue's, and password hashing, email
-- confirmation, reset and rate limiting are its job rather than ours. That
-- division is the entire point of moving accounts out: the list of things the
-- local backend does not do is exactly the list this does not implement either,
-- because someone else already has.
--
-- Two tables:
--
--   readers        one row per account, carrying the things GoTrue has no
--                  opinion about — a display name and the personal-feed token.
--   subscriptions  what each reader follows. Same columns as the SQLite table
--                  it replaces, so `personalFeed()` needs no change: the join
--                  between a reader's list and the records has always been in
--                  application code, not in SQL, which is what makes splitting
--                  the two stores possible at all.
--
-- Every policy is written against `auth.uid()`, and the web tier holds only the
-- anon key, so Postgres — not our `WHERE` clauses — is what keeps one reader's
-- list out of another's. A service role key on the web tier would make every
-- policy below decorative; townCivic never reads one at runtime.
--
-- Idempotent throughout: `create ... if not exists` where the statement has it,
-- and drop-then-create for policies and triggers, which do not.

create extension if not exists pgcrypto with schema extensions;

/* ------------------------------------------------------------------ readers */

create table if not exists public.readers (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  -- Denormalized from auth.users, kept current by the trigger below. Copied
  -- rather than joined so that resolving a session is one PostgREST read: that
  -- read happens on every signed-in request, and a join across the auth schema
  -- would need a view and a wider grant to pay for itself.
  email        text,
  display_name text,
  -- Bearer token for the personal Atom feed, for readers that cannot hold a
  -- cookie. Hex rather than base64 because it goes in a URL path segment.
  feed_token   text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at   timestamptz not null default now()
);

comment on table public.readers is
  'The half of an account that is townCivic''s rather than GoTrue''s.';

/* ------------------------------------------------------------ subscriptions */

-- `jurisdiction` is the town the subscription was made in, or '*' for every
-- town. It is not decoration: `value` is only unique *within* a town. "Planning
-- Board" means a different set of records in Milton than in Hull, and without
-- this column a reader following Milton's would silently start receiving Hull's
-- the moment Hull was ingested.
create table if not exists public.subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  jurisdiction text not null default '*',
  kind         text not null check (kind in ('matter', 'body', 'channel', 'search')),
  value        text not null,
  label        text not null,
  -- none | digest | immediate. Only `none` is honoured today — nothing sends
  -- mail yet — so the column records intent rather than behaviour.
  alerts       text not null default 'none' check (alerts in ('none', 'digest', 'immediate')),
  created_at   timestamptz not null default now(),
  unique (user_id, jurisdiction, kind, value)
);

create index if not exists idx_subscriptions_user on public.subscriptions (user_id);

/* ------------------------------------------------- a reader per auth.users */

-- Runs for every account however it was created — the sign-up form, a magic
-- link, an OAuth provider added later, or a row inserted by hand in the
-- dashboard. Putting it in a trigger rather than in the sign-up path is what
-- makes "every account has a feed token" true rather than merely usual.
create or replace function public.handle_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.readers (user_id, email, display_name)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  )
  -- `readers` rather than `public.readers` on the right: inside ON CONFLICT the
  -- target row is addressed by the table's bare name, whatever the search path.
  on conflict (user_id) do update
    set email = excluded.email,
        -- Only fill a display name in, never blank one out: a reader who later
        -- signs in with a provider that has no name should keep the one they
        -- chose.
        display_name = coalesce(excluded.display_name, readers.display_name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_changed on auth.users;
create trigger on_auth_user_changed
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.handle_auth_user();

-- Accounts that predate this migration, including any imported from a local
-- database. Cheap, and it makes running the migration twice harmless.
insert into public.readers (user_id, email, display_name)
select u.id, u.email, nullif(u.raw_user_meta_data ->> 'display_name', '')
  from auth.users u
 on conflict (user_id) do nothing;

/* -------------------------------------------------------- row-level security */

alter table public.readers enable row level security;
alter table public.subscriptions enable row level security;

drop policy if exists "readers select own" on public.readers;
create policy "readers select own" on public.readers
  for select using ((select auth.uid()) = user_id);

-- Update, so a reader can rotate their own feed token or change their display
-- name. No insert policy (the trigger owns that) and no delete policy (the row
-- goes when the account does, by cascade).
drop policy if exists "readers update own" on public.readers;
create policy "readers update own" on public.readers
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "subscriptions select own" on public.subscriptions;
create policy "subscriptions select own" on public.subscriptions
  for select using ((select auth.uid()) = user_id);

drop policy if exists "subscriptions insert own" on public.subscriptions;
create policy "subscriptions insert own" on public.subscriptions
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "subscriptions update own" on public.subscriptions;
create policy "subscriptions update own" on public.subscriptions
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "subscriptions delete own" on public.subscriptions;
create policy "subscriptions delete own" on public.subscriptions
  for delete using ((select auth.uid()) = user_id);

/* ------------------------------------------------------------ the feed token */

-- The personal Atom feed is fetched by a feed reader: a bearer token in a URL
-- path and nothing else — no cookie, no session, no `auth.uid()`. So it cannot
-- use any of the policies above, and the tempting alternatives are both bad.
-- Granting `anon` select on `readers` would let anyone enumerate every account;
-- putting a service role key in the web tier would bypass every policy on this
-- page.
--
-- This is the third option: one `security definer` function that trades a token
-- the caller already holds for exactly the feed it names, and nothing else. Not
-- the email, not the reader id, not any other reader. `anon` may execute this
-- and nothing more.
--
-- A left join rather than an inner one, so a reader who follows nothing comes
-- back as a single row of nulls. That is what keeps "no such token" (no rows)
-- distinguishable from "an empty list" (one row), which decides 404 vs. an
-- empty feed.
--
-- Note for anyone turning on statement logging: the token is a function
-- argument, so `log_statement = 'all'` with parameter logging will write it to
-- the Postgres log. Rotate the affected tokens if that has been on.
create or replace function public.feed_for_token(token text)
returns table (
  name         text,
  jurisdiction text,
  kind         text,
  value        text,
  label        text,
  alerts       text
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    coalesce(nullif(r.display_name, ''), split_part(coalesce(r.email, 'reader'), '@', 1)) as name,
    s.jurisdiction,
    s.kind,
    s.value,
    s.label,
    s.alerts
  from public.readers r
  left join public.subscriptions s on s.user_id = r.user_id
  where r.feed_token = token
  order by s.jurisdiction, s.kind, s.label;
$$;

/* --------------------------------------------------------------- privileges */

grant usage on schema public to anon, authenticated;

-- `authenticated` gets the tables, and RLS narrows that to their own rows.
-- Two statements because PostgreSQL's table-level and column-level GRANT are
-- different forms and cannot be combined. The column list is the point of the
-- second: a reader may change their display name and rotate their feed token,
-- and may not edit the email GoTrue is the authority on.
grant select on public.readers to authenticated;
grant update (display_name, feed_token) on public.readers to authenticated;
grant select, insert, update, delete on public.subscriptions to authenticated;

-- `anon` gets no table at all — only the one function, and only to spend a
-- token it already has.
revoke all on function public.feed_for_token(text) from public;
grant execute on function public.feed_for_token(text) to anon, authenticated;

-- PostgREST caches the schema. Supabase reloads it on DDL automatically; this
-- makes running the file by hand in the SQL editor behave the same way.
notify pgrst, 'reload schema';
