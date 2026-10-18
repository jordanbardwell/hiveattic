import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, deliverEvent, mint, nid, resetVault, rest, testEnv, versionsOf } from "./helpers";

// F4 / F9 / item 10. profile/summary.md lists active, normal, untagged shared facts only. Forget,
// purge, an outside delete, and a move regenerate it, and a purge also scrubs its history, so a
// forgotten, purged, moved, or domain-tagged fact never shows through it.

let writer = "";
let reader = "";

beforeAll(async () => {
  writer = await mint("sum-writer", ["read:shared", "read:own", "write:own", "write:shared", "read:domain/deals"], "sum-writer");
  reader = await mint("sum-reader", ["read:shared"], "sum-reader");
});

async function fact(key: string, statement: string, domain?: string): Promise<{ id: string; path: string }> {
  const written = await rest("/v1/facts", writer, {
    method: "POST",
    body: JSON.stringify({ key, statement, observed_at: "2099-01-01T00:00:00Z", scope: "shared", ...(domain ? { domain } : {}) }),
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
});
