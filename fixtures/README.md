# Fixtures

**These are synthetic samples, not captured public records.**

They reproduce the *markup and URL shapes* CivicPlus CivicEngage emits so the
adapters, tests and UI can be exercised with no network access. The board names
are real Milton boards; every agenda, bid, hearing and notice in them is made up.

Nothing here should ever be presented as a record of what Milton actually did.
`towncivic seed` tags every event it loads from these files with `sample`, and
the web UI shows a standing banner while any sample event is in the database.

To work with real records, run `towncivic verify` and then `towncivic ingest`
against the live site.

## Which town a fixture belongs to

Each town's fixtures are declared on its own profile (`fixtures` in
`src/registry/<id>.ts`), keyed by source id, and live in a directory named after
the jurisdiction — `fixtures/milton-ma/`. A town with no fixtures simply seeds
nothing, which is the honest state for a town whose site has not been read yet:
inventing a fixture for it would be fiction twice over.

## `meeting-notice.pdf`

A minimal AcroForm PDF with the same field names as the Town Clerk's real
template (`BOARDCOMMITTEE`, `DATE`, `TIME`, `AGENDA`, `PostTime`, …). It exists
so the PDF extraction tests can run offline without committing a real public
record as a test artifact.

Regenerate it with:

```bash
node fixtures/tools/make-meeting-notice.mjs
```

The addresses in it (271 Pleasant Street, 14 Adams Street) are invented, and the
page text deliberately includes the town hall address so the venue filter has
something to exclude.
