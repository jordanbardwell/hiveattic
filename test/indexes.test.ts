import { describe, expect, it } from "vitest";
import { testEnv } from "./helpers";

// Lookups that writes, forgets, purges, and the audit reads run on every call. Each one must
// search an index. A scan reads the whole table, and D1 bills and waits for every row it reads.
const LOOKUPS: [sql: string, binds: unknown[], index: string][] = [
  ["DELETE FROM chunks WHERE note_id = ?", ["n"], "chunks_note"],
  ["SELECT id FROM chunks WHERE note_id = ?", ["n"], "chunks_note"],
  ["SELECT COALESCE(MAX(n), -1) AS n FROM chunks WHERE note_id = ?", ["n"], "chunks_note"],
  ["UPDATE links SET dst_note_id = ? WHERE dst_note_id IS NULL AND target = ?", ["n", "t"], "links_target_open"],
  ["DELETE FROM links WHERE src_note_id = ? OR dst_note_id = ?", ["n", "n"], "links_dst"],
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
      expect(text, sql).not.toMatch(/\bSCAN (chunks|links|journal_entries|audit_log)\b/);
    }
  });
});
