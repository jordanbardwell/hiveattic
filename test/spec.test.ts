import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scanFinancial, scanSecrets } from "../src/filters";
import worker from "../src/index";
import { ADMIN, mcp, mint, nid, resetVault, rest, testEnv, type Envelope } from "./helpers";

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
    expect(fact.status).toBe(200);
    const factPath = String(fact.json.data?.path ?? "");
    expect((await rest(`/v1/notes?path=${encodeURIComponent(factPath)}`, financeRo)).status).toBe(404);
    expect(results((await rest(`/v1/search?q=${marker}`, financeRo)).json).some((row) => row.path === factPath)).toBe(false);
    const listed = await rest("/v1/list?prefix=domains/finance/", readerX);
    expect(JSON.stringify(listed.json.data ?? {}).includes(path)).toBe(false);
    const hybrid = await rest(`/v1/search?q=${marker}&mode=hybrid`, financeRw);
    expect(hybrid.json.data?.warning).toBe("semantic_deferred");
    expect(results(hybrid.json).some((row) => row.path === path)).toBe(true);
  });

  it("T-02 secret filter", async () => {
    const secrets = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "password: hunter2",
      `sk-\u200Bproj-abcdefghijklmnopqrstuvwxyz0123456789`,
    ];
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      for (const secret of secrets) {
        const path = `shared/note-${nid()}.md`;
        const response = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: `prefix ${secret} suffix`, type: "note" }) });
        expect(response.status).toBe(422);
        expect(response.json.error?.code).toBe("rejected_secret");
        expect(response.text.includes(secret)).toBe(false);
        const audit = await testEnv().DB.prepare("SELECT path, outcome, reason_codes, content_hash FROM audit_log WHERE request_id = ?").bind(response.json.request_id).all();
        const dumped = JSON.stringify(audit.results ?? []);
        expect(dumped.includes(secret)).toBe(false);
        const listed = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(String(response.json.request_id ?? ""))}`, ADMIN);
        expect(listed.status).toBe(200);
        const entries = listed.json.data?.entries;
        expect(Array.isArray(entries) && entries.length > 0).toBe(true);
        expect(JSON.stringify(entries).includes(secret)).toBe(false);
        expect(logs.some((line) => line.includes(secret))).toBe(false);
      }
      const mcpReject = await mcp(sharedWriter, "vault_write_note", { path: `shared/mcp-${nid()}.md`, body: "password: hunter2", type: "note" });
      expect(mcpReject.json.error?.code).toBe("rejected_secret");
      expect(mcpReject.text.includes("hunter2")).toBe(false);
      expect(mcpReject.json.request_id).toBeTruthy();
      const mcpAudit = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(String(mcpReject.json.request_id))}`, ADMIN);
      expect(mcpAudit.status).toBe(200);
      expect(JSON.stringify(mcpAudit.json.data?.entries ?? []).includes("hunter2")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("T-03 financial filter rejects cards, routing numbers, and benign text", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
    const card = await rest("/v1/notes", sharedWriter, {
      method: "PUT",
      body: JSON.stringify({ path: `shared/card-${nid()}.md`, body: "Card 4242424242424242 on file", type: "note" }),
    });
    expect(card.status).toBe(422);
    expect(card.json.error?.code).toBe("rejected_financial");
    expect(card.json.error?.reasons).toContain("financial_card");
    expect(card.text.includes("4242424242424242")).toBe(false);
    const cardAudit = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(String(card.json.request_id ?? ""))}`, ADMIN);
    expect(JSON.stringify(cardAudit.json.data?.entries ?? []).includes("4242424242424242")).toBe(false);
    expect(logs.some((line) => line.includes("4242424242424242"))).toBe(false);
    const routing = await rest("/v1/facts", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ key: `route-${nid()}`, statement: "routing 021000021", observed_at: "2026-01-01T00:00:00Z", scope: "own" }),
    });
    expect(routing.status).toBe(422);
    expect(routing.json.error?.reasons).toContain("financial_routing");
    const routingAudit = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(String(routing.json.request_id ?? ""))}`, ADMIN);
    expect(JSON.stringify(routingAudit.json.data?.entries ?? []).includes("021000021")).toBe(false);
    expect(logs.some((line) => line.includes("021000021"))).toBe(false);
    const ssn = await mcp(sharedWriter, "vault_write_note", { path: `shared/ssn-${nid()}.md`, body: "ssn 219-09-9999", type: "note" });
    expect(ssn.json.error?.code).toBe("rejected_government_id");
    const benign = await rest("/v1/notes", sharedWriter, {
      method: "PUT",
      body: JSON.stringify({ path: `shared/benign-${nid()}.md`, body: "The price is $51.00 on 2026-10-17 and ticker ACME rose.", type: "note" }),
    });
    expect(benign.status).toBe(200);
    const corpus = testEnv().BENIGN_CORPUS ?? "";
    const sentences = corpus.split("\n").map((line) => line.trim()).filter(Boolean);
    expect(sentences.length).toBeGreaterThanOrEqual(200);
    const hits = sentences.filter((sentence) => scanFinancial(sentence).length > 0 || scanSecrets(sentence).length > 0);
    expect(hits.length / sentences.length).toBeLessThanOrEqual(0.02);
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(!(testEnv().ACCOUNT_FIXTURE ?? "").trim(), "T-03 account fixture absent: set HIVEATTIC_ACCOUNT_NUMBER or test/fixtures/account-number.local.txt")(
    "T-03 account number fixture",
    async () => {
      const account = (testEnv().ACCOUNT_FIXTURE ?? "").trim();
      const statement = /\d{6,}/.test(account) && /account|acct|acc#|brokerage|iban/i.test(account) ? account : `The brokerage account ${account} is on file.`;
      const response = await rest("/v1/notes", sharedWriter, {
        method: "PUT",
        body: JSON.stringify({ path: `shared/acct-${nid()}.md`, body: statement, type: "note" }),
      });
      const leaked = response.text.includes(account);
      expect(response.status, "account fixture status").toBe(422);
      expect(response.json.error?.code).toBe("rejected_financial");
      expect(response.json.error?.reasons).toContain("financial_account");
      expect(leaked, "response echoed the account fixture").toBe(false);
      const audit = await testEnv().DB.prepare("SELECT path, reason_codes, content_hash FROM audit_log WHERE request_id = ?").bind(response.json.request_id).all();
      expect(JSON.stringify(audit.results ?? []).includes(account), "audit echoed the account fixture").toBe(false);
      const listed = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(String(response.json.request_id ?? ""))}`, ADMIN);
      expect(JSON.stringify(listed.json.data?.entries ?? []).includes(account), "audit endpoint echoed the account fixture").toBe(false);
    },
  );

  it("T-04 employer guardrail", async () => {
    for (const term of [
      { term: "Contoso Example Corp", kind: "context_subject" },
      { term: "customer", kind: "context_qualifier" },
      { term: "nda", kind: "employer" },
    ]) {
      expect((await rest("/v1/admin/policy", ADMIN, { method: "POST", body: JSON.stringify(term) })).status).toBe(200);
    }
    const rejected = await rest("/v1/facts", readerX, {
      method: "POST",
      body: JSON.stringify({
        key: `work-${nid()}`,
        statement: "Contoso Example Corp customer migration notes",
        observed_at: "2026-02-01T00:00:00Z",
        scope: "own",
      }),
    });
    expect(rejected.status).toBe(422);
    expect(rejected.json.error?.code).toBe("rejected_employer");
    const accepted = await mcp(readerX, "vault_write_fact", {
      key: `career-${nid()}`,
      statement: "I start at Contoso Example Corp next month as an analyst",
      observed_at: "2026-02-02T00:00:00Z",
      scope: "own",
    });
    expect(accepted.json.ok).toBe(true);
    const monday = await rest("/v1/notes", sharedWriter, {
      method: "PUT",
      body: JSON.stringify({ path: `shared/monday-${nid()}.md`, body: "The monday market opens at nine.", type: "note" }),
    });
    expect(monday.status).toBe(200);
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
    const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    expect(read.json.data?.status).toBe("forgotten");
    expect(String(read.json.data?.markdown)).toContain("Forgotten");
    expect(String(read.json.data?.markdown)).not.toContain(marker);
    const search = await rest(`/v1/search?q=${marker}`, readerX);
    expect(results(search.json)).toEqual([]);
    const history = await rest(`/v1/history?id=${id}`, ADMIN);
    expect(versions(history.json).length).toBeGreaterThan(0);
    const queued = await testEnv().DB.prepare("SELECT chunk_id FROM vector_delete_queue WHERE note_id = ?").bind(id).all<{ chunk_id: string }>();
    const queuedIds = new Set((queued.results ?? []).map((row) => row.chunk_id));
    for (const chunk of chunks.results ?? []) expect(queuedIds.has(chunk.id)).toBe(true);
    console.log("T-09 PARTIAL — FTS covered (search empty, stub read, history kept, chunk ids queued). Vector deletion deferred to M2.");
  });

  it("T-11 keyword indexing for an outside edit, with history and secret quarantine", async () => {
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

    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const marker = `qxsecret${nid()}`;
    await testEnv().VAULT.put(row!.r2_key, `${secret}\n${marker}\n`, { httpMetadata: { contentType: "text/markdown" } });
    await deliver({ action: "PutObject", key: row!.r2_key });
    const leakedSearch = await rest(`/v1/search?q=${marker}`, ADMIN);
    expect(results(leakedSearch.json)).toEqual([]);
    const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, ADMIN);
    expect(String(read.json.data?.markdown).includes(secret)).toBe(false);
    expect(read.json.data?.status).toBe("quarantined");
    const quarantine = await testEnv().VAULT.list({ prefix: "sys/quarantine/" });
    expect(quarantine.objects.length).toBeGreaterThan(0);
    const inbox = await rest("/v1/notes?path=inbox/quarantine.md", ADMIN);
    expect(String(inbox.json.data?.markdown ?? "").includes(secret)).toBe(false);
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
    const rebuilt = await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" });
    expect(rebuilt.status).toBe(200);
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
