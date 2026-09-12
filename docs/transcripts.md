# Milton meeting transcripts

Milton Access TV publishes a public WordPress RSS feed with the complete transcript
in each item's `content:encoded` field:

- Archive/search: https://miltonaccesstv.org/transcripts/
- RSS: https://miltonaccesstv.org/category/transcript/feed/

Verified September 12, 2026. **No YouTube API key, OAuth, Whisper, or transcription
service is needed for this source.** The adapter reads MATV's published text;
YouTube is the playback destination only. Google's official caption-download API
requires permission to edit the video, not just a public API key:
https://developers.google.com/youtube/v3/docs/captions/download

## Run

Requires the project's normal Node 22.5+ environment and dependencies (`npm ci`).

```sh
# Fetch and parse without inserting event records. Like other ingest sources,
# dry-run still archives the response and records fetch state.
npm run ingest -- --jurisdiction milton-ma --source milton-ma:transcripts:matv --dry-run

# --force refetches after a dry-run even if the publisher answers conditional GETs.
npm run ingest -- --jurisdiction milton-ma --source milton-ma:transcripts:matv --force

npm run serve
```

Search Activity using a word from a transcript, or select the Milton Access TV
source. Open a Transcript record to read all passages and follow a timestamp to
YouTube. Dates in Activity are meeting dates, including historical meetings
published recently. Use the Past/All view when appropriate.

Full text is indexed at ingestion: `extract` is unnecessary for these records.
`interpret` remains a separate optional operation. The source is registered but
**disabled in unattended refresh** pending a successful fetch from the deployment
network. An explicit `--source` overrides that flag for a scoped run. After
`npm run verify -- --jurisdiction milton-ma --source milton-ma:transcripts:matv`
succeeds there, set `MATV_TRANSCRIPTS.enabled` to `true` in
`src/registry/milton-ma.ts` to join the existing all-town refresh. It uses the same
document-store configuration and needs no new secrets or database migration.

## Stored data

- One `meeting_transcript` event per MATV permalink; repeated fetches are idempotent.
- Canonical board via the existing town aliases, day-precision meeting date, and
  separate RSS publication date. No clock time is invented from the transcript.
- Full searchable text in `events.doc_text`, without the brief summary's truncation.
- Versioned transcript shape in `events.raw.transcript`: publisher-auto origin,
  actual case-sensitive YouTube video ID, meeting date, and segments containing
  start/end seconds, source speaker label, and text.
- Raw XML in the existing content-addressed document archive. Changed text or
  timestamps update the searchable projection and increment the event revision;
  the fetched source bytes remain available in the archive.

Publisher wording is retained, including profanity. Whitespace is normalized and
paragraph boundaries retained. HTML is converted to text and escaped at display.
The source may already contain recognition errors or omissions.

`Speaker 1` is an unverified source label, not an identified person. This adapter
does not infer attendance or map labels to names. A later attendance record should
use an explicit roll call/minutes reference, independently of speaker attribution.

Board and meeting date provide candidates for a future notice/minutes join; this
change does not merge recordings on those fields or assert exact meeting identity.
Transcripts remain distinct from agendas/minutes. Matter linking skips transcript
speech for now, so mention of an address, contract, or past approval does not create
a location or assert a current decision. Passage-to-agenda matching and subject
annotation are follow-up work.

## Coverage and operational limits

The observed RSS window contains **10 recent publications**, not the latest ten
meeting dates. MATV is publishing historical transcripts as well as current ones.
This first adapter fetches that window only. Previously ingested events remain
when they leave the feed, but more than ten publications between successful polls
can cause gaps. The existing twice-daily schedule is not a completeness guarantee.
Old transcript corrections outside the feed window are not rediscovered.

The feed was downloaded successfully, but a later direct crawler request received
a bot challenge (HTTP 202). Access from Actions/Fly/local environments still needs
verification; that is why the source is disabled by default.

Archive pagination was not verified: the attempted second-page request returned a
SiteGround bot challenge in this environment. Historical backfill needs a verified
archive/API/feed export or cooperation from MATV. There is no unverified pagination
fallback, proxy rotation, browser login, or YouTube scraping in this adapter.

Malformed XML, HTML challenge responses (including HTTP 200), missing full content,
and unrecognized segment structures fail the source visibly rather than returning
an apparently successful empty transcript. A valid empty RSS channel is accepted.
A failed parse preserves existing events and clears conditional validators so the
next run retries the body. Parsing validates the complete batch before writes.

## Verification

`test/transcripts.test.ts` uses synthetic feed text shaped like the live source.
It checks date separation, canonical bodies, full-text indexing, late-text revisions,
timestamps, unchanged reingestion, dry-run behavior, escaped rendering, malformed
source handling, archive writes, and conditional requests. It does not rely on live
municipal sites or infer real people's statements.
