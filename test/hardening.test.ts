import { beforeAll, describe, expect, it } from "vitest";
import { clearAuthCache } from "../src/auth";
import { hashToken } from "../src/crypto";
import { etStamp } from "../src/time";
import { ADMIN, deliverEvent, mint, nid, resetVault, rest, results, runJob, testEnv, versionsOf } from "./helpers";

// T-19 and the folded-in review fixes: identity, scope grammar, forget on protected paths, tags,
// vault_id write-back, outside deletes, exact purge, the vault time zone, and domain classes.

let writer = "";
let reader = "";

beforeAll(async () => {
  writer = await mint("hard-writer", ["read:shared", "read:own", "write:own", "write:shared", "write:decisions", "write:inbox"], "hard-writer");
  reader = await mint("hard-reader", ["read:shared"], "hard-reader");
});

const mintRaw = (body: Record<string, unknown>) => rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify(body) });

describe("identity and scope grammar", () => {
  it("reserved agent ids cannot be minted", async () => {
    for (const id of ["admin", "operator", "system", "sys", "owner", "shared", "external", "replay", "rebuild", "reconcile", "indexer", "migration"]) {
      const minted = await mintRaw({ agent_id: id, scopes: ["read:shared"], label: id });
      expect(minted.status, id).toBe(400);
      expect(minted.json.error?.reasons).toContain("agent_id");
    }
    expect((await mintRaw({ agent_id: `ok-${nid()}`, scopes: ["read:shared"], label: "ok" })).status).toBe(200);
  });

  it("scope grammar is checked, a raw admin scope is refused, and a stored admin scope does not make a token admin", async () => {
    for (const scope of ["admin", "read:everything", "read:domain/Finance", "write:prefix:../x", "read:prefix:sys/", "read:sensitive/restricted", "read:bots/"]) {
      expect((await mintRaw({ agent_id: `bad-${nid()}`, scopes: [scope], label: "bad" })).status, scope).toBe(400);
    }
    for (const scope of ["read:domain/*", "read:sensitive/pii", "read:bots/*", "read:prefix:shared/", "audit:read", "read:sensitive:summary/health"]) {
      expect((await mintRaw({ agent_id: `good-${nid()}`, scopes: [scope], label: "good" })).status, scope).toBe(200);
    }
    // A token row written before this check, holding a raw "admin" scope, is not the admin.
    const db = testEnv().DB;
    const agent = `legacy-${nid()}`;
    const token = `vlt_${agent}_legacytokenvalue`;
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO agents (id, display_name, kind, scopes, created_at) VALUES (?, ?, 'agent', ?, ?)").bind(agent, agent, JSON.stringify(["admin", "read:shared"]), now).run();
    await db.prepare("INSERT INTO tokens (id, agent_id, token_hash, scopes_override, label, created_at) VALUES (?, ?, ?, NULL, 'legacy', ?)")
      .bind(`tok-${nid()}`, agent, await hashToken(testEnv().TOKEN_PEPPER, token), now)
      .run();
    clearAuthCache();
    const who = await rest("/v1/whoami", token);
    expect(who.json.data?.admin).toBe(false);
    expect((await rest("/v1/admin/audit", token)).status).toBe(403);
    expect((await rest("/v1/admin/reindex", token, { method: "POST", body: "{}" })).status).toBe(403);
  });

  it("wildcards stay inside their class: read:domain/* never reaches a sensitive or unclassified domain, read:sensitive/* never reaches restricted", async () => {
    await resetVault();
    const domainsAll = await mint(`dom-${nid()}`, ["read:domain/*"], "dom");
    const sensitiveAll = await mint(`sen-${nid()}`, ["read:sensitive/*"], "sen");
    expect((await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: "domains/finance/w.md", body: "ledger", type: "note" }) })).status).toBe(200);
    expect((await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: "domains/deals/w.md", body: "deal", type: "note" }) })).status).toBe(200);
    await testEnv().VAULT.put("vault/domains/medical/w.md", "placed outside qxmedical\n");
    await deliverEvent("PutObject", "vault/domains/medical/w.md");
    const restricted = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: `shared/r-${nid()}.md`, body: "Call 206-555-0142", type: "note" }) });
    const health = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: `shared/h-${nid()}.md`, body: "Flu shot", type: "note" }) });
    expect((await rest("/v1/notes?path=domains/deals/w.md", domainsAll)).status).toBe(200);
    expect((await rest("/v1/notes?path=domains/finance/w.md", domainsAll)).status).toBe(404);
    expect((await rest("/v1/notes?path=domains/medical/w.md", domainsAll)).status).toBe(404);
    expect((await rest("/v1/notes?path=domains/medical/w.md", sensitiveAll)).status).toBe(404);
    expect(results((await rest("/v1/search?q=qxmedical", reader)).json)).toEqual([]);
    // A domains/<d>/ folder still needs read:domain/<d> as well. sensitive/<d>/ needs only read:sensitive/<d>.
    expect((await rest("/v1/notes?path=domains/finance/w.md", sensitiveAll)).status).toBe(404);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(String(health.json.data?.path))}`, sensitiveAll)).status).toBe(200);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(String(restricted.json.data?.path))}`, sensitiveAll)).status).toBe(404);
    const unclassified = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: "domains/legal/x.md", body: "x", type: "note" }) });
    expect(unclassified.status).toBe(400);
    expect(unclassified.json.error?.code).toBe("unclassified_domain");
  });

  it("a domain listed as both sensitive and ordinary fails closed", async () => {
    const env = testEnv();
    const saved = env.ORDINARY_DOMAINS;
    env.ORDINARY_DOMAINS = "deals,x,health";
    try {
      const response = await rest("/v1/whoami", reader);
      expect(response.status).toBe(500);
      expect(response.json.error?.code).toBe("misconfigured");
    } finally {
      env.ORDINARY_DOMAINS = saved;
    }
    expect((await rest("/v1/whoami", reader)).status).toBe(200);
  });
});

describe("forget, tags, and outside edits", () => {
  it("only the admin token can forget append-only and server-managed files, and appends keep working", async () => {
    await resetVault();
    const day = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "day", body: "entry one", at: "2099-08-08T12:00:00Z" }) });
    const own = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "own", title: "own", body: "own entry", at: "2099-08-08T12:00:00Z" }) });
    await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "decisions", title: "keep", body: "decided", at: "2099-08-08T12:00:00Z" }) });
    await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ key: `k-${nid()}`, statement: "Likes tea", observed_at: "2099-01-01T00:00:00Z", scope: "shared" }) });
    await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: "inbox/proposal.md", body: "proposal", type: "note" }) });
    const protectedPaths = [String(day.json.data?.path), String(own.json.data?.path), "shared/decisions.md", "profile/summary.md", "inbox/proposal.md", "AGENTS.md"];
    for (const path of protectedPaths) {
      const refused = await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ path, reason: "try" }) });
      expect(refused.status, path).toBe(400);
      expect(refused.json.error?.code).toBe("forget_protected_path");
    }
    const dayId = (await rest(`/v1/notes?path=${day.json.data?.path}`, writer)).json.data?.id;
    const byId = await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ id: dayId, reason: "try" }) });
    expect(byId.json.error?.code).toBe("forget_protected_path");
    const later = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "day", body: "entry two", at: "2099-08-08T13:00:00Z" }) });
    expect(later.status).toBe(200);
    expect(String((await rest(`/v1/notes?path=${day.json.data?.path}`, writer)).json.data?.markdown)).toContain("entry two");
    const admin = await rest("/v1/forget", ADMIN, { method: "POST", body: JSON.stringify({ path: String(day.json.data?.path), reason: "admin" }) });
    expect(admin.status).toBe(200);
  });

  it("tags with a newline, a middle dot, or a caret are refused on journals and facts", async () => {
    for (const tag of ["a\n## forged", "a · b", "x^01ABCDEFGHJKMNPQRSTVWXYZ0", "a\rb"]) {
      const journal = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "own", title: "t", body: "b", tags: [tag] }) });
      expect(journal.status, JSON.stringify(tag)).toBe(400);
      const fact = await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ key: `t-${nid()}`, statement: "s", observed_at: "2099-01-01T00:00:00Z", tags: [tag] }) });
      expect(fact.status, JSON.stringify(tag)).toBe(400);
    }
    expect((await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "own", title: "t", body: "b", tags: ["fine tag", "émoji 🙂"] }) })).status).toBe(200);
  });

  it("an outside put or copy writes vault_id into the file, so a rebuild after D1 loses the row keeps the same id", async () => {
    await resetVault();
    const path = `shared/outside-${nid()}.md`;
    await testEnv().VAULT.put(`vault/${path}`, "# Outside\n\nCreated in Obsidian qxoutsideid\n");
    await deliverEvent("PutObject", `vault/${path}`);
    const row = await testEnv().DB.prepare("SELECT id, r2_etag FROM notes WHERE path = ?").bind(path).first<{ id: string; r2_etag: string }>();
    const stored = await testEnv().VAULT.get(`vault/${path}`);
    expect(await stored!.text()).toContain(`vault_id: ${row!.id}`);
    expect(stored!.customMetadata?.["vault-id"]).toBe(row!.id);
    expect(row!.r2_etag).toBe(stored!.etag);
    // The bucket's event for that write-back is skipped as unchanged.
    const versions = (await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").bind(row!.id).first<{ n: number }>())?.n;
    await deliverEvent("PutObject", `vault/${path}`);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").bind(row!.id).first<{ n: number }>())?.n).toBe(versions);
    const copy = `shared/copied-${nid()}.md`;
    const bytes = await (await testEnv().VAULT.get(`vault/${path}`))!.text();
    await testEnv().VAULT.put(`vault/${copy}`, bytes.replace(/vault_id: .+\n/, ""));
    await deliverEvent("CopyObject", `vault/${copy}`, { copySource: { bucket: "hiveattic-vault", object: `vault/${path}` } });
    const copyRow = await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(copy).first<{ id: string }>();
    expect(copyRow!.id).not.toBe(row!.id);
    expect(await (await testEnv().VAULT.get(`vault/${copy}`))!.text()).toContain(`vault_id: ${copyRow!.id}`);
    const db = testEnv().DB;
    for (const id of [row!.id, copyRow!.id]) {
      await db.batch([
        db.prepare("DELETE FROM chunks WHERE note_id = ?").bind(id),
        db.prepare("DELETE FROM note_versions WHERE note_id = ?").bind(id),
        db.prepare("DELETE FROM notes WHERE id = ?").bind(id),
      ]);
    }
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    expect((await db.prepare("SELECT id FROM notes WHERE path = ?").bind(path).first<{ id: string }>())?.id).toBe(row!.id);
    expect((await db.prepare("SELECT id FROM notes WHERE path = ?").bind(copy).first<{ id: string }>())?.id).toBe(copyRow!.id);
  });

  it("an outside delete or a missing object forgets the note and readers get a stub without the body", async () => {
    await resetVault();
    const marker = `qxdeleted${nid()}`;
    const path = `shared/del-${nid()}.md`;
    const created = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body: `Body ${marker}`, type: "note" }) });
    await testEnv().VAULT.delete(`vault/${path}`);
    await deliverEvent("DeleteObject", `vault/${path}`);
    for (const query of [`path=${encodeURIComponent(path)}`, `id=${created.json.data?.id}`]) {
      const read = await rest(`/v1/notes?${query}`, writer);
      expect(read.json.data?.status).toBe("forgotten");
      expect(read.text).not.toContain(marker);
    }
    expect((await rest(`/v1/history?path=${encodeURIComponent(path)}`, reader)).text).not.toContain(marker);
    expect(JSON.stringify(versionsOf((await rest(`/v1/history?path=${encodeURIComponent(path)}`, ADMIN)).json))).toContain(marker);
    expect(await testEnv().VAULT.head(`vault/${path}`)).toBeNull();
  });

  it("purging shared/a.md never touches bots/x/shared/a.md", async () => {
    await resetVault();
    const name = `a-${nid()}.md`;
    const shared = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: `shared/${name}`, body: "shared qxpurgea", type: "note" }) });
    const nested = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: `bots/x-${nid()}/shared/${name}`, body: "nested qxpurgeb", type: "note" }) });
    await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: String(nested.json.data?.path), body: "nested qxpurgeb two", type: "note", if_match: nested.json.data?.etag }) });
    const purged = await rest("/v1/admin/purge", ADMIN, { method: "DELETE", body: JSON.stringify({ path: `shared/${name}` }) });
    expect(purged.json.data?.purged).toBe(true);
    expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE id = ?").bind(shared.json.data?.id).first()).toBeNull();
    expect((await rest(`/v1/notes?path=${encodeURIComponent(String(nested.json.data?.path))}`, ADMIN)).json.data?.status).toBe("active");
    expect((await testEnv().VAULT.list({ prefix: `sys/history/${nested.json.data?.id}/` })).objects.length).toBeGreaterThan(0);
    expect(results((await rest("/v1/search?q=qxpurgeb", ADMIN)).json).length).toBe(1);
  });
});

describe("VAULT_TZ", () => {
  it("defaults to UTC and files entries by the configured zone across daylight saving changes", async () => {
    expect(etStamp("2099-06-01T03:59:59Z").date).toBe("2099-06-01");
    expect(etStamp("2099-06-01T03:59:59Z").heading).toBe("03:59 UTC");
    const ny = "America/New_York";
    const cases: [string, string][] = [
      ["2099-06-01T03:59:59Z", "2099-05-31"],
      ["2099-06-01T04:00:00Z", "2099-06-01"],
      ["2099-12-01T04:59:59Z", "2099-11-30"],
      ["2099-12-01T05:00:00Z", "2099-12-01"],
      ["2099-03-08T04:59:59Z", "2099-03-07"],
      ["2099-03-08T05:00:00Z", "2099-03-08"],
      ["2099-11-01T03:59:59Z", "2099-10-31"],
      ["2099-11-01T04:00:00Z", "2099-11-01"],
    ];
    for (const [at, date] of cases) expect(etStamp(at, ny).date, at).toBe(date);
    expect(etStamp("2099-06-01T16:00:00Z", ny).heading).toBe("12:00 EDT");
    expect(etStamp("2099-12-01T17:00:00Z", ny).heading).toBe("12:00 EST");
    await resetVault();
    const env = testEnv();
    env.VAULT_TZ = ny;
    try {
      const late = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "late", body: "late night", at: "2099-06-01T03:59:59Z" }) });
      expect(late.json.data?.path).toBe("journal/2099/05/2099-05-31.md");
      expect(String((await rest(`/v1/notes?path=${late.json.data?.path}`, writer)).json.data?.markdown)).toContain("## 23:59 EDT · hard-writer · late");
      const early = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "early", body: "early", at: "2099-06-01T04:00:00Z" }) });
      expect(early.json.data?.path).toBe("journal/2099/06/2099-06-01.md");
      expect((await rest("/v1/whoami", writer)).json.data?.vault_tz).toBe(ny);
      // TZ_DISPLAY is read when VAULT_TZ is unset, for one release.
      env.VAULT_TZ = "";
      env.TZ_DISPLAY = ny;
      const alias = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "alias", body: "alias", at: "2099-12-01T04:59:59Z" }) });
      expect(alias.json.data?.path).toBe("journal/2099/11/2099-11-30.md");
      env.TZ_DISPLAY = undefined;
      env.VAULT_TZ = "Mars/Olympus";
      const bad = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "bad", body: "bad", at: "2099-12-01T04:59:59Z" }) });
      expect(bad.status).toBe(500);
      expect(bad.json.error?.code).toBe("misconfigured");
    } finally {
      env.VAULT_TZ = "UTC";
      env.TZ_DISPLAY = undefined;
    }
  });
});

describe("reads, lists, and routes", () => {
  it("profile/summary.md lists only untagged normal facts", async () => {
    await resetVault();
    await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ key: `plain-${nid()}`, statement: "Plain qxsummaryplain", observed_at: "2099-01-01T00:00:00Z", scope: "shared" }) });
    const deals = await mint(`deals-${nid()}`, ["read:shared", "write:shared", "read:domain/deals", "write:domain/deals"], "deals");
    expect((await rest("/v1/facts", deals, { method: "POST", body: JSON.stringify({ key: `deal-${nid()}`, statement: "Deal qxsummarydeal", observed_at: "2099-01-01T00:00:00Z", scope: "shared", domain: "deals" }) })).status).toBe(200);
    const summary = String((await rest("/v1/notes?path=profile/summary.md", reader)).json.data?.markdown);
    expect(summary).toContain("qxsummaryplain");
    expect(summary).not.toContain("qxsummarydeal");
  });

  it("list pagination fills each page with notes the caller can read and drops nothing", async () => {
    await resetVault();
    const prefix = `shared/page-${nid()}/`;
    const lister = await mint(`lister-${nid()}`, ["read:shared", "read:sensitive/*"], "lister");
    const visible: string[] = [];
    const now = new Date().toISOString();
    for (let i = 0; i < 115; i++) {
      const path = `${prefix}${String(i).padStart(3, "0")}.md`;
      if (i % 10 === 0) {
        // A legacy row flagged sensitive in place with no domain. read:sensitive/* lets it through the SQL
        // prefilter, and canRead drops it because only read:sensitive/pii covers it.
        await testEnv().DB.prepare(
          `INSERT INTO notes (id, path, type, owner, sensitivity, title, body, frontmatter, content_hash, r2_key, status, created_at, updated_at, last_writer)
           VALUES (?, ?, 'note', 'shared', 'sensitive', 'hidden', 'hidden', '{}', 'x', ?, 'active', ?, ?, 'test')`,
        )
          .bind(`01HIDDEN${String(i).padStart(18, "0")}`, path, `vault/${path}`, now, now)
          .run();
        continue;
      }
      const written = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path, body: `row ${i}`, type: "note" }) });
      expect(written.status).toBe(200);
      visible.push(path);
    }
    const seen: string[] = [];
    let cursor = "";
    let pages = 0;
    for (let page = 0; page < 5; page++) {
      pages += 1;
      const listed = await rest(`/v1/list?prefix=${encodeURIComponent(prefix)}&cursor=${encodeURIComponent(cursor)}`, lister);
      seen.push(...(listed.json.data?.notes as { path: string }[]).map((note) => note.path));
      cursor = String(listed.json.data?.cursor ?? "");
      if (!listed.json.data?.cursor) break;
    }
    expect(seen).toEqual(visible);
    expect(pages).toBe(2);
  }, 60_000);

  it("search is GET only, and the retired policy and quarantine routes are gone", async () => {
    expect((await rest("/v1/search?q=anything", reader)).status).toBe(200);
    expect((await rest("/v1/search", reader, { method: "POST", body: JSON.stringify({ q: "anything" }) })).status).toBe(404);
    for (const [method, path] of [["GET", "/v1/admin/policy"], ["POST", "/v1/admin/policy"], ["DELETE", "/v1/admin/policy"], ["GET", "/v1/admin/quarantine"]] as const) {
      expect((await rest(path, ADMIN, { method, ...(method === "GET" ? {} : { body: "{}" }) })).status, `${method} ${path}`).toBe(404);
    }
  });
});
