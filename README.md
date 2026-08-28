# townCivic

**RSS for the jurisdiction — not an automated local newspaper.**

A primary-source feed of what one town's government actually did this week. It
records what was published, by whom, and when. It does not summarize, editorialize,
or decide what is newsworthy.

Currently scoped to **Milton, Massachusetts**.

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

Milton runs CivicPlus CivicEngage. Two URL shapes carry nearly everything, and
both put the facts in the path rather than the markup:

```
/AgendaCenter/<Board-Slug>-<CID>                       per-board agenda + minutes listing
/AgendaCenter/ViewFile/<Agenda|Minutes>/_MMDDYYYY-<id> the file itself
```

The adapters key off those hrefs, not CSS classes. The meeting date, the file id,
and the agenda-versus-minutes distinction are all in the URL, so a theme change
degrades ingestion to "found nothing" rather than to plausible garbage.

A live run currently yields **~718 records back to 2017** across 14 curated boards,
plus the site-wide index, bid postings and the news flash.

### Source tiers

| Tier | What                                                                 | Status                                            |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------- |
| 1    | The town itself — Agenda Center, bids, news flash                    | **Live**, 17 sources                              |
| 2    | State systems queried for the town — AG Municipal Law Unit, COMMBUYS | Registered, disabled, needs form-driving adapters |
| 3    | Federal actions resolving to the municipality                        | Not started                                       |
| 4    | Town-controlled social accounts                                      | Not started; discovery only, never canonical      |

Everything registered lives in `src/registry/milton-ma.ts` — one file, reviewed by
a human. `discover` proposes additions; it never writes them.

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
| `seed`               | Load synthetic fixtures                                                      |
| `sources` / `events` | Print the registry / recent records                                          |
| `clear-samples`      | Delete everything loaded from fixtures                                       |

Useful flags: `--source <id>` (repeatable), `--all` (include disabled),
`--force` (ignore ETag / re-extract), `--dry-run`, `--limit <n>`, `--since <date>`,
`--provider <name>`, `--json`.

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

The security primitives are real: scrypt with a per-user salt, constant-time
comparison, an opaque `HttpOnly` `SameSite=Lax` session cookie, a per-session
CSRF token on every state change, no open redirect on login, and one error
message whether the account is missing or the password is wrong.

**What is missing, and would have to exist first:** email verification, password
reset, rate limiting and lockout, a second factor, and any account-recovery path
at all. Set `TOWNCIVIC_SECURE_COOKIES=1` for anything served over HTTPS. The
personal feed URL contains a bearer token — rotatable, not the password, and a
secret.

Alerts are recorded but not sent. The `alerts` column carries the intent; there
is no sender. The honest description of alerts today is "an Atom feed you can
point anything at".

Accounts are also the one thing in the database that is not derived. If you run
them, `data/towncivic.db` stops being disposable.

## Operations

Full detail in **[docs/operations.md](docs/operations.md)** — the three
deployment shapes, a systemd unit, and what to watch.

The short version: `.github/workflows/refresh.yml` runs the cycle twice a day,
restores the previous database from the Actions cache, and publishes it as an
artifact. Twice a day is deliberate — meeting notices run on a 48-hour clock, so
a 12-hour worst case still leaves a day and a half, and these are small
municipal servers.

`status` is the whole monitoring story:

```bash
npm run status                            # human-readable
npm run status -- --json | jq .problems   # exits non-zero on a problem
```

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

## Adding a town

The state and federal adapters are meant to be reused; a new town is mostly
configuration.

1. Copy `src/registry/milton-ma.ts`, set the base URL and jurisdiction id.
2. Run `discover` against the new site to get its real module and category ids.
3. Curate the boards worth following, and write `BODY_RULES` for its committee names.
4. Register it in `src/registry/index.ts` and add a label in `src/web/server.ts`.
5. Run `verify` before enabling anything.

Per-jurisdiction classification currently lives in the Milton registry module and
is imported directly by `src/pipeline/normalize.ts`. That import is the one thing
that should move behind an interface when a second town lands.

## Deliberately not built yet

These are staged, not forgotten:

- **The bylaw lifecycle.** `town meeting adopts → clerk submits within 30 days →
AG decides within 90`. The AG Municipal Law Unit source is registered and
  disabled pending a form-driving adapter. Article matters already hold one end
  of it.
- **Sending an alert.** Subscriptions and the personal feed work; nothing mails
  or pushes. That needs a sender, a digest schedule, and an unsubscribe path
  that works without signing in.
- **Accounts that could face the internet.** See [Accounts](#accounts) for the
  list — email verification, password reset, rate limiting, recovery.
- **Parcels rather than points.** The map geocodes to a street address and draws
  the town outline. MassGIS also publishes the statewide parcel layer, which is
  what a land-use record is actually about.
- **A street basemap.** Deferred rather than rejected — see [Map](#map). The
  cost is ~25 MB of cached tiles per town, which is the wrong thing to take on
  before a second town exists.
- **Courts.** Registered as a channel, no sources. It needs an aggressive
  inclusion filter — the town as a party, a local official sued in official
  capacity, a challenge to a local decision — so it stays _the town's legal
  surface_ and never becomes a courthouse blotter.
- **OCR.** Not needed for Milton today. `likelyScanned` flags the handful of
  image-only documents rather than silently returning nothing, so the day it
  matters it will be visible.
- **A second town.** Per-jurisdiction classification still lives in the Milton
  registry module and is imported directly by `src/pipeline/normalize.ts`. The
  matter keys are in the same position. The map is no longer among them: a new
  town needs a row in `BOUNDARY_SOURCES` and one `boundary` run, because MassGIS
  publishes all 351 Massachusetts municipalities in a single layer.

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

All optional, all environment variables: `TOWNCIVIC_DATA_DIR`, `TOWNCIVIC_DB`,
`PORT`, `TOWNCIVIC_BASE_URL`, `TOWNCIVIC_USER_AGENT`, `TOWNCIVIC_TIMEOUT_MS`,
`TOWNCIVIC_HOST_DELAY_MS`, `TOWNCIVIC_MAX_RETRIES`, `TOWNCIVIC_JURISDICTION`,
`TOWNCIVIC_SECURE_COOKIES`. `ANTHROPIC_API_KEY` is read only by
`interpret --provider anthropic`.

`TOWNCIVIC_SECURE_COOKIES=1` marks the session cookie `Secure`. It is off by
default so `npm run serve` works on localhost, where a `Secure` cookie is never
sent and signing in would appear to fail silently. Turn it on for anything
served over HTTPS.

The crawler identifies itself honestly, waits between requests to the same host,
and sends conditional requests. `HTTPS_PROXY` / `HTTP_PROXY` are honoured — Node's
global `fetch` ignores them unless wired up explicitly, which `src/fetch/http.ts`
does.

## Being a good citizen of someone else's web server

These are small municipal servers serving public records. The defaults reflect that:
one request per host per second, conditional GETs so unchanged pages cost nothing,
bounded retries with exponential backoff, and a user agent with a contact URL.
Please don't lower them.
