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
