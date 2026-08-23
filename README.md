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
always reproducible and always fixable in one place. Document extraction and event
linking are deliberately deferred — see [Deliberately not built yet](#deliberately-not-built-yet).

## Quick start

```bash
npm install
npm run ingest     # fetch every enabled source (~20 requests, about a minute)
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
are present. `npx tsx src/cli.ts clear-samples` removes them.

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

| Tier | What | Status |
| --- | --- | --- |
| 1 | The town itself — Agenda Center, bids, news flash | **Live**, 17 sources |
| 2 | State systems queried for the town — AG Municipal Law Unit, COMMBUYS | Registered, disabled, needs form-driving adapters |
| 3 | Federal actions resolving to the municipality | Not started |
| 4 | Town-controlled social accounts | Not started; discovery only, never canonical |

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

| Command | What it does |
| --- | --- |
| `ingest` | Fetch every enabled source, normalize, store what changed |
| `verify` | Check every registered URL against the live site |
| `discover` | Probe the CivicPlus site for boards and feeds not yet registered |
| `serve` | Web UI plus Atom and JSON feeds |
| `seed` | Load synthetic fixtures |
| `sources` / `events` | Print the registry / recent records |
| `clear-samples` | Delete everything loaded from fixtures |

Useful flags: `--source <id>` (repeatable), `--all` (include disabled),
`--force` (ignore ETag), `--dry-run`, `--json`.

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

| | |
| --- | --- |
| 10 | A board's own listing |
| 20 | The site-wide index |
| 30–40 | News flash, calendar |
| 90 | Peripheral accounts (future) |

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
  channel      land-use          occurred    2026-09-10   (meeting date, from the URL)
  event_type   meeting_agenda    published   2026-09-04   (posted date — Open Meeting Law notice)
  body         Board of Appeals  source      milton-ma:agenda:board-of-appeals
  url          https://www.miltonma.gov/AgendaCenter/ViewFile/Agenda/_09102026-6844
```

The **meeting date and the posted date are separate facts**, and the gap between
them is what makes a notice timely under the Open Meeting Law.

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

- **PDF text extraction.** The single biggest limitation today. Real Agenda Center
  rows carry only a date and a link — the subject matter (*"variance to reduce the
  rear setback from 20′ to 11′ at 271 Pleasant St"*) is inside the PDF. Subject and
  address extraction is written and tested, and returns almost nothing on live data
  for exactly this reason. This is the next thing worth building.
- **Event linking into timelines.** `application filed → hearing scheduled →
  continued → approved 4–1 → appealed`. Needs the PDF text above first.
- **The bylaw lifecycle.** `town meeting adopts → clerk submits within 30 days →
  AG decides within 90`. The AG Municipal Law Unit source is registered and
  disabled pending a form-driving adapter.
- **Courts.** Registered as a channel, no sources. It needs an aggressive
  inclusion filter — the town as a party, a local official sued in official
  capacity, a challenge to a local decision — so it stays *the town's legal
  surface* and never becomes a courthouse blotter.
- **An LLM indexing step.** Only ever as an indexer over stored documents, never
  as the authority. The raw document, its extracted text and its URL stay attached.

## Development

```bash
npm test           # 36 tests, no network
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
