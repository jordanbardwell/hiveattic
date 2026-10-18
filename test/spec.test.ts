import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { ADMIN, mcp, mint, nid, resetVault, rest, runJob, testEnv, type Envelope } from "./helpers";

let readerX = "";
let financeRw = "";
let financeRo = "";
let chief = "";
let sharedWriter = "";

beforeAll(async () => {
  readerX = await mint("reader-x", ["read:shared", "read:own", "write:own", "read:domain/x", "write:domain/x"], "reader-x");
  financeRw = await mint(
    "finance-rw",
    ["read:shared", "read:own", "write:own", "read:domain/finance", "write:domain/finance", "read:sensitive/finance", "write:sensitive/finance"],
    "finance-rw",
  );
  financeRo = await mint("finance-ro", ["read:shared", "read:own", "write:own", "read:domain/finance", "read:sensitive/finance"], "finance-ro");
  chief = await mint("chief-of-staff", ["read:shared", "read:inbox", "read:sensitive:summary/health", "read:sensitive:summary/finance"], "chief-of-staff");
  sharedWriter = await mint("shared-writer", ["read:shared", "read:own", "write:own", "write:shared"], "shared-writer");
});

beforeEach(async () => {
  await resetVault();
});

describe("HiveAttic acceptance", () => {
  it("T-01 scope enforcement", async () => {
    const marker = `qxfinance${nid()}`;
    const path = `domains/finance/ledger-${nid()}.md`;
    const written = await rest("/v1/notes", financeRw, { method: "PUT", body: JSON.stringify({ path, body: `Ledger note ${marker}`, type: "note" }) });
    expect(written.status).toBe(200);
    const denied = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    expect(denied.status).toBe(404);
    expect(denied.json.error?.code).toBe("not_found");
    const hidden = await rest(`/v1/search?q=${marker}`, readerX);
    expect(hidden.status).toBe(200);
    expect(results(hidden.json)).toEqual([]);
    const visible = await rest(`/v1/search?q=${marker}`, financeRw);
    expect(results(visible.json).some((row) => row.path === path)).toBe(true);
    const readOnly = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, financeRo);
    expect(readOnly.status).toBe(200);
    const readOnlyWrite = await rest("/v1/notes", financeRo, { method: "PUT", body: JSON.stringify({ path: `domains/finance/other-${nid()}.md`, body: "nope", type: "note" }) });
    expect(readOnlyWrite.status).toBe(403);
    const healthPath = `domains/health/visit-${nid()}.md`;
    expect((await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: healthPath, body: `Clinical ${marker}`, type: "note" }) })).status).toBe(200);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(healthPath)}`, financeRw)).status).toBe(404);
    const role = await rest("/v1/notes", readerX, { method: "PUT", body: JSON.stringify({ path: "bots/finance-rw/role.md", body: "nope", type: "role" }) });
    expect(role.status).toBe(403);
    const mcpDenied = await mcp(readerX, "vault_read", { path });
    expect(mcpDenied.json.ok).toBe(false);
    expect(mcpDenied.json.error?.code).toBe("not_found");
    const mcpSearch = await mcp(readerX, "vault_search", { q: marker });
    expect(results(mcpSearch.json)).toEqual([]);
    const summaryPath = `domains/health/summaries/visit-${nid()}.md`;
    const summary = await rest("/v1/notes", ADMIN, {
      method: "PUT",
      body: JSON.stringify({ path: summaryPath, body: "Summary only", type: "note", sensitivity: "sensitive" }),
    });
    expect(summary.status).toBe(200);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(healthPath)}`, chief)).status).toBe(404);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(summaryPath)}`, chief)).status).toBe(200);
    const spoof = await rest("/v1/notes", financeRw, {
      method: "PUT",
      body: JSON.stringify({ path: `domains/finance/spoof-${nid()}.md`, body: "spoof", type: "note", domain: "deals" }),
    });
    expect(spoof.status).toBe(400);
    const fact = await rest("/v1/facts", ADMIN, {
      method: "POST",
      body: JSON.stringify({ key: `health-${nid()}`, statement: `Shared health fact ${marker}`, observed_at: "2026-01-01T00:00:00Z", scope: "shared", domain: "health" }),
    });
    // A declared sensitive domain on a shared fact moves it into the sensitive folder.
    expect(fact.status, fact.text).toBe(201);
    expect(fact.json.data?.rerouted).toBe(true);
    const factPath = String(fact.json.data?.path ?? "");
    expect(factPath.startsWith("sensitive/health/profile/facts/")).toBe(true);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(factPath)}`, financeRo)).status).toBe(404);
    expect(results((await rest(`/v1/search?q=${marker}`, financeRo)).json).some((row) => row.path === factPath)).toBe(false);
    const listed = await rest("/v1/list?prefix=domains/finance/", readerX);
    expect(JSON.stringify(listed.json.data ?? {}).includes(path)).toBe(false);
    const hybrid = await rest(`/v1/search?q=${marker}&mode=hybrid`, financeRw);
    expect(hybrid.json.data?.warning).toBe("semantic_deferred");
    expect(results(hybrid.json).some((row) => row.path === path)).toBe(true);
  });

  // T-02, T-03, and T-04 are retired: HiveAttic does not filter content. These keep the ids and check that
  // content is stored as written. Bots must never write secrets; the server stores what it is sent.
  it("T-02 content containing a key-like string is accepted and stored", async () => {
    const samples = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "password: hunter2",
      "Zq8xP2mL9vR4tY7wK1nB5cJ3hF6dS0aG",
    ];
    for (const sample of samples) {
      const path = `shared/note-${nid()}.md`;
      const marker = `qxkey${nid()}`;
      const response = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: `${marker} prefix ${sample} suffix`, type: "note" }) });
      expect(response.status, response.text).toBe(200);
      const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, sharedWriter);
      expect(read.json.data?.status).toBe("active");
      expect(String(read.json.data?.markdown)).toContain(sample);
      expect(results((await rest(`/v1/search?q=${marker}`, sharedWriter)).json).some((row) => row.path === path)).toBe(true);
    }
    const fact = await rest("/v1/facts", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ key: `token-${nid()}`, statement: "The test key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", observed_at: "2026-01-01T00:00:00Z", scope: "own" }),
    });
    expect(fact.status, fact.text).toBe(200);
    const journal = await rest("/v1/journal", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "keys", body: "Rotated AKIAIOSFODNN7EXAMPLE today", at: "2026-02-01T16:00:00Z" }),
    });
    expect(journal.status, journal.text).toBe(200);
    const mcpPath = `shared/mcp-${nid()}.md`;
    const viaMcp = await mcp(sharedWriter, "vault_write_note", { path: mcpPath, body: "password: hunter2", type: "note" });
    expect(viaMcp.json.ok, viaMcp.text).toBe(true);
    expect(String((await rest(`/v1/notes?path=${encodeURIComponent(mcpPath)}`, sharedWriter)).json.data?.markdown)).toContain("hunter2");
  });

  it("T-03 content containing a card number or an account number is accepted and stored", async () => {
    const cases = [
      { path: `shared/card-${nid()}.md`, body: "Card 4242424242424242 on file", fragment: "4242424242424242" },
      { path: `shared/card-spaced-${nid()}.md`, body: "card 4242 4242 4242 4242", fragment: "4242 4242 4242 4242" },
      { path: `shared/acct-${nid()}.md`, body: "Account 5839201746 is on file.", fragment: "5839201746" },
      { path: `shared/iban-${nid()}.md`, body: "IBAN GB82WEST12345698765432", fragment: "GB82WEST12345698765432" },
    ];
    for (const item of cases) {
      const response = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: item.path, body: item.body, type: "note" }) });
      expect(response.status, response.text).toBe(200);
      const read = await rest(`/v1/notes?path=${encodeURIComponent(item.path)}`, sharedWriter);
      expect(String(read.json.data?.markdown)).toContain(item.fragment);
    }
    const routing = await rest("/v1/facts", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ key: `route-${nid()}`, statement: "routing 021000021", observed_at: "2026-01-01T00:00:00Z", scope: "own" }),
    });
    expect(routing.status, routing.text).toBe(200);
    const ssnPath = `shared/ssn-${nid()}.md`;
    const ssn = await mcp(sharedWriter, "vault_write_note", { path: ssnPath, body: "ssn 219-09-9999", type: "note" });
    expect(ssn.json.ok, ssn.text).toBe(true);
    const shared = await rest("/v1/journal", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "call", body: "Called about account 5839201746 and routing 021000021", at: "2026-03-01T16:00:00Z" }),
    });
    expect(shared.status, shared.text).toBe(200);
    expect(String(shared.json.data?.path)).toMatch(/^journal\//);
  });

  it("T-05 newest observed fact wins", async () => {
    const key = `home-city-${nid()}`;
    const older = "Lives in the cedar harbor qxold";
    const newer = "Lives in the maple harbor qxnew";
    const first = await rest("/v1/facts", readerX, {
      method: "POST",
      body: JSON.stringify({ key, statement: older, observed_at: "2020-01-01T00:00:00Z", scope: "own" }),
    });
    expect(first.status, first.text).toBe(200);
    expect(first.json.data?.outcome).toBe("created");
    const second = await mcp(readerX, "vault_write_fact", { key, statement: newer, observed_at: "2024-01-01T00:00:00Z", scope: "own" });
    expect(second.json.data?.outcome).toBe("updated");
    const path = `bots/reader-x/facts/${key}.md`;
    const active = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    expect(String(active.json.data?.markdown)).toContain(newer);
    expect(String(active.json.data?.markdown)).not.toContain("qxold");
    const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, ADMIN);
    const bodies = versions(history.json).map((version) => String(version.body ?? ""));
    expect(bodies.some((body) => body.includes("qxold"))).toBe(true);
    expect(bodies.some((body) => body.includes("qxnew"))).toBe(true);

    const reverse = `home-city-${nid()}`;
    await rest("/v1/facts", readerX, {
      method: "POST",
      body: JSON.stringify({ key: reverse, statement: "Current city qxkeep", observed_at: "2024-06-01T00:00:00Z", scope: "own" }),
    });
    const stale = await rest("/v1/facts", readerX, {
      method: "POST",
      body: JSON.stringify({ key: reverse, statement: "Old city qxdrop", observed_at: "2020-06-01T00:00:00Z", scope: "own" }),
    });
    expect(stale.json.data?.outcome).toBe("superseded_older");
    const kept = await rest(`/v1/notes?path=${encodeURIComponent(`bots/reader-x/facts/${reverse}.md`)}`, readerX);
    expect(String(kept.json.data?.markdown)).toContain("qxkeep");
    expect(String(kept.json.data?.markdown)).not.toContain("qxdrop");
  });

  it("T-06 concurrent journal appends and stale etag", async () => {
    const at = "2026-06-01T16:00:00.000Z";
    const seen = new Set<string>();
    for (let run = 0; run < 100; run++) {
      const batch = await Promise.all(
        Array.from({ length: 7 }, (_, slot) =>
          rest("/v1/journal", sharedWriter, {
            method: "POST",
            body: JSON.stringify({ target: "shared", title: `r${run}s${slot}`, body: `marker-${run}-${slot}`, at, tags: [] }),
          }),
        ),
      );
      for (const response of batch) {
        expect(response.status).toBe(200);
        const ref = String(response.json.data?.block_ref ?? "");
        expect(seen.has(ref)).toBe(false);
        seen.add(ref);
      }
    }
    expect(seen.size).toBe(700);
    const note = await rest("/v1/notes?path=journal/2026/06/2026-06-01.md", sharedWriter);
    const markdown = String(note.json.data?.markdown ?? "");
    for (let run = 0; run < 100; run++) {
      for (let slot = 0; slot < 7; slot++) expect(markdown.includes(`marker-${run}-${slot}`)).toBe(true);
    }
    const refs = [...markdown.matchAll(/\^([0-9A-HJKMNP-TV-Z]{26})/g)].map((match) => `^${match[1]}`);
    expect(new Set(refs).size).toBe(700);
    const rows = await testEnv().DB.prepare(
      "SELECT block_ref FROM journal_entries WHERE note_id = ? ORDER BY rowid",
    )
      .bind(note.json.data?.id)
      .all<{ block_ref: string }>();
    expect((rows.results ?? []).map((row) => row.block_ref)).toEqual(refs);

    const mcpAppend = await mcp(sharedWriter, "vault_append_journal", { target: "shared", title: "mcp", body: "marker-mcp", at });
    expect(mcpAppend.json.ok).toBe(true);

    const path = `shared/etag-${nid()}.md`;
    const created = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "version one", type: "note" }) });
    const etag = String(created.json.data?.etag ?? "");
    const updated = await rest("/v1/notes", sharedWriter, {
      method: "PUT",
      body: JSON.stringify({ path, body: "version two", type: "note", if_match: etag }),
    });
    expect(updated.status).toBe(200);
    const stale = await rest("/v1/notes", sharedWriter, {
      method: "PUT",
      body: JSON.stringify({ path, body: "version stale", type: "note", if_match: etag }),
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error?.code).toBe("conflict_etag");
  }, 180_000);

  it("T-06 the shared day file takes parallel appends from seven tokens, in file order", async () => {
    const tokens: string[] = [];
    for (let slot = 0; slot < 7; slot++) tokens.push(await mint(`t06-day-${slot}`, ["read:shared", "write:shared"], `t06-day-${slot}`));
    const at = "2099-06-02T16:00:00.000Z";
    for (let run = 0; run < 5; run++) {
      const batch = await Promise.all(
        tokens.map((token, slot) => rest("/v1/journal", token, { method: "POST", body: JSON.stringify({ target: "shared", title: `r${run}s${slot}`, body: `shared-${run}-${slot}`, at }) })),
      );
      for (const response of batch) expect(response.status, response.text).toBe(200);
    }
    const path = "journal/2099/06/2099-06-02.md";
    const markdown = String((await rest(`/v1/notes?path=${path}`, tokens[0]!)).json.data?.markdown ?? "");
    for (let run = 0; run < 5; run++) for (let slot = 0; slot < 7; slot++) expect(markdown.split(`shared-${run}-${slot}\n`).length - 1).toBe(1);
    const refs = [...markdown.matchAll(/\^([0-9A-HJKMNP-TV-Z]{26})/g)].map((match) => `^${match[1]}`);
    expect(refs.length).toBe(35);
    const order = await rest(`/v1/admin/journal-order?path=${path}`, ADMIN);
    expect(order.json.data?.block_refs).toEqual(refs);
  });

  it("T-07 append-only journal and audit log", async () => {
    const at = "2026-07-01T16:00:00.000Z";
    const appended = await rest("/v1/journal", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "kept", body: "original entry", at }),
    });
    expect(appended.status).toBe(200);
    const rewrite = await mcp(sharedWriter, "vault_write_note", { path: "journal/2026/07/2026-07-01.md", body: "rewritten", type: "note" });
    expect(rewrite.json.error?.code).toBe("invalid");
    const row = await testEnv().DB.prepare("SELECT seq, outcome FROM audit_log ORDER BY seq LIMIT 1").first<{ seq: number; outcome: string }>();
    expect(row).toBeTruthy();
    await expect(testEnv().DB.prepare("UPDATE audit_log SET outcome = 'tampered' WHERE seq = ?").bind(row!.seq).run()).rejects.toThrow(/append-only|ABORT/i);
    await expect(testEnv().DB.prepare("DELETE FROM audit_log WHERE seq = ?").bind(row!.seq).run()).rejects.toThrow(/append-only|ABORT/i);
    const after = await testEnv().DB.prepare("SELECT outcome FROM audit_log WHERE seq = ?").bind(row!.seq).first<{ outcome: string }>();
    expect(after?.outcome).toBe(row!.outcome);
    const probe = await rest("/v1/admin/audit/verify-append-only", ADMIN, { method: "POST", body: "{}" });
    expect(probe.status).toBe(200);
    expect(probe.json.data?.update_aborted).toBe(true);
    expect(probe.json.data?.delete_aborted).toBe(true);
  });

  it("T-08 idempotency", async () => {
    const key = `idem-${nid()}`;
    const body = { target: "own", title: "once", body: "same entry", at: "2026-08-01T16:00:00.000Z", idempotency_key: key };
    const first = await rest("/v1/journal", readerX, { method: "POST", body: JSON.stringify(body) });
    const second = await mcp(readerX, "vault_append_journal", body);
    expect(first.status).toBe(200);
    expect(second.json.data).toEqual(first.json.data);
    const rows = await testEnv().DB.prepare("SELECT id FROM journal_entries WHERE idempotency_key = ?").bind(key).all();
    expect(rows.results?.length).toBe(1);
  });

  it("T-09 PARTIAL: FTS forget is covered; vector deletion is deferred to M2", async () => {
    const marker = `qxforget${nid()}`;
    const path = `bots/reader-x/notes-${nid()}.md`;
    const written = await rest("/v1/notes", readerX, { method: "PUT", body: JSON.stringify({ path, body: `Remember ${marker}`, type: "note" }) });
    expect(written.status).toBe(200);
    const id = String(written.json.data?.id);
    const chunks = await testEnv().DB.prepare("SELECT id FROM chunks WHERE note_id = ?").bind(id).all<{ id: string }>();
    expect((chunks.results ?? []).length).toBeGreaterThan(0);
    const found = await rest(`/v1/search?q=${marker}`, readerX);
    expect(results(found.json).some((row) => row.path === path)).toBe(true);
    const forgotten = await mcp(readerX, "vault_forget", { path, reason: "no longer needed" });
    expect(forgotten.json.ok).toBe(true);
    // A forgotten note is 404 for its owner and every other non-admin. The admin reads the stub.
    const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    expect(read.status).toBe(404);
    expect(read.text).not.toContain(marker);
    const stub = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, ADMIN);
    expect(stub.json.data?.status).toBe("forgotten");
    expect(String(stub.json.data?.markdown)).toContain("Forgotten");
    expect(String(stub.json.data?.markdown)).not.toContain(marker);
    const search = await rest(`/v1/search?q=${marker}`, readerX);
    expect(results(search.json)).toEqual([]);
    const history = await rest(`/v1/history?id=${id}`, ADMIN);
    expect(versions(history.json).length).toBeGreaterThan(0);
    const queued = await testEnv().DB.prepare("SELECT chunk_id FROM vector_delete_queue WHERE note_id = ?").bind(id).all<{ chunk_id: string }>();
    const queuedIds = new Set((queued.results ?? []).map((row) => row.chunk_id));
    for (const chunk of chunks.results ?? []) expect(queuedIds.has(chunk.id)).toBe(true);
    console.log("T-09 PARTIAL — FTS covered (search empty, stub read, history kept, chunk ids queued). Vector deletion deferred to M2.");
  });

  it("T-11 keyword indexing for an outside edit, with history", async () => {
    const path = `shared/human-${nid()}.md`;
    const created = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "Original qxalpha text", type: "note" }) });
    expect(created.status).toBe(200);
    const id = String(created.json.data?.id);
    const before = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").bind(id).first<{ n: number }>();
    await deliver({ action: "PutObject", key: `vault/${path}` });
    const afterSkip = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").bind(id).first<{ n: number }>();
    expect(afterSkip?.n).toBe(before?.n);
    const row = await testEnv().DB.prepare("SELECT r2_key, index_enqueued_at FROM notes WHERE id = ?").bind(id).first<{ r2_key: string; index_enqueued_at: string | null }>();
    expect(row?.index_enqueued_at).toBeTruthy();
    await deliverIndex(id, path);
    const indexed = await testEnv().DB.prepare("SELECT indexed_at FROM notes WHERE id = ?").bind(id).first<{ indexed_at: string | null }>();
    expect(indexed?.indexed_at).toBeTruthy();

    const edited = `---\ntitle: Human\n---\nUpdated qxbeta from outside the api\n`;
    await testEnv().VAULT.put(row!.r2_key, edited, { httpMetadata: { contentType: "text/markdown" } });
    await deliver({ action: "PutObject", key: row!.r2_key });
    const found = await rest("/v1/search?q=qxbeta", sharedWriter);
    expect(results(found.json).some((item) => item.path === path)).toBe(true);
    const history = await rest(`/v1/history?id=${id}`, ADMIN);
    expect(versions(history.json).some((version) => String(version.body ?? "").includes("qxalpha"))).toBe(true);


    // Malformed frontmatter from an outside editor is indexed as body text. Nothing is quarantined.
    const marker = `qxmalformed${nid()}`;
    await testEnv().VAULT.put(row!.r2_key, `---\ntitle: [unclosed\n---\n${marker} after a bad header\n`, { httpMetadata: { contentType: "text/markdown" } });
    await deliver({ action: "PutObject", key: row!.r2_key });
    const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, ADMIN);
    expect(read.json.data?.status).toBe("active");
    expect(String(read.json.data?.markdown)).toContain(marker);
    expect(results((await rest(`/v1/search?q=${marker}`, sharedWriter)).json).some((item) => item.path === path)).toBe(true);
  });

  it("T-12 rebuild D1 from R2 and restore one note", async () => {
    const shared = `qxboth${nid()}`;
    const oldWord = `qxold${nid()}`;
    const newWord = `qxnew${nid()}`;
    const other = `qxother${nid()}`;
    const firstPath = `shared/restore-${nid()}.md`;
    const secondPath = `shared/other-${nid()}.md`;
    const created = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: firstPath, body: `${shared} ${oldWord}`, type: "note" }) });
    const etag = String(created.json.data?.etag);
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: secondPath, body: `${shared} ${other}`, type: "note" }) });
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: firstPath, body: `${shared} ${newWord}`, type: "note", if_match: etag }) });
    const before = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>();
    const searchBefore = results((await rest(`/v1/search?q=${shared}`, sharedWriter)).json).map((row) => row.path).sort();
    const now = new Date().toISOString();
    await testEnv().DB.prepare(
      `INSERT INTO notes (id, path, type, owner, sensitivity, title, body, frontmatter, content_hash, r2_key, status, created_at, updated_at, last_writer)
       VALUES (?, ?, 'note', 'shared', 'normal', 'junk', 'junk', '{}', 'abc', ?, 'active', ?, ?, 'test')`,
    )
      .bind("junknotfromr2junknotfromr201", `shared/junk-${nid()}.md`, "vault/shared/junk.md", now, now)
      .run();
    const rebuilt = await runJob("/v1/admin/reindex");
    expect(rebuilt.job.data?.status, JSON.stringify(rebuilt.job)).toBe("done");
    const after = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const junk = await testEnv().DB.prepare("SELECT id FROM notes WHERE id = ?").bind("junknotfromr2junknotfromr201").first();
    expect(junk).toBeNull();
    const searchAfter = results((await rest(`/v1/search?q=${shared}`, sharedWriter)).json).map((row) => row.path).sort();
    expect(searchAfter).toEqual(searchBefore);
    const history = await rest(`/v1/history?path=${encodeURIComponent(firstPath)}`, ADMIN);
    const prior = versions(history.json).find((version) => String(version.body ?? "").includes(oldWord));
    expect(prior?.version_ts).toBeTruthy();
    const restored = await rest("/v1/admin/restore", ADMIN, {
      method: "POST",
      body: JSON.stringify({ path: firstPath, version_ts: prior?.version_ts }),
    });
    expect(restored.status).toBe(200);
    const read = await rest(`/v1/notes?path=${encodeURIComponent(firstPath)}`, sharedWriter);
    expect(String(read.json.data?.markdown)).toContain(oldWord);
  });

  it.skip("T-10 Vectorize hybrid search is deferred to a later milestone", () => {});
  it.skip("T-13 OAuth connector access is deferred to a later milestone", () => {});
  it.skip("T-14 cost load test is deferred to a later milestone", () => {});
});

function results(json: Envelope): { path?: string }[] {
  const value = json.data?.results;
  return Array.isArray(value) ? (value as { path?: string }[]) : [];
}

function versions(json: Envelope): { version_ts?: string; body?: string }[] {
  const value = json.data?.versions;
  return Array.isArray(value) ? (value as { version_ts?: string; body?: string }[]) : [];
}

async function deliver(event: { action: string; key: string }): Promise<void> {
  const batch = createMessageBatch("hiveattic-index-jobs", [
    {
      id: nid(),
      timestamp: new Date(),
      attempts: 1,
      body: { account: "test", action: event.action, bucket: "hiveattic-vault", object: { key: event.key, size: 1, eTag: "test" }, eventTime: new Date().toISOString() },
    },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, testEnv(), ctx);
  await getQueueResult(batch, ctx);
}

async function deliverIndex(noteId: string, path: string): Promise<void> {
  const batch = createMessageBatch("hiveattic-index-jobs", [
    { id: nid(), timestamp: new Date(), attempts: 1, body: { kind: "agent-index", note_id: noteId, path } },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, testEnv(), ctx);
  await getQueueResult(batch, ctx);
}
