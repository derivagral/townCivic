# Transcript-first home and street preferences

The front page now prioritizes meeting transcripts and topic search. The old
header stacked brand, towns, exploration links, and channel links above a long
facet rail. Towns are now a select, exploration is one navigation row, and the
general feed's filters expand on demand. All board/source values remain available.
Nearby retains its topic filter as a select.

## Reader workflows

- `/` and `/meetings` show transcripts, newest meeting date first, in the chosen
  town (Milton by default). Search uses the existing full-text index, including
  transcript passages, and shows highlighted matching text. No model calls.
- “All meeting records” also includes notices, hearings, agendas, and minutes.
  “Upcoming” orders future records soonest first. These are individual published
  records, not a deduplicated meeting calendar.
- Timelines remains a primary destination; General feed is one click away at
  `/activity`. Existing filtered root URLs continue to serve the general feed.
- `/start` respects existing browser starting-view choices; its default is now
  Meetings. No extra account lookup is needed for that redirect.
- Sign-in and signup retain their return destination. With no destination, they
  lead to `/start`. Successful email-confirmation signup returns HTTP 200. The
  local-only recovery warning is no longer shown for hosted accounts.
- An authenticated reader with no street preference sees a nonblocking prompt.
  “Add street” opens the profile; “Prefer not to share” persists a declined choice.
  The profile supports editing, declining, or clearing the preference later.

## Profile contract

| Column                | Meaning                                                       |
| --------------------- | ------------------------------------------------------------- |
| `street_status`       | `unset`, `provided`, or `declined`                            |
| `home_jurisdiction`   | Explicitly chosen town; only populated when provided          |
| `street`              | Self-reported street name; no house number field or geocoding |
| `location_updated_at` | Time of the latest explicit save, decline, or clear           |

New and existing readers begin unset. Declining clears town/street and prevents
further prompts across devices and sessions. Clearing returns to unset and permits
prompting again. Browsing another town never changes the home town. Existing
follows are preserved; no demographic values are inferred. Location is neither an
authorization claim nor consent for notifications. Alert delivery remains off.

Supabase persists these columns on `readers`, using the existing owner policies
and additional column-scoped UPDATE grants. The personal-feed RPC does not return
location. Local SQLite accounts use the same store contract and additive columns.
Authenticated pages and auth forms are private/no-store.

## Deploy order

1. Apply `supabase/migrations/20260923170811_reader_street_preference.sql` to the
   hosted accounts database, using the existing migration process. This is additive
   and compatible with the old app. Do not deploy the new app before applying it:
   session resolution now selects the new columns.
2. Deploy the app and verify a test reader can sign in, save a town/street, decline,
   sign out and sign in again, and update that choice from the profile.
3. Verify `/meetings?town=milton-ma&q=budget` against the deployed transcript corpus.
   An empty result describes collected coverage, not an absence of local discussion.

Rolling back the app does not require removing the new profile columns. Keep them
so reader choices survive. No live schema, production accounts, ingestion, or alert
settings were changed while preparing this PR.

## Verification

The route/store tests cover full-text transcript matching, scope, chronology,
pagination, all board choices, legacy links, signup return paths, confirmation,
CSRF, invalid values, escaping, save failures, migration of SQLite accounts, and
provided/declined/unset transitions through both backends.

`test/sql/reader-location.sql` runs both real migration files in a disposable
PostgreSQL database with minimal auth-schema stand-ins. It checks backfill,
idempotence, constraints, owner updates, denial of other-reader updates, and denial
of anonymous reads. CI runs it on PostgreSQL 17. It also passed locally using
PGlite's PostgreSQL engine; this does not verify configuration of the live project.

Browser checks covered transcript search/open, signup, declining a street, saving a
street, and logout/login persistence. The desktop header measured 64 px at a
1440 px viewport; the 390 px mobile view had no page overflow. Screens were
reviewed using clearly labelled synthetic fixtures.
