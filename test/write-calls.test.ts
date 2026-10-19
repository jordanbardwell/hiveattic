import { beforeAll, describe, expect, it } from "vitest";
import { mint, nid, rest, runInWriter, testEnv, withInstrumentedWriter, type Stats } from "./helpers";

// The writer runs one write at a time for the whole vault, so each D1 round trip of a write adds to
// the wait of every write behind it. A journal append makes one read batch and one write batch.

let writer = "";

beforeAll(async () => {
  writer = await mint("calls-writer", ["read:shared", "read:own", "write:own", "write:shared"], "calls-writer");
});

function counter(): Stats {
  return { d1Calls: 0, d1Statements: 0, r2Gets: 0, r2Lists: 0, sql: [] };
}

async function append(target: "own" | "shared", at: string, title: string, body: string, key: string | null = null) {
  const written = await rest("/v1/journal", writer, {
    method: "POST",
    body: JSON.stringify({ target, at, title, body, ...(key ? { idempotency_key: key } : {}) }),
  });
  expect(written.status, written.text).toBe(200);
  return { entry: String(written.json.data?.entry_id), path: String(written.json.data?.path) };
}

async function noteAt(path: string) {
  return testEnv().DB.prepare("SELECT id, r2_etag, index_enqueued_at FROM notes WHERE path = ?")
    .bind(path)
    .first<{ id: string; r2_etag: string; index_enqueued_at: string | null }>();
}

describe("D1 round trips per write", () => {
  it("makes 2 D1 calls for a journal append, to a new or an existing day file", async () => {
    for (const [target, at] of [["own", "2087-04-11T10:00:00Z"], ["shared", "2087-04-12T10:00:00Z"]] as const) {
      for (const n of [1, 2]) {
        const stats = counter();
        await withInstrumentedWriter(stats, () => append(target, at, `entry ${n}`, `qxcalls ${target} ${n}`, `calls-${target}-${n}-${nid()}`));
        expect(stats.d1Calls, stats.sql.join("\n")).toBe(2);
      }
    }
  });

  it("answers a retried journal append from the stored reply in one D1 call and writes nothing", async () => {
    const key = `calls-retry-${nid()}`;
    const at = "2087-04-13T10:00:00Z";
    const first = await append("own", at, "retried", "qxretried once", key);
    const before = await noteAt(first.path);
    // Without the writer's own record of the operation, the reply comes from D1.
    await runInWriter((state) => state.storage.sql.exec("DELETE FROM operations"));
    const stats = counter();
    const again = await withInstrumentedWriter(stats, () => append("own", at, "retried", "qxretried once", key));
    expect(again).toEqual(first);
    expect(stats.d1Calls, stats.sql.join("\n")).toBe(1);
    const reused = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "own", at, title: "retried", body: "qxretried other", idempotency_key: key }) });
    expect(reused.status, reused.text).toBe(422);
    expect((await noteAt(first.path))?.r2_etag).toBe(before?.r2_etag);
  });

  it("numbers the chunks of each appended entry after the chunks already stored", async () => {
    const at = "2087-04-14T10:00:00Z";
    const first = await append("own", at, "short", "qxchunk first entry");
    // About 4,000 characters split into 3 chunks, all inserted in the same batch.
    await append("own", at, "long", `qxchunk long entry ${"words to split ".repeat(270)}`);
    await append("own", at, "last", "qxchunklast final entry");
    const note = await noteAt(first.path);
    expect(note?.index_enqueued_at).toBeTruthy();
    const rows = await testEnv().DB.prepare("SELECT id, n FROM chunks WHERE note_id = ? ORDER BY n").bind(note!.id).all<{ id: string; n: number }>();
    const chunks = rows.results ?? [];
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.map((chunk) => chunk.n)).toEqual(chunks.map((_, n) => n));
    expect(chunks.map((chunk) => chunk.id)).toEqual(chunks.map((_, n) => `${note!.id}:${n}`));
    const found = await rest("/v1/search?q=qxchunklast", writer);
    expect(found.status).toBe(200);
    expect(JSON.stringify(found.json.data)).toContain(first.path);
  });

  it("points a link written before its day file existed at the new day file", async () => {
    const at = "2087-04-15T10:00:00Z";
    const link = "journal/2087/04/2087-04-15";
    const source = await rest("/v1/notes", writer, {
      method: "PUT",
      body: JSON.stringify({ path: `shared/calls-${nid()}.md`, body: `# Source\n\nSee [[${link}]]`, type: "note" }),
    });
    expect(source.status, source.text).toBe(200);
    const open = await testEnv().DB.prepare("SELECT dst_note_id FROM links WHERE src_note_id = ? AND target = ?")
      .bind(String(source.json.data?.id), link)
      .first<{ dst_note_id: string | null }>();
    expect(open).toEqual({ dst_note_id: null });
    const day = await append("shared", at, "first", "qxbackfill entry");
    const resolved = await testEnv().DB.prepare("SELECT dst_note_id FROM links WHERE src_note_id = ? AND target = ?")
      .bind(String(source.json.data?.id), link)
      .first<{ dst_note_id: string | null }>();
    expect(resolved?.dst_note_id).toBe((await noteAt(day.path))?.id);
  });

  it("makes 3 D1 calls for a note update with no links", async () => {
    const path = `shared/calls-update-${nid()}.md`;
    const created = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body: "# Update\n\nqxupdate one", type: "note" }) });
    expect(created.status, created.text).toBe(200);
    const stats = counter();
    const updated = await withInstrumentedWriter(stats, () =>
      rest("/v1/notes", writer, {
        method: "PUT",
        body: JSON.stringify({ path, body: "# Update\n\nqxupdate two", type: "note", if_match: String(created.json.data?.etag), idempotency_key: `calls-update-${nid()}` }),
      }),
    );
    expect(updated.status, updated.text).toBe(200);
    // The read batch, the check for a history copy of the current text, and the write batch.
    expect(stats.d1Calls, stats.sql.join("\n")).toBe(3);
  });
});
