# townCivic

**RSS for the jurisdiction — not an automated local newspaper.**

A primary-source feed of what a town's government actually did this week. It
records what was published, by whom, and when. It does not summarize, editorialize,
or decide what is newsworthy.

Covering **Milton**, **Weymouth**, **Hull** and **Scituate, Massachusetts**. One
database, one schema, one row per town — see [Towns](#towns).

The system answers four questions, and only these four:

1. Is this authoritative?
2. Does it concern this jurisdiction?
3. What changed?
4. What earlier record does it belong to?

There is **no model in the loop.** Classification is a table of regular expressions
you can read in one sitting (`src/pipeline/classify.ts`). A surprising result is
always reproducible and always fixable in one place. That includes reading the
agendas: Milton's notices are fillable PDFs, so the agenda arrives as a _named
form field_ — structured data, not prose. See
[Reading the documents](#reading-the-documents).

## Quick start

```bash
npm install
npm run ingest     # fetch every enabled source (~20 requests, about a minute)
npm run extract    # open the linked PDFs and read what the meetings are about
npm run link       # group records about the same property into timelines
npm run geocode    # resolve those properties to points, for the map
npm run serve      # http://localhost:8787
```

`npm run interpret` is optional and runs whenever you want it: it reads votes and
dispositions out of minutes into a separate index, and the site works without it.

### The stages, and what each one needs

Each stage is a separate command on purpose — they fail, resume and re-run
independently, and the two that read only the database (`link`, and `interpret`
under its default rules provider) can be re-run freely at no cost to anyone
else's server. The ordering is a real data dependency, not a convention:

| Stage       | Needs        | Reads                         | Writes                           | Network                    |
| ----------- | ------------ | ----------------------------- | -------------------------------- | -------------------------- |
| `ingest`    | the registry | source listings               | `events`, `documents`, `fetches` | yes                        |
| `extract`   | `ingest`     | `events.document_url`         | `attachments`, enriches `events` | yes                        |
| `link`      | `extract`    | `events.subjects`, `doc_text` | `matters`, `matter_events`       | no                         |
| `geocode`   | `link`       | `matters`                     | `places`                         | yes                        |
| `interpret` | `extract`    | `events.doc_text`             | `interpretations`                | only with a model provider |

Running one out of order is safe but does nothing useful: `geocode` selects the
matters that have no place yet, so before `link` there is simply nothing to
resolve, and it will say so rather than fail.

**`--force` re-does work that was skipped as already done** — `ingest` ignores
stored ETags, `extract` and `interpret` reprocess documents, `geocode` re-resolves
addresses. `link` has no `--force` because every run is already a full rebuild of
the jurisdiction's matters; there is no incremental state to invalidate.

Accounts sit outside all of this. Signing in, watching a matter and the personal
feed only ever _read_ what the pipeline produced — no stage depends on a user
existing, and dropping every account changes nothing about the records.

No API keys, no Docker, no database server. Storage is `node:sqlite`, built into
Node — the only native dependency is Node itself.

To look at the UI without touching the network:

```bash
npm run seed       # load synthetic fixtures
npm run serve
```

Seeded records are tagged `sample` and the UI shows a standing banner while any
are present. `npm run clear-samples` removes them.

**Requires Node ≥ 22.5** (for `node:sqlite`).

## What it collects

These towns all run CivicPlus CivicEngage — which is why they are the ones being
added first. Two URL shapes carry nearly everything, and both put the facts in
the path rather than the markup:

```
/AgendaCenter/<Board-Slug>-<CID>                       per-board agenda + minutes listing
/AgendaCenter/ViewFile/<Agenda|Minutes>/_MMDDYYYY-<id> the file itself
```

The adapters key off those hrefs, not CSS classes. The meeting date, the file id,
and the agenda-versus-minutes distinction are all in the URL, so a theme change
degrades ingestion to "found nothing" rather than to plausible garbage.

A live Milton run currently yields **~718 records back to 2017** across 14 curated
boards, plus the site-wide index, bid postings and the news flash. First runs
elsewhere: Hull ~446, Scituate ~427, Weymouth ~295, each from its Agenda Center.

### Source tiers

| Tier | What                                                                 | Status                                            |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------- |
| 1    | The town itself — Agenda Center, bids, news flash                    | **Live** in four towns                            |
| 2    | State systems queried for the town — AG Municipal Law Unit, COMMBUYS | Registered, disabled, needs form-driving adapters |
| 3    | Federal actions resolving to the municipality                        | Not started                                       |
| 4    | Town-controlled social accounts                                      | Not started; discovery only, never canonical      |

Everything registered lives in `src/registry/<town>.ts` — one file per town,
reviewed by a human. `discover` proposes additions; it never writes them.

### Channels

Ten feeds, one per channel: `meetings`, `land-use`, `money`, `law`, `elections`,
`schools`, `public-safety`, `courts`, `state-federal`, `admin`. Routine
administration is collapsed out of the default view.

A **board-scoped source is authoritative about its channel**: a Planning Board
hearing about a by-law stays in `land-use` and picks up a `bylaw` tag, rather than
being pulled into `law`. Someone following development should never have to also
watch a second feed to avoid missing things.

## Commands

```bash
npx tsx src/cli.ts <command>
```

| Command              | What it does                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| `ingest`             | Fetch every enabled source, normalize, store what changed                    |
| `extract`            | Open the linked PDFs and read agendas, locations, posting times and subjects |
| `link`               | Group records about the same property or article into timelines              |
| `interpret`          | Read votes and dispositions out of the prose in minutes                      |
| `geocode`            | Resolve linked addresses to coordinates for the map                          |
| `status`             | Pipeline counts and source health; exits non-zero on a problem               |
| `boundary`           | Refetch the town outline from MassGIS (maintenance — commit the result)      |
| `verify`             | Check every registered URL against the live site                             |
| `discover`           | Probe the CivicPlus site for boards and feeds not yet registered             |
| `serve`              | Web UI plus Atom and JSON feeds                                              |
| `accounts`           | Report which accounts backend is configured, and probe it                    |
| `documents`          | Report where the archive lives, probe it, and `--backfill` it into a bucket  |
| `seed`               | Load synthetic fixtures                                                      |
| `towns`              | List every registered town and what the database holds for each              |
| `sources` / `events` | Print the registry / recent records                                          |
| `clear`              | Delete one town's derived data, its records, or the town itself              |
| `clear-samples`      | Delete everything loaded from fixtures                                       |

Useful flags: `--jurisdiction <id>` or `--jurisdiction all`, `--source <id>`
(repeatable), `--all` (include disabled), `--force` (ignore ETag / re-extract),
`--dry-run`, `--limit <n>`, `--since <date>`, `--provider <name>`, `--scope`, `--json`.

Every pipeline command takes `--jurisdiction all`, which is how the scheduled
refresh covers every town in one pass. It is spelled out rather than being the
default: a command that quietly fetched four towns because someone omitted a flag
would be a bad surprise for four town servers.

The first three are the pipeline, and they run in that order because each
depends on what the one before it wrote. `link` and `interpret` touch nothing
outside the database.

### `discover` is the reason the ids are right

CivicPlus module and category ids are assigned per install and are **not
guessable**. Guessing them is how you ship a registry that silently returns
nothing. `discover` reads `/rss.aspx` and the Agenda Center index and reports what
the site actually publishes.

That mattered here. The conventional guess for News Flash is `ModID=76`; on
Milton's install 76 is **Pages**, and News Flash is `ModID=1`. The real map:

```
ModID=1   News Flash      ModID=58  Calendar        ModID=65  Agenda Center
ModID=51  Blog            ModID=63  Alert Center    ModID=66  Jobs
ModID=53  Photo Gallery   ModID=76  Pages
```

`verify` then distinguishes three states that look alike from a distance: a URL
that fails, a URL that answers with records, and a URL that answers correctly but
publishes **nothing**. Four of Milton's feeds are in that last category — the
Calendar and all three Alert Center feeds are live, correctly addressed, and empty.
They ship registered-but-disabled with a note, because that is a fact about the
town worth recording, not a bug to hide.

## How it fits together

```
registry (reviewed by a human)
     ↓
fetch adapters — conditional GET, per-host politeness, retry with backoff
     ↓
raw document store — content-addressed, never overwritten, the authority
     ↓
normalize + classify — deterministic rules, no model
     ↓
dedupe by precedence
     ↓
SQLite (node:sqlite, FTS5)
     ↓                    ↘
     ↓                     link → matters and timelines → geocode → map
     ↓                     interpret → derived readings, separately indexed
     ↓                    ↙
Atom / JSON Feed + web UI
```

Everything downstream of the document store is derived and can be rebuilt by
deleting `data/towncivic.db` and re-running `ingest`.

### Deduplication by precedence

The same agenda appears on its board's page and on the site-wide index. Identity
is keyed on the **jurisdiction and the artifact**, not the source, so those
collapse into one record.

When two sources carry the same record, `precedence` settles it — lower wins:

|       |                              |
| ----- | ---------------------------- |
| 10    | A board's own listing        |
| 20    | The site-wide index          |
| 30–40 | News flash, calendar         |
| 90    | Peripheral accounts (future) |

A weaker source confirms a record still exists and nothing more. This is
order-independent, so repeated ingests never ping-pong ownership between two
sources — a live run reports 310 of the index's 712 items as duplicates and leaves
the board pages owning them.

That rule generalizes the obvious editorial one: if a Facebook post and an
official agenda PDF describe the same meeting, the PDF is the record.

### Change detection

Nothing is ever deleted — a record that drops off a listing stays in the feed,
because it was published. Within one source, a content hash over the
reader-visible fields decides whether a re-fetch is a revision (agenda amended,
bid updated) or a no-op. Revisions bump `revision` and set `revised_at`.

## What a record looks like

```
Board of Appeals — Agenda, September 10, 2026
  channel      land-use          meets       2026-09-10 7:00 PM   (from the notice)
  event_type   meeting_agenda    posted      2026-08-17 2:55 PM   (by the Town Clerk)
  body         Board of Appeals  subjects    39 Frothingham Street
  source       milton-ma:agenda:board-of-appeals
  url          https://www.miltonma.gov/AgendaCenter/ViewFile/Agenda/_09102026-6844

  Upon the Application of Zachary & Alexa Rouleau (represented by Attorney
  Marion McEttrick) at 39 Frothingham Street dated July 29, 2026, seeking a
  Special Permit to build a two-story addition … The property is in a
  Residence C Zoning District.
```

The **meeting time and the posting time are separate facts**, and the gap between
them is what makes a notice timely under the Open Meeting Law. Both come from the
document; the listing row knows neither.

## Reading the documents

`ingest` records _that_ a meeting exists. `extract` opens the PDF behind it and
records what it is **about** — which is where the useful part of civic
information actually lives.

This is the part that looked like it would need a model. It does not.

### Milton's notices are structured data

The Town Clerk files meeting notices on a **fillable AcroForm template**, so a
modern notice carries named fields rather than prose:

```
BOARDCOMMITTEE   Zoning Board of Appeals
DATE / TIME      September 10, 2026 / 7:00 PM
BUILDING / ROOM  Milton Town Hall / Carol Blute Conference Room
AGENDA           Upon the Application of … at 39 Frothingham Street …
                 seeking a Special Permit to build a two-story addition …
PostTime         08/17/2026 02:55 pm
Posting Authority  Susan M Galvin
```

Every fact townCivic shows comes from a labelled field. No summarization, no
inference, nothing to hallucinate — and `PostTime` gives the Open Meeting Law
48-hour clock to the minute.

### Where this lands on OSS and cost

**Entirely free and open source, with no service to sign up for.**

|             |                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Library     | [`pdfjs-dist`](https://github.com/mozilla/pdf.js) — Mozilla's pdf.js, **Apache-2.0**             |
| Runtime     | Pure JavaScript. No native build, no system package, works anywhere Node does                    |
| OCR         | **Not needed.** A survey of the archive from 2017 to 2026 found essentially no scanned documents |
| Model / API | None. Zero inference cost, zero per-document cost                                                |

Alternatives considered and rejected: Poppler's `pdftotext` gives excellent
layout but is GPL and needs a system binary; `mupdf.js` is AGPL; hosted
document-AI services cost money per page for a job that named form fields
already answer exactly.

If a town _did_ scan its minutes, the honest additions are `tesseract.js`
(Apache-2.0, WASM, no native dep) or system Tesseract. townCivic does not
silently pretend a scan is empty — the extractor flags `likelyScanned` when the
text layer is too thin, so the gap is visible rather than invisible.

### What it actually gets

Measured over the 72 most recent documents:

|                                          |                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Structured AcroForm notices              | 48 of 60 sampled (80%)                                                             |
| Records with a parsed agenda             | 60                                                                                 |
| Records with an exact clerk posting time | 72 (100%)                                                                          |
| Extraction failures                      | 0                                                                                  |
| Detected as scanned                      | 2 — both from the _regional_ school district, which does not use Milton's template |

Real addresses now attached to records: 39 Frothingham Street, 350 Blue Hill
Avenue, 53 Lawrence Road, 303 Adams Street, 77 Morton Road, 64 Park Street …
and warrant articles as `Article 4`, `Article 5`.

### Three document shapes, all handled

1. **AcroForm notice** (agendas since roughly 2021) — named fields; the best case.
2. **Plain-text PDF** (minutes, and older agendas) — text layer only; structure
   inferred from the text, and the record is marked unstructured rather than
   pretending otherwise.
3. **HTML** — some pre-2018 Agenda Center links serve a web page. The `?html=true`
   parameter is stripped to ask for the file; if HTML comes back anyway, its text
   is kept so search still reaches it.

Extracted text is denormalized onto the record and indexed in FTS5, so searching
`Frothingham`, `MBTA` or `special permit` now hits **inside** the PDFs — none of
those strings appear anywhere in the listing HTML.

### Deliberately conservative

- The venue is not a subject. Every notice carries the clerk's address in its
  template, so without a filter every record in town would be tagged
  `525 Canton Avenue` and the one address that matters would be buried.
- Boilerplate is not a summary. "Call to Order", "Public Comment" and
  "Adjournment" appear on every agenda; the summary skips them unless they are
  all there is.
- Nothing overwrites a fact the listing already established unless the document
  is more precise — the notice's exact start time replaces a date-only guess,
  but a missing field never blanks a known value.

## Timelines

`ingest` records that a meeting exists and `extract` records what it is about.
`link` answers the question those two leave open: **which of these records are
about the same thing?**

A **matter** is the thing the town is deciding about, as opposed to any one
meeting about it — a property, a warrant article, a procurement. Group by matter
and order by date and the sequence falls out:

```
271 Pleasant Street                                          Property · Decided
  Mar 3   Application filed    Board of Appeals — Agenda
          ↳ Upon the Application of A. Resident at 271 Pleasant St …
  Apr 7   Hearing scheduled    Board of Appeals — Agenda
          ↳ Public hearing on the variance sought at 271 Pleasant Street.
  May 5   Continued            Board of Appeals — Agenda
          ↳ Continued hearing, 271 Pleasant Street.
  Jun 2   Decided              Board of Appeals — Minutes
          ↳ The variance at 271 Pleasant Street was approved 4-1.
```

### There is no ID to link on

Worth stating plainly, because it determined the design. CivicPlus assigns
`_09142026-7480` per **file**, and Milton's notice template has no docket field,
so nothing in the source data says these four meetings concern the same house.
The only handle is the subject string the extractor already pulls out.

So linking is a **normalization**, not a clustering algorithm — the same choice
the classifier makes. `271 Pleasant St`, `271 Pleasant St.` and
`271A Pleasant Street` reduce to one key; `14 Adams Street` and `40 Adams Street`
never do. A canonical key is reproducible and wrong in ways you can see. Fuzzy
matching would quietly merge two neighbouring properties, and nothing in the
output would tell you it had happened.

The cost is the opposite failure: two spellings a human would call one matter
stay apart. That is the failure to prefer — a missing link shows up as a short
timeline, an invented one shows up as nothing at all.

Three kinds are keyed:

| Kind        | Key                | Note                                                             |
| ----------- | ------------------ | ---------------------------------------------------------------- |
| Property    | normalized address | Street types expanded, unit letters dropped                      |
| Article     | year + number      | Article 14 of the fall warrant is not Article 14 the next spring |
| Procurement | bid number         | Learned from postings that label it, then matched bare           |

That last one closes the loop procurement usually loses. The bid posting says
`Bid No. SB26-9`; four weeks later a Select Board agenda says only
`award of contract, SB26-9`. Matching a bare `XX00-0` everywhere would sweep in
fiscal-year codes and statute cites, so instead the linker collects the numbers
the town has _already published under a label_ and matches those. The vocabulary
comes from the town.

### Stages are read, and they show their working

`filed → scheduled → heard → continued → decided → withdrawn`, from a table of
regular expressions in `src/matters/stages.ts`. Two things keep it honest:

- **The reading is scoped to the sentence naming the subject.** An agenda covers
  six unrelated properties; without scoping, one item approved 4–1 would mark
  every other item on the night "decided".
- **Every link stores the phrase it was read from**, and the timeline shows it.
  A surprising stage traces to the words that caused it.

Nothing here is a legal determination. The linked primary source is.

## Map

`/map` plots every property the town has a record about, sized by how many
records mention it and coloured by channel. Addresses become coordinates in
their own stage — `geocode` — because it is the only part of the pipeline that
asks anything of a service other than the town.

|           |                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Geocoder  | [US Census Bureau](https://geocoding.geo.census.gov/) — public, free, **no API key**, results public domain |
| Outline   | MassGIS Census 2020 Towns — the state's own GIS, no key, committed to the repo                              |
| Caching   | Permanent. A street address does not move, and a definite miss is cached too                                |
| Rendering | Server-rendered SVG. No tiles, no JavaScript, no external requests                                          |
| Failures  | Named on the page, not dropped — an address missing from a map is a gap in it                               |

### The town outline earns its place twice

The map draws Milton's actual shape, from
[MassGIS](https://arcgisserver.digital.mass.gov/arcgisserver/rest/services/AGOL/Census2020_Towns/FeatureServer/2).
That makes the pins legible — a property means far more against the shape of the
town than against an empty rectangle — but the bigger win is invisible.

`geocode` used to fence results against a **hand-written bounding box**. That
box accepted **5.6× the town's real area**: it reached 3.6 km north into
Mattapan and 3.4 km east into Quincy, so a street continuing over the town line
could resolve to a house in Boston and be recorded as Milton. Even a perfectly
tight rectangle would be twice too big — Milton fills only **49% of its own
bounding box**. A polygon does not have that problem, and the fence is now
point-in-polygon.

The tests use the Census's own `INTPTLAT20`/`INTPTLON20` internal points as
anchors — coordinates the source guarantees fall inside each town — so
"Quincy is not Milton" is checked against ground truth rather than against a
coordinate someone eyeballed off a map.

```bash
npm run boundary              # refetch from MassGIS; commit the diff
npm run boundary -- --dry-run # report what would change
```

The boundary is **committed, not fetched at runtime**: 18 KB, changes about as
often as the town's borders do, and a map that needs the network to draw its own
frame breaks offline. It is regenerable — the command above writes exactly the
committed bytes, so a no-op run reports `unchanged`.

Every ring the source publishes is kept, including an 18 m² Census sliver, because
an area threshold that dropped it would also drop a real island in some other town.

### What it deliberately does not do

**No street basemap.** Tiles are a real option — MassGIS serves them, and
covering Milton z12–z16 is about 1,377 tiles — but they are deferred: a borrowed
street rendering implies a precision the geocoding does not have, and 25 MB of
cached raster per town is the wrong thing to add before a second town exists.
The outline gives most of the legibility for 18 KB and no runtime dependency.

**No parcels.** A pin is a geocoder's reading of a street address, not a lot
line. MassGIS also publishes the statewide parcel layer, which is what a
land-use record is actually about; that is the next honest step.

### The geocode cache

`geocode` asks a public geocoder — the US Census — about a street address, which
is slow, external, rate-limited by politeness, and stable: a street address does
not move. So the answer is stored against **the question** rather than against
whoever asked it:

```
geocodes(jurisdiction, key, provider) → lat, lon, matched, failure, retrieved_at
```

`key` is the normalized address, the same value as `matters.key`, and
`jurisdiction` is part of the key because 10 Main Street in Hull is a different
house from 10 Main Street in Milton. Misses are cached too, so an address the
geocoder cannot parse is asked about once rather than on every run.

This is not an optimization; it fixes a real bug. `link` is a full rebuild — it
deletes a town's matters and re-inserts them — and `places.matter_id` cascades,
so **every `link` run used to throw away every point in that town**. The
scheduled refresh runs `link` and then `geocode --limit 50` twice a day, which
meant a town with more than fifty addresses never finished being placed, and the
Census was asked the same questions twice a day forever. Now `link` refills
`places` from the cache with no network, and `geocode` only ever asks about
addresses nobody has asked about yet.

`places` is consequently a projection rather than a store: matters × geocodes.
Dropping it costs nothing. Dropping `geocodes` costs a re-run against someone
else's server, which is why only `clear --scope town` does it.

## Derived readings

Agendas are structured data, so `extract` gets everything out of them. Minutes
are prose, and the votes and conditions in them are the part of the civic record
people most want and least often get.

`interpret` is the seam where a model is allowed in — and the design is about
making sure it stays a _seam_:

- Readings go in their own table, with their own FTS index. The default search
  is over what the town published; derived text is opted into with a checkbox.
- They render in a visibly separate block labelled **not the record**.
- They never overwrite a parsed fact, and dropping the whole table changes
  nothing about what townCivic reports the town did.
- Each row records the provider, model, prompt version, and a hash of the
  document it read — so a re-extraction makes a reading stale rather than
  silently wrong.

Two providers ship:

| Provider    | Needs                         | What it is                                              |
| ----------- | ----------------------------- | ------------------------------------------------------- |
| `rules`     | nothing — the default         | Regular expressions for recorded votes and continuances |
| `anthropic` | `ANTHROPIC_API_KEY` + the SDK | A model reading minutes for dispositions                |

`rules` is not a placeholder. It is the floor: it costs nothing to run over the
whole archive, and whatever a model adds has to beat it. Having both makes that
comparable rather than assumed.

```bash
npm run interpret                                  # rules, no key, no cost
npx tsx src/cli.ts interpret --provider anthropic  # opt in
```

`@anthropic-ai/sdk` is **not** a dependency and is loaded dynamically, so the
quick start stays "npm install, npm run ingest" with no account to create.

## Accounts

A proof of concept, answering one question: _what do **I** want to see?_ Sign up,
follow a property, a board, a channel or a search, and get a personal Atom feed
that is the union of them.

Following a matter is the point — it tracks a property across whichever board
takes it up next, which is exactly what channel and board filters cannot do.

Readers can live in either of two places, chosen by `TOWNCIVIC_ACCOUNTS`:

|                                          | `sqlite` (default)                      | `supabase`                       |
| ---------------------------------------- | --------------------------------------- | -------------------------------- |
| Where readers are                        | `data/towncivic.db`, beside the records | A hosted Postgres, behind GoTrue |
| Needs an account anywhere                | no                                      | yes                              |
| Email confirmation, reset, rate limiting | no                                      | yes                              |
| `data/towncivic.db` stays disposable     | **no**                                  | yes                              |

Both sit behind one interface — `src/accounts/store.ts` — and one test suite
runs against both, so the second backend is not a promise about a future
refactor. `npm run accounts` says which one is configured and probes it.

### The local backend

The security primitives are real: scrypt with a per-user salt, constant-time
comparison, an opaque `HttpOnly` `SameSite=Lax` session cookie, a per-session
CSRF token on every state change, no open redirect on login, and one error
message whether the account is missing or the password is wrong.

**What is missing, and would have to exist first:** email verification, password
reset, rate limiting and lockout, a second factor, and any account-recovery path
at all. Set `TOWNCIVIC_SECURE_COOKIES=1` for anything served over HTTPS. The
personal feed URL contains a bearer token — rotatable, not the password, and a
secret.

It is also the reason the database is not disposable. Accounts are the one thing
in `data/towncivic.db` that is not derived from the document store: run them
here, and deleting the file signs everybody out and loses their subscriptions.

### The hosted backend

`TOWNCIVIC_ACCOUNTS=supabase` moves exactly that undeletable part out — and only
that part. Every civic record stays in SQLite, built by the pipeline and carried
by the deploy, because the records are the same for every reader and are
rebuildable by re-running `ingest`. Which means the list above is not a list of
things still to write: email confirmation, password reset and rate limiting are
someone else's job the moment you switch, and the database goes back to being a
cache.

Setup, the migration, and what it costs are in
**[supabase/README.md](supabase/README.md)**. Three things worth knowing before
reading it:

- The web tier holds only the **anon** key. Row-level security is what keeps one
  reader's list out of another's, and a service role key would bypass every
  policy in `supabase/migrations/`.
- A signed-in request costs one round trip. Signed-out pages — which is nearly
  everything here — cost nothing, and stay up when the hosted project is down.
- There is no import for existing local accounts. Password hashes cannot be
  converted between scrypt and bcrypt by anyone, so switch before you have
  readers, or invite them.

Alerts are recorded but not sent under either backend. The `alerts` column
carries the intent; there is no sender. The honest description of alerts today is
"an Atom feed you can point anything at".

## Operations

Full detail in **[docs/operations.md](docs/operations.md)** — the four
deployment shapes, a systemd unit, and what to watch.

The short version: `.github/workflows/refresh.yml` runs the cycle twice a day,
restores the previous database from the Actions cache, and publishes it as an
artifact. Twice a day is deliberate — meeting notices run on a 48-hour clock, so
a 12-hour worst case still leaves a day and a half, and these are small
municipal servers.

`status` is the whole monitoring story:

```bash
npm run status                                     # the default town
npm run status -- --jurisdiction all               # every town; worst exit code wins
npm run status -- --json | jq .problems            # exits non-zero on a problem
```

A town registered with nothing enabled yet reports its counts and no problems: a
red light that is always on is the same as no red light. `status` also names any
jurisdiction with rows that the registry no longer knows, which is the one thing
a multi-town database can accumulate that a single-town one could not.

It is built around the _quiet_ failure. A crawler that errors is obvious; a
crawler that keeps returning 200 while the town silently stops publishing looks
exactly like a quiet week. So `status` reports when each source last produced
something **new**, not just whether the last fetch succeeded — with a 60-day
threshold, because boards meet monthly and take August off.

## Feeds

```
/feeds/all.atom          /feeds/all.json
/feeds/land-use.atom     /feeds/money.atom     /feeds/meetings.atom    …
/feeds/all.atom?matter=<id>                    one property, whoever publishes it
/feeds/my/<token>.atom                         one reader's subscriptions
```

Add `?source=`, `?body=`, `?q=` or `?matter=` to narrow any feed the same way the
web filters do. JSON Feed entries carry a `_towncivic` object with the
jurisdiction, source level, agency, body, channel, event type and permalink.

## Towns

One database, one schema, one row per town. Every table that holds a record
carries `jurisdiction` as a plain column and every query that reads records
filters on it; no table's name or shape depends on which town it holds. A town is
data.

A database per town was the obvious alternative and was rejected because the
expensive parts are shared. `users`, `sessions` and `subscriptions` are
per-person, not per-town — a reader following a property in Milton and the school
committee in Weymouth is one account either way. Cross-town questions stay one
query rather than a fan-out. And adding or dropping a town is writing rows, which
is what `clear` does.

| Town     | Boards | What this install publishes                                              |
| -------- | ------ | ------------------------------------------------------------------------ |
| Milton   | 14     | Agenda Center, bids, news flash; calendar and alert feeds live but empty |
| Weymouth | 14     | Agenda Center only — no `/rss.aspx`, no `/bids.aspx`                     |
| Hull     | 18     | Agenda Center, bids, and every RSS module — all of the feeds empty       |
| Scituate | 16     | Agenda Center only; no School Committee category                         |

`npm run towns` prints that table with real counts, and `/towns` is the same
thing in the browser. A town listed as _registered, nothing enabled_ has its URL
shapes written down and nothing confirmed against the live site — an unverified
claim does not get to make requests.

### What a town is, in code

A jurisdiction is a value: `src/registry/<id>.ts` exports a `JurisdictionProfile`
and `src/registry/index.ts` lists it. Nothing else in the codebase knows a town by
name. The profile carries what varies:

| Field                      | Why it cannot be shared                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`, `sources`       | different site, different per-install ids                                                                                |
| `bodyAliases`, `bodyRules` | "Advisory Board" is Hull's finance committee; Weymouth has a Town Council and ordinances, not a Select Board and by-laws |
| `venueAddresses`           | the clerk's own address is printed on every notice, and it is a different address in each town                           |
| `bbox`, `boundary`         | the geocoding fence, and which MassGIS feature to fetch                                                                  |
| `fixtures`                 | which synthetic bodies `seed` replays                                                                                    |

The statewide defaults do most of the work — the enabling statutes name most of
these bodies, so `DEFAULT_BODY_RULES` classifies "Planning Board" and
"Conservation Commission" everywhere — and a town's own rules are tried first, so
an override actually overrides.

### Adding a town

The state adapters and the whole pipeline are reused; a new town is
configuration plus three commands.

1. Write `src/registry/<id>-ma.ts`: id, name, base URL, a padded bounding box, and
   the MassGIS town name. `hull-ma.ts` is the smallest complete example.
2. `npx tsx src/cli.ts discover --jurisdiction <id>` — reads the site for its real
   module and category ids and prints them as registry entries to paste in.
   **Never guess these.**
3. Curate the boards worth following, and add `bodyAliases` / `bodyRules` for any
   name its committees use that the statewide defaults would misfile.
4. `npx tsx src/cli.ts verify --jurisdiction <id> --all` — fetch every registered
   URL and see what parses. Mark what answered as `confidence: 'verified'` and
   enable it; leave the rest disabled.
5. `npx tsx src/cli.ts boundary --jurisdiction <id>` and commit the GeoJSON.
6. `npx tsx src/cli.ts ingest --jurisdiction <id>`.

Weymouth is what that produced, and it is worth reading as a counter-example to
Milton: no `/rss.aspx` at all, no bids module, and an Agenda Center themed as
collapsible panels rather than links — which is why `extractAgendaCategories`
reads two layouts. None of those differences needed a change outside the adapter
and the town's own file.

### Migrations, and clearing one town

The database is a cache. The document store is the authority, `events` is
derivable from documents by re-fetching, and everything below `events` is
derivable from `events` with no network at all. So the recovery for anything is
to drop a layer and re-run the stage that fills it — which is what `clear` does:

```bash
npx tsx src/cli.ts clear --jurisdiction hull-ma --scope derived --dry-run
```

| `--scope` | Removes                                                                              | Way back                       |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| `derived` | matters, timelines, map pins, model readings (the geocode cache is kept)             | `link`, `geocode`, `interpret` |
| `records` | the above plus `events` and what hangs off them                                      | `ingest`, `extract`, …         |
| `town`    | the above plus its sources, fetch log, document index and its row in `jurisdictions` | the town is gone               |

`--dry-run` counts what would go using the same SQL the delete uses. Nothing here
touches the content-addressed document store. `--orphans` runs `town` scope for
every jurisdiction that has rows but is no longer in the registry; `status`
reports those, so they get cleaned up deliberately rather than accumulating.

`records` and `town` also clear each source's stored ETag and `Last-Modified`.
That is not tidiness: `ingest` sends those, the town answers `304 Not Modified`,
and a town whose records you just deleted would refill with _nothing_ and look
like a broken adapter. It is part of the operation rather than a line in the
docs saying to remember `--force`.

`derived` and `records` deliberately keep the **geocode cache**, which is why
rebuilding either of them costs no network at all — see
[The geocode cache](#the-geocode-cache).

### After a `git pull`

Usually nothing. The next command that opens the database migrates it in place,
and the migration is idempotent, so there is no ordering to get right:

```bash
git pull && npm i
npm run towns                            # what the registry now holds
npm run ingest -- --jurisdiction all     # pick up towns the pull added
npm run status -- --jurisdiction all
```

Upgrading a database written before this change does four things, all
automatically: it adds the `jurisdictions` table and the jurisdiction-leading
indexes (dropping the two they supersede), gives `subscriptions` its
jurisdiction column and rebuilds the table around the new uniqueness
constraint, and renames the two statewide source ids that were not namespaced by
town. The rename moves each source's records with it — a source id is a foreign
key with `ON DELETE CASCADE`, so dropping and recreating the row would have
taken its records along.

### Starting over

In increasing order of violence. The first three keep every other town intact:

| What you want                                                  | What to run                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The derived layer rebuilt (matter keys or stage rules changed) | `npm run clear -- --jurisdiction all --scope derived`, then `link`, `geocode`, `interpret` |
| One town re-fetched from scratch                               | `npm run clear -- --jurisdiction hull-ma --scope records`, then `ingest`, `extract`        |
| One town gone entirely                                         | `npm run clear -- --jurisdiction hull-ma --scope town`                                     |
| The database gone, the archive kept                            | `rm -f data/towncivic.db*`, then `ingest`                                                  |
| Everything gone, including the archive                         | `rm -rf data/`                                                                             |

Two details worth knowing. The `*` in `data/towncivic.db*` is doing real work:
WAL mode leaves `-wal` and `-shm` files beside the database, and deleting only
the main file leaves them behind. And the last row is the only one that loses
something a re-run cannot get back — the town's site publishes what it currently
publishes, so a nine-year archive is only re-fetchable while the town still
has it.

### How a schema change is made

`src/db/migrate.ts`, in increasing order of violence: `schema.sql` is
re-executed on every open and is all `CREATE ... IF NOT EXISTS`, so a new table
or index needs nothing else; `ADDED_COLUMNS` handles new columns, because
`CREATE TABLE IF NOT EXISTS` will not add one to a table that exists;
`MIGRATIONS` handles what SQLite cannot do in place, guarded by
`PRAGMA user_version` and written to be idempotent anyway, so a database from
before the file existed replays every step and lands where a fresh one does.

The multi-town change needed all three. The one worth reading is the
`subscriptions` rebuild: `UNIQUE(user_id, kind, value)` said a reader may follow
one board called "Planning Board", full stop, and SQLite cannot alter a UNIQUE
constraint in place. Existing rows are backfilled with the configured default
town, never with the every-town wildcard — silently widening someone's
subscriptions is the one outcome nobody asked for.

One trap the schema file cannot catch on its own: `CREATE INDEX IF NOT EXISTS`
will not _rebuild_ an index that already exists under that name, so redefining
one silently leaves upgraded databases differing from fresh ones. Rename it and
drop the old name in a migration, which is what `idx_matters_recent` →
`idx_matters_town_recent` does.

## Deliberately not built yet

These are staged, not forgotten:

- **The bylaw lifecycle.** `town meeting adopts → clerk submits within 30 days →
AG decides within 90`. The AG Municipal Law Unit source is registered and
  disabled pending a form-driving adapter. Article matters already hold one end
  of it.
- **Sending an alert.** Subscriptions and the personal feed work; nothing mails
  or pushes. That needs a sender, a digest schedule, and an unsubscribe path
  that works without signing in.
- **Accounts that could face the internet, on the local backend.** See
  [Accounts](#accounts) for the list — email verification, password reset, rate
  limiting, recovery. Not staged so much as declined: `TOWNCIVIC_ACCOUNTS=supabase`
  hands all four to someone whose job they are, and re-implementing them here
  would be the wrong way to spend the effort.
- **Records in the hosted database.** The accounts backend moved the one thing
  that is not derived. Moving the records too would make the web tier stateless
  entirely and let a static front end query them over PostgREST — but it is a
  different change with a different budget. `events` and its full-text index are
  the large tables, Supabase's free tier is 500 MB, and the pipeline would need
  a publish stage and a story for what happens when a rebuild disagrees with
  what is already up there. Nothing in `src/accounts/` assumes it either way.
- **Sign-in that is not a password.** Magic links and OAuth are dashboard
  switches on the hosted backend, and the trigger in `supabase/migrations/`
  already gives an account arriving that way a reader row and a feed token. What
  is missing is the buttons.
- **Parcels rather than points.** The map geocodes to a street address and draws
  the town outline. MassGIS also publishes the statewide parcel layer, which is
  what a land-use record is actually about.
- **A street basemap.** Deferred rather than rejected — see [Map](#map). The
  cost is ~25 MB of cached tiles per town, and there are now several towns, so
  the arithmetic has got worse rather than better.
- **Courts.** Registered as a channel, no sources. It needs an aggressive
  inclusion filter — the town as a party, a local official sued in official
  capacity, a challenge to a local decision — so it stays _the town's legal
  surface_ and never becomes a courthouse blotter.
- **OCR.** Not needed for Milton today. `likelyScanned` flags the handful of
  image-only documents rather than silently returning nothing, so the day it
  matters it will be visible.
- **A cross-town view.** Every query can already drop the jurisdiction filter, so
  "every open bid on the South Shore" is one query away. What is missing is the
  UI question, not the data one: `body` and `channel` facets would silently merge
  four towns' Planning Boards into one row, and a merged facet is worse than no
  facet. The switcher is one town at a time until that is answered.
- **Per-town reader preferences.** Subscriptions carry their town and the feed
  respects it, but there is no "follow this in every town", no per-town digest,
  and no way to reorder the switcher. The column that would carry a wildcard
  exists (`jurisdiction = '*'`); nothing writes it.
- **Towns outside Massachusetts.** `timeZone` and `state` are on the profile and
  the geocoder reads both, but `boundary` only knows MassGIS and the body rules
  are written for Massachusetts municipal government. A New Hampshire town would
  need a second boundary provider and its own rule set.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request:

- **check** — `npm ci`, typecheck, Prettier, and the full test suite.
- **smoke** — seeds the fixtures on a clean checkout, links them into timelines,
  starts the server, and requests the feed, a channel view, the timelines index,
  a matter, the map, the source registry and the Atom feed.

`.github/workflows/refresh.yml` runs the live cycle on a schedule — see
[Operations](#operations).

Both jobs are fully offline, so CI never touches the town's servers and a red
build is a real regression rather than someone else's outage.

A `SessionStart` hook in `.claude/hooks/session-start.sh` installs dependencies
so a fresh remote checkout can run tests and linters immediately.

## Development

```bash
npm test           # 55 tests, no network
npm run typecheck
npm run format
```

Tests run the real adapters over fixtures in `fixtures/`. Those fixtures are
**synthetic** — they reproduce the markup and URL shapes of the live site, but
every agenda, bid and notice in them is made up. See `fixtures/README.md`.

### Configuration

**[`.env.example`](.env.example) lists every variable in one place**, with the
R2 and Supabase values annotated. townCivic does not load `.env` itself — export
them, or use whatever your host provides — so that config arrives one way
everywhere.

All optional, all environment variables: `TOWNCIVIC_DATA_DIR`, `TOWNCIVIC_DB`,
`PORT`, `TOWNCIVIC_BASE_URL`, `TOWNCIVIC_USER_AGENT`, `TOWNCIVIC_TIMEOUT_MS`,
`TOWNCIVIC_HOST_DELAY_MS`, `TOWNCIVIC_MAX_RETRIES`, `TOWNCIVIC_JURISDICTION`,
`TOWNCIVIC_SECURE_COOKIES`. `ANTHROPIC_API_KEY` is read only by
`interpret --provider anthropic`.

`TOWNCIVIC_SECURE_COOKIES=1` marks the session cookie `Secure`. It is off by
default so `npm run serve` works on localhost, where a `Secure` cookie is never
sent and signing in would appear to fail silently. Turn it on for anything
served over HTTPS.

`TOWNCIVIC_ACCOUNTS` chooses where readers live: `sqlite` (default) or
`supabase`. The hosted backend needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` —
Supabase's newer `sb_publishable_…` key goes in the latter, it is the same role
under a new name — and refuses to start without them rather than falling back,
because a fat-fingered variable that quietly served a working site with readers
in the wrong database would be the worst of both. The `NEXT_PUBLIC_` spellings
of those two are read as well, since that is what the dashboard hands you.
`TOWNCIVIC_SESSION_SECRET` is optional and is not a session store; see
[supabase/README.md](supabase/README.md). `npm run accounts` checks all of it.

`TOWNCIVIC_DOCUMENTS` chooses where the raw archive lives: `local` (default) or
`s3`. The S3 backend reads `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`,
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, and works against any
S3-compatible store rather than one provider — R2, Tigris, B2, MinIO, AWS.
`npm run documents` probes it with a real write and read; `--backfill` copies an
existing local archive in. See
[docs/operations.md](docs/operations.md#moving-the-archive-out).

`TOWNCIVIC_BASE_URL` is the origin the server is reachable at, used for absolute
links in feeds. The default is right for localhost; set it once there is a public
hostname, together with `TOWNCIVIC_SECURE_COOKIES=1`. Note that this is a Node
server rather than a static site, so it does not run on GitHub Pages — see
[docs/operations.md](docs/operations.md#not-a-shape-github-pages).

The crawler identifies itself honestly, waits between requests to the same host,
and sends conditional requests. `HTTPS_PROXY` / `HTTP_PROXY` are honoured — Node's
global `fetch` ignores them unless wired up explicitly, which `src/fetch/http.ts`
does.

## Being a good citizen of someone else's web server

These are small municipal servers serving public records. The defaults reflect that:
one request per host per second, conditional GETs so unchanged pages cost nothing,
bounded retries with exponential backoff, and a user agent with a contact URL.
Please don't lower them.
