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
npm run serve      # http://localhost:8787
```

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
| `verify`             | Check every registered URL against the live site                             |
| `discover`           | Probe the CivicPlus site for boards and feeds not yet registered             |
| `serve`              | Web UI plus Atom and JSON feeds                                              |
| `seed`               | Load synthetic fixtures                                                      |
| `sources` / `events` | Print the registry / recent records                                          |
| `clear-samples`      | Delete everything loaded from fixtures                                       |

Useful flags: `--source <id>` (repeatable), `--all` (include disabled),
`--force` (ignore ETag / re-extract), `--dry-run`, `--limit <n>`, `--since <date>`, `--json`.

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
     ↓
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

## Feeds

```
/feeds/all.atom          /feeds/all.json
/feeds/land-use.atom     /feeds/money.atom     /feeds/meetings.atom    …
```

Add `?source=`, `?body=` or `?q=` to narrow any feed the same way the web filters
do. JSON Feed entries carry a `_towncivic` object with the jurisdiction, source
level, agency, body, channel, event type and permalink.

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

- **Event linking into timelines.** `application filed → hearing scheduled →
continued → approved 4–1 → appealed`. The extraction work above is the
  prerequisite, and now that agendas resolve to street addresses this is the
  natural next step: group records by subject and order them by date.
- **The bylaw lifecycle.** `town meeting adopts → clerk submits within 30 days →
AG decides within 90`. The AG Municipal Law Unit source is registered and
  disabled pending a form-driving adapter.
- **Minutes are only text.** Agendas are structured; minutes are prose, so votes
  ("approved 4–1") and conditions are not parsed out yet. This is the one place a
  model would genuinely earn its keep — and it would run as an _indexer_ over
  stored documents, never as the authority.
- **Courts.** Registered as a channel, no sources. It needs an aggressive
  inclusion filter — the town as a party, a local official sued in official
  capacity, a challenge to a local decision — so it stays _the town's legal
  surface_ and never becomes a courthouse blotter.
- **OCR.** Not needed for Milton today. `likelyScanned` flags the handful of
  image-only documents rather than silently returning nothing, so the day it
  matters it will be visible.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request:

- **check** — `npm ci`, typecheck, Prettier, and the full test suite.
- **smoke** — seeds the fixtures on a clean checkout, starts the server, and
  requests the timeline, a channel view, the source registry and the Atom feed.

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
`TOWNCIVIC_HOST_DELAY_MS`, `TOWNCIVIC_MAX_RETRIES`, `TOWNCIVIC_JURISDICTION`.

The crawler identifies itself honestly, waits between requests to the same host,
and sends conditional requests. `HTTPS_PROXY` / `HTTP_PROXY` are honoured — Node's
global `fetch` ignores them unless wired up explicitly, which `src/fetch/http.ts`
does.

## Being a good citizen of someone else's web server

These are small municipal servers serving public records. The defaults reflect that:
one request per host per second, conditional GETs so unchanged pages cost nothing,
bounded retries with exponential backoff, and a user agent with a contact URL.
Please don't lower them.
