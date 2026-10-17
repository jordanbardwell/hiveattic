-- HiveAttic index. R2 markdown is the source of truth. This database can be rebuilt.

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'external', 'human')),
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  token_hash TEXT NOT NULL UNIQUE,
  scopes_override TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  owner TEXT NOT NULL,
  domain TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  fact_key TEXT,
  title TEXT,
  body TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  statement_hash TEXT,
  r2_etag TEXT,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'forgotten', 'quarantined')),
  superseded_by TEXT,
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version_ts TEXT,
  last_writer TEXT NOT NULL,
  last_confirmed_at TEXT,
  index_enqueued_at TEXT,
  indexed_at TEXT
);

CREATE UNIQUE INDEX notes_fact_key ON notes(owner, fact_key) WHERE fact_key IS NOT NULL AND status = 'active';
CREATE INDEX notes_domain_type ON notes(domain, type, status);
CREATE INDEX notes_updated ON notes(updated_at);
CREATE INDEX notes_status_path ON notes(status, path);

CREATE TABLE note_versions (
  note_id TEXT NOT NULL REFERENCES notes(id),
  version_ts TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  writer TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (note_id, version_ts)
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  n INTEGER NOT NULL,
  text TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  token_count INTEGER
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  title,
  path UNINDEXED,
  content='chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, title, path)
  VALUES (new.rowid, new.text, new.title, new.path);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, title, path)
  VALUES ('delete', old.rowid, old.text, old.title, old.path);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, title, path)
  VALUES ('delete', old.rowid, old.text, old.title, old.path);
  INSERT INTO chunks_fts(rowid, text, title, path)
  VALUES (new.rowid, new.text, new.title, new.path);
END;

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  agent_id TEXT NOT NULL,
  at TEXT NOT NULL,
  title TEXT NOT NULL,
  block_ref TEXT NOT NULL,
  idempotency_key TEXT,
  UNIQUE (agent_id, idempotency_key)
);

CREATE TABLE links (
  src_note_id TEXT NOT NULL,
  target TEXT NOT NULL,
  dst_note_id TEXT,
  PRIMARY KEY (src_note_id, target)
);

CREATE TABLE tombstones (
  note_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  by_agent TEXT NOT NULL,
  reason TEXT NOT NULL,
  purged_at TEXT,
  content_hash TEXT NOT NULL
);

CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  fact_key TEXT NOT NULL,
  winner_id TEXT,
  loser_id TEXT,
  at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);

CREATE TABLE policy_terms (
  term TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('employer', 'deny', 'allow', 'context_subject', 'context_qualifier')),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  request_id TEXT NOT NULL,
  agent_id TEXT,
  token_id TEXT,
  client TEXT NOT NULL,
  action TEXT NOT NULL,
  path TEXT,
  note_id TEXT,
  outcome TEXT NOT NULL,
  reason_codes TEXT,
  content_hash TEXT,
  bytes INTEGER,
  ip_country TEXT
);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit is append-only');
END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit is append-only');
END;

CREATE TABLE idempotency (
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  response TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (agent_id, key)
);

CREATE TABLE rate_counters (
  token_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (token_id, bucket_start, kind)
);

-- Chunk ids that M2 must delete from Vectorize. M1 has no vector index.
CREATE TABLE vector_delete_queue (
  chunk_id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  requested_at TEXT NOT NULL
);
