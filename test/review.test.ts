import { createExecutionContext, createMessageBatch, env, getQueueResult, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hmacSha256Hex, sha256Hex } from "../src/crypto";
import { inspectWrite, scanEmployer, scanFinancial, scanSecrets } from "../src/filters";
import worker from "../src/index";
import { ADMIN, mint, nid, resetVault, rest, testEnv } from "./helpers";

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
    const rebuilt = await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" });
    expect(rebuilt.status).toBe(200);
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
    expect((await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" })).status).toBe(200);
    const row = await testEnv().DB.prepare("SELECT id FROM journal_entries WHERE agent_id = ?").bind("forged").first();
    expect(row).toBeNull();
  });

  it("P4 filters catch spaced secrets and ids and leave benign phrases", () => {
    const empty: { term: string; kind: string }[] = [];
    expect(inspectWrite("token Zq8xP2mL9vR4tY7wK1nB5cJ3hF6dS0aG here", empty)?.reasons).toContain("secret_entropy");
    expect(inspectWrite('api_key="Zq8xP2mL9vR4tY7wK1nB5cJ3hF6dS0aG";', empty)?.code).toBe("rejected_secret");
    expect(inspectWrite("use Zq8xP2mL9vR4tY7wK1nB5cJ3hF6dS0aG, then", empty)?.code).toBe("rejected_secret");
    expect(inspectWrite("card 4242 4242 4242 4242", empty)?.code).toBe("rejected_financial");
    expect(inspectWrite("card 4242 4242 4242 4242 2026", empty)?.reasons).toContain("financial_card");
    expect(inspectWrite("card 4242.4242.4242.4242", empty)?.reasons).toContain("financial_card");
    expect(inspectWrite("accounts 5839201746", empty)?.reasons).toContain("financial_account");
    expect(inspectWrite("ssn 219 09 9999", empty)?.code).toBe("rejected_government_id");
    expect(scanFinancial("My passport renewal appointment is next Tuesday")).toEqual([]);
    expect(scanFinancial("Driver's license renewal reminder for October")).toEqual([]);
    expect(scanFinancial("Opened the brokerage account on 2026-10-17")).toEqual([]);
    expect(scanFinancial("My brokerage balance is 125000 dollars")).toEqual([]);
    expect(scanSecrets("key 7ZQ4K9M2X8P5R3T6V1W0Y8N4HJ")).toEqual([]);
    const policy = [
      { term: "Contoso Example Corp", kind: "context_subject" },
      { term: "deal", kind: "context_qualifier" },
      { term: "nda", kind: "employer" },
    ];
    expect(scanEmployer("Got a good deal on a Contoso Example Corp Surface at the shop", [])).toEqual([]);
    expect(scanEmployer("Got a good deal on a Contoso Example Corp Surface at the shop", policy)).toContain("employer_context");
    expect(scanEmployer("Got a good deal on a Contoso Example Corp Surface at the shop", [...policy, { term: "Surface", kind: "allow" }])).toEqual([]);
    expect(scanEmployer("Signed an nda with my landlord", policy)).toContain("employer_denylist");
    expect(scanEmployer("The monday market opens at nine.", policy)).toEqual([]);
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
    const path = `bots/rev-reader/secret-history-${nid()}.md`;
    const marker = `qxbody${nid()}`;
    const written = await rest("/v1/notes", readerX, { method: "PUT", body: JSON.stringify({ path, body: marker, type: "note" }) });
    const id = String(written.json.data?.id);
    await rest("/v1/forget", readerX, { method: "POST", body: JSON.stringify({ path, reason: "done" }) });
    const owner = await rest(`/v1/history?id=${id}`, readerX);
    const admin = await rest(`/v1/history?id=${id}`, ADMIN);
    const ownerBodies = JSON.stringify(owner.json.data ?? {});
    expect(ownerBodies.includes(marker)).toBe(false);
    expect(JSON.stringify(admin.json.data ?? {}).includes(marker)).toBe(true);
  });

  it("P10 a spoofed writer tag does not skip a secret edit", async () => {
    await resetVault();
    const path = `shared/spoof-${nid()}.md`;
    const created = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "Original qxalpha", type: "note" }) });
    const id = String(created.json.data?.id);
    const key = `vault/${path}`;
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const marker = `qxsecret${nid()}`;
    await testEnv().VAULT.put(key, `${secret}\n${marker}\n`, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: { "vault-writer": "do", "vault-id": id },
    });
    await deliver({ action: "PutObject", key });
    const row = await testEnv().DB.prepare("SELECT status, body FROM notes WHERE path = ?").bind(path).first<{ status: string; body: string }>();
    expect(row?.status).toBe("quarantined");
    expect(row?.body.includes(secret)).toBe(false);
    expect(results((await rest(`/v1/search?q=${marker}`, ADMIN)).json)).toEqual([]);
    expect(await testEnv().VAULT.head(key)).not.toBeNull();
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

  it("P13 rejected audit hashes are not unsalted sha256", async () => {
    await resetVault();
    const statement = "routing 021000021";
    const response = await rest("/v1/facts", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ key: `route-${nid()}`, statement, observed_at: "2026-01-01T00:00:00Z", scope: "own" }),
    });
    expect(response.json.error?.code).toBe("rejected_financial");
    const row = await testEnv().DB.prepare("SELECT content_hash FROM audit_log WHERE request_id = ?").bind(response.json.request_id).first<{ content_hash: string }>();
    const plain = await sha256Hex(`${statement}\n\n`);
    const keyed = await hmacSha256Hex("hiveattic-test-audit-key", `${statement}\n\n`);
    expect(row?.content_hash).not.toBe(plain);
    expect(row?.content_hash).toBe(keyed);
  });

  it("P16 another bot cannot read a sensitive own journal", async () => {
    await resetVault();
    const owner = await mint("owner-a", ["read:own", "write:own", "read:shared"], "owner-a");
    const bots = await mint("bots-reader", ["read:shared", "read:bots/*"], "bots-reader");
    const appended = await rest("/v1/journal", owner, {
      method: "POST",
      body: JSON.stringify({ target: "own", title: "call", body: "Reached me at 206-555-0142", at: "2026-05-01T16:00:00.000Z" }),
    });
    expect(appended.status).toBe(200);
    const path = String(appended.json.data?.path);
    expect(path.includes("/journal-sensitive/")).toBe(true);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, bots)).status).toBe(404);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, owner)).status).toBe(200);
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
    const reconciled = await rest("/v1/admin/reconcile", ADMIN, { method: "POST", body: "{}" });
    expect(reconciled.status).toBe(200);
    expect(results((await rest("/v1/search?q=qxnewdrift", sharedWriter)).json).some((row) => row.path === drift)).toBe(true);
  });

  it("cleanup is absent unless the staging flag is set, and it only removes namespaced paths", async () => {
    await resetVault();
    const runId = "e2e0123456789";
    const blocked = await rest("/v1/admin/cleanup", ADMIN, { method: "POST", body: JSON.stringify({ run_id: runId }) });
    expect(blocked.status).toBe(404);
    const namespaced = `shared/${runId}.md`;
    const kept = `shared/kept-${nid()}.md`;
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: namespaced, body: "temp", type: "note" }) });
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: kept, body: "stay", type: "note" }) });
    testEnv().E2E_CLEANUP_ENABLED = "true";
    try {
      const cleaned = await rest("/v1/admin/cleanup", ADMIN, { method: "POST", body: JSON.stringify({ run_id: runId }) });
      expect(cleaned.status).toBe(200);
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(namespaced).first()).toBeNull();
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(kept).first()).toBeTruthy();
    } finally {
      testEnv().E2E_CLEANUP_ENABLED = "";
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
