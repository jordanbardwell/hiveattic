-- The names a [[link]] can use for a note, in lower case: the path (kind 0), each part of the path
-- after a slash (kind 1), the fact key (kind 2), and each alias (kind 3). A link finds its target
-- here with the primary key, so a write no longer reads every note for each link. The writer keeps
-- these rows equal to the note row. This fills the table for the notes that exist now.
CREATE TABLE note_names (
  name TEXT NOT NULL,
  note_id TEXT NOT NULL,
  kind INTEGER NOT NULL,
  PRIMARY KEY (name, note_id)
) WITHOUT ROWID;

CREATE INDEX note_names_note ON note_names(note_id);

INSERT INTO note_names (name, note_id, kind)
WITH RECURSIVE
  picked AS (SELECT id, path, fact_key, frontmatter FROM notes),
  tail(id, rest) AS (
    SELECT id, substr(path, instr(path, '/') + 1) FROM picked WHERE instr(path, '/') > 0
    UNION ALL SELECT id, substr(rest, instr(rest, '/') + 1) FROM tail WHERE instr(rest, '/') > 0
  ),
  named(name, id, kind) AS (
    SELECT path, id, 0 FROM picked
    UNION ALL SELECT rest, id, 1 FROM tail
    UNION ALL SELECT fact_key, id, 2 FROM picked WHERE fact_key IS NOT NULL
    UNION ALL SELECT trim(a.value), p.id, 3 FROM picked p,
      json_each(CASE WHEN json_valid(p.frontmatter) THEN CASE json_type(p.frontmatter, '$.aliases') WHEN 'array' THEN p.frontmatter END END, '$.aliases') a
      WHERE a.type = 'text'
  )
SELECT lower(name), id, MIN(kind) FROM named WHERE name != '' GROUP BY lower(name), id;
