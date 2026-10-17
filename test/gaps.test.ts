import { beforeAll, describe, expect, it } from "vitest";
import { REVIEWER_SCOPES } from "../src/access";
import { ADMIN, mcp, mint, nid, resetVault, rest, results, testEnv } from "./helpers";

// Test gaps the PR #3 review (A6) and the PR #5 review (P5-1) listed: the exact reviewer preset,
// MCP reviewer reads, 400 unclassified_domain on facts, journals, and forget, mixed-case domains,
// the summary as the reviewer sees it, and forget on tagged, ordinary, and unclassified notes.

let reviewer = "";
let sharedWriter = "";
let xWriter = "";

beforeAll(async () => {
  const minted = await rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify({ agent_id: "gap-reviewer", preset: "reviewer", label: "gap-reviewer" }) });
  reviewer = String(minted.json.data?.token);
  sharedWriter = await mint("gap-shared", ["read:shared", "read:own", "write:own", "write:shared"], "gap-shared");
  xWriter = await mint("gap-x", ["read:shared", "read:domain/x", "write:domain/x"], "gap-x");
});

// A note as an older build stored it: a row and an object at a path the API would now refuse or
// reroute, such as a finance-tagged shared note or a mixed-case domain folder.
async function seedLegacy(path: string, body: string, domain: string | null, sensitivity: "normal" | "sensitive"): Promise<string> {
  const id = `01GAP${nid().toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0").padEnd(21, "0").slice(0, 21)}`;
  const text = `---\nvault_id: ${id}\n---\n${body}\n`;
  const put = (await testEnv().VAULT.put(`vault/${path}`, text))!;
  const now = new Date().toISOString();
  await testEnv().DB.batch([
    testEnv().DB.prepare(
      `INSERT INTO notes (id, path, type, owner, domain, sensitivity, title, body, frontmatter, content_hash, r2_etag, r2_key, status, created_at, updated_at, last_writer)
       VALUES (?, ?, 'note', 'shared', ?, ?, ?, ?, '{}', 'x', ?, ?, 'active', ?, ?, 'test')`,
    ).bind(id, path, domain, sensitivity, path, text, put.etag, `vault/${path}`, now, now),
    testEnv().DB.prepare("INSERT INTO chunks (id, note_id, n, text, title, path, token_count) VALUES (?, ?, 0, ?, ?, ?, 10)").bind(`${id}:0`, id, body, path, path),
  ]);
  return id;
}

describe("PR #3 and PR #5 test gaps", () => {
  it("the reviewer preset is exactly read:shared, read:decisions, read:domain/*, read:inbox, and the minted token carries exactly that", async () => {
    expect(REVIEWER_SCOPES).toEqual(["read:shared", "read:decisions", "read:domain/*", "read:inbox"]);
    const who = await rest("/v1/whoami", reviewer);
    expect(who.json.data?.scopes).toEqual(["read:shared", "read:decisions", "read:domain/*", "read:inbox"]);
    const stored = await testEnv().DB.prepare("SELECT scopes_override FROM tokens WHERE label = 'gap-reviewer'").first<{ scopes_override: string }>();
    expect(JSON.parse(String(stored?.scopes_override))).toEqual(REVIEWER_SCOPES);
  });

  it("the reviewer gets the same denials over MCP as over REST", async () => {
    await resetVault();
    const marker = `qxgapmcp${nid()}`;
    const finance = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: `domains/finance/${marker}.md`, body: `${marker} budget`, type: "note" }) });
    const health = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: `domains/health/${marker}.md`, body: `${marker} checkup`, type: "note" }) });
    const deals = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: `domains/deals/${marker}.md`, body: `${marker} deal`, type: "note" }) });
    for (const note of [finance, health]) {
      const path = String(note.json.data?.path);
      expect((await mcp(reviewer, "vault_read", { path })).json.error?.code).toBe("not_found");
      expect((await mcp(reviewer, "vault_read", { id: note.json.data?.id })).json.error?.code).toBe("not_found");
      expect((await mcp(reviewer, "vault_history", { path })).json.error?.code).toBe("not_found");
    }
    const search = await mcp(reviewer, "vault_search", { q: marker });
    expect(((search.json.data?.results ?? []) as { path: string }[]).map((hit) => hit.path)).toEqual([String(deals.json.data?.path)]);
    const listed = JSON.stringify((await mcp(reviewer, "vault_list", { prefix: "domains/" })).json.data);
    expect(listed).toContain("domains/deals/");
    expect(listed).not.toContain("domains/finance/");
    expect(listed).not.toContain("domains/health/");
    expect((await mcp(reviewer, "vault_read", { path: String(deals.json.data?.path) })).json.ok).toBe(true);
    expect((await mcp(reviewer, "vault_write_note", { path: `shared/${marker}.md`, body: "x", type: "note" })).json.error?.code).toBe("forbidden_scope");
  });

  it("an unclassified domain is 400 unclassified_domain on facts, journals, notes, and forget, over REST and MCP", async () => {
    await resetVault();
    const fact = await rest("/v1/facts", sharedWriter, { method: "POST", body: JSON.stringify({ key: `gap-${nid()}`, statement: "x", observed_at: "2099-01-01T00:00:00Z", domain: "medical" }) });
    expect(fact.status).toBe(400);
    expect(fact.json.error?.code).toBe("unclassified_domain");
    const journal = await rest("/v1/journal", sharedWriter, { method: "POST", body: JSON.stringify({ target: "own", title: "t", body: "b", domain: "legal" }) });
    expect(journal.json.error?.code).toBe("unclassified_domain");
    const note = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: "domains/medical/x.md", body: "x", type: "note" }) });
    expect(note.json.error?.code).toBe("unclassified_domain");
    await seedLegacy("domains/medical/legacy.md", "old medical note", "medical", "normal");
    const forget = await rest("/v1/forget", sharedWriter, { method: "POST", body: JSON.stringify({ path: "domains/medical/legacy.md", reason: "x" }) });
    expect(forget.status).toBe(400);
    expect(forget.json.error?.code).toBe("unclassified_domain");
    for (const [tool, args] of [
      ["vault_write_fact", { key: `gap-${nid()}`, statement: "x", observed_at: "2099-01-01T00:00:00Z", domain: "medical" }],
      ["vault_append_journal", { target: "own", title: "t", body: "b", domain: "legal" }],
      ["vault_forget", { path: "domains/medical/legacy.md", reason: "x" }],
    ] as const) {
      expect((await mcp(sharedWriter, tool, args)).json.error?.code, tool).toBe("unclassified_domain");
    }
  });

  it("a mixed-case domain folder is unclassified: writes are 400 and a file placed there reads as sensitive", async () => {
    await resetVault();
    for (const path of ["domains/Finance/x.md", "domains/HEALTH/x.md"]) {
      const written = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path, body: "x", type: "note" }) });
      expect(written.status, path).toBe(400);
      expect(written.json.error?.code).toBe("unclassified_domain");
    }
    const marker = `qxmixed${nid()}`;
    await seedLegacy("domains/Finance/placed.md", `${marker} placed outside`, "Finance", "normal");
    expect((await rest("/v1/notes?path=domains/Finance/placed.md", reviewer)).status).toBe(404);
    expect(results((await rest(`/v1/search?q=${marker}`, reviewer)).json)).toEqual([]);
    expect((await rest("/v1/notes?path=domains/Finance/placed.md", ADMIN)).status).toBe(200);
  });

  it("the summary the reviewer reads holds no sensitive, rerouted, or tagged fact", async () => {
    await resetVault();
    const n = nid();
    await rest("/v1/facts", sharedWriter, { method: "POST", body: JSON.stringify({ key: `plain-${n}`, statement: `qxplain${n} likes maps`, observed_at: "2099-01-01T00:00:00Z", scope: "shared" }) });
    const health = await rest("/v1/facts", sharedWriter, { method: "POST", body: JSON.stringify({ key: `health-${n}`, statement: `qxhealth${n} synthetic flu shot`, observed_at: "2099-01-01T00:00:00Z", scope: "shared" }) });
    expect(health.status).toBe(201);
    const summary = await rest("/v1/notes?path=profile/summary.md", reviewer);
    expect(summary.status).toBe(200);
    expect(summary.json.data?.markdown).toContain(`qxplain${n}`);
    expect(summary.json.data?.markdown).not.toContain(`qxhealth${n}`);
  });

  it("P5-1 forget: a finance-tagged shared note, an ordinary domain note, and an unclassified note each need the right scope", async () => {
    await resetVault();
    const tagged = await seedLegacy(`shared/tagged-${nid()}.md`, "old finance note", "finance", "sensitive");
    for (const args of [{ id: tagged }]) {
      expect((await rest("/v1/forget", sharedWriter, { method: "POST", body: JSON.stringify({ ...args, reason: "x" }) })).status).toBe(403);
      expect((await mcp(sharedWriter, "vault_forget", { ...args, reason: "x" })).json.error?.code).toBe("forbidden_scope");
    }
    expect((await testEnv().DB.prepare("SELECT status FROM notes WHERE id = ?").bind(tagged).first<{ status: string }>())?.status).toBe("active");
    // A write:domain/x caller cannot forget a domains/deals note, by path or by id.
    const deals = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: `domains/deals/d-${nid()}.md`, body: "deal", type: "note" }) });
    expect((await rest("/v1/forget", xWriter, { method: "POST", body: JSON.stringify({ path: deals.json.data?.path, reason: "x" }) })).status).toBe(403);
    expect((await rest("/v1/forget", xWriter, { method: "POST", body: JSON.stringify({ id: deals.json.data?.id, reason: "x" }) })).status).toBe(403);
    // It can forget its own domain's notes.
    const own = await rest("/v1/notes", xWriter, { method: "PUT", body: JSON.stringify({ path: `domains/x/o-${nid()}.md`, body: "x note", type: "note" }) });
    expect((await rest("/v1/forget", xWriter, { method: "POST", body: JSON.stringify({ id: own.json.data?.id, reason: "x" }) })).status).toBe(200);
    // An unclassified note found by id needs a scope no one can hold: 403, and it stays active.
    const odd = await seedLegacy(`domains/legal/l-${nid()}.md`, "old legal note", "legal", "normal");
    expect((await rest("/v1/forget", sharedWriter, { method: "POST", body: JSON.stringify({ id: odd, reason: "x" }) })).status).toBe(403);
    expect((await testEnv().DB.prepare("SELECT status FROM notes WHERE id = ?").bind(odd).first<{ status: string }>())?.status).toBe("active");
  });
});
