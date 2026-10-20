import { describe, expect, it } from "vitest";
import { ADMIN, mcp, nid, rest, testEnv } from "./helpers";

// The console's Edit access button changes a live token's scopes in place. The agent keeps the
// same token string.

async function setScopes(tokenId: string, scopes: string[], as = ADMIN) {
  return rest("/v1/admin/tokens/scopes", as, { method: "POST", body: JSON.stringify({ token_id: tokenId, scopes }) });
}

async function minted(agentId: string, scopes: string[]) {
  const response = await rest("/v1/admin/tokens", ADMIN, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, display_name: agentId, kind: "agent", scopes, label: "scopes test" }),
  });
  return { token: String(response.json.data?.token), id: String(response.json.data?.token_id) };
}

describe("edit a token's scopes", () => {
  it("adds and removes access for the same token and audits it", async () => {
    const agentId = `scopes-${nid()}`;
    const { token, id } = await minted(agentId, ["read:own", "write:own"]);
    const path = `shared/scopes-${nid()}.md`;
    expect((await mcp(token, "vault_write_note", { path, body: "x" })).json.error?.code).toBe("forbidden_scope");

    const changed = await setScopes(id, ["read:own", "write:own", "read:shared", "write:shared", "write:shared"]);
    expect(changed.status, changed.text).toBe(200);
    expect(changed.json.data?.scopes).toEqual(["read:own", "write:own", "read:shared", "write:shared"]);
    expect((await mcp(token, "vault_write_note", { path, body: "x" })).json.ok).toBe(true);

    expect((await setScopes(id, ["read:own"])).status).toBe(200);
    expect((await mcp(token, "vault_write_note", { path: `bots/${agentId}/x.md`, body: "x" })).json.error?.code).toBe("forbidden_scope");

    const audit = await testEnv().DB.prepare("SELECT action, note_id FROM audit_log WHERE action = 'token_scopes' ORDER BY seq DESC LIMIT 1").first<{ action: string; note_id: string }>();
    expect(audit?.note_id).toBe(id);
  });

  it("refuses bad input, revoked tokens, and agent tokens", async () => {
    const { token, id } = await minted(`scopes-${nid()}`, ["read:own"]);
    expect((await setScopes(id, ["admin"])).json.error?.code).toBe("invalid");
    expect((await setScopes(id, ["read:sensitive/restricted"])).json.error?.code).toBe("invalid");
    expect((await setScopes(id, [])).status).toBe(400);
    expect((await setScopes(id, ["read:all"], token)).status).toBe(403);
    expect((await setScopes("01NOTATOKEN0000000000000000", ["read:own"])).status).toBe(404);
    expect((await rest("/v1/admin/tokens/revoke", ADMIN, { method: "POST", body: JSON.stringify({ token_id: id }) })).status).toBe(200);
    expect((await setScopes(id, ["read:all"])).status).toBe(404);
  });

  it("shows the new scopes in the agent list", async () => {
    const agentId = `scopes-${nid()}`;
    const { id } = await minted(agentId, ["read:own"]);
    await setScopes(id, ["read:own", "read:inbox"]);
    const agents = await rest("/v1/admin/agents", ADMIN);
    const agent = (agents.json.data?.agents as { id: string; tokens: { id: string; scopes: string[] }[] }[]).find((a) => a.id === agentId);
    expect(agent?.tokens.find((t) => t.id === id)?.scopes).toEqual(["read:own", "read:inbox"]);
  });
});
