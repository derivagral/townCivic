-- townCivic storage.
--
-- Layers, deliberately separated:
--   jurisdictions  the towns, as materialized registry rows
--   sources        the registry as materialized rows (so the UI can join against it)
--   fetches        one row per fetch attempt — the operational log
--   documents      content-addressed raw bodies — the authority, never overwritten
--   events         the normalized feed unit — derivable from documents, safe to rebuild
--
-- Every table that holds a record carries `jurisdiction` as a plain column, and
-- every query that reads records filters on it. That is the whole multi-town
-- design: one database, one schema, one row per town in `jurisdictions`, and no
-- table whose name or shape depends on which town it holds. A town is data.
--
-- The alternative — a database per town — was rejected because the expensive
-- parts are shared. `users`, `sessions` and `subscriptions` are per-person, not
-- per-town; a reader following a property in Milton and a school committee in
-- Hull is one account either way. Cross-town questions ("every open bid on the
-- South Shore") stay one query rather than a fan-out. And a town is added or
-- dropped by writing rows, which is what `clear` does.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- The towns, materialized from `src/registry/`.
--
-- The registry in code is the authority; this table exists so the UI can render
-- a town switcher, and `status` can count records per town, from one query
-- instead of importing the registry. A row here outliving its registry entry is
-- expected — see `orphanJurisdictions()`.
CREATE TABLE IF NOT EXISTS jurisdictions (
  id           TEXT PRIMARY KEY,          -- 'milton-ma'
  name         TEXT NOT NULL,             -- 'Milton'
  label        TEXT NOT NULL,             -- 'Milton, Massachusetts'
  state        TEXT NOT NULL,
  time_zone    TEXT NOT NULL,
  platform     TEXT NOT NULL,             -- civicplus | other
  base_url     TEXT NOT NULL,
  -- The geocoding fence used until the real outline is fetched, as JSON.
  bbox         TEXT NOT NULL DEFAULT '{}',
  -- Where the outline comes from, as JSON. Null when the town has no source yet.
  boundary     TEXT,
  notes        TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE INDEX IF NOT EXISTS idx_sources_town ON sources(jurisdiction, tier, label);

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
CREATE INDEX IF NOT EXISTS idx_events_source   ON events(source_id);
CREATE INDEX IF NOT EXISTS idx_events_pubdate  ON events(published_at DESC);

-- Jurisdiction leads every index below because it leads every query: with more
-- than one town in the table, an index on `channel` alone makes SQLite read the
-- other towns' rows to throw them away. These replace the single-column
-- `channel` and `body` indexes, which the composites cover.
CREATE INDEX IF NOT EXISTS idx_events_town_sort ON events(jurisdiction, coalesce(occurred_at, published_at, first_seen_at) DESC);
CREATE INDEX IF NOT EXISTS idx_events_town_channel ON events(jurisdiction, channel);
CREATE INDEX IF NOT EXISTS idx_events_town_body ON events(jurisdiction, body);

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

-- A *matter* is the thing the town is deciding about, as opposed to any one
-- meeting about it: a property, a warrant article, a procurement. Milton's
-- documents carry no case or docket identifier, so a matter is derived — see
-- src/matters/key.ts for the normalization that stands in for one — and the
-- whole table is rebuildable from `events` by re-running `link`.
CREATE TABLE IF NOT EXISTS matters (
  id            TEXT PRIMARY KEY,          -- hash of jurisdiction + kind + key
  jurisdiction  TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- address | article | bid
  -- The normalized form two records have to agree on to be the same matter.
  key           TEXT NOT NULL,
  -- The prettiest spelling seen, for display.
  label         TEXT NOT NULL,
  -- Rollups, recomputed by `link`. Denormalized so the index page is one query.
  event_count   INTEGER NOT NULL DEFAULT 0,
  first_at      TEXT,
  last_at       TEXT,
  bodies        TEXT NOT NULL DEFAULT '[]',
  channels      TEXT NOT NULL DEFAULT '[]',
  -- Where the matter stands, taken from its most recent record.
  status        TEXT,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_matters_key ON matters(jurisdiction, kind, key);
-- Renamed rather than redefined: `CREATE INDEX IF NOT EXISTS` will not rebuild
-- an index that already exists under the same name, so an upgraded database
-- would have kept the old single-column one and quietly differed from a fresh
-- one. The old name is dropped in `migrate.ts`.
CREATE INDEX IF NOT EXISTS idx_matters_town_recent ON matters(jurisdiction, last_at DESC);

CREATE TABLE IF NOT EXISTS matter_events (
  matter_id  TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- Where this record sits in the matter's life: filed, scheduled, heard,
  -- continued, decided, withdrawn, or just mentioned.
  stage      TEXT NOT NULL,
  -- The sentence the stage was read out of. Auditable: a surprising stage can
  -- always be traced to the words that produced it.
  evidence   TEXT,
  -- `exact` when the subject string matched, `derived` when a rule inferred it.
  confidence TEXT NOT NULL DEFAULT 'exact',
  linked_at  TEXT NOT NULL,
  PRIMARY KEY (matter_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_matter_events_event ON matter_events(event_id);

-- Readers, and what each of them wants to be told about.
--
-- A proof of concept, deliberately the smallest thing that answers "what do *I*
-- want to see": local accounts, a session cookie, and a list of subscriptions.
-- No email verification, no password reset, no third-party identity. See the
-- Accounts section of the README for what would have to be true before this
-- faced the public internet.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  -- Lower-cased email, so one address cannot register twice in two cases.
  email_key     TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  -- scrypt, with a per-user salt. Never a bare hash of the password.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  -- Bearer token for this reader's personal feed, so a feed reader that cannot
  -- hold a cookie can still subscribe. Rotatable without touching the password.
  feed_token    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,            -- the random value in the cookie
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Per-session token, required on every state-changing form post.
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One thing a reader is following. `kind` says how to read `value`:
--   matter   a matter id — this property, wherever it comes up
--   body     a public body name
--   channel  a feed channel
--   search   a full-text query
--
-- `jurisdiction` is the town the subscription was made in, or `*` for every
-- town. It is not decoration: `value` is only unique *within* a town. "Planning
-- Board" and "land-use" mean a different set of records in Milton than in Hull,
-- and without this column a reader following Milton's Planning Board would
-- silently start receiving Hull's the moment Hull was ingested. Matter ids are
-- globally unique and would have been safe either way; bodies, channels and
-- searches are the three kinds that would have quietly merged.
CREATE TABLE IF NOT EXISTS subscriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jurisdiction TEXT NOT NULL DEFAULT '*',
  kind         TEXT NOT NULL,
  value        TEXT NOT NULL,
  label        TEXT NOT NULL,
  -- none | digest | immediate. Only `none` is honoured today — nothing sends
  -- mail yet — so the column records intent rather than behaviour.
  alerts       TEXT NOT NULL DEFAULT 'none',
  created_at   TEXT NOT NULL,
  UNIQUE(user_id, jurisdiction, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

-- Readings of a document produced by something other than a parser.
--
-- Deliberately its own table with its own search index, never written back onto
-- `events`. The record is what the town published; this is an *indexer* over
-- it, so that prose the deterministic parsers cannot structure — a vote buried
-- in a paragraph of minutes — is still reachable by search. Anything in here is
-- labelled as derived wherever it is shown, and dropping the table loses
-- nothing that cannot be regenerated.
CREATE TABLE IF NOT EXISTS interpretations (
  id            TEXT PRIMARY KEY,          -- hash of event + kind + provider + prompt version
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- votes | decisions | summary
  kind          TEXT NOT NULL,
  provider      TEXT NOT NULL,             -- rules | anthropic | ...
  model         TEXT,
  -- Bumped when the prompt changes, so old readings are visibly from old rules.
  prompt_version TEXT NOT NULL,
  -- Hash of the document text this was read from. A re-extraction that changes
  -- the document makes the reading stale rather than silently wrong.
  doc_hash      TEXT NOT NULL,
  -- Prose, which is the point: this is what search reaches.
  text          TEXT NOT NULL,
  -- Whatever structure the provider managed to pull out, verbatim.
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interpretations_event ON interpretations(event_id);

-- A separate index from events_fts on purpose: the default search stays over
-- what the town published, and derived text is opted into.
CREATE VIRTUAL TABLE IF NOT EXISTS interpretations_fts USING fts5(
  text,
  content = 'interpretations',
  content_rowid = 'rowid'
);

CREATE TRIGGER IF NOT EXISTS interpretations_fts_insert AFTER INSERT ON interpretations BEGIN
  INSERT INTO interpretations_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS interpretations_fts_delete AFTER DELETE ON interpretations BEGIN
  INSERT INTO interpretations_fts(interpretations_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS interpretations_fts_update AFTER UPDATE ON interpretations BEGIN
  INSERT INTO interpretations_fts(interpretations_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO interpretations_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Where a matter is, when it has a place. One row per matter, including the
-- ones that failed to resolve — a recorded miss stops the geocoder being asked
-- the same unanswerable question on every run.
CREATE TABLE IF NOT EXISTS places (
  matter_id      TEXT PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
  lat            REAL,
  lon            REAL,
  -- The address as the geocoder understood it. Storing it is how a plausible
  -- but wrong match becomes visible instead of just being a pin in the water.
  matched        TEXT,
  -- census | manual | none
  provider       TEXT NOT NULL,
  -- Set when the lookup ran but produced nothing usable.
  failure        TEXT,
  geocoded_at    TEXT NOT NULL
);

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
