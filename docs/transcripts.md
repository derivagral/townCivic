# Milton meeting transcripts

Milton Access TV's WordPress REST API is the primary transcript source. The user
confirmed public category **36**, reporting 429 posts on September 13, 2026:

- Category: https://miltonaccesstv.org/wp-json/wp/v2/categories?slug=transcript
- Posts: https://miltonaccesstv.org/wp-json/wp/v2/posts?categories=36
- Human archive/search: https://miltonaccesstv.org/transcripts/

No WordPress account, API key, YouTube credentials, or transcription service is
needed for public posts. API access can still be challenged by SiteGround depending
on the requesting environment. Category access alone does not establish that full
post content is reachable from GitHub Actions.

RSS polling is tabled. Its parser remains for compatibility tests and the shared
MATV HTML parser, but there is no registered RSS transcript source. Existing records
keep their permalink identity when switching from RSS to the API.

## Run and resume

Requires the project's Node 22.5+ environment and dependencies (`npm ci`).

```sh
# First invocation discovers the archive; fetch up to five batches of 20 posts.
npm run ingest -- --jurisdiction milton-ma --source milton-ma:transcripts:matv --max-pages 5

# Repeat the same command to resume pending IDs. Once complete, subsequent runs
# discover newly modified posts instead of starting the archive again.
npm run ingest -- --jurisdiction milton-ma --source milton-ma:transcripts:matv --max-pages 5

# Explicit reconciliation of all published transcript posts. A pending batch
# always resumes first; this flag starts a full scan when no queue is pending.
npm run ingest -- --source milton-ma:transcripts:matv --backfill --max-pages 30

# Inspect without inserting records or advancing any checkpoint/watermark.
# Responses and fetch diagnostics are still archived, as with ordinary ingest.
npm run ingest -- --source milton-ma:transcripts:matv --dry-run --max-pages 1 --json

npm run serve
```

`--max-pages` limits content requests to 1–100 batches per invocation. Initial
inventory discovery requests only IDs, in pages of 100: approximately five small
requests for the currently reported archive. Discovery is capped at 10,000 posts;
exceeding that cap fails explicitly. Every request uses the existing per-host
politeness delay, timeout, and retry mechanism. A failed API ingest with `--json`
returns a nonzero process status, so Actions does not mistake a bot check for success.

The report includes `pages`, `pending`, `completedThrough`, and `unavailableIds`.
A successful bounded batch can still have pending work. Repeat until `pending` is
zero. Search and reading are available for each committed batch immediately; no
`extract` or model call is needed.

## Synchronization and storage

1. Discover IDs ordered by ID, scoped to category 36 and a fixed modification-time
   upper bound. Pagination headers and distinct ascending IDs must agree. If the
   inventory changes or a page is missing, discovery fails and is retried from
   the beginning; an incomplete inventory is never checkpointed as complete.
2. Save the discovered ID queue and cursor in `transcript_sync`, alongside the
   events in SQLite. Fetch full content by explicit ID batches, so subsequent
   content requests do not depend on changing page offsets.
3. Archive each raw JSON response in the configured content-addressed store.
   Parse the entire content batch, then atomically commit its events and cursor.
   A malformed post or interrupted batch leaves that cursor pending for retry.
4. Once the queue is exhausted, advance `completedThrough`. Later discovery uses
   `modified_after` with a 24-hour overlap and `modified_before` fixed five minutes
   behind the current clock. Both new posts and older edited posts are checked.

Posts removed, unpublished, or moved out of the category between discovery and
retrieval are reported as `unavailableIds`. Existing stored records are retained.
Public API reads cannot distinguish those reasons. Use `--backfill` periodically
for full reconciliation, especially after a publisher imports backdated content.

Checkpoints persist as part of the database, including its existing Actions cache
and snapshot. Losing the database causes discovery to start over; raw archived
responses remain in the configured document store. `clear --scope records` resets
the transcript checkpoint with that town's records. The new checkpoint table is
created automatically on database open; no manual migration is required.

Meeting date remains separate from publication/modification time. Full text is
indexed in `events.doc_text`; `events.raw.transcript` keeps source speaker labels,
case-sensitive YouTube ID, and start/end seconds. Full post content, not the excerpt,
is parsed. Transcript changes refresh search and increment the event revision.

Publisher wording, including profanity, is retained. Numbered speakers remain
unverified source labels; no names or attendance are inferred. Matter linking skips
speech until passage-level evidence is supported. Board/date metadata is available
for later notice/minutes matching; records are not merged on those fields.

## Run the live check before merging

`.github/workflows/transcripts.yml` runs on relevant **same-repository PR updates**.
It checks out the PR head and performs inventory discovery plus at most two content
batches (40 posts) by default. This is a live network check separate from offline CI.

The job uses a fresh temporary SQLite database and local document archive. It has
no production secrets, production cache restoration, snapshot publishing, or deploy
step. Its report, database, and raw responses are uploaded as an artifact for seven
days, including on failure. A red job distinguishes access or parser problems from a
successful run with pending backfill.

A new `workflow_dispatch` workflow generally needs to exist on the default branch
before its manual button is available. After merge, use Actions → Milton transcript
API check → Run workflow → Branch, or:

```sh
gh workflow run transcripts.yml --ref feat/milton-transcripts -f max_pages=2
```

Manual checks also use fresh temporary storage; they do not resume another job's
artifact automatically. Run the ingest CLI against the same persistent database to
resume a real backfill. The PR check is deliberately a bounded connectivity test.

The source remains disabled in the shared unattended refresh until runner access
is verified. Explicit `--source` overrides that flag. Once verified, setting
`MATV_TRANSCRIPTS.enabled` to `true` lets the existing refresh command fill the
archive over successive bounded runs, then switch automatically to incremental
synchronization. No RSS fallback will activate.

References: [WordPress posts API](https://developer.wordpress.org/rest-api/reference/posts/),
[pagination](https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/),
[GitHub manual workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
