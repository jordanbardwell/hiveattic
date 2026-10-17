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
    expect(scanSecrets("aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY").length).toBeGreaterThan(0);
    expect(scanSecrets("use Zq8xP2mL9vR4tY7wK1n/B5cJ3hF6dS0aGq8xP2 now")).toContain("secret_entropy");
    expect(scanSecrets("see src/components/settings/NotificationPreferences.tsx")).toEqual([]);
    const longAgent = "e2e0123456789-01hxyz7k3m9q2w4e6r8t0y2u";
    expect(longAgent.length).toBeGreaterThanOrEqual(20);
    expect(longAgent.length).toBeLessThanOrEqual(40);
    expect(scanSecrets(`bots/${longAgent}/facts/city.md`)).toEqual([]);
    expect(scanSecrets(`bots/${longAgent}/journal/2099/11/2099-11-11.md`)).toEqual([]);
    expect(scanSecrets(`bots/architect-staging-admin/facts/city.md`)).toEqual([]);
    expect(scanSecrets(`shared/e2e0123456789-secret-object.md`)).toEqual([]);
    expect(scanSecrets(`## 16:00 UTC · ${longAgent} · outside ^01ARZ3NDEKTSV4RRFFQ69G5FAV`)).toEqual([]);
    expect(scanSecrets(`owner: ${longAgent}`)).toEqual([]);
    expect(scanSecrets(`note ${longAgent} in prose`)).toContain("secret_entropy");
    expect(scanSecrets(`bots/sk-proj-abcdefghijklmnopqrstuvwxyz0123456789/facts/x.md`).length).toBeGreaterThan(0);
    expect(scanFinancial("call 2065550142 2065550143 2065550144")).toEqual([]);
    expect(scanFinancial("order number 20261017004512345678")).toEqual([]);
    expect(scanFinancial("UPS tracking 1Z999AA10123456784 and USPS 9400111899223197428490")).toEqual([]);
    expect(scanFinancial("brokerage account 5839201746 holds 500 dollars")).toContain("financial_account");
    expect(scanFinancial("account 5839201746 (USD)")).toEqual([]);
    expect(scanFinancial("account 5839.201.746")).toContain("financial_account");
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
    expect((await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" })).status).toBe(200);
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
    expect((await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" })).status).toBe(200);
    const after = await testEnv().DB.prepare("SELECT id, path FROM notes WHERE path IN ('AGENTS.md', 'README.md') ORDER BY path").all<{ id: string; path: string }>();
    expect(after.results).toEqual(before.results);
    expect((await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(plainPath).first<{ id: string }>())?.id).toBe(plainId);
    expect((await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(d1Path).first<{ id: string }>())?.id).toBe(d1Id);
  });

  it("cleanup removes shared entries, history, and quarantine records for a run", async () => {
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
    const secretPath = `shared/${runId}-secret-object.md`;
    expect((await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path: secretPath, body: "Plain qxplain", type: "note" }) })).status).toBe(200);
    await testEnv().VAULT.put(`vault/${secretPath}`, "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\nqxsecretmarker\n");
    expect((await deliver({ action: "PutObject", key: `vault/${secretPath}` })).acked).toBe(true);
    const dayBytes = await (await testEnv().VAULT.get(`vault/${dayPath}`))!.text();
    await testEnv().VAULT.put(`vault/${dayPath}`, `${dayBytes}\n`);
    expect((await deliver({ action: "PutObject", key: `vault/${dayPath}` })).acked).toBe(true);
    const inboxBefore = await rest("/v1/notes?path=inbox/quarantine.md", ADMIN);
    expect(String(inboxBefore.json.data?.markdown ?? "")).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(String(inboxBefore.json.data?.markdown ?? "")).not.toContain(secretPath);
    expect(inboxBefore.json.data?.status).toBe("active");
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
      const dayAfter = await (await testEnv().VAULT.get(`vault/${dayPath}`))!.text();
      expect(dayAfter).toContain("qxkeepday");
      expect(dayAfter).not.toContain("qxrunday");
      expect(dayAfter).not.toContain(runId);
      const decisions = await (await testEnv().VAULT.get("vault/shared/decisions.md"))!.text();
      expect(decisions).toContain("qxkeepdecision");
      expect(decisions).not.toContain("qxrundecision");
      expect(decisions).not.toContain(runId);
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(ownPath).first()).toBeNull();
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(secretPath).first()).toBeNull();
      expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(keptNote).first()).toBeTruthy();
      expect(await testEnv().DB.prepare("SELECT id FROM journal_entries WHERE agent_id = ?").bind(agent).first()).toBeNull();
      const keptEntries = await testEnv().DB.prepare("SELECT id FROM journal_entries WHERE agent_id = ?").bind("rev-shared").all();
      expect(keptEntries.results?.length).toBeGreaterThan(0);
      const quarantine = await testEnv().VAULT.list({ prefix: "sys/quarantine/" });
      for (const object of quarantine.objects) {
        expect(await (await testEnv().VAULT.get(object.key))!.text()).not.toContain(runId);
      }
      let historyCursor: string | undefined;
      do {
        const history = await testEnv().VAULT.list({ prefix: "sys/history/", cursor: historyCursor });
        for (const object of history.objects) {
          const text = await (await testEnv().VAULT.get(object.key))!.text();
          expect(text.includes(runId), object.key).toBe(false);
          expect(text.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"), object.key).toBe(false);
        }
        historyCursor = history.truncated ? history.cursor : undefined;
      } while (historyCursor);
      const inbox = await testEnv().VAULT.get("vault/inbox/quarantine.md");
      if (inbox) {
        const text = await inbox.text();
        expect(text).not.toContain(runId);
        expect(text).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
        expect(text).not.toContain(secretPath);
      }
    } finally {
      testEnv().E2E_CLEANUP_ENABLED = "";
      testEnv().DEPLOY_ENV = "";
      testEnv().VAULT_BUCKET = "hiveattic-vault";
      testEnv().DB_NAME = "hiveattic-index";
      testEnv().WORKER_NAME = "hiveattic";
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
