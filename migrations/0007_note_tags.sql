-- The tags of each note, in lower case, so a search can ask for notes with a tag and the tag list
-- can count them. A note gives its frontmatter tags (a list, or one comma-separated string) and, for
-- a journal or decision day file, the Tags: line of each entry. The writer keeps these rows equal to the
-- note row, as it does note_names, and the nightly reconcile repairs them. This fills the table for
-- the notes that exist now, with the statement src/tags.ts uses (noteTagRows).
CREATE TABLE note_tags (
  tag TEXT NOT NULL,
  note_id TEXT NOT NULL,
  PRIMARY KEY (tag, note_id)
) WITHOUT ROWID;

CREATE INDEX note_tags_note ON note_tags(note_id);

INSERT INTO note_tags (tag, note_id)
WITH
  picked AS (SELECT id, type, body, frontmatter FROM notes),
  listed(id, value) AS (
    SELECT p.id, t.value FROM picked p,
      json_each(CASE WHEN json_valid(p.frontmatter) THEN CASE json_type(p.frontmatter, '$.tags') WHEN 'array' THEN p.frontmatter END END, '$.tags') t
      WHERE t.type = 'text'
    UNION ALL
    SELECT p.id, json_extract(p.frontmatter, '$.tags') FROM picked p
      WHERE json_valid(p.frontmatter) AND json_type(p.frontmatter, '$.tags') = 'text'
    UNION ALL
    SELECT p.id, substr(line.value, 7) FROM picked p,
      json_each(CASE WHEN p.type IN ('journal', 'decision') THEN
        '[' || replace(json_quote(replace(replace(replace(p.body, char(57344), ''), char(13), ''), char(10), char(57344))), char(57344), '","') || ']' END) line
      WHERE substr(line.value, 1, 6) = 'Tags: '
  ),
  split(id, tag) AS (
    SELECT l.id, s.value FROM listed l, json_each('[' || replace(json_quote(l.value), ',', '","') || ']') s
  ),
  clean(id, tag) AS (SELECT DISTINCT id, lower(trim(ltrim(trim(tag), '#'))) FROM split),
  kept(id, tag, k) AS (
    SELECT id, tag, row_number() OVER (PARTITION BY id ORDER BY tag) FROM clean
      WHERE tag != '' AND length(tag) <= 64 AND instr(tag, char(10)) = 0 AND instr(tag, char(13)) = 0
  )
SELECT tag, id FROM kept WHERE k <= 200;
