import { VaultError } from "./errors";

// Tags group notes, facts, and journal days across folders. note_tags holds each note's tags in one
// form: spaces at either end and any leading `#` removed, and ASCII letters in lower case. The SQL
// below makes that form when it fills the table, and normalizeTag makes it for a search, so a
// search finds what the table holds. A tag nests under another with `/`: `projects` also finds
// `projects/garden`.

// The longest tag the table keeps. A write takes 40 characters (schemas.ts); an outside edit can
// carry longer ones, and those are not indexed.
export const MAX_TAG_CHARS = 64;
// The most tags one note puts in the table, so an outside edit with thousands of tags cannot make
// a write's batch too big to run. The first ones in sorted order are kept.
export const MAX_TAGS_PER_NOTE = 200;
// The most tags one search takes. A note must have all of them.
export const MAX_SEARCH_TAGS = 10;

export function normalizeTag(raw: string): string | null {
  const tag = trimSpaces(trimSpaces(raw).replace(/^#+/, "")).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (!tag || [...tag].length > MAX_TAG_CHARS || /[\r\n,]/.test(tag)) return null;
  return tag;
}

// SQLite's trim() removes spaces only, and its lower() changes ASCII letters only. These match it.
function trimSpaces(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

// The tags a search asks for, in normal form and without repeats. Bad input is refused rather than
// dropped, because a dropped filter would widen the search.
export function searchTags(raw: string[] | undefined): string[] {
  if (!raw?.length) return [];
  if (raw.length > MAX_SEARCH_TAGS) throw new VaultError("invalid", `A search takes at most ${MAX_SEARCH_TAGS} tags`, ["tags"]);
  const tags = raw.map(normalizeTag);
  if (tags.some((tag) => tag === null)) {
    throw new VaultError("invalid", `A tag must have 1 to ${MAX_TAG_CHARS} characters and no comma or line break`, ["tags"]);
  }
  return [...new Set(tags as string[])];
}

// The prefix for the tag list: empty for every tag, or a tag in normal form, such as `projects/`.
export function tagPrefix(raw: string): string {
  if (!raw.trim()) return "";
  const prefix = normalizeTag(raw);
  if (prefix === null) throw new VaultError("invalid", "Tag prefix is not valid", ["prefix"]);
  return prefix;
}

// A filter that keeps the notes with this tag or a tag nested under it. The two ranges read the
// note_tags primary key: the tag itself, then every tag from `tag/` up to `tag0` (`0` sorts right
// after `/`), so `projects` matches `projects/garden` and not `projects-old`.
export function taggedIdsSql(): string {
  return "SELECT note_id FROM note_tags WHERE tag = ? UNION SELECT note_id FROM note_tags WHERE tag >= ? AND tag < ?";
}

export function taggedIdsBinds(tag: string): string[] {
  return [tag, `${tag}/`, `${tag}0`];
}

// The (tag, note_id) rows of the notes that `picked` selects (id, type, body, frontmatter). The tags
// come from:
// - frontmatter `tags` as a list of strings, as the API writes them for notes and facts;
// - frontmatter `tags` as one string, as an outside edit may write them;
// - each `Tags: ` line of a journal or decision day file. The server writes that line for an entry,
//   and a caller's body cannot start a line with it (markdown.ts escapes it).
// Each of these is split on commas, so no indexed tag holds one, whatever wrote the file. The text is
// split by turning it into a JSON array with json_quote (a comma is never part of an escape), so the
// work grows with the size of the file, not with its lines times its size. Line breaks become U+E000
// before the quote, because json_quote escapes them; U+E000 already in the text is dropped first.
// Then each tag takes its normal form, and empty tags, tags over MAX_TAG_CHARS, and tags with a line
// break are dropped. Each note keeps at most MAX_TAGS_PER_NOTE, the first in sorted order.
// migrations/0007_note_tags.sql fills the table with the same statement.
export function noteTagRows(picked: string): string {
  return `WITH
  picked AS (${picked}),
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
      WHERE tag != '' AND length(tag) <= ${MAX_TAG_CHARS} AND instr(tag, char(10)) = 0 AND instr(tag, char(13)) = 0
  )
SELECT tag, id FROM kept WHERE k <= ${MAX_TAGS_PER_NOTE}`;
}

const PICKED = "SELECT id, type, body, frontmatter FROM notes";

// The note_tags rows of the notes whose ids are bound as a JSON array.
export const NOTE_TAGS_FILL = `INSERT OR IGNORE INTO note_tags (tag, note_id)\n${noteTagRows(`${PICKED} WHERE id IN (SELECT value FROM json_each(?))`)}`;

// Makes the whole tag table equal to the notes: removes each row the notes do not give, then adds
// each row that is missing. When the table is already right, the two statements write nothing.
const ALL_TAGS = noteTagRows(PICKED);
export const NOTE_TAGS_REPAIR = [
  `DELETE FROM note_tags WHERE (tag, note_id) NOT IN (${ALL_TAGS})`,
  `INSERT INTO note_tags (tag, note_id)\n${ALL_TAGS}\nEXCEPT SELECT tag, note_id FROM note_tags`,
];
