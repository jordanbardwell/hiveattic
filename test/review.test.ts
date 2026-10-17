import { createExecutionContext, createMessageBatch, env, getQueueResult, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import worker from "../src/index";
import { ADMIN, mcp, mint, nid, resetVault, rest, runJob, testEnv } from "./helpers";

let financeRw = "";
let financeRo = "";
let sharedWriter = "";
let readerX = "";

beforeAll(async () => {
  financeRw = await mint(
    "rev-finance",
    ["read:shared", "read:own", "write:own", "read:domain/finance", "write:domain/finance", "read:sensitive/finance", "write:sensitive/finance"],
    "rev-finance",
  );
  financeRo = await mint("rev-finance-ro", ["read:shared", "read:own", "write:own", "read:domain/finance", "read:sensitive/finance"], "rev-finance-ro");
  sharedWriter = await mint("rev-shared", ["read:shared", "read:own", "write:own", "write:shared"], "rev-shared");
  readerX = await mint("rev-reader", ["read:shared", "read:own", "write:own", "read:domain/x", "write:domain/x"], "rev-reader");
});

describe("architect review regressions", () => {
  it("P1 external delete tombstones in D1 and does not recreate the object", async () => {
    await resetVault();
    const path = `shared/gone-${nid()}.md`;
    const created = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: `Gone ${nid()}`, type: "note" }) });
    expect(created.status).toBe(200);
    const key = `vault/${path}`;
    await testEnv().VAULT.delete(key);
    const batch = await deliver({ action: "DeleteObject", key });
    expect(batch.acked).toBe(true);
    expect(batch.retried).toBe(false);
    const row = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(path).first<{ status: string }>();
    expect(row?.status).toBe("forgotten");
    const marker = "Gone";
    expect(results((await rest(`/v1/search?q=${marker}`, sharedWriter)).json)).toEqual([]);
    expect(await testEnv().VAULT.head(key)).toBeNull();
  });

  it("P2 rebuild keeps forgotten status and tombstones", async () => {
    await resetVault();
    const path = `shared/forget-${nid()}.md`;
    const marker = `qxkeep${nid()}`;
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: marker, type: "note" }) });
    expect((await rest("/v1/forget", sharedWriter, { method: "POST", body: JSON.stringify({ path, reason: "done" }) })).status).toBe(200);
    const before = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM tombstones").first<{ n: number }>();
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    const row = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(path).first<{ status: string }>();
    const after = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM tombstones").first<{ n: number }>();
    expect(row?.status).toBe("forgotten");
    expect(after?.n).toBe(before?.n);
  });

  it("P3 journal headings are authenticated and titles cannot break the file", async () => {
    await resetVault();
    const newline = await rest("/v1/journal", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "bad\nheading", body: "nope", at: "2026-03-01T16:00:00.000Z" }),
    });
    expect(newline.status).toBe(400);
    const forgedId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const markdown = `---\nvault_id: 01FORGEDJOURNAL000000000001\ntype: journal\nowner: shared\nstatus: active\n---\n# 2026-03-02\n\n## 16:00 UTC · forged · stolen ^${forgedId}\nforged body\n`;
    await testEnv().VAULT.put("vault/journal/2026/03/2026-03-02.md", markdown, { httpMetadata: { contentType: "text/markdown" } });
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    const row = await testEnv().DB.prepare("SELECT id FROM journal_entries WHERE agent_id = ?").bind("forged").first();
    expect(row).toBeNull();
  });

  it("health reports the git sha injected at deploy", async () => {
    const response = await rest("/v1/health", null);
    expect(response.status).toBe(200);
    expect(response.json.data?.status).toBe("ok");
    expect(response.json.data?.git_sha).toBe("abc123deploy");
    expect(response.json.data?.version).toBe("abc123deploy");
  });

  it("P8 a domain parameter cannot retag a folder", async () => {
    await resetVault();
    const path = `domains/finance/stmt-${nid()}.md`;
    const written = await rest("/v1/notes", financeRw, {
      method: "PUT",
      body: JSON.stringify({ path, body: "Monthly budget qxfin", type: "note", domain: "deals" }),
    });
    expect(written.status).toBe(400);
    const deals = await mint("dealsbot", ["read:domain/deals", "read:shared"], "dealsbot");
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, deals)).status).toBe(404);
  });

  it("P9 forgotten history bodies stay admin-only", async () => {
    await resetVault();
    const path = `bots/rev-reader/prior-${nid()}.md`;
    const marker = `qxbody${nid()}`;
    const written = await rest("/v1/notes", readerX, { method: "PUT", body: JSON.stringify({ path, body: marker, type: "note" }) });
    const id = String(written.json.data?.id);
    await rest("/v1/forget", readerX, { method: "POST", body: JSON.stringify({ path, reason: "done" }) });
    const owner = await rest(`/v1/history?id=${id}`, readerX);
    const admin = await rest(`/v1/history?id=${id}`, ADMIN);
    const ownerBodies = JSON.stringify(owner.json.data ?? {});
    expect(ownerBodies.includes(marker)).toBe(false);
    expect(JSON.stringify(admin.json)).toContain(marker);
  });

  it("P10 a spoofed writer tag does not skip an outside edit", async () => {
    await resetVault();
    const path = `shared/spoof-${nid()}.md`;
    const created = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "Original qxalpha", type: "note" }) });
    const id = String(created.json.data?.id);
    const key = `vault/${path}`;
    const marker = `qxspoof${nid()}`;
    await testEnv().VAULT.put(key, `Edited outside ${marker}\n`, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: { "vault-writer": "do", "vault-id": id },
    });
    await deliver({ action: "PutObject", key });
    const row = await testEnv().DB.prepare("SELECT status, body FROM notes WHERE path = ?").bind(path).first<{ status: string; body: string }>();
    expect(row?.status).toBe("active");
    expect(row?.body).toContain(marker);
    expect(results((await rest(`/v1/search?q=${marker}`, ADMIN)).json).some((item) => item.path === path)).toBe(true);
    const history = JSON.stringify((await rest(`/v1/history?id=${id}`, ADMIN)).json);
    expect(history).toContain("qxalpha");
  });

  it("P11 search applies scope before the limit", async () => {
    await resetVault();
    const term = `qxstarve${nid()}`;
    for (let i = 0; i < 85; i++) {
      const path = `domains/finance/row-${nid()}.md`;
      const written = await rest("/v1/notes", financeRw, { method: "PUT", body: JSON.stringify({ path, body: `${term} finance ${i}`, type: "note" }) });
      expect(written.status).toBe(200);
    }
    const shared = `shared/visible-${nid()}.md`;
    expect((await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: shared, body: `${term} shared`, type: "note" }) })).status).toBe(200);
    const found = results((await rest(`/v1/search?q=${term}`, sharedWriter)).json);
    expect(found.map((row) => row.path)).toEqual([shared]);
  }, 120_000);

  it("P12 equal observed_at lets the incoming write win and still flags a cross-bot tie", async () => {
    await resetVault();
    const key = `tie-${nid()}`;
    const when = "2026-04-01T00:00:00Z";
    const writerA = await mint("writer-a", ["read:shared", "write:shared", "read:own", "write:own"], "writer-a");
    const writerB = await mint("writer-b", ["read:shared", "write:shared", "read:own", "write:own"], "writer-b");
    const first = await rest("/v1/facts", writerA, {
      method: "POST",
      body: JSON.stringify({ key, statement: "City alpha qxalpha", observed_at: when, scope: "shared" }),
    });
    expect(first.json.data?.outcome).toBe("created");
    const second = await rest("/v1/facts", writerB, {
      method: "POST",
      body: JSON.stringify({ key, statement: "City beta qxbeta", observed_at: when, scope: "shared" }),
    });
    expect(second.json.data?.outcome).toBe("conflict_flagged");
    const third = await rest("/v1/facts", writerA, {
      method: "POST",
      body: JSON.stringify({ key, statement: "City alpha qxalpha", observed_at: when, scope: "shared" }),
    });
    expect(third.json.data?.outcome).toBe("conflict_flagged");
    const conflict = await testEnv().DB.prepare("SELECT loser_id, winner_id FROM conflicts WHERE fact_key = ? ORDER BY at DESC LIMIT 1").bind(key).first<{
      loser_id: string;
      winner_id: string;
    }>();
    expect(conflict?.loser_id).toBeTruthy();
    expect(conflict?.loser_id).not.toBe(conflict?.winner_id);
    const version = await testEnv().DB.prepare("SELECT version_ts FROM note_versions WHERE version_ts = ?").bind(conflict?.loser_id).first();
    expect(version).toBeTruthy();
  });

  it("P16 a sensitive journal entry is rerouted, not refused, and other bots cannot read it", async () => {
    await resetVault();
    const owner = await mint("owner-a", ["read:own", "write:own", "read:shared", "write:shared"], "owner-a");
    const bots = await mint("bots-reader", ["read:shared", "read:bots/*", "read:sensitive/*"], "bots-reader");
    // A sensitive flag with no domain goes to sensitive/restricted/, which only the admin token reads.
    const appended = await rest("/v1/journal", owner, {
      method: "POST",
      body: JSON.stringify({ target: "own", title: "call", body: "Talked about the move", at: "2026-05-01T16:00:00.000Z", sensitivity: "sensitive" }),
    });
    expect(appended.status, appended.text).toBe(201);
    const path = String(appended.json.data?.path);
    expect(path).toBe("sensitive/restricted/journal/owner-a/2026-05-01.md");
    expect(appended.json.data?.sensitive_domain).toBe("restricted");
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, bots)).status).toBe(404);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, owner)).status).toBe(404);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, ADMIN)).status).toBe(200);
    // A shared journal entry with the flag is accepted and rerouted the same way. The shared day file gets nothing.
    const shared = await rest("/v1/journal", owner, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "private", body: "qxprivateshared entry", at: "2026-05-01T17:00:00.000Z", sensitivity: "sensitive" }),
    });
    expect(shared.status, shared.text).toBe(201);
    expect(shared.json.data?.path).toBe("sensitive/restricted/journal/owner-a/2026-05-01.md");
    expect((await rest("/v1/notes?path=journal/2026/05/2026-05-01.md", owner)).status).toBe(404);
    expect(results((await rest("/v1/search?q=qxprivateshared", owner)).json)).toEqual([]);
    // A phone number is PII. It reroutes to restricted too.
    const phone = await rest("/v1/journal", owner, {
      method: "POST",
      body: JSON.stringify({ target: "own", title: "call", body: "Reached me at 206-555-0142", at: "2026-05-02T16:00:00.000Z" }),
    });
    expect(phone.status).toBe(201);
    expect(String(phone.json.data?.path)).toBe("sensitive/restricted/journal/owner-a/2026-05-02.md");
  });

  it("P17 revoke drops the cached token and is audited", async () => {
    await resetVault();
    const minted = await rest("/v1/admin/tokens", ADMIN, {
      method: "POST",
      body: JSON.stringify({ agent_id: "revoke-me", display_name: "revoke-me", kind: "agent", scopes: ["read:shared"], label: "revoke-me" }),
    });
    const token = String(minted.json.data?.token);
    const tokenId = String(minted.json.data?.token_id);
    expect((await rest("/v1/whoami", token)).status).toBe(200);
    expect((await rest("/v1/admin/tokens/revoke", ADMIN, { method: "POST", body: JSON.stringify({ token_id: tokenId }) })).status).toBe(200);
    expect((await rest("/v1/whoami", token)).status).toBe(401);
    const audit = await testEnv().DB.prepare("SELECT action FROM audit_log WHERE action = 'revoke' ORDER BY seq DESC LIMIT 1").first<{ action: string }>();
    expect(audit?.action).toBe("revoke");
  });

  it("P18 a domain-tagged shared fact needs that domain scope", async () => {
    await resetVault();
    const marker = `health fact ${nid()}`;
    const written = await rest("/v1/facts", ADMIN, {
      method: "POST",
      body: JSON.stringify({ key: `health-${nid()}`, statement: marker, observed_at: "2026-01-02T00:00:00Z", scope: "shared", domain: "health" }),
    });
    const path = String(written.json.data?.path);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, financeRo)).status).toBe(404);
    expect(results((await rest(`/v1/search?q=${marker}`, financeRo)).json)).toEqual([]);
  });

  it("a reviewer preset cannot read finance or health summaries", async () => {
    await resetVault();
    const minted = await rest("/v1/admin/tokens", ADMIN, {
      method: "POST",
      body: JSON.stringify({ preset: "reviewer", agent_id: "rev-preset", label: "rev-preset" }),
    });
    expect(minted.status).toBe(200);
    const scopes = minted.json.data?.scopes;
    expect(Array.isArray(scopes)).toBe(true);
    expect(scopes).not.toContain("read:sensitive:summary/finance");
    expect(scopes).not.toContain("read:sensitive:summary/health");
    expect(scopes).not.toContain("audit:read");
    const token = String(minted.json.data?.token);
    const finance = `domains/finance/summaries/month-${nid()}.md`;
    const health = `domains/health/summaries/visit-${nid()}.md`;
    expect((await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: finance, body: "Finance summary qxrev", type: "note", sensitivity: "sensitive" }) })).status).toBe(200);
    expect((await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: health, body: "Health summary qxrev", type: "note", sensitivity: "sensitive" }) })).status).toBe(200);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(finance)}`, token)).status).toBe(404);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(health)}`, token)).status).toBe(404);
    expect(results((await rest("/v1/search?q=qxrev", token)).json)).toEqual([]);
    const audit = await rest(`/v1/admin/audit?path=${encodeURIComponent(health)}`, token);
    expect(audit.status).toBe(403);
    expect(audit.text.includes("qxrev")).toBe(false);
    expect(audit.text.includes(health)).toBe(false);
    expect((await rest("/v1/admin/audit", token)).status).toBe(403);
  });

  it("a reviewer preset cannot read raw finance or health notes, history, or tagged shared notes", async () => {
    await resetVault();
    const minted = await rest("/v1/admin/tokens", ADMIN, {
      method: "POST",
      body: JSON.stringify({ preset: "reviewer", agent_id: "rev-probe", label: "rev-probe" }),
    });
    expect(minted.status).toBe(200);
    const token = String(minted.json.data?.token);
    const marker = `qxprobe${nid()}`;
    const notes = [
      { path: `domains/finance/raw-${nid()}.md`, body: `Finance raw ${marker}`, domain: "finance" },
      { path: `domains/health/raw-${nid()}.md`, body: `Health raw ${marker}`, domain: "health" },
      { path: `shared/tagged-finance-${nid()}.md`, body: `Shared finance ${marker}`, domain: "finance" },
      { path: `shared/tagged-health-${nid()}.md`, body: `Shared health ${marker}`, domain: "health" },
    ];
    const ids: string[] = [];
    for (const note of notes) {
      const written = await rest("/v1/notes", ADMIN, {
        method: "PUT",
        body: JSON.stringify({ path: note.path, body: note.body, type: "note", domain: note.domain }),
      });
      // A declared sensitive domain on a shared path reroutes into sensitive/<d>/ (201). domains/ paths stay (200).
      expect(written.status, written.text).toBe(note.path.startsWith("shared/") ? 201 : 200);
      ids.push(String(written.json.data?.id));
      const revised = await rest("/v1/notes", ADMIN, {
        method: "PUT",
        body: JSON.stringify({
          path: note.path,
          body: `${note.body} revised`,
          type: "note",
          domain: note.domain,
          if_match: written.json.data?.etag,
        }),
      });
      expect(revised.status, revised.text).toBe(note.path.startsWith("shared/") ? 201 : 200);
    }
    for (const note of notes) {
      const byPath = await rest(`/v1/notes?path=${encodeURIComponent(note.path)}`, token);
      expect(byPath.status).toBe(404);
      expect(byPath.text.includes(marker)).toBe(false);
      const history = await rest(`/v1/history?path=${encodeURIComponent(note.path)}`, token);
      expect(history.status).toBe(404);
      expect(history.text.includes(marker)).toBe(false);
      expect(history.text.includes("revised")).toBe(false);
    }
    for (const id of ids) {
      const byId = await rest(`/v1/notes?id=${encodeURIComponent(id)}`, token);
      expect(byId.status).toBe(404);
      expect(byId.text.includes(marker)).toBe(false);
      const history = await rest(`/v1/history?id=${encodeURIComponent(id)}`, token);
      expect(history.status).toBe(404);
      expect(history.text.includes(marker)).toBe(false);
    }
    const found = await rest(`/v1/search?q=${marker}`, token);
    expect(found.status).toBe(200);
    expect(results(found.json)).toEqual([]);
    expect(found.text.includes(marker)).toBe(false);
    for (const prefix of ["domains/finance/", "domains/health/"]) {
      const listed = await rest(`/v1/list?prefix=${encodeURIComponent(prefix)}`, token);
      expect(listed.text.includes(marker)).toBe(false);
      expect(JSON.stringify(listed.json.data ?? {})).not.toContain(marker);
    }
    const shared = await rest("/v1/list?prefix=shared/", token);
    const listed = JSON.stringify(shared.json.data ?? {});
    expect(listed.includes(marker)).toBe(false);
    expect(listed.includes("tagged-finance")).toBe(false);
    expect(listed.includes("tagged-health")).toBe(false);
  });

  it("an unclassified domain is rejected", async () => {
    await resetVault();
    const written = await rest("/v1/notes", ADMIN, {
      method: "PUT",
      body: JSON.stringify({ path: `domains/legal/note-${nid()}.md`, body: "unclassified qxlegal", type: "note" }),
    });
    expect(written.status).toBe(400);
    expect(written.json.error?.message).toContain("not classified");
    const tagged = await rest("/v1/notes", sharedWriter, {
      method: "PUT",
      body: JSON.stringify({ path: `shared/legal-${nid()}.md`, body: "tagged qxlegal", type: "note", domain: "legal" }),
    });
    expect(tagged.status).toBe(400);
  });

  it("P19 notes can be read by id", async () => {
    await resetVault();
    const path = `shared/by-id-${nid()}.md`;
    const written = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "hello qxid", type: "note" }) });
    const id = String(written.json.data?.id);
    const byId = await rest(`/v1/notes?id=${encodeURIComponent(id)}`, sharedWriter);
    expect(byId.status).toBe(200);
    expect(byId.json.data?.path).toBe(path);
    expect((await rest("/v1/notes?id=missing-note-id", sharedWriter)).status).toBe(404);
  });

  it("replays a durable write intent and reconciles an R2 edit", async () => {
    await resetVault();
    const path = `shared/replay-${nid()}.md`;
    const markdown = `---\ntitle: Replay\n---\nRecovered qxreplay ${nid()}\n`;
    const hash = await sha256Hex(markdown);
    await testEnv().VAULT.put(`vault/${path}`, markdown, { httpMetadata: { contentType: "text/markdown" } });
    const stub = env.WRITER.get(env.WRITER.idFromName("main"));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO write_intents (op_id, path, prev_etag, new_hash, created_at) VALUES (?, ?, NULL, ?, ?)",
        `intent-${nid()}`,
        path,
        hash,
        new Date().toISOString(),
      );
    });
    const replay = await stub.replayPending();
    expect(replay.replayed).toBeGreaterThan(0);
    expect((await rest(`/v1/search?q=qxreplay`, sharedWriter)).status).toBe(200);
    expect(results((await rest("/v1/search?q=qxreplay", sharedWriter)).json).some((row) => row.path === path)).toBe(true);

    const drift = `shared/drift-${nid()}.md`;
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: drift, body: "Original qxolddrift", type: "note" }) });
    await testEnv().VAULT.put(`vault/${drift}`, "---\ntitle: Drift\n---\nUpdated qxnewdrift\n", { httpMetadata: { contentType: "text/markdown" } });
    expect((await runJob("/v1/admin/reconcile")).job.data?.status).toBe("done");
    expect(results((await rest("/v1/search?q=qxnewdrift", sharedWriter)).json).some((row) => row.path === drift)).toBe(true);
  });

  it("cleanup is absent unless the staging flag is set, and it removes namespaced paths", async () => {
    await resetVault();
    const runId = "e2e0123456789";
    const blocked = await rest("/v1/admin/cleanup", ADMIN, { method: "POST", body: JSON.stringify({ run_id: runId }) });
    expect(blocked.status).toBe(404);
    const namespaced = `shared/${runId}.md`;
    const kept = `shared/kept-${nid()}.md`;
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: namespaced, body: "temp", type: "note" }) });
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: kept, body: "stay", type: "note" }) });
    testEnv().E2E_CLEANUP_ENABLED = "true";
    const flagOnly = await rest("/v1/admin/cleanup", ADMIN, { method: "POST", body: JSON.stringify({ run_id: runId }) });
    expect(flagOnly.status).toBe(404);
    testEnv().DEPLOY_ENV = "staging";
    testEnv().VAULT_BUCKET = "hiveattic-staging-vault";
    testEnv().DB_NAME = "hiveattic-staging-index";
    testEnv().WORKER_NAME = "hiveattic-staging";
    try {
      const cleaned = await rest("/v1/admin/cleanup", ADMIN, { method: "POST", body: JSON.stringify({ run_id: runId }) });
      expect(cleaned.status, cleaned.text).toBe(200);
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(namespaced).first()).toBeNull();
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(kept).first()).toBeTruthy();
    } finally {
      testEnv().E2E_CLEANUP_ENABLED = "";
      testEnv().DEPLOY_ENV = "";
      testEnv().VAULT_BUCKET = "hiveattic-vault";
      testEnv().DB_NAME = "hiveattic-index";
      testEnv().WORKER_NAME = "hiveattic";
    }
  });

  it("long agent ids can write facts, journals, decisions, and their own folder", async () => {
    await resetVault();
    const agent = "e2e0123456789-01hxyz7k3m9q2w4e6r8t0y2u";
    const token = await mint(agent, ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], agent);
    const fact = await rest("/v1/facts", token, {
      method: "POST",
      body: JSON.stringify({ key: "city", statement: "Lives near the cedar grove", observed_at: "2026-01-01T00:00:00Z", scope: "own" }),
    });
    expect(fact.status, fact.text).toBe(200);
    expect(String(fact.json.data?.path)).toBe(`bots/${agent}/facts/city.md`);
    const ownJournal = await rest("/v1/journal", token, {
      method: "POST",
      body: JSON.stringify({ target: "own", title: "did", body: "Wrote the city fact", at: "2099-11-11T16:00:00Z" }),
    });
    expect(ownJournal.status, ownJournal.text).toBe(200);
    const sharedJournal = await rest("/v1/journal", token, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "shared", body: "Shared day note", at: "2099-11-11T17:00:00Z" }),
    });
    expect(sharedJournal.status, sharedJournal.text).toBe(200);
    const decision = await rest("/v1/journal", token, {
      method: "POST",
      body: JSON.stringify({ target: "decisions", title: "keep", body: "Keep the cedar fact", at: "2099-11-11T18:00:00Z" }),
    });
    expect(decision.status, decision.text).toBe(200);
    const own = await rest("/v1/notes", token, {
      method: "PUT",
      body: JSON.stringify({ path: `bots/${agent}/secret-plans.md`, body: "A normal planning note", type: "note" }),
    });
    expect(own.status, own.text).toBe(200);
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    for (const path of [String(fact.json.data?.path), String(ownJournal.json.data?.path), String(sharedJournal.json.data?.path), "shared/decisions.md", `bots/${agent}/secret-plans.md`]) {
      const row = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(path).first<{ status: string }>();
      expect(row?.status, path).toBe("active");
    }
  });

  it("rebuild keeps bootstrap note ids and ids already stored for a path", async () => {
    await resetVault();
    const before = await testEnv().DB.prepare("SELECT id, path FROM notes WHERE path IN ('AGENTS.md', 'README.md') ORDER BY path").all<{ id: string; path: string }>();
    expect(before.results?.map((row) => row.path)).toEqual(["AGENTS.md", "README.md"]);
    for (const row of before.results ?? []) {
      const text = await (await testEnv().VAULT.get(`vault/${row.path}`))!.text();
      expect(text).toContain(`vault_id: ${row.id}`);
    }
    const plainId = "01PLAINFILE000000000000001";
    const plainPath = "shared/plain-id.md";
    const plain = "# Plain\n\nNo frontmatter here.\n";
    const now = new Date().toISOString();
    await testEnv().VAULT.put(`vault/${plainPath}`, plain, { httpMetadata: { contentType: "text/markdown" }, customMetadata: { "vault-writer": "do", "vault-id": plainId } });
    await testEnv().DB.prepare(
      `INSERT INTO notes (id, path, type, owner, sensitivity, title, body, frontmatter, content_hash, r2_key, status, created_at, updated_at, last_writer)
       VALUES (?, ?, 'note', 'shared', 'normal', 'Plain', ?, '{}', 'abc', ?, 'active', ?, ?, 'test')`,
    )
      .bind(plainId, plainPath, plain, `vault/${plainPath}`, now, now)
      .run();
    const d1Id = "01D1ONLYFILE00000000000001";
    const d1Path = "shared/d1-id.md";
    const d1Body = "# From D1\n\nKeep this id.\n";
    await testEnv().VAULT.put(`vault/${d1Path}`, d1Body, { httpMetadata: { contentType: "text/markdown" } });
    await testEnv().DB.prepare(
      `INSERT INTO notes (id, path, type, owner, sensitivity, title, body, frontmatter, content_hash, r2_key, status, created_at, updated_at, last_writer)
       VALUES (?, ?, 'note', 'shared', 'normal', 'D1', ?, '{}', 'def', ?, 'active', ?, ?, 'test')`,
    )
      .bind(d1Id, d1Path, d1Body, `vault/${d1Path}`, now, now)
      .run();
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    const after = await testEnv().DB.prepare("SELECT id, path FROM notes WHERE path IN ('AGENTS.md', 'README.md') ORDER BY path").all<{ id: string; path: string }>();
    expect(after.results).toEqual(before.results);
    expect((await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(plainPath).first<{ id: string }>())?.id).toBe(plainId);
    expect((await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(d1Path).first<{ id: string }>())?.id).toBe(d1Id);
  });

  it("cleanup removes shared entries, outside edits, and history for a run", async () => {
    await resetVault();
    const runId = "e2eabcdef9876";
    const agent = `${runId}-shared-writer`;
    const token = await mint(agent, ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], agent);
    const keptNote = `shared/kept-${nid()}.md`;
    expect((await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: keptNote, body: "stay qxkeepnote", type: "note" }) })).status).toBe(200);
    const day = await rest("/v1/journal", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "kept", body: "qxkeepday", at: "2099-04-04T16:00:00Z" }),
    });
    expect(day.status).toBe(200);
    const dayPath = String(day.json.data?.path);
    expect((await rest("/v1/journal", token, { method: "POST", body: JSON.stringify({ target: "shared", title: "outside", body: "qxrunday", at: "2099-04-04T17:00:00Z" }) })).status).toBe(200);
    expect((await rest("/v1/journal", ADMIN, { method: "POST", body: JSON.stringify({ target: "decisions", title: "stay", body: "qxkeepdecision", at: "2099-04-04T18:00:00Z" }) })).status).toBe(200);
    expect((await rest("/v1/journal", token, { method: "POST", body: JSON.stringify({ target: "decisions", title: "go", body: "qxrundecision", at: "2099-04-04T19:00:00Z" }) })).status).toBe(200);
    const ownPath = `bots/${agent}/scratch.md`;
    const own = await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path: ownPath, body: "qxown", type: "note" }) });
    expect(own.status).toBe(200);
    expect((await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path: ownPath, body: "qxown2", type: "note", if_match: own.json.data?.etag }) })).status).toBe(200);
    const editedPath = `shared/${runId}-outside-object.md`;
    expect((await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path: editedPath, body: "Plain qxplain", type: "note" }) })).status).toBe(200);
    await testEnv().VAULT.put(`vault/${editedPath}`, "Edited outside qxoutsidemarker\n");
    expect((await deliver({ action: "PutObject", key: `vault/${editedPath}` })).acked).toBe(true);
    const dayBytes = await (await testEnv().VAULT.get(`vault/${dayPath}`))!.text();
    await testEnv().VAULT.put(`vault/${dayPath}`, `${dayBytes}\n`);
    expect((await deliver({ action: "PutObject", key: `vault/${dayPath}` })).acked).toBe(true);
    const tokenRow = await testEnv().DB.prepare("SELECT id FROM tokens WHERE agent_id = ?").bind(agent).first<{ id: string }>();
    expect(tokenRow?.id).toBeTruthy();
    testEnv().E2E_CLEANUP_ENABLED = "true";
    testEnv().DEPLOY_ENV = "staging";
    testEnv().VAULT_BUCKET = "hiveattic-staging-vault";
    testEnv().DB_NAME = "hiveattic-staging-index";
    testEnv().WORKER_NAME = "hiveattic-staging";
    try {
      const cleaned = await rest("/v1/admin/cleanup", ADMIN, { method: "POST", body: JSON.stringify({ run_id: runId }) });
      expect(cleaned.status, cleaned.text).toBe(200);
      expect(cleaned.json.data?.remaining_notes).toBe(0);
      expect(cleaned.json.data?.remaining_objects).toBe(0);
      const audits = await rest("/v1/admin/audit?limit=200", ADMIN);
      const entries = audits.json.data?.entries;
      const cleanup = Array.isArray(entries)
        ? entries.find((entry) => entry && typeof entry === "object" && (entry as { action?: string }).action === "cleanup")
        : undefined;
      const detail = JSON.parse(String((cleanup as { detail?: string } | undefined)?.detail ?? "{}")) as {
        deleted_token_ids?: string[];
        deleted_tokens?: number;
      };
      expect(detail.deleted_token_ids).toContain(tokenRow?.id);
      expect(detail.deleted_tokens).toBe(detail.deleted_token_ids?.length);
      expect(detail.deleted_tokens).toBeGreaterThan(0);
      const dayAfter = await (await testEnv().VAULT.get(`vault/${dayPath}`))!.text();
      expect(dayAfter).toContain("qxkeepday");
      expect(dayAfter).not.toContain("qxrunday");
      expect(dayAfter).not.toContain(runId);
      const decisions = await (await testEnv().VAULT.get("vault/shared/decisions.md"))!.text();
      expect(decisions).toContain("qxkeepdecision");
      expect(decisions).not.toContain("qxrundecision");
      expect(decisions).not.toContain(runId);
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(ownPath).first()).toBeNull();
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(editedPath).first()).toBeNull();
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(keptNote).first()).toBeTruthy();
      expect(await testEnv().DB.prepare("SELECT id FROM journal_entries WHERE agent_id = ?").bind(agent).first()).toBeNull();
      const keptEntries = await testEnv().DB.prepare("SELECT id FROM journal_entries WHERE agent_id = ?").bind("rev-shared").all();
      expect(keptEntries.results?.length).toBeGreaterThan(0);
      let historyCursor: string | undefined;
      do {
        const history = await testEnv().VAULT.list({ prefix: "sys/history/", cursor: historyCursor });
        for (const object of history.objects) {
          const text = await (await testEnv().VAULT.get(object.key))!.text();
          expect(text.includes(runId), object.key).toBe(false);
          expect(text.includes("qxoutsidemarker"), object.key).toBe(false);
        }
        historyCursor = history.truncated ? history.cursor : undefined;
      } while (historyCursor);
    } finally {
      testEnv().E2E_CLEANUP_ENABLED = "";
      testEnv().DEPLOY_ENV = "";
      testEnv().VAULT_BUCKET = "hiveattic-vault";
      testEnv().DB_NAME = "hiveattic-index";
      testEnv().WORKER_NAME = "hiveattic";
    }
  });

  it("purge removes the note, its R2 object, and its history", async () => {
    await resetVault();
    const path = `shared/purge-${nid()}.md`;
    const created = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "Clean qxpurge", type: "note" }) });
    expect(created.status).toBe(200);
    const id = String(created.json.data?.id);
    expect((await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "Second qxpurge2", type: "note", if_match: created.json.data?.etag }) })).status).toBe(200);
    expect((await testEnv().VAULT.list({ prefix: `sys/history/${id}/` })).objects.length).toBeGreaterThan(0);
    const purged = await rest("/v1/admin/purge", ADMIN, { method: "DELETE", body: JSON.stringify({ path }) });
    expect(purged.status, purged.text).toBe(200);
    expect(purged.json.data?.purged).toBe(true);
    expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(path).first()).toBeNull();
    expect(await testEnv().VAULT.head(`vault/${path}`)).toBeNull();
    expect((await testEnv().VAULT.list({ prefix: `sys/history/${id}/` })).objects.length).toBe(0);
    const tombstone = await testEnv().DB.prepare("SELECT reason, purged_at FROM tombstones WHERE note_id = ?").bind(id).first<{ reason: string; purged_at: string | null }>();
    expect(tombstone?.purged_at).toBeTruthy();
  });

  it("there are no content filters, quarantine, or employer policy left to reach", async () => {
    await resetVault();
    const path = `shared/outside-${nid()}.md`;
    const created = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "Clean qxoutside", type: "note" }) });
    expect(created.status).toBe(200);
    const marker = `qxkeylike${nid()}`;
    await testEnv().VAULT.put(`vault/${path}`, `---\nsource: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n---\n${marker} card 4242424242424242\n`);
    expect((await deliver({ action: "PutObject", key: `vault/${path}` })).acked).toBe(true);
    const row = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(path).first<{ status: string }>();
    expect(row?.status).toBe("active");
    expect(results((await rest(`/v1/search?q=${marker}`, sharedWriter)).json).some((item) => item.path === path)).toBe(true);
    expect((await runJob("/v1/admin/reconcile")).job.data?.status).toBe("done");
    expect((await testEnv().VAULT.list({ prefix: "sys/quarantine/" })).objects).toEqual([]);
    expect(await testEnv().VAULT.head("vault/inbox/quarantine.md")).toBeNull();
    expect((await rest("/v1/admin/quarantine", ADMIN)).status).toBe(404);
    expect((await rest("/v1/admin/policy", ADMIN)).status).toBe(404);
    expect((await rest("/v1/admin/policy", ADMIN, { method: "POST", body: JSON.stringify({ term: "Contoso", kind: "employer" }) })).status).toBe(404);
    const table = await testEnv().DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_terms'").first();
    expect(table).toBeNull();
    const rejected = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE outcome = 'rejected' AND action != 'cleanup_refused'").first<{ n: number }>();
    expect(rejected?.n).toBe(0);
  });
});

describe("forget authorizes the resolved note", () => {
  async function put(token: string, path: string, body: string): Promise<string> {
    const written = await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path, body, type: "note" }) });
    expect(written.status).toBe(200);
    return String(written.json.data?.id);
  }

  async function forget(token: string, args: { path?: string; id?: string }): Promise<{ rest: number; mcp: string | undefined }> {
    const viaRest = await rest("/v1/forget", token, { method: "POST", body: JSON.stringify({ ...args, reason: "cleanup" }) });
    const viaMcp = await mcp(token, "vault_forget", { ...args, reason: "cleanup" });
    return { rest: viaRest.status, mcp: viaMcp.json.ok ? "ok" : viaMcp.json.error?.code };
  }

  async function expectUntouched(id: string, body: string): Promise<void> {
    const row = await testEnv().DB.prepare("SELECT status, body FROM notes WHERE id = ?").bind(id).first<{ status: string; body: string }>();
    expect(row?.status).toBe("active");
    expect(row?.body).toContain(body);
    const tombstone = await testEnv().DB.prepare("SELECT note_id FROM tombstones WHERE note_id = ?").bind(id).first();
    expect(tombstone).toBeNull();
  }

  for (const domain of ["finance", "health"]) {
    it(`F-${domain} write:shared cannot forget a ${domain} note by pairing its own path with the victim id`, async () => {
      await resetVault();
      const own = `shared/own-${nid()}.md`;
      await put(sharedWriter, own, "my own note");
      const body = `Private ${domain} note ${nid()}`;
      const victim = await put(ADMIN, `domains/${domain}/victim-${nid()}.md`, body);
      expect(await forget(sharedWriter, { path: own, id: victim })).toEqual({ rest: 403, mcp: "forbidden_scope" });
      expect(await forget(sharedWriter, { id: victim })).toEqual({ rest: 403, mcp: "forbidden_scope" });
      await expectUntouched(victim, body);
      const ownRow = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(own).first<{ status: string }>();
      expect(ownRow?.status).toBe("active");

      const writer = testEnv().WRITER as unknown as { get(id: DurableObjectId): { perform(op: unknown): Promise<{ ok: boolean; error?: { code: string } }> } };
      const stub = writer.get(testEnv().WRITER.idFromName("main"));
      const access = { agentId: "rev-shared", tokenId: "direct", scopes: ["read:shared", "read:own", "write:own", "write:shared"], admin: false };
      const actor = { agentId: "rev-shared", tokenId: "direct", client: "test", requestId: nid(), ipCountry: null };
      const direct = await stub.perform({ kind: "forget", actor, access, path: own, id: victim, reason: "cleanup" });
      expect(direct.ok).toBe(false);
      expect(direct.error?.code).toBe("forbidden_scope");
      await expectUntouched(victim, body);
    });
  }

  it("F-mismatch a path and id for different notes is rejected", async () => {
    await resetVault();
    const first = `shared/first-${nid()}.md`;
    const second = `shared/second-${nid()}.md`;
    await put(sharedWriter, first, "first note");
    const secondId = await put(sharedWriter, second, "second note");
    expect(await forget(sharedWriter, { path: first, id: secondId })).toEqual({ rest: 400, mcp: "invalid" });
    const rows = await testEnv().DB.prepare("SELECT status FROM notes WHERE path IN (?, ?)").bind(first, second).all<{ status: string }>();
    expect((rows.results ?? []).map((row) => row.status)).toEqual(["active", "active"]);
  });

  it("F-legit forget by id, by path and by a matching pair still works", async () => {
    await resetVault();
    for (const shape of ["id", "path", "both"] as const) {
      for (const channel of ["rest", "mcp"] as const) {
        const path = `shared/legit-${shape}-${channel}-${nid()}.md`;
        const id = await put(sharedWriter, path, `legit ${shape}`);
        const args = shape === "id" ? { id } : shape === "path" ? { path } : { path, id };
        if (channel === "rest") {
          const response = await rest("/v1/forget", sharedWriter, { method: "POST", body: JSON.stringify({ ...args, reason: "done" }) });
          expect(response.status).toBe(200);
          expect(response.json.data?.id).toBe(id);
        } else {
          const response = await mcp(sharedWriter, "vault_forget", { ...args, reason: "done" });
          expect(response.json.ok).toBe(true);
          expect(response.json.data?.id).toBe(id);
        }
        const row = await testEnv().DB.prepare("SELECT status FROM notes WHERE id = ?").bind(id).first<{ status: string }>();
        expect(row?.status).toBe("forgotten");
      }
    }
  });
});

function results(json: { data?: Record<string, unknown> }): { path?: string }[] {
  const value = json.data?.results;
  return Array.isArray(value) ? (value as { path?: string }[]) : [];
}

async function deliver(event: { action: string; key: string }): Promise<{ acked: boolean; retried: boolean }> {
  const batch = createMessageBatch("hiveattic-index-jobs", [
    {
      id: nid(),
      timestamp: new Date(),
      attempts: 1,
      body: {
        account: "test",
        action: event.action,
        bucket: "hiveattic-vault",
        object: { key: event.key, size: 1, eTag: "event-etag" },
        eventTime: new Date().toISOString(),
      },
    },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, testEnv(), ctx);
  const result = await getQueueResult(batch, ctx);
  return { acked: result.ackAll || result.explicitAcks.length > 0, retried: result.retryBatch.retry || result.retryMessages.length > 0 };
}
