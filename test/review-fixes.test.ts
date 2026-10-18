import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/crypto";
import { inspectWrite } from "../src/filters";
import { textForFilter } from "../src/markdown";
import worker from "../src/index";
import { ADMIN, mcp, mint, nid, resetVault, rest, testEnv } from "./helpers";

let sharedWriter = "";
let dealsWriter = "";
let reader = "";
let finance = "";
let financeWriteOnly = "";

beforeAll(async () => {
  sharedWriter = await mint("fix-shared", ["read:shared", "read:own", "write:own", "write:shared"], "fix-shared");
  dealsWriter = await mint(
    "fix-deals",
    ["read:shared", "read:own", "write:own", "write:shared", "write:decisions", "read:decisions", "read:domain/deals", "write:domain/deals"],
    "fix-deals",
  );
  reader = await mint("fix-reader", ["read:shared", "read:own", "write:own", "read:decisions"], "fix-reader");
  finance = await mint(
    "fix-finance",
    ["read:shared", "read:own", "write:own", "write:shared", "read:domain/finance", "write:domain/finance", "read:sensitive/finance", "write:sensitive/finance"],
    "fix-finance",
  );
  financeWriteOnly = await mint("fix-finance-wo", ["read:own", "write:own", "write:sensitive/finance"], "fix-finance-wo");
});

describe("review fixes", () => {
  it("R1 forgetting or deleting a shared fact removes it from the summary and from search", async () => {
    await resetVault();
    const forgotten = `qxsumforget${nid()}`;
    const deleted = `qxsumdelete${nid()}`;
    const kept = `qxsumkeep${nid()}`;
    const first = await fact(sharedWriter, `a-${nid()}`, `Likes ${forgotten}`);
    const second = await fact(sharedWriter, `b-${nid()}`, `Likes ${deleted}`);
    await fact(sharedWriter, `c-${nid()}`, `Likes ${kept}`);
    expect(await summaryText()).toContain(forgotten);

    expect((await rest("/v1/forget", sharedWriter, { method: "POST", body: JSON.stringify({ path: first, reason: "privacy" }) })).status).toBe(200);
    expect(await summaryText()).not.toContain(forgotten);
    expect(paths(await rest(`/v1/search?q=${forgotten}`, reader))).toEqual([]);

    await testEnv().VAULT.delete(`vault/${second}`);
    await deliver({ action: "DeleteObject", key: `vault/${second}` });
    expect(await summaryText()).not.toContain(deleted);
    expect(paths(await rest(`/v1/search?q=${deleted}`, reader))).toEqual([]);
    expect(await summaryText()).toContain(kept);
  });

  it("R2 a domain-tagged shared fact stays out of the summary", async () => {
    await resetVault();
    const marker = `qxsumdeal${nid()}`;
    const path = await fact(dealsWriter, `d-${nid()}`, `Deal ${marker}`, "deals");
    expect((await rest(`/v1/notes?path=${path}`, reader)).status).toBe(404);
    expect((await rest(`/v1/notes?path=${path}`, dealsWriter)).status).toBe(200);
    expect(await summaryText()).not.toContain(marker);
    expect(paths(await rest(`/v1/search?q=${marker}`, reader))).toEqual([]);
  });

  it("R3 a domain-tagged entry does not retag the shared day file or decisions", async () => {
    await resetVault();
    for (const target of ["shared", "decisions"] as const) {
      const plain = await rest("/v1/journal", target === "shared" ? sharedWriter : dealsWriter, {
        method: "POST",
        body: JSON.stringify({ target, title: "plain", body: `plain ${nid()}` }),
      });
      expect(plain.status).toBe(200);
      const path = String(plain.json.data?.path);
      const tagged = await rest("/v1/journal", dealsWriter, { method: "POST", body: JSON.stringify({ target, title: "deal", body: `deal ${nid()}`, domain: "deals" }) });
      expect(tagged.status).toBe(200);
      expect(tagged.json.data?.path).toBe(path);
      expect((await rest(`/v1/notes?path=${path}`, reader)).status).toBe(200);
      const row = await testEnv().DB.prepare("SELECT domain FROM notes WHERE path = ?").bind(path).first<{ domain: string | null }>();
      expect(row?.domain).toBeNull();
    }
  });

  it("R4 each write call in an MCP batch counts against the rate limit, and the body is capped", async () => {
    await resetVault();
    const limited = { ...testEnv(), RATE_LIMIT_WRITES_PER_MIN: "2" } as unknown as Env;
    const token = await mint(`fix-batch-${nid()}`, ["read:shared", "read:own", "write:own"], "fix-batch");
    const session = await mcpSession(limited, token);
    const calls = [1, 2, 3].map((i) => ({
      jsonrpc: "2.0",
      id: 10 + i,
      method: "tools/call",
      params: { name: "vault_append_journal", arguments: { title: `batch ${i}`, body: `batch body ${i}` } },
    }));
    const batch = await call(limited, token, session, JSON.stringify(calls));
    expect(batch.status).toBe(429);
    const agent = token.split("_")[1];
    const written = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE agent_id = ?").bind(agent).first<{ n: number }>();
    expect(written?.n).toBe(0);

    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_whoami", arguments: { pad: "x".repeat(300_000) } } });
    expect((await call(testEnv(), token, session, big)).status).toBe(400);
  });

  it("R5 reserved agent ids cannot be minted, and an existing token for one is refused", async () => {
    await resetVault();
    for (const id of ["shared", "owner", "external"]) {
      const minted = await rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify({ agent_id: id, scopes: ["read:own"] }) });
      expect(minted.status).toBe(400);
    }
    const token = `vlt_shared_${nid()}${nid()}`;
    const now = new Date().toISOString();
    await testEnv().DB.batch([
      testEnv().DB.prepare("INSERT OR IGNORE INTO agents (id, display_name, kind, scopes, created_at) VALUES ('shared', 'shared', 'agent', '[\"read:own\"]', ?)").bind(now),
      testEnv().DB.prepare("INSERT INTO tokens (id, agent_id, token_hash, created_at) VALUES (?, 'shared', ?, ?)").bind(nid(), await hashToken(testEnv().TOKEN_PEPPER, token), now),
    ]);
    const note = await rest("/v1/notes", dealsWriter, { method: "PUT", body: JSON.stringify({ path: `domains/deals/n-${nid()}.md`, body: `deal ${nid()}` }) });
    expect(note.status).toBe(200);
    expect((await rest(`/v1/notes?path=${note.json.data?.path}`, token)).status).toBe(401);
  });

  it("R6 an outside edit cannot hide a secret in a hiveattic comment, a vault_ key, or a generated note", async () => {
    await resetVault();
    const secret = `AKIA${"QWERTYUIOPASDFGH"}`;
    const cases = [
      { path: `shared/comment-${nid()}.md`, text: `# Note\n\nhello <!-- hiveattic: ${secret} -->\n` },
      { path: `shared/frontmatter-${nid()}.md`, text: `---\nvault_note: ${secret}\n---\n# Note\n\nhello\n` },
      { path: "profile/summary.md", text: `# Profile\n\n${secret}\n` },
    ];
    for (const item of cases) {
      await testEnv().VAULT.put(`vault/${item.path}`, item.text);
      await deliver({ action: "PutObject", key: `vault/${item.path}` });
      const row = await testEnv().DB.prepare("SELECT status, body FROM notes WHERE path = ?").bind(item.path).first<{ status: string; body: string }>();
      expect(row?.status, item.path).toBe("quarantined");
      expect(row?.body).not.toContain(secret);
    }
    const journal = await rest("/v1/journal", sharedWriter, { method: "POST", body: JSON.stringify({ target: "shared", title: "marker", body: "plain", idempotency_key: "550e8400-e29b-41d4-a716-446655440000" }) });
    expect(journal.status).toBe(200);
    expect((await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" })).status).toBe(200);
    const day = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(String(journal.json.data?.path)).first<{ status: string }>();
    expect(day?.status).toBe("active");
  });

  it("R7 a write is authorized against the note it replaces, not only the new classification", async () => {
    await resetVault();
    const path = `shared/budget-${nid()}.md`;
    const created = await rest("/v1/notes", finance, { method: "PUT", body: JSON.stringify({ path, body: "budget notes", domain: "finance" }) });
    expect(created.status).toBe(200);
    const overwrite = await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path, body: "replaced", if_match: created.json.data?.etag }) });
    expect(overwrite.status).toBe(403);

    const key = `bank-${nid()}`;
    const factPath = await fact(finance, key, "Bank is in the finance domain", "finance");
    const replaced = await rest("/v1/facts", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ key, statement: "replaced", scope: "shared", observed_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    expect(replaced.status).toBe(403);
    const row = await testEnv().DB.prepare("SELECT domain FROM notes WHERE path = ?").bind(factPath).first<{ domain: string | null }>();
    expect(row?.domain).toBe("finance");
  });

  it("R8 vault_list over MCP pages with a cursor", async () => {
    await resetVault();
    const now = new Date().toISOString();
    const run = nid();
    const statements = Array.from({ length: 105 }, (_, i) => {
      const path = `shared/page-${run}/n-${String(i).padStart(3, "0")}.md`;
      return testEnv().DB.prepare(
        `INSERT INTO notes (id, path, type, owner, sensitivity, title, body, frontmatter, content_hash, r2_key, status, created_at, updated_at, last_writer)
         VALUES (?, ?, 'note', 'shared', 'normal', 'n', 'n', '{}', 'h', ?, 'active', ?, ?, 'test')`,
      ).bind(`${run}${i}`, path, `vault/${path}`, now, now);
    });
    await testEnv().DB.batch(statements);
    const first = await mcp(reader, "vault_list", { prefix: `shared/page-${run}/` });
    expect((first.json.data?.notes as unknown[]).length).toBe(100);
    const cursor = first.json.data?.cursor;
    expect(typeof cursor).toBe("string");
    const second = await mcp(reader, "vault_list", { prefix: `shared/page-${run}/`, cursor });
    expect((second.json.data?.notes as unknown[]).length).toBe(5);
    expect(second.json.data?.cursor).toBeNull();
  });

  it("R9 search returns one result per note, so a long note does not use up the limit", async () => {
    await resetVault();
    const marker = `qxlong${nid()}`;
    // Short, dense sections rank above the two notes that mention the marker once among filler, so a
    // chunk-level limit would fill every slot with the long note.
    const sections = Array.from({ length: 6 }, (_, i) => `## Part ${i}\n\n${`${marker} `.repeat(5)}`).join("\n\n");
    const filler = "filler text ".repeat(100);
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: `shared/long-${nid()}.md`, body: sections }) });
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: `shared/short-a-${nid()}.md`, body: `${marker} ${filler}` }) });
    await rest("/v1/notes", sharedWriter, { method: "PUT", body: JSON.stringify({ path: `shared/short-b-${nid()}.md`, body: `${marker} ${filler}` }) });
    const found = paths(await rest(`/v1/search?q=${marker}&limit=3`, reader));
    expect(found.length).toBe(3);
    expect(new Set(found).size).toBe(3);
  });

  it("R10 own-folder reads need the sensitive scope, except the own journal-sensitive file", async () => {
    await resetVault();
    const path = "bots/fix-finance-wo/budget.md";
    expect((await rest("/v1/notes", financeWriteOnly, { method: "PUT", body: JSON.stringify({ path, body: "private budget", domain: "finance" }) })).status).toBe(200);
    expect((await rest(`/v1/notes?path=${path}`, financeWriteOnly)).status).toBe(404);
    expect(paths(await rest("/v1/list?prefix=bots/fix-finance-wo/", financeWriteOnly))).toEqual([]);
    const pii = await rest("/v1/journal", financeWriteOnly, { method: "POST", body: JSON.stringify({ title: "call", body: "Called 555-123-4567 today" }) });
    expect(pii.status).toBe(200);
    expect(String(pii.json.data?.path)).toContain("/journal-sensitive/");
    expect((await rest(`/v1/notes?path=${pii.json.data?.path}`, financeWriteOnly)).status).toBe(200);
  });

  it("R12 a quarantine alert hash that looks like a card number does not quarantine the alert file", () => {
    const hash = `4111111111111111${"a".repeat(48)}`;
    const line = `A vault file was excluded from search (secret_aws). Hash ${hash}.`;
    const file = `---\nvault_id: 01JABCDEFGHJKMNPQRSTVWXYZ0\ntype: note\n---\n# Quarantine\n\n## 2026-10-18T00:00:00.000Z · quarantine\n${line}\n`;
    expect(inspectWrite(line, [])?.code).toBe("rejected_financial");
    expect(inspectWrite(textForFilter(file), [])).toBeNull();
    expect(inspectWrite(textForFilter(`${file}\nCard 4111 1111 1111 1111\n`), [])?.code).toBe("rejected_financial");
  });

  it("R11 a non-numeric limit falls back to the default", async () => {
    await resetVault();
    expect((await rest("/v1/search?q=anything&limit=abc", reader)).status).toBe(200);
    expect((await rest("/v1/admin/audit?limit=abc", ADMIN)).status).toBe(200);
  });
});

async function fact(token: string, key: string, statement: string, domain?: string): Promise<string> {
  const written = await rest("/v1/facts", token, {
    method: "POST",
    body: JSON.stringify({ key, statement, scope: "shared", domain, observed_at: new Date().toISOString() }),
  });
  expect(written.status).toBe(200);
  return String(written.json.data?.path);
}

async function summaryText(): Promise<string> {
  const summary = await rest("/v1/notes?path=profile/summary.md", reader);
  return String(summary.json.data?.markdown ?? "");
}

function paths(response: { json: { data?: Record<string, unknown> } }): string[] {
  const data = response.json.data;
  const rows = (Array.isArray(data?.results) ? data.results : Array.isArray(data?.notes) ? data.notes : []) as { path: string }[];
  return rows.map((row) => row.path);
}

async function deliver(event: { action: string; key: string }): Promise<void> {
  const batch = createMessageBatch("hiveattic-index-jobs", [
    {
      id: nid(),
      timestamp: new Date(),
      attempts: 1,
      body: { account: "test", action: event.action, bucket: "hiveattic-vault", object: { key: event.key, size: 1, eTag: "event-etag" }, eventTime: new Date().toISOString() },
    },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, testEnv(), ctx);
  const result = await getQueueResult(batch, ctx);
  expect(result.retryMessages).toEqual([]);
}

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function mcpSession(env: Env, token: string): Promise<string | null> {
  const init = await call(
    env,
    token,
    null,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fix", version: "0" } } }),
  );
  const session = init.headers.get("mcp-session-id");
  await call(env, token, session, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return session;
}

async function call(env: Env, token: string, session: string | null, body: string): Promise<{ status: number; headers: Headers }> {
  const headers: Record<string, string> = { ...MCP_HEADERS, authorization: `Bearer ${token}` };
  if (session) headers["mcp-session-id"] = session;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://hiveattic.test/mcp", { method: "POST", headers, body }), env, ctx);
  await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers };
}
