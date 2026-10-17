-- Rebuild runs as a paged job. Every write stamps index_gen with the writer's current generation;
-- a rebuild bumps it, restamps every row it reads back from R2, and sweeps rows left on an older one.
ALTER TABLE notes ADD COLUMN index_gen INTEGER;
CREATE INDEX notes_index_gen ON notes(index_gen);
-- A note moved to a sensitive folder leaves a tombstone at its old path. moved_to is read by the
-- admin token only. path records the old location, including for files that never had a row.
ALTER TABLE tombstones ADD COLUMN moved_to TEXT;
ALTER TABLE tombstones ADD COLUMN path TEXT;
