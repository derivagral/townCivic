-- Run only in a disposable PostgreSQL database, from the repository root:
-- psql -v ON_ERROR_STOP=1 -f test/sql/reader-location.sql
begin;
create role anon;
create role authenticated;
create schema auth;
create schema extensions;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

\ir ../../supabase/migrations/20260830120000_accounts.sql
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'one@example.test'),
  ('00000000-0000-0000-0000-000000000002', 'two@example.test');
\ir ../../supabase/migrations/20260923170811_reader_street_preference.sql
-- Reapplying the additive migration must preserve the same state.
\ir ../../supabase/migrations/20260923170811_reader_street_preference.sql

do $$ begin
  if (select count(*) from public.readers where street_status = 'unset' and street is null) <> 2
    then raise exception 'existing readers were not backfilled'; end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
update public.readers set street_status = 'provided', home_jurisdiction = 'milton-ma',
  street = 'Adams Street', location_updated_at = now()
  where user_id = '00000000-0000-0000-0000-000000000001';

do $$ declare changed integer; begin
  if (select count(*) from public.readers) <> 1 then raise exception 'RLS leaked another reader'; end if;
  if (select street from public.readers) <> 'Adams Street' then raise exception 'own save failed'; end if;
  update public.readers set street_status = 'declined', street = null, home_jurisdiction = null
    where user_id = '00000000-0000-0000-0000-000000000002';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'updated another reader'; end if;
  begin
    update public.readers set street_status = 'declined';
    raise exception 'decline retained a street';
  exception when check_violation then null; end;
  begin
    update public.readers set street = '  ';
    raise exception 'blank provided street accepted';
  exception when check_violation then null; end;
  begin
    update public.readers set user_id = '00000000-0000-0000-0000-000000000002';
    raise exception 'reader ownership changed';
  exception when insufficient_privilege then null; end;
end $$;
update public.readers set street_status = 'declined', home_jurisdiction = null, street = null, location_updated_at = now();
do $$ begin
  if (select street_status from public.readers) <> 'declined' then raise exception 'decline not saved'; end if;
end $$;
set local role anon;
do $$ begin
  begin
    perform street from public.readers;
    raise exception 'anonymous access leaked street';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  if (select street_status from public.readers where user_id = '00000000-0000-0000-0000-000000000002') <> 'unset'
    then raise exception 'other reader changed'; end if;
end $$;
rollback;
