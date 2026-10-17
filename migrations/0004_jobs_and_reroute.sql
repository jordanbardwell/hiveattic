-- Rebuild runs as a paged job. Every write stamps index_gen with the writer's current generation;
-- a rebuild bumps it, restamps every row it reads back from R2, and sweeps rows left on an older one.
ALTER TABLE notes ADD COLUMN index_gen INTEGER;
CREATE INDEX notes_index_gen ON notes(index_gen);
-- A note moved to a sensitive folder leaves a tombstone at its old path. moved_to is read by the
-- admin token only. path records the old location, including for files that never had a row.
ALTER TABLE tombstones ADD COLUMN moved_to TEXT;
ALTER TABLE tombstones ADD COLUMN path TEXT;
-- An idempotency key is bound to a hash of its payload: the same key with another payload is refused.
ALTER TABLE idempotency ADD COLUMN payload_hash TEXT;
-- A stored object over 1,900,000 bytes is not indexed, not deleted, and not served. Its index
-- status is oversize: D1 records the path and size only. A row the path had before keeps its
-- history but loses its chunks and links.
CREATE TABLE oversize_files (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  r2_etag TEXT,
  note_id TEXT,
  status TEXT NOT NULL DEFAULT 'oversize' CHECK (status = 'oversize'),
  found_at TEXT NOT NULL,
  index_gen INTEGER
);
