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

### Moving the archive out

`TOWNCIVIC_DOCUMENTS=s3` puts `data/documents/` in any S3-compatible object
store — Cloudflare R2, Tigris, Backblaze B2, MinIO, AWS. Configuration is an
endpoint and a key pair, deliberately rather than a provider integration: the
reason to use object storage instead of a platform's bundled add-on is that the
bucket should outlive the decision about where the app runs.

```bash
export TOWNCIVIC_DOCUMENTS=s3
export S3_BUCKET=towncivic
export S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS
export S3_REGION=auto                                            # a real region on AWS
export S3_ACCESS_KEY_ID=…
export S3_SECRET_ACCESS_KEY=…

npm run documents                 # probe it: a real write, read and delete
npm run documents -- --backfill   # copy an existing local archive in
```

`--backfill` reads its manifest from the database rather than by walking a
directory, because `documents.path` and `attachments.path` already name every
object and their `id` is the content hash. Keys are the same in both backends,
so this is a copy rather than a migration: it is restartable, an object already
there is skipped, and a row whose file is missing from disk is counted and
reported rather than passed over.

This is what frees the pipeline from a persistent disk. With the archive in
object storage, `.github/workflows/refresh.yml` running in Actions is durable on
its own instead of depending on a cache that can be evicted — and combined with
readers in Supabase, nothing that matters lives on any machine you have to keep.

Sizing, from four towns of Massachusetts municipal records: about 550 MB, of
which 510 MB is roughly 1,850 attachment PDFs averaging 276 KB, and 40 MB is
listing pages. R2's free tier is 10 GB. Requests are negligible in both
directions — the pipeline writes at most a few hundred objects a day and nothing
reads the archive at all.

#### Setting up a bucket, end to end

Cloudflare R2, because it is the one with a 10 GB free tier and no egress
charge. Any S3-compatible store works the same way; only the endpoint changes.

**1. A bucket, and the endpoint.** Create a bucket in the R2 dashboard. Take the
**account ID** from the R2 overview page — the S3 endpoint is
`https://<account-id>.r2.cloudflarestorage.com`, and the region is the literal
string `auto`.

**2. A key pair — not a Cloudflare API token.** In R2, **Manage API tokens →
Create API token**, scoped to _Object Read & Write_ on that one bucket. What
comes back is an **Access Key ID** and a **Secret Access Key**, and the secret is
shown once.

This is the step with a trap in it. Cloudflare also issues _API tokens_, which
are bearer tokens for Cloudflare's own REST API and look like the obvious thing
to reach for. The S3 protocol cannot use one: it signs each request with a key
pair, so `CF_API_TOKEN` has nowhere to go. townCivic never sends a bearer token
to a bucket.

**3. Point at it and prove it.**

```bash
export TOWNCIVIC_DOCUMENTS=s3
export S3_BUCKET=towncivic
export S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export S3_REGION=auto
export S3_ACCESS_KEY_ID=…
export S3_SECRET_ACCESS_KEY=…

npm run documents
```

That writes, reads back and deletes a probe object, which is the only check that
proves the credentials, the signature, the region and the bucket policy are all
right _at once_. It exits non-zero if any of them is not.

**4. Move the archive you already have.**

```bash
npm run documents -- --backfill
```

Run this **from wherever the archive actually is** — your laptop, most likely.
Nothing else has a copy: a fresh Actions runner has an empty `data/`, so the
scheduled job cannot do this for you. About 550 MB and a few thousand requests,
comfortably inside R2's free tier, and safe to interrupt and re-run.

`.env.example` lists every variable in one place.

#### Doing all of it from the cloud

Two commands and a workflow, so the operational loop does not live in a shell.

```bash
npm run preflight                        # both dependencies, one exit code
./scripts/sync-github-config.sh          # show what would go to Actions
./scripts/sync-github-config.sh --apply  # send it
gh workflow run Preflight                # prove it from up there
```

`gh workflow run Preflight` answers `could not find any workflows named
Preflight` until `preflight.yml` is on the **default branch**. That is GitHub,
not a typo: `workflow_dispatch` workflows are registered from the default branch
only, so a workflow that exists solely on a feature branch cannot be dispatched —
not even by naming the branch. Merge first, then dispatch. Secrets and variables
are repository-level and can be set at any time, so the sync script works before
the merge.

`preflight` asks the question an operator actually has, which is "can I deploy",
rather than "is the bucket reachable". It runs the archive check and the accounts
check, adds the two serve-time settings that are only wrong _in combination_ —
a `Secure` cookie over plain HTTP is never sent, so signing in silently does
nothing — and exits non-zero if anything is not ready.

`scripts/sync-github-config.sh` copies a working `.env` into the repository's
Actions configuration, so the values are not retyped into a web form. It follows
one rule, which is also the rule the workflows follow:

> **The locator is a variable. The credential is a secret.**

A bucket name, an endpoint, a project URL: not credentials, and masking them
turns a configuration mistake into an unreadable log. Keys are secrets. Anything
not on its allowlist is left alone and reported, because a `.env` is a working
file and uploading it wholesale is how a credential ends up somewhere nobody
meant to put it. Dry run by default; no secret value is ever printed, only its
length, which is enough to spot a truncated paste.

`.github/workflows/preflight.yml` then runs the same command on a schedule and
on demand. Running it _there_ is the point: it proves what Actions can reach
with the secrets Actions holds, which is the thing that has to be true. A green
run on a laptop only ever proved that laptop's `.env` was right.

Weekly, because the failures it catches are all silent — a rotated key, a
deleted bucket, a Supabase project paused for inactivity. None of them affect a
single public record, so nothing else would notice.

#### On a schedule, in GitHub Actions

`.github/workflows/refresh.yml` reads the bucket configuration from the
repository's own settings, so once these are set the twice-daily run stores
straight to R2 with no further edits.

Under **Settings → Secrets and variables → Actions**:

| Where     | Name                   | Value                                           |
| --------- | ---------------------- | ----------------------------------------------- |
| Variables | `S3_BUCKET`            | `towncivic`                                     |
| Variables | `S3_ENDPOINT`          | `https://<account-id>.r2.cloudflarestorage.com` |
| Variables | `S3_REGION`            | `auto`                                          |
| Secrets   | `S3_ACCESS_KEY_ID`     | the R2 access key id                            |
| Secrets   | `S3_SECRET_ACCESS_KEY` | the R2 secret                                   |

Variables rather than secrets for the first three on purpose: they are not
credentials, and a masked bucket name turns a configuration mistake into an
unreadable log. The key pair is the only part worth hiding.

`TOWNCIVIC_DOCUMENTS` is derived rather than set — the workflow selects `s3`
when `S3_BUCKET` is present and `local` otherwise, so a fork with none of this
configured still runs, and a half-finished setup fails loudly at the probe
instead of silently writing the archive to a disk that is about to vanish.

Two things deliberately not here:

- **No Supabase.** The pipeline never reads a user. Readers are a serve-time
  dependency, so nothing about accounts belongs in this job.
- **Nothing in `ci.yml`.** That workflow runs on `pull_request`; this one runs
  only on a schedule and on manual dispatch, which is what keeps the credentials
  out of reach of anything triggered by a branch or a fork.

Run it by hand once — **Actions → Refresh → Run workflow** — and read the
"Check the document store" step. It fails before the first request to any town,
so a wrong key costs nobody else anything.

After that the Actions cache is a performance optimization rather than the place
the archive lives. Losing it means the towns get asked for everything again,
which is slow and impolite; it no longer means anything is gone.

### Moving the readers out

`TOWNCIVIC_ACCOUNTS=supabase` puts readers in a hosted Postgres and leaves every
record where it is. Then there are still two pieces of state, but the second one
is not on this machine:

|                     |                                                                            |
| ------------------- | -------------------------------------------------------------------------- |
| `data/documents/`   | The authority. A volume, until `TOWNCIVIC_DOCUMENTS=s3` moves it too.      |
| `data/towncivic.db` | Derived, and now **disposable again** — delete it and re-run the pipeline. |
| Supabase            | Readers and subscriptions. The only thing that must be backed up.          |

With both backends switched, nothing that matters is on any machine you have to
keep: the archive is in a bucket, the readers are in Postgres, and the database
between them is a cache the pipeline rebuilds.

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

With `TOWNCIVIC_DOCUMENTS=s3` as well, the pipeline stops needing a volume too,
and the scheduled refresh in GitHub Actions becomes the whole back end: it
fetches, extracts, writes the archive to a bucket, and publishes the database as
the artifact the web tier ships with. At that point there is no machine in this
picture that anyone has to keep running.

What it still does not buy is somewhere to _put_ the archive for free forever —
object storage is cheap and durable rather than magic, and losing the bucket
loses the one thing here that cannot be re-derived.

### Fly, concretely

`Dockerfile`, `fly.toml` and `.github/workflows/deploy.yml` are the whole of it.

```bash
fly apps create towncivic          # once — NOT `fly launch`, see below
./scripts/setup-fly.sh --apply     # the credentials (dry run without --apply)
npm run snapshot                   # publish the database, from wherever it is
./scripts/deploy-fly.sh            # preflight, pull, deploy, verify
```

Three things that bite in that order, all of them once:

**`fly launch` rewrites `fly.toml`.** It generates its own and discards this one,
comments and all. `fly apps create` makes the app and leaves the file alone.
App names are global, so if `towncivic` is taken, pick another and change
`TOWNCIVIC_BASE_URL` to match — a test pins those two together for `.fly.dev`
hostnames, because a mismatch is invisible until every Atom feed advertises a
self-link that resolves nowhere.

**`data/` is gitignored, so a fresh clone has no database.** Deploying from a
branch rather than a working copy fails at the `COPY`:

```
failed to compute cache key: "/data/towncivic.db": not found
```

That failure is deliberate — an image without a database comes up healthy and
serves an empty archive — but the message is Docker's and says none of that. The
fix is ordering: publish a snapshot once (`npm run snapshot`, from wherever the
pipeline actually ran), then let `deploy-fly.sh` or `deploy.yml` pull it into the
build context. Neither can invent one.

**flyctl versions disagree about `fly.toml`.** `auto_stop_machines` was a bool
before it accepted `"stop"` / `"suspend"` / `"off"`, and an older flyctl rejects
the string outright. This file uses the bool, which every version reads. If some
other field is rejected as the wrong type, `fly version upgrade` is the answer.

**The database is baked into the image**, and that is the decision the files
encode. At 24 MB for four towns it is a trivial layer, the file is read-only at
serve time, and baking makes starting unconditional: a machine that boots while
the bucket is unreachable still serves, a few hours stale. Downloading at boot
would buy fresher data per restart and pay for it by putting a network call on
the path to serving anything at all.

It also makes the image the unit. A rollback returns matching code _and_ data,
and a database that will not open fails its health check mid-rollout while the
old machines keep serving.

The cost is that new data needs a deploy, which is why `deploy.yml` runs after
every successful Refresh. Revisit around a few hundred megabytes: past that the
image is slow to push and `snapshot --pull` at boot becomes the better trade —
keeping a baked copy as the floor, so booting still cannot fail.

`snapshot` is what carries the file between them. The pipeline pushes it to a
fixed key in the same bucket; the deploy pulls it and verifies the checksum
before installing. A stable key rather than a content-addressed one, because the
deploy has to be able to name it without being told which version to want.

Three things the deploy does in order, and the order is the point:

1. **Preflight.** If the bucket or the Supabase project is not answering, a
   deploy would produce a machine that starts, passes its health check, serves
   every public record, and cannot sign anybody in. Failing here costs nothing.
2. **Pull and bake.** A missing database fails the build rather than shipping an
   image that comes up healthy and holds nothing.
3. **Verify.** `/healthz` names the accounts backend, so a machine that came up
   against the wrong configuration is caught by the deploy rather than by a
   reader.

`FLY_API_TOKEN` is a deploy credential, a meaningfully larger grant than the R2
key beside it, and it lives only in this workflow — the job that reaches out to
town websites twice a day cannot also redeploy the site.

There is no volume, which is the payoff for everything before it: the archive is
in a bucket, the readers are in Supabase, and the database is in the image, so a
machine holds nothing anybody would miss.

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
