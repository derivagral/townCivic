-- townCivic storage.
--
-- Three layers, deliberately separated:
--   sources    the registry as materialized rows (so the UI can join against it)
--   fetches    one row per fetch attempt — the operational log
--   documents  content-addressed raw bodies — the authority, never overwritten
--   events     the normalized feed unit — derivable from documents, safe to rebuild

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  jurisdiction   TEXT NOT NULL,
  label          TEXT NOT NULL,
  adapter        TEXT NOT NULL,
  url            TEXT NOT NULL,
  level          TEXT NOT NULL,
  agency         TEXT NOT NULL,
  body           TEXT,
  channel        TEXT NOT NULL,
  event_type     TEXT,
  priority       TEXT NOT NULL,
  tier           INTEGER NOT NULL,
  precedence     INTEGER NOT NULL DEFAULT 50,
  confidence     TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  options        TEXT NOT NULL DEFAULT '{}',
  notes          TEXT,
  -- operational state, updated by the fetcher
  etag           TEXT,
  last_modified  TEXT,
  last_fetch_at  TEXT,
  last_status    INTEGER,
  last_error     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fetches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  duration_ms  INTEGER,
  http_status  INTEGER,
  ok           INTEGER NOT NULL,
  not_modified INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER,
  document_id  TEXT REFERENCES documents(id),
  item_count   INTEGER,
  new_count    INTEGER,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_fetches_source ON fetches(source_id, started_at DESC);

-- Raw bodies, keyed by sha256 of the content. Re-fetching unchanged pages is free.
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,          -- sha256 hex of body
  source_id     TEXT NOT NULL,
  url           TEXT NOT NULL,
  content_type  TEXT,
  bytes         INTEGER NOT NULL,
  path          TEXT NOT NULL,             -- relative path inside the document store
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,          -- stable hash: source + external id
  jurisdiction  TEXT NOT NULL,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  level         TEXT NOT NULL,
  agency        TEXT NOT NULL,
  body          TEXT,
  channel       TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  priority      TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT,
  url           TEXT NOT NULL,
  document_url  TEXT,
  -- when the thing happens/happened (meeting date, hearing date, bid due date)
  occurred_at   TEXT,
  -- when the source published the record
  published_at  TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  -- set when a later fetch changes the item in place (agenda revised, bid amended)
  revised_at    TEXT,
  revision      INTEGER NOT NULL DEFAULT 1,
  subjects      TEXT NOT NULL DEFAULT '[]',
  tags          TEXT NOT NULL DEFAULT '[]',
  -- text extracted from the linked document, denormalized here so one FTS index
  -- covers both the listing metadata and the contents of the PDF
  doc_text      TEXT,
  -- when the document behind this record was last extracted
  extracted_at  TEXT,
  -- precedence of the source that currently owns this record; a lower-numbered
  -- source may take it over, a higher-numbered one may not
  precedence    INTEGER NOT NULL DEFAULT 50,
  content_hash  TEXT NOT NULL,
  raw           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_sort     ON events(coalesce(occurred_at, published_at, first_seen_at) DESC);
CREATE INDEX IF NOT EXISTS idx_events_channel  ON events(channel);
CREATE INDEX IF NOT EXISTS idx_events_source   ON events(source_id);
CREATE INDEX IF NOT EXISTS idx_events_body     ON events(body);
CREATE INDEX IF NOT EXISTS idx_events_pubdate  ON events(published_at DESC);

-- Free-text search over the parts a person would actually search.
-- `doc_text` is what makes searching an agenda's contents work: "39 Frothingham"
-- appears only inside the notice PDF, never in the listing row.
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title, summary, subjects, agency, doc_text,
  content = 'events',
  content_rowid = 'rowid'
);

CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, title, summary, subjects, agency, doc_text)
  VALUES (new.rowid, new.title, new.summary, new.subjects, new.agency, new.doc_text);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, summary, subjects, agency, doc_text)
  VALUES ('delete', old.rowid, old.title, old.summary, old.subjects, old.agency, old.doc_text);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_update AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, summary, subjects, agency, doc_text)
  VALUES ('delete', old.rowid, old.title, old.summary, old.subjects, old.agency, old.doc_text);
  INSERT INTO events_fts(rowid, title, summary, subjects, agency, doc_text)
  VALUES (new.rowid, new.title, new.summary, new.subjects, new.agency, new.doc_text);
END;

-- One row per document actually fetched and parsed. The bytes themselves stay
-- in the content-addressed store; this records what came out of them.
CREATE TABLE IF NOT EXISTS attachments (
  id             TEXT PRIMARY KEY,          -- sha256 of the file
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  content_type   TEXT,
  bytes          INTEGER NOT NULL,
  path           TEXT,                      -- relative path in the document store
  pages          INTEGER,
  chars_per_page INTEGER,
  likely_scanned INTEGER NOT NULL DEFAULT 0,
  -- AcroForm field values, verbatim. The structured payload of a notice.
  fields         TEXT NOT NULL DEFAULT '{}',
  -- Parsed meeting notice, when the document is one.
  notice         TEXT,
  extracted_at   TEXT NOT NULL,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_event ON attachments(event_id);
