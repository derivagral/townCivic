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

`boundary` sits outside this cycle. It refetches the town outline from MassGIS
and is a maintenance command like `discover` — run it by hand, read the diff,
commit it. Nothing in the running system calls it, and the outline it writes is
what `geocode` fences against.

`status` reports what came out of it and exits non-zero on a problem, which is
the whole monitoring story:

```bash
npm run status          # human-readable
npm run status -- --json | jq .problems
```

## The two pieces of state

|                     |                                                                             |
| ------------------- | --------------------------------------------------------------------------- |
| `data/documents/`   | Content-addressed raw bodies. **The authority.** Never overwritten.         |
| `data/towncivic.db` | Everything else. Derived, and rebuildable from the documents by re-running. |

Accounts are the exception: `users`, `sessions` and `subscriptions` live in the
same SQLite file but are _not_ derived from anything. If you run accounts, the
database stops being disposable — back it up, or accept that dropping it signs
everybody out and loses their subscriptions.

## Three shapes that work

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
ExecStart=/usr/bin/npm run ingest
ExecStart=/usr/bin/npm run extract -- --limit 200
ExecStart=/usr/bin/npm run link
ExecStart=/usr/bin/npm run interpret
ExecStart=/usr/bin/npm run status
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

## Being a good citizen

The defaults exist for a reason and the schedule is part of them:

- One request per host per second (`TOWNCIVIC_HOST_DELAY_MS`).
- Conditional GETs, so an unchanged page costs the town a 304.
- Twice a day. Meeting notices run on a 48-hour clock; polling hourly finds the
  same nothing twenty-three extra times.
- `extract --limit` caps how many documents one run opens. A first run over a
  nine-year archive should spread over several runs.

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

The quiet failure is the one worth designing for: a crawler that keeps returning
200 while the town silently stops publishing looks exactly like a quiet week.
That is why `status` reports when each source last produced something new rather
than only whether the last fetch succeeded.
