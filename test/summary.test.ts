import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, deliverEvent, mint, nid, resetVault, rest, testEnv, versionsOf, withInstrumentedWriter, type Stats } from "./helpers";

// F4 / F9 / item 10. profile/summary.md lists active, normal, untagged shared facts only. Forget,
// purge, an outside delete, and a move regenerate it, and a purge also scrubs its history, so a
// forgotten, purged, moved, or domain-tagged fact never shows through it.

let writer = "";
let reader = "";

beforeAll(async () => {
  writer = await mint("sum-writer", ["read:shared", "read:own", "write:own", "write:shared", "read:domain/deals"], "sum-writer");
  reader = await mint("sum-reader", ["read:shared"], "sum-reader");
});

async function fact(key: string, statement: string, domain?: string, links: string[] = []): Promise<{ id: string; path: string }> {
  const written = await rest("/v1/facts", writer, {
    method: "POST",
    body: JSON.stringify({ key, statement, observed_at: "2099-01-01T00:00:00Z", scope: "shared", links, ...(domain ? { domain } : {}) }),
  });
  expect(written.status, written.text).toBe(200);
  return { id: String(written.json.data?.id), path: String(written.json.data?.path) };
}

async function summary(token = reader): Promise<string> {
  const read = await rest("/v1/notes?path=profile/summary.md", token);
  expect(read.status).toBe(200);
  return String(read.json.data?.markdown);
}

describe("profile/summary.md", () => {
  it("drops forgotten, purged, deleted, and domain-tagged facts, and a purge scrubs the summary's history", async () => {
    await resetVault();
    const n = nid();
    const kept = await fact(`keep-${n}`, `qxkeep${n} likes maps`);
    const forgotten = await fact(`forget-${n}`, `qxforget${n} likes ferries`);
    const purged = await fact(`purge-${n}`, `qxpurge${n} likes trains`);
    const deleted = await fact(`delete-${n}`, `qxdelete${n} likes buses`);
    await fact(`deals-${n}`, `qxdeals${n} closed the contract`, "deals");
    const before = await summary();
    for (const word of ["qxkeep", "qxforget", "qxpurge", "qxdelete"]) expect(before).toContain(`${word}${n}`);
    expect(before).not.toContain(`qxdeals${n}`);

    expect((await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ id: forgotten.id, reason: "stale" }) })).status).toBe(200);
    expect(await summary()).not.toContain(`qxforget${n}`);

    expect((await rest("/v1/admin/purge", ADMIN, { method: "DELETE", body: JSON.stringify({ id: purged.id }) })).json.data?.purged).toBe(true);
    const afterPurge = await summary();
    expect(afterPurge).not.toContain(`qxpurge${n}`);
    expect(afterPurge).toContain(`qxkeep${n}`);
    const history = versionsOf((await rest("/v1/history?path=profile/summary.md", ADMIN)).json);
    expect(JSON.stringify(history)).not.toContain(`qxpurge${n}`);

    await testEnv().VAULT.delete(`vault/${deleted.path}`);
    await deliverEvent("DeleteObject", `vault/${deleted.path}`);
    expect(await summary()).not.toContain(`qxdelete${n}`);

    // A fact that moves to a sensitive folder leaves the summary too.
    await rest("/v1/facts", writer, {
      method: "POST",
      body: JSON.stringify({ key: `keep-${n}`, statement: `qxkeep${n} had a synthetic flu shot`, observed_at: "2099-02-01T00:00:00Z", scope: "shared" }),
    });
    const final = await summary();
    expect(final).not.toContain(`qxkeep${n}`);
    expect(final).not.toContain("flu shot");
    expect(kept.id).not.toBe("");
  });

  it("stores no links or history copies of its own, costs the same with more facts, and is not rewritten when its list stays the same", async () => {
    await resetVault();
    const n = nid();
    for (let i = 0; i < 12; i++) await fact(`many-${i}-${n}`, `qxmany${n} item ${i}`, undefined, [`qxtarget-${i}-${n}`, `qxmissing-${i}-${n}`]);
    const summaryRow = async () =>
      (await testEnv().DB.prepare("SELECT id, r2_etag, body FROM notes WHERE path = 'profile/summary.md'").first<{ id: string; r2_etag: string; body: string }>())!;
    const row = await summaryRow();
    // The summary text still shows each fact's links. Only the facts store them as link rows.
    expect(row.body).toContain(`[[qxtarget-0-${n}]]`);
    const count = async (sql: string, ...binds: unknown[]) => (await testEnv().DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n;
    expect(await count("SELECT COUNT(*) AS n FROM links WHERE src_note_id = ?", row.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM links l JOIN notes f ON f.id = l.src_note_id WHERE f.type = 'fact'")).toBe(24);
    expect(await count("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?", row.id)).toBe(0);
    expect((await testEnv().VAULT.list({ prefix: `sys/history/${row.id}/` })).objects).toEqual([]);

    // One more shared fact costs a fixed number of round trips. Before, the writer looked up every
    // link of every summarized fact again, so 12 facts with 2 links each took more than 60 calls.
    const stats: Stats = { d1Calls: 0, d1Statements: 0, r2Gets: 0, r2Lists: 0, sql: [] };
    await withInstrumentedWriter(stats, () => fact(`more-${n}`, `qxmore${n} item`, undefined, [`qxtarget-more-${n}`]));
    expect(stats.d1Calls, stats.sql.join("\n")).toBeLessThan(30);

    // A fact with a domain tag is not in the summary, so the summary is not written again.
    const before = await summaryRow();
    await fact(`tagged-${n}`, `qxtagged${n} closed the contract`, "deals");
    const after = await summaryRow();
    expect(after.r2_etag).toBe(before.r2_etag);
    expect(after.body).toBe(before.body);

    // An outside edit of the summary is replaced at the next fact write, even with the same list.
    const edited = before.body.replace(`qxmany${n} item 0`, `qxedited${n}`);
    await testEnv().VAULT.put("vault/profile/summary.md", edited);
    await deliverEvent("PutObject", "vault/profile/summary.md");
    expect(await summary()).toContain(`qxedited${n}`);
    await fact(`tagged2-${n}`, `qxtagged2${n} closed another contract`, "deals");
    const restored = await summary();
    expect(restored).not.toContain(`qxedited${n}`);
    expect(restored).toContain(`qxmany${n} item 0`);
  });
});
