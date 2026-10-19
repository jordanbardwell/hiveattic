import { describe, expect, it } from "vitest";
import { linkTargetSql, NOTE_NAMES_FILL } from "../src/writer-do";
import { testEnv } from "./helpers";

// Lookups that writes, forgets, purges, and the audit reads run on every call. Each one must
// search an index. A scan reads the whole table, and D1 bills and waits for every row it reads.
const LOOKUPS: [sql: string, binds: unknown[], index: string][] = [
  ["DELETE FROM chunks WHERE note_id = ?", ["n"], "chunks_note"],
  ["SELECT id FROM chunks WHERE note_id = ?", ["n"], "chunks_note"],
  [
    "INSERT INTO chunks (id, note_id, n, text, title, path, token_count) SELECT ? || ':' || next.n, ?, next.n, ?, ?, ?, ? FROM (SELECT COALESCE(MAX(n), -1) + 1 AS n FROM chunks WHERE note_id = ?) AS next",
    ["n", "n", "t", "t", "p", 1, "n"],
    "chunks_note",
  ],
  ["UPDATE links SET dst_note_id = ? WHERE dst_note_id IS NULL AND target IN (SELECT value FROM json_each(?))", ["n", '["a","b"]'], "links_target_open"],
  ["DELETE FROM links WHERE src_note_id = ? OR dst_note_id = ?", ["n", "n"], "links_dst"],
  ["DELETE FROM note_names WHERE note_id IN (SELECT value FROM json_each(?))", ['["n"]'], "note_names_note"],
  [NOTE_NAMES_FILL, ['["n"]'], "sqlite_autoindex_notes_1"],
  ["SELECT block_ref FROM journal_entries WHERE note_id = ? ORDER BY rowid", ["n"], "journal_entries_note"],
  ["DELETE FROM journal_entries WHERE note_id = ?", ["n"], "journal_entries_note"],
  ["SELECT seq FROM audit_log WHERE request_id = ? ORDER BY seq DESC LIMIT 50", ["r"], "audit_log_request"],
  ["SELECT substr(ts, 1, 13) AS hour, COUNT(*) AS n FROM audit_log WHERE ts >= ? AND path IS NOT NULL GROUP BY hour", ["2026"], "audit_log_ts"],
];

describe("lookup indexes", () => {
  it("serves each per-write lookup from an index, not a table scan", async () => {
    for (const [sql, binds, index] of LOOKUPS) {
      const plan = await testEnv().DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      const text = (plan.results ?? []).map((row) => row.detail).join(" | ");
      expect(text, sql).toContain(index);
      expect(text, sql).not.toMatch(/\bSCAN (chunks|links|journal_entries|audit_log|notes|note_names)\b/);
    }
  });

  // A link lookup must start from the name it looks for. Starting from the notes reads every active note.
  it("starts each link lookup from the name index", async () => {
    const fence = "n.path NOT LIKE 'sensitive/%'";
    for (const [sql, binds] of [
      [`SELECT t.value AS target, ${linkTargetSql("t.value", "?", fence)} AS dst FROM json_each(?) t`, ["n", '["a","b"]']],
      [`UPDATE links SET dst_note_id = ${linkTargetSql("links.target", "links.src_note_id", fence)} WHERE rowid BETWEEN ? AND ?`, [1, 2]],
    ] as [string, unknown[]][]) {
      const plan = await testEnv().DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      const text = (plan.results ?? []).map((row) => row.detail).join(" | ");
      expect(text, sql).toMatch(/SEARCH nn USING PRIMARY KEY \(name=\?\).*SEARCH n USING INDEX sqlite_autoindex_notes_1 \(id=\?\)/);
      expect(text, sql).not.toContain("notes_status_path");
    }
  });
});
