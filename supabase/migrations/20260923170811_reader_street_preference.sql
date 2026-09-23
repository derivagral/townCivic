-- Apply before deploying the transcript-first UI. Existing readers start unset;
-- a browsing town or a followed search is never inferred to be a home address.
alter table public.readers
  add column if not exists street_status text not null default 'unset',
  add column if not exists home_jurisdiction text,
  add column if not exists street text,
  add column if not exists location_updated_at timestamptz;

alter table public.readers drop constraint if exists readers_street_preference;
alter table public.readers add constraint readers_street_preference check (
  street_status in ('unset', 'provided', 'declined')
  and (
    (street_status = 'provided'
      and home_jurisdiction is not null and length(trim(home_jurisdiction)) between 1 and 80
      and street is not null and length(trim(street)) between 1 and 160)
    or (street_status in ('unset', 'declined') and home_jurisdiction is null and street is null)
  )
);

-- Reuse the existing SELECT/UPDATE-own policies, including their WITH CHECK.
-- These are profile values, never authorization claims or notification consent.
alter table public.readers enable row level security;
grant update (street_status, home_jurisdiction, street, location_updated_at)
  on public.readers to authenticated;

comment on column public.readers.street_status is
  'unset = unanswered; provided = town/street supplied; declined = do not prompt. Separate from alert consent.';
comment on column public.readers.street is
  'Self-reported street name. No house number or geocoding is required.';

notify pgrst, 'reload schema';
