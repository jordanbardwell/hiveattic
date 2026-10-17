import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, deliverEvent, mint, nid, resetVault, rest, results, runJob, testEnv } from "./helpers";

// Regression tests for the "Fixes for Blake" list in the full review (F11-F24), beyond the ones
// other files already cover.

let writer = "";
let reader = "";
let dealsWriter = "";

beforeAll(async () => {
  writer = await mint("fix-writer", ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], "fix-writer");
  reader = await mint("fix-reader", ["read:shared"], "fix-reader");
  dealsWriter = await mint("fix-deals", ["read:shared", "write:shared", "read:domain/deals", "write:domain/deals"], "fix-deals");
});

describe("review fixes", () => {
  it("F24: a forgotten note path, fact key, and admin-forgotten day file can be written again under a new id", async () => {
    await resetVault();
    const path = `shared/again-${nid()}.md`;
    const first = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body: "first life", type: "note" }) });
    expect((await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ path, reason: "done" }) })).status).toBe(200);
    const again = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body: "second life", type: "note" }) });
    expect(again.status, again.text).toBe(200);
    expect(again.json.data?.id).not.toBe(first.json.data?.id);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, reader)).json.data?.markdown).toContain("second life");
    // The forgotten note is still the admin's to inspect, by id.
    expect((await rest(`/v1/notes?id=${first.json.data?.id}`, ADMIN)).json.data?.status).toBe("forgotten");
    expect((await rest(`/v1/notes?id=${first.json.data?.id}`, reader)).status).toBe(404);

    const key = `again-${nid()}`;
    const fact = (statement: string) =>
      rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ key, statement, observed_at: "2099-01-01T00:00:00Z", scope: "shared" }) });
    const factFirst = await fact("likes maps");
    expect((await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ id: factFirst.json.data?.id, reason: "wrong" }) })).status).toBe(200);
    const factAgain = await fact("likes charts");
    expect(factAgain.status, factAgain.text).toBe(200);
    expect(factAgain.json.data).toMatchObject({ outcome: "created", path: `profile/facts/${key}.md` });
    expect(factAgain.json.data?.id).not.toBe(factFirst.json.data?.id);

    const at = "2099-07-07T12:00:00Z";
    const day = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "one", body: "first entry", at }) });
    const dayPath = String(day.json.data?.path);
    expect((await rest("/v1/forget", ADMIN, { method: "POST", body: JSON.stringify({ path: dayPath, reason: "test" }) })).status).toBe(200);
    const next = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "two", body: "second entry", at }) });
    expect(next.status, next.text).toBe(200);
    const read = await rest(`/v1/notes?path=${encodeURIComponent(dayPath)}`, reader);
    expect(read.json.data?.markdown).toContain("second entry");
    expect(read.json.data?.markdown).not.toContain("first entry");
  });

  it("F14: an update keeps a note's domain tag and needs write access to it", async () => {
    await resetVault();
    const path = `shared/tagged-${nid()}.md`;
    const made = await rest("/v1/notes", dealsWriter, { method: "PUT", body: JSON.stringify({ path, body: "deal notes", type: "note", domain: "deals" }) });
    expect(made.status, made.text).toBe(200);
    // The update leaves the domain out; the stored tag stays, so read:shared alone still cannot read it.
    const update = await rest("/v1/notes", dealsWriter, { method: "PUT", body: JSON.stringify({ path, body: "deal notes two", type: "note", if_match: made.json.data?.etag }) });
    expect(update.status, update.text).toBe(200);
    expect((await testEnv().DB.prepare("SELECT domain FROM notes WHERE path = ?").bind(path).first<{ domain: string }>())?.domain).toBe("deals");
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, reader)).status).toBe(404);
    // Changing the domain is refused.
    const moved = await rest("/v1/notes", dealsWriter, { method: "PUT", body: JSON.stringify({ path, body: "x", type: "note", domain: "x", if_match: update.json.data?.etag }) });
    expect(moved.status).toBe(400);
    // A legacy finance-tagged shared note needs write:sensitive/finance to update, whatever the new text says.
    const legacy = `shared/legacy-${nid()}.md`;
    const id = `01LEG${nid().toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0").padEnd(21, "0").slice(0, 21)}`;
    const text = `---\nvault_id: ${id}\nsensitivity: sensitive\ndomain: finance\n---\nold budget\n`;
    const put = (await testEnv().VAULT.put(`vault/${legacy}`, text))!;
    const now = new Date().toISOString();
    await testEnv().DB.prepare(
      `INSERT INTO notes (id, path, type, owner, domain, sensitivity, title, body, frontmatter, content_hash, r2_etag, r2_key, status, created_at, updated_at, last_writer)
       VALUES (?, ?, 'note', 'shared', 'finance', 'sensitive', 'legacy', ?, '{}', 'x', ?, ?, 'active', ?, ?, 'test')`,
    )
      .bind(id, legacy, text, put.etag, `vault/${legacy}`, now, now)
      .run();
    const overwrite = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: legacy, body: "neutral now", type: "note", if_match: put.etag }) });
    expect(overwrite.status).toBe(403);
  });

  it("F13: a shared day file never takes the domain of one entry", async () => {
    await resetVault();
    const at = "2099-08-08T12:00:00Z";
    const tagged = await rest("/v1/journal", dealsWriter, { method: "POST", body: JSON.stringify({ target: "shared", title: "deal", body: "deal entry", at, domain: "deals" }) });
    expect(tagged.status, tagged.text).toBe(200);
    await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "plain", body: "plain entry", at }) });
    const path = String(tagged.json.data?.path);
    expect((await testEnv().DB.prepare("SELECT domain FROM notes WHERE path = ?").bind(path).first<{ domain: string | null }>())?.domain).toBeNull();
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, reader)).status).toBe(200);
  });

  it("F21/F22: body lines that look like Tags: or a server marker are kept, escaped, and survive a rebuild", async () => {
    await resetVault();
    const body = "first line\nTags: not really tags\nsee hiveattic: notes\nlast line";
    const appended = await rest("/v1/journal", writer, {
      method: "POST",
      body: JSON.stringify({ target: "own", title: "escaped", body, tags: ["real"], at: "2099-09-01T12:00:00Z", idempotency_key: `esc-${nid()}` }),
    });
    expect(appended.status).toBe(200);
    const path = String(appended.json.data?.path);
    const stored = await (await testEnv().VAULT.get(`vault/${path}`))!.text();
    expect(stored).toContain("\\Tags: not really tags");
    expect(stored).toContain("hiveattic\\: notes");
    expect(stored).toContain("last line");
    await testEnv().DB.prepare("DELETE FROM journal_entries").run();
    expect((await runJob("/v1/admin/rebuild")).job.data?.status).toBe("done");
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE title = 'escaped'").first<{ n: number }>())?.n).toBe(1);
  });

  it("F15: each version is its own immutable copy, labelled with the write that made it, and restoring one restores it", async () => {
    await resetVault();
    const path = `shared/versions-${nid()}.md`;
    let etag: unknown = null;
    for (const text of ["qxver one", "qxver two", "qxver three"]) {
      const written = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body: text, type: "note", ...(etag ? { if_match: etag } : {}) }) });
      expect(written.status, written.text).toBe(200);
      etag = written.json.data?.etag;
    }
    const history = (await rest(`/v1/history?path=${encodeURIComponent(path)}`, ADMIN)).json.data?.versions as { version_ts: string; body: string; reason: string }[];
    expect(history.map((version) => version.reason)).toEqual(["created", "updated", "updated"]);
    expect(history.map((version) => version.body.includes("qxver one"))).toEqual([true, false, false]);
    expect(history.map((version) => version.body.includes("qxver three"))).toEqual([false, false, true]);
    const restored = await rest("/v1/admin/restore", ADMIN, { method: "POST", body: JSON.stringify({ path, version_ts: history[0]!.version_ts }) });
    expect(restored.status, restored.text).toBe(200);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, reader)).json.data?.markdown).toContain("qxver one");
    const after = (await rest(`/v1/history?path=${encodeURIComponent(path)}`, ADMIN)).json.data?.versions as { reason: string }[];
    expect(after.map((version) => version.reason)).toEqual(["created", "updated", "updated", "restore"]);
  });

  it("F17: a search page fills past matches the caller cannot read", async () => {
    await resetVault();
    const marker = `qxfill${nid()}`;
    // Many hidden matches rank first (the marker repeated), a few visible ones after them.
    for (let i = 0; i < 12; i++) {
      await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: `bots/hidden-${i}/${marker}.md`, body: `${marker} ${marker} ${marker} hidden ${i}`, type: "note" }) });
    }
    for (let i = 0; i < 3; i++) {
      await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: `shared/${marker}-${i}.md`, body: `${marker} visible ${i} with more words to lower its rank`, type: "note" }) });
    }
    // Legacy in-place sensitive rows under other bots' folders: the read:sensitive/pii SQL clause lets
    // them through, and canRead then drops them (no read:bots/<x>).
    await testEnv().DB.prepare("UPDATE notes SET sensitivity = 'sensitive' WHERE path LIKE 'bots/hidden-%'").run();
    const piiReader = await mint(`fix-pii-${nid()}`, ["read:shared", "read:sensitive/pii"], "fix-pii");
    const sql = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE path LIKE 'bots/hidden-%' AND sensitivity = 'sensitive'").first<{ n: number }>();
    expect(sql?.n).toBe(12);
    const found = results((await rest(`/v1/search?q=${marker}&limit=3`, piiReader)).json);
    expect(found.map((hit) => hit.path).sort()).toEqual([0, 1, 2].map((i) => `shared/${marker}-${i}.md`));
  });

  it("F25: reviewer tokens expire after 30 days by default, any token can be minted with ttl_days, and an expired one is refused", async () => {
    await resetVault();
    const reviewerMint = await rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify({ agent_id: `rev-${nid()}`, preset: "reviewer", label: "rev" }) });
    expect(reviewerMint.status).toBe(200);
    const days = (Date.parse(String(reviewerMint.json.data?.expires_at)) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    const short = await rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify({ agent_id: `ttl-${nid()}`, scopes: ["read:shared"], ttl_days: 1, label: "ttl" }) });
    expect(short.status).toBe(200);
    const token = String(short.json.data?.token);
    expect((await rest("/v1/whoami", token)).status).toBe(200);
    await testEnv().DB.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), short.json.data?.token_id).run();
    const { clearAuthCache } = await import("../src/auth");
    clearAuthCache();
    expect((await rest("/v1/whoami", token)).status).toBe(401);
    expect((await rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify({ agent_id: `ttl-${nid()}`, scopes: ["read:shared"], ttl_days: 0 }) })).status).toBe(400);
    // A plain token without ttl_days does not expire.
    const plain = await rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify({ agent_id: `plain-${nid()}`, scopes: ["read:shared"] }) });
    expect(plain.json.data?.expires_at).toBeNull();
  });

  it("a deploy missing AUDIT_KEY or JOURNAL_MAC_KEY answers 500 misconfigured instead of writing unhashed or unsigned rows", async () => {
    const env = testEnv();
    for (const name of ["AUDIT_KEY", "JOURNAL_MAC_KEY"] as const) {
      const saved = env[name];
      env[name] = "";
      try {
        const response = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "own", title: "t", body: "b" }) });
        expect(response.status, name).toBe(500);
        expect(response.json.error).toMatchObject({ code: "misconfigured", reasons: [name] });
      } finally {
        env[name] = saved;
      }
    }
    expect((await rest("/v1/whoami", writer)).status).toBe(200);
  });

  it("F11: a late delete event for a key that exists again does not forget the live note", async () => {
    await resetVault();
    const path = `shared/late-${nid()}.md`;
    await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body: "still here qxlate", type: "note" }) });
    expect((await deliverEvent("DeleteObject", `vault/${path}`)).acked).toBe(true);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, reader)).status).toBe(200);
    expect(results((await rest("/v1/search?q=qxlate", reader)).json).length).toBe(1);
  });

  it("F12: an append after an outside edit of the day file re-reads it from R2 and keeps the outside text", async () => {
    await resetVault();
    const at = "2099-10-10T12:00:00Z";
    const first = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "own", title: "one", body: "first entry", at }) });
    const path = String(first.json.data?.path);
    const current = await (await testEnv().VAULT.get(`vault/${path}`))!.text();
    await testEnv().VAULT.put(`vault/${path}`, `${current}\nA line added in Obsidian qxobsidian.\n`);
    // No event delivered yet: D1 still has the old etag.
    const next = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "own", title: "two", body: "second entry", at }) });
    expect(next.status, next.text).toBe(200);
    const after = await (await testEnv().VAULT.get(`vault/${path}`))!.text();
    expect(after).toContain("qxobsidian");
    expect(after).toContain("second entry");
  });
});
