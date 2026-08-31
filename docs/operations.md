# Running townCivic

The pipeline is five commands, and the shape of an operational deployment is
mostly a question of where you put the two pieces of state.

## The cycle

```
ingest     fetch every enabled source, normalize, store what changed
extract    open the linked PDFs and read what the meetings are about
link       group records about the same property or article into timelines
interpret  read votes and dispositions out of the prose in minutes
geocode    resolve linked addresses to coordinates for the map
```

They run in that order because each depends on what the one before it wrote.
Only `ingest`, `extract` and `geocode` touch the network; `link` and `interpret`
(with the default provider) are pure functions of the database.

Every one of them takes `--jurisdiction <id>`, or `--jurisdiction all` for every
registered town in one pass. `all` is what the scheduled refresh runs, so adding a
town to the registry adds it to the schedule with no edit to the job. The
per-host politeness delay is what keeps several towns in one run from becoming a
burst at any one of them — they are different hosts, so the delay does not stack
into a slow run either.

`boundary` sits outside this cycle. It refetches the town outline from MassGIS
and is a maintenance command like `discover` — run it by hand, read the diff,
commit it. Nothing in the running system calls it, and the outline it writes is
what `geocode` fences against.

`status` reports what came out of it and exits non-zero on a problem, which is
the whole monitoring story:

```bash
npm run status                          # the default town
npm run status -- --jurisdiction all    # every town; the worst exit code wins
npm run status -- --json | jq .problems
```

A town that is registered with nothing enabled yet reports counts and no
problems. That is deliberate: a town can sit in the registry for months waiting
for someone to run `discover` against its site, and a red light that is always on
is the same as no red light at all.

## The two pieces of state

|                     |                                                                             |
| ------------------- | --------------------------------------------------------------------------- |
| `data/documents/`   | Content-addressed raw bodies. **The authority.** Never overwritten.         |
| `data/towncivic.db` | Everything else. Derived, and rebuildable from the documents by re-running. |

Accounts are the exception: `users`, `sessions` and `subscriptions` live in the
same SQLite file but are _not_ derived from anything. If you run accounts on the
default backend, the database stops being disposable — back it up, or accept
that dropping it signs everybody out and loses their subscriptions.

That is also why one database holds every town rather than one file per town.
The records are disposable and the readers are not, and a reader is a person
rather than a town: splitting the files would mean either splitting the accounts
or keeping a separate account database anyway.

### Moving the exception out

`TOWNCIVIC_ACCOUNTS=supabase` puts readers in a hosted Postgres and leaves every
record where it is. Then there are still two pieces of state, but the second one
is not on this machine:

|                     |                                                                            |
| ------------------- | -------------------------------------------------------------------------- |
| `data/documents/`   | The authority. Still yours, still a volume.                                |
| `data/towncivic.db` | Derived, and now **disposable again** — delete it and re-run the pipeline. |
| Supabase            | Readers and subscriptions. The only thing that must be backed up.          |

Setup is in [supabase/README.md](../supabase/README.md); `npm run accounts`
reports what is configured and probes it. Two operational notes:

- A signed-in request costs one round trip to resolve the session cookie.
  Signed-out pages cost nothing, and when the hosted project is unreachable they
  keep serving — the site degrades to signed-out rather than to a 500. That is
  the right failure for something that is nearly all public records.
- Supabase pauses free projects after a week of inactivity, and a paused project
  means nobody can sign in. The records are unaffected, which makes it a quiet
  failure — `npm run accounts` is what turns it into a loud one.

### Clearing one town

With several towns, "start over" can no longer mean deleting the file. `clear`
removes one town at a layer:

```bash
npx tsx src/cli.ts clear --jurisdiction hull-ma --scope derived --dry-run
npx tsx src/cli.ts clear --jurisdiction hull-ma --scope records
npx tsx src/cli.ts clear --orphans        # towns with rows but no registry entry
```

`derived` drops matters, places and readings (rebuild with `link`, `geocode`,
`interpret`); `records` also drops `events` (rebuild with `ingest`, `extract`);
`town` also drops its sources, fetch log, document index and its row in
`jurisdictions`. Nothing in any scope touches `data/documents/`, which is the
authority. `--dry-run` counts what would go using the same SQL the delete uses.

`records` and `town` also clear each source's stored ETag and `Last-Modified`,
because otherwise the next `ingest` sends them, the town answers 304, and the
town you just emptied refills with nothing.

`derived` and `records` keep the geocode cache. `link` rebuilds `places` from it
with no network, so rebuilding timelines and the map is free; only `--scope town`
drops the cache, because only then are the addresses gone too.

### After an upgrade

```bash
git pull && npm i
npm run towns                            # what the registry now holds
npm run ingest -- --jurisdiction all     # pick up towns the pull added
npm run status -- --jurisdiction all
```

Nothing else. The next command that opens the database migrates it in place, and
every migration is idempotent, so there is no ordering to get right and no step
to skip if it has already run. `status` names anything the upgrade could not
decide on its own — a town with rows that the registry no longer lists, or a
source row that was dropped rather than renamed.

Starting over is a matter of choosing a layer: `clear --scope derived` to
rebuild timelines and the map, `--scope records` to re-fetch one town,
`rm -f data/towncivic.db*` to rebuild everything from the document store (the
`*` matters — WAL leaves `-wal` and `-shm` beside it), and `rm -rf data/` only
when the archive itself is disposable, which it is not once the town has stopped
publishing something it used to.

## Four shapes that work

### 1. Scheduled job, no server — what this repo does

`.github/workflows/refresh.yml` runs the cycle twice a day, restores the
previous database from the Actions cache, and publishes it as an artifact. No
host, no bill, and `status` failing turns the run red.

Good for: keeping the archive current, proving the pipeline still works against
the live site, having a database to download.

The catch: no live site, and the Actions cache is a cache — it can be evicted,
so treat a rebuild-from-scratch as a normal event rather than a disaster. Also
note that GitHub disables scheduled workflows on repositories with no activity
for 60 days.

### 2. One small machine

A `$5` VM, a systemd timer, and `npm run serve` behind a reverse proxy that
terminates TLS.

```ini
# /etc/systemd/system/towncivic-refresh.service
[Service]
Type=oneshot
WorkingDirectory=/srv/towncivic
Environment=TOWNCIVIC_DATA_DIR=/var/lib/towncivic
ExecStart=/usr/bin/npm run ingest -- --jurisdiction all
ExecStart=/usr/bin/npm run extract -- --jurisdiction all --limit 200
ExecStart=/usr/bin/npm run link -- --jurisdiction all
ExecStart=/usr/bin/npm run interpret -- --jurisdiction all
ExecStart=/usr/bin/npm run status -- --jurisdiction all
```

```ini
# /etc/systemd/system/towncivic-refresh.timer
[Timer]
OnCalendar=*-*-* 07,19:10:00
Persistent=true
```

`Persistent=true` matters: it runs a missed cycle after a reboot rather than
waiting half a day.

Set `TOWNCIVIC_SECURE_COOKIES=1` and `TOWNCIVIC_BASE_URL=https://…` — the first
is required for the session cookie to be safe over the public internet, the
second so feed self-links point somewhere real.

Good for: the actual product. Live site, live feeds, accounts, one thing to
watch.

### 3. Container with a volume

Same as (2), containerised, with `data/` on a persistent volume. Run the cycle
as a separate scheduled task against the same volume rather than inside the web
container, so a long extraction cannot take the site down with it.

Whatever runs it, **`data/` must be a volume.** An ephemeral filesystem means
re-downloading the town's entire archive on every deploy, which is rude.

### 4. Ephemeral web tier, hosted readers

The shape the accounts port exists for. The pipeline runs where the document
store is — (1) or (2) above — and publishes `data/towncivic.db` as a build
artifact. The web tier is a container that carries that file read-only, holds no
volume of its own, and keeps readers in Supabase.

```bash
TOWNCIVIC_ACCOUNTS=supabase
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=…
TOWNCIVIC_SESSION_SECRET=…        # stable across restarts; a new one expires every open form
TOWNCIVIC_SECURE_COOKIES=1
TOWNCIVIC_BASE_URL=https://…
```

Gate the deploy on `npm run accounts`, which exits non-zero if the project is
unreachable or the migrations have not been applied. Then the web tier can be
redeployed, scaled to several instances, or thrown away and rebuilt without
anybody being signed out, because nothing a reader owns is on its disk.

What this does not buy: the pipeline still needs somewhere with a real volume,
because `data/documents/` is the authority and no amount of hosting changes
that. This shape moves the _web_ tier onto ephemeral infrastructure, not the
archive.

### Not a shape: GitHub Pages

Worth stating plainly, because moving accounts out makes it look closer than it
is. **townCivic cannot run on GitHub Pages.** Pages serves static files; `serve`
is a Node process — Hono routes, `POST /login`, server-set cookies, and
`node:sqlite` reading a real file. There is no configuration that bridges that,
and hosting accounts elsewhere does not help, because it is the server that is
missing rather than the database.

Two things that _would_ work, and are different from each other:

- **Somewhere that runs Node.** A small VM, Fly, Render, Railway — shape (2) or
  (4) above. `node:sqlite` needs Node ≥ 22.5 and a filesystem, which also rules
  out the edge runtimes (Workers, Deno Deploy) even though Hono itself runs on
  them. Set `TOWNCIVIC_BASE_URL` to that hostname.
- **A static build that is not this one.** Records rendered to flat HTML at
  build time, with the browser talking to Supabase directly using the publishable
  key and RLS. That is the canonical static-site-plus-hosted-backend shape and it
  is entirely coherent — but it is a second front end, not a deploy target for
  this one: no server-rendered pages, no server-side session cookie, and the
  filter and search paths would have to be rebuilt against PostgREST instead of
  FTS5.

Publishing a subfolder to Pages alongside a real server elsewhere is fine — but
`TOWNCIVIC_BASE_URL` must point at the server, not at the Pages site, or every
feed's `self` link and every personal-feed URL resolves to a 404.

## Being a good citizen

The defaults exist for a reason and the schedule is part of them:

- One request per host per second (`TOWNCIVIC_HOST_DELAY_MS`).
- The geocode cache, which means the US Census is asked about each address once
  rather than on every refresh. `link` re-derives the map from it for free.
- Conditional GETs, so an unchanged page costs the town a 304.
- Twice a day. Meeting notices run on a 48-hour clock; polling hourly finds the
  same nothing twenty-three extra times.
- `extract --limit` caps how many documents one run opens, **per town** — so
  `--jurisdiction all --limit 150` can open 150 for each of them. That is the
  fair reading: one town's nine-year backlog should not starve another's
  next-week agendas. Divide the limit if the total is what you care about.

If you fork this for another town, keep them.

## Cost

Everything in the default path is free and needs no account: the town's own
website, the US Census geocoder, MassGIS, and `node:sqlite`. The only metered thing is
`interpret --provider anthropic`, which is off unless both a key and the SDK are
present. The `rules` provider is the default precisely so the pipeline has no
floor cost.

## What to watch

`status --json` gives you all of it. In order of how much it should worry you:

| Signal                                 | What it usually means                                          |
| -------------------------------------- | -------------------------------------------------------------- |
| `problems` non-empty                   | Read it; each entry names the source                           |
| a source failing repeatedly            | The town changed its site — run `verify`, then `discover`      |
| `answered but has produced no records` | The URL is right and the adapter is not, or the feed is empty  |
| `nothing new in N days`                | Often just August. Check the town's site before assuming a bug |
| `documentsPending` only growing        | `extract --limit` is set lower than the arrival rate           |
| `orphans` non-empty                    | A town was dropped from the registry with its rows still there |

The quiet failure is the one worth designing for: a crawler that keeps returning
200 while the town silently stops publishing looks exactly like a quiet week.
That is why `status` reports when each source last produced something new rather
than only whether the last fetch succeeded.
