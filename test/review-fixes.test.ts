import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { classificationText, frontmatterText } from "../src/classify";
import { hashToken } from "../src/crypto";
import worker from "../src/index";
import { ADMIN, deliverEvent, mint, nid, resetVault, rest, runJob, testEnv } from "./helpers";

let sharedWriter = "";
let dealsWriter = "";

beforeAll(async () => {
  sharedWriter = await mint("fix-shared", ["read:shared", "read:own", "write:own", "write:shared"], "fix-shared");
  dealsWriter = await mint("fix-deals", ["read:shared", "read:own", "write:own", "write:shared", "read:domain/deals", "write:domain/deals"], "fix-deals");
});

describe("review fixes after M1.1", () => {
  it("R4 each write call in an MCP batch counts against the write limit", async () => {
    await resetVault();
    const limited = { ...testEnv(), RATE_LIMIT_WRITES_PER_MIN: "2" } as unknown as Env;
    const agent = `fix-batch-${nid()}`;
    const token = await mint(agent, ["read:shared", "read:own", "write:own"], agent);
    const session = await mcpSession(limited, token);
    const calls = [1, 2, 3].map((i) => ({
      jsonrpc: "2.0",
      id: 10 + i,
      method: "tools/call",
      params: { name: "vault_append_journal", arguments: { title: `batch ${i}`, body: `batch body ${i}`, idempotency_key: `batch-${nid()}` } },
    }));
    expect((await call(limited, token, session, JSON.stringify(calls))).status).toBe(429);
    const written = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE agent_id = ?").bind(agent).first<{ n: number }>();
    expect(written?.n).toBe(0);
    // A rejected batch is still charged, like a rejected single call, so a batch within the limit
    // is checked on a fresh token.
    const fresh = await mint(`${agent}-b`, ["read:shared", "read:own", "write:own"], `${agent}-b`);
    expect((await call(limited, fresh, await mcpSession(limited, fresh), JSON.stringify(calls.slice(0, 2)))).status).toBe(200);
  });

  it("R5 a token minted for a reserved agent id before mint refused it is not accepted", async () => {
    await resetVault();
    const minted = await rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify({ agent_id: "shared", scopes: ["read:own"] }) });
    expect(minted.status).toBe(400);
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

  it("R6 an outside edit cannot keep health text out of the classifier with a marker-like comment or a server key name", async () => {
    await resetVault();
    const text = "My prescription refill is due Friday.";
    const cases = [
      { name: "comment", body: `# Note\n\n${text} <!-- hiveattic: x -->\n` },
      { name: "vault-key", body: `---\nvault_note: ${text}\n---\n# Note\n\nhello\n` },
      { name: "server-key", body: `---\nowner: ${text}\n---\n# Note\n\nhello\n` },
    ];
    for (const item of cases) {
      const path = `shared/outside-${item.name}-${nid()}.md`;
      await testEnv().VAULT.put(`vault/${path}`, item.body);
      expect((await deliverEvent("PutObject", `vault/${path}`)).retried).toBe(false);
      const moved = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(`sensitive/health/${path}`).first<{ status: string }>();
      expect(moved?.status, item.name).toBe("active");
      const left = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ? AND status = 'active'").bind(path).first();
      expect(left, item.name).toBeNull();
    }
  });

  it("R6 server markers and server frontmatter still stay out of classification", async () => {
    await resetVault();
    const marker = `<!-- hiveattic:idempotency=flu-shot-key h=${"a".repeat(64)} mac=${"b".repeat(16)} -->`;
    expect(classificationText(`# Day\n\nplain words\n${marker}\n`)).not.toContain("flu");
    expect(frontmatterText({ vault_id: "01JABCDEFGHJKMNPQRSTVWXYZ0", key: "flu-shot", owner: "fix-agent", observed_at: new Date().toISOString(), confidence: 0.7 })).toBe("");
    expect(frontmatterText({ key: "My flu shot is booked" })).toContain("flu shot");

    const journal = await rest("/v1/journal", sharedWriter, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "plain", body: "plain words", idempotency_key: "550e8400-e29b-41d4-a716-446655440000" }),
    });
    expect(journal.status).toBe(200);
    const path = String(journal.json.data?.path);
    await runJob("/v1/admin/reindex");
    const day = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(path).first<{ status: string }>();
    expect(day?.status).toBe("active");
  });
});

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
