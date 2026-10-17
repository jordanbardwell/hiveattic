import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMIN, auditText, deliverEvent, mcp, mint, nid, resetVault, rest, results, runJob, testEnv, versionsOf, type Envelope } from "./helpers";

// T-15. The folder decides visibility: text that classifies as health, finance, or PII at a path
// that is not already sensitive is stored under sensitive/<d>/<same path>. Nothing is refused.

let writer = "";
let reader = "";
let health = "";
let finance = "";
let wide = "";
let healthWriter = "";

beforeAll(async () => {
  writer = await mint("rr-writer", ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], "rr-writer");
  reader = await mint("rr-reader", ["read:shared"], "rr-reader");
  health = await mint("rr-health", ["read:shared", "read:sensitive/health"], "rr-health");
  finance = await mint("rr-finance", ["read:shared", "read:sensitive/finance"], "rr-finance");
  wide = await mint("rr-wide", ["read:all", "read:shared", "read:sensitive/*", "read:sensitive/health", "read:sensitive/finance", "read:sensitive/pii", "audit:read"], "rr-wide");
  healthWriter = await mint("rr-health-writer", ["read:shared", "write:shared", "read:sensitive/health", "write:sensitive/health"], "rr-health-writer");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const put = (token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => rest("/v1/notes", token, { method: "PUT", body: JSON.stringify(body), headers });
const read = (token: string, path: string) => rest(`/v1/notes?path=${encodeURIComponent(path)}`, token);

// Every way a caller could find a note: path, id, search, list, and history.
async function expectHidden(token: string, paths: string[], ids: string[], marker: string): Promise<void> {
  for (const path of paths) {
    const byPath = await read(token, path);
    expect(byPath.status, `${path} ${byPath.text}`).toBe(404);
    expect(byPath.text).not.toContain(marker);
    expect(byPath.text).not.toContain("sensitive/");
    const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, token);
    expect(history.status).toBe(404);
  }
  for (const id of ids) {
    expect((await rest(`/v1/notes?id=${encodeURIComponent(id)}`, token)).status).toBe(404);
    expect((await rest(`/v1/history?id=${encodeURIComponent(id)}`, token)).status).toBe(404);
  }
  const found = await rest(`/v1/search?q=${marker}`, token);
  expect(found.status).toBe(200);
  expect(results(found.json)).toEqual([]);
  for (const prefix of ["shared/", "profile/", "journal/", "sensitive/", ""]) {
    const listed = await rest(`/v1/list?prefix=${encodeURIComponent(prefix)}`, token);
    for (const path of paths) expect(listed.text.includes(path), `${prefix} lists ${path}`).toBe(false);
  }
}

describe("T-15 rerouting", () => {
  it("health text in a new shared note goes to sensitive/health/ and only a health reader can find it", async () => {
    await resetVault();
    const marker = `qxhealth${nid()}`;
    const path = `shared/rr-h-${nid()}.md`;
    const target = `sensitive/health/${path}`;
    const key = `rr-h-${nid()}`;
    const written = await put(writer, { path, body: `Got a synthetic flu shot today. ${marker}`, type: "note" }, { "idempotency-key": key });
    expect(written.status, written.text).toBe(201);
    expect(written.json.data).toMatchObject({ path: target, rerouted: true, sensitive_domain: "health", outcome: "created" });
    const id = String(written.json.data?.id);
    expect((await read(ADMIN, path)).status).toBe(404);
    expect(await testEnv().VAULT.head(`vault/${path}`)).toBeNull();
    await expectHidden(reader, [path, target], [id], marker);
    // The writer has no read:sensitive/health, so it cannot read its own rerouted note back.
    await expectHidden(writer, [path, target], [id], marker);
    await expectHidden(finance, [path, target], [id], marker);
    expect((await read(health, target)).status).toBe(200);
    expect((await rest(`/v1/notes?id=${id}`, health)).status).toBe(200);
    expect(results((await rest(`/v1/search?q=${marker}`, health)).json).map((row) => row.path)).toEqual([target]);
    expect((await rest("/v1/list?prefix=sensitive/", health)).text).toContain(target);
    expect(versionsOf((await rest(`/v1/history?id=${id}`, health)).json).length).toBe(1);
    // A retry with the same key returns the same 201 and writes nothing new.
    const retry = await put(writer, { path, body: `Got a synthetic flu shot today. ${marker}`, type: "note", idempotency_key: key });
    expect(retry.status).toBe(201);
    expect(retry.json.data).toEqual(written.json.data);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE body LIKE ?").bind(`%${marker}%`).first<{ n: number }>())?.n).toBe(1);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").bind(id).first<{ n: number }>())?.n).toBe(1);
    const audit = await auditText();
    expect(audit).not.toContain(marker);
    const row = await testEnv().DB.prepare("SELECT action, detail, content_hash, bytes FROM audit_log WHERE note_id = ? AND action = 'reroute'").bind(id).first<{
      action: string;
      detail: string;
      content_hash: string;
      bytes: number;
    }>();
    expect(JSON.parse(row!.detail)).toEqual({ requested_path: path, sensitive_domain: "health" });
    expect(row!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // MCP returns the same envelope.
    const mcpPath = `shared/rr-hm-${nid()}.md`;
    const viaMcp = await mcp(writer, "vault_write_note", { path: mcpPath, body: `Prescription refill ${marker}`, type: "note" });
    expect(viaMcp.json.data).toMatchObject({ path: `sensitive/health/${mcpPath}`, rerouted: true, sensitive_domain: "health" });
  });

  it("finance text in a shared note and a shared fact goes to sensitive/finance/, and the profile summary leaves it out", async () => {
    await resetVault();
    const marker = `qxfin${nid()}`;
    const path = `shared/rr-f-${nid()}.md`;
    const note = await put(writer, { path, body: `The synthetic budget for October is tight. ${marker}`, type: "note" });
    expect(note.status, note.text).toBe(201);
    expect(note.json.data).toMatchObject({ path: `sensitive/finance/${path}`, sensitive_domain: "finance" });
    const key = `rr-ff-${nid()}`;
    const factBody = { key, statement: `Monthly mortgage payment is synthetic ${marker}`, observed_at: "2099-01-01T00:00:00Z", scope: "shared", idempotency_key: `${key}-k` };
    const fact = await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify(factBody) });
    expect(fact.status, fact.text).toBe(201);
    expect(fact.json.data).toMatchObject({ path: `sensitive/finance/profile/facts/${key}.md`, rerouted: true, sensitive_domain: "finance" });
    const again = await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify(factBody) });
    expect(again.json.data).toEqual(fact.json.data);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE fact_key = ?").bind(key).first<{ n: number }>())?.n).toBe(1);
    await expectHidden(reader, [path, `sensitive/finance/${path}`, `profile/facts/${key}.md`, String(fact.json.data?.path)], [String(note.json.data?.id), String(fact.json.data?.id)], marker);
    await expectHidden(health, [`sensitive/finance/${path}`], [String(note.json.data?.id)], marker);
    expect((await read(finance, String(fact.json.data?.path))).status).toBe(200);
    const summary = await read(reader, "profile/summary.md");
    expect(summary.text).not.toContain(marker);
  });

  it("health with finance, PII alone, or a bare sensitive flag go to sensitive/restricted/, which only the admin token reads", async () => {
    await resetVault();
    const marker = `qxrestricted${nid()}`;
    const cases = [
      { body: `Hospital bill and the monthly budget ${marker}`, sensitivity: undefined },
      { body: `Call me at 206-555-0142 ${marker}`, sensitivity: undefined },
      { body: `Lives at 12 Elm Street ${marker}`, sensitivity: undefined },
      { body: `A plain note the caller marked ${marker}`, sensitivity: "sensitive" },
    ];
    const paths: string[] = [];
    const ids: string[] = [];
    for (const item of cases) {
      const path = `shared/rr-r-${nid()}.md`;
      const written = await put(writer, { path, body: item.body, type: "note", ...(item.sensitivity ? { sensitivity: item.sensitivity } : {}) });
      expect(written.status, written.text).toBe(201);
      expect(written.json.data).toMatchObject({ path: `sensitive/restricted/${path}`, rerouted: true, sensitive_domain: "restricted" });
      paths.push(path, `sensitive/restricted/${path}`);
      ids.push(String(written.json.data?.id));
    }
    for (const token of [reader, health, finance, wide, writer]) await expectHidden(token, paths, ids, marker);
    for (const id of ids) expect((await rest(`/v1/notes?id=${id}`, ADMIN)).status).toBe(200);
    expect(results((await rest(`/v1/search?q=${marker}`, ADMIN)).json).length).toBe(4);
    // Nothing can grant restricted.
    for (const scope of ["read:sensitive/restricted", "write:sensitive/restricted", "read:sensitive:summary/restricted"]) {
      const minted = await rest("/v1/admin/tokens", ADMIN, { method: "POST", body: JSON.stringify({ agent_id: `rr-bad-${nid()}`, scopes: [scope], label: "x" }) });
      expect(minted.status, scope).toBe(400);
    }
    // A wide token's audit read shows no reroute row.
    const audit = await rest("/v1/admin/audit?limit=200", wide);
    expect(audit.status).toBe(200);
    expect(audit.text).not.toContain("sensitive/restricted");
    expect((await rest(`/v1/admin/audit?path=${encodeURIComponent(paths[0]!)}`, wide)).status).toBe(403);
  });

  it("a shared journal entry with sensitive text is accepted and appended to the writer's sensitive day file", async () => {
    await resetVault();
    const marker = `qxjournal${nid()}`;
    const at = "2099-06-01T16:00:00Z";
    const day = "journal/2099/06/2099-06-01.md";
    const sensitivePath = "sensitive/health/journal/rr-writer/2099-06-01.md";
    const neutral = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "standup", body: "Neutral one", at }) });
    expect(neutral.status).toBe(200);
    const body = { target: "shared", title: "health", body: `Synthetic flu shot booked ${marker}`, at, idempotency_key: `rr-j-${nid()}` };
    const rerouted = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify(body) });
    expect(rerouted.status, rerouted.text).toBe(201);
    expect(rerouted.json.data).toMatchObject({ path: sensitivePath, rerouted: true, sensitive_domain: "health" });
    expect((await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "standup", body: "Neutral two", at }) })).status).toBe(200);
    const shared = await read(reader, day);
    expect(shared.status).toBe(200);
    expect(shared.text).not.toContain(marker);
    expect(shared.text).not.toContain("health");
    const order = await rest(`/v1/admin/journal-order?path=${encodeURIComponent(day)}`, ADMIN);
    expect((order.json.data?.block_refs as string[]).length).toBe(2);
    await expectHidden(reader, [sensitivePath], [], marker);
    await expectHidden(writer, [sensitivePath], [], marker);
    await expectHidden(finance, [sensitivePath], [], marker);
    expect((await read(health, sensitivePath)).status).toBe(200);
    expect(results((await rest(`/v1/search?q=${marker}`, health)).json).map((row) => row.path)).toEqual([sensitivePath]);
    const retry = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify(body) });
    expect(retry.status).toBe(201);
    expect(retry.json.data).toEqual(rerouted.json.data);
    const file = String((await read(ADMIN, sensitivePath)).json.data?.markdown);
    expect(file.split(marker).length - 1).toBe(1);
    const audit = await testEnv().DB.prepare("SELECT detail FROM audit_log WHERE action = 'journal_reroute'").first<{ detail: string }>();
    expect(JSON.parse(audit!.detail)).toEqual({ requested_path: day, sensitive_domain: "health" });
    expect(await auditText()).not.toContain(marker);
    const viaMcp = await mcp(writer, "vault_append_journal", { target: "decisions", title: "money", body: `Raise the synthetic budget ${marker}`, at });
    expect(viaMcp.json.data).toMatchObject({ path: "sensitive/finance/journal/rr-writer/2099-06-01.md", rerouted: true, sensitive_domain: "finance" });
    expect((await read(ADMIN, "shared/decisions.md")).status).toBe(404);
    // A rebuild keeps both where they are.
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    expect((await read(reader, day)).text).not.toContain(marker);
    expect((await read(health, sensitivePath)).status).toBe(200);
  });

  it("an update that adds sensitive text moves the note, and the old path keeps only its earlier versions", async () => {
    await resetVault();
    const marker = `qxmove${nid()}`;
    const path = `shared/rr-mv-${nid()}.md`;
    const v1 = await put(writer, { path, body: "First neutral draft qxv1", type: "note" });
    const v2 = await put(writer, { path, body: "Second neutral draft qxv2", type: "note", if_match: v1.json.data?.etag });
    expect(v2.status).toBe(200);
    const oldId = String(v1.json.data?.id);
    const v3 = await put(writer, { path, body: `Third draft adds a synthetic diagnosis ${marker}`, type: "note", if_match: v2.json.data?.etag });
    expect(v3.status, v3.text).toBe(201);
    const target = `sensitive/health/${path}`;
    expect(v3.json.data).toMatchObject({ path: target, rerouted: true, sensitive_domain: "health", outcome: "moved" });
    const newId = String(v3.json.data?.id);
    expect(newId).not.toBe(oldId);
    const oldRead = await read(reader, path);
    expect(oldRead.status).toBe(404);
    expect(oldRead.text).not.toContain(newId);
    expect(oldRead.text).not.toContain("health");
    await expectHidden(reader, [path, target], [oldId, newId], marker);
    expect((await rest("/v1/list?prefix=shared/", reader)).text).not.toContain(path);
    const admin = await read(ADMIN, path);
    expect(admin.json.data?.status).toBe("forgotten");
    expect(admin.text).not.toContain(marker);
    const oldHistory = versionsOf((await rest(`/v1/history?id=${oldId}`, ADMIN)).json).map((version) => version.body ?? "");
    expect(oldHistory.some((body) => body.includes("qxv1"))).toBe(true);
    expect(oldHistory.some((body) => body.includes("qxv2"))).toBe(true);
    expect(oldHistory.some((body) => body.includes(marker))).toBe(false);
    const tombstone = await testEnv().DB.prepare("SELECT reason, moved_to, path FROM tombstones WHERE note_id = ?").bind(oldId).first<{ reason: string; moved_to: string; path: string }>();
    expect(tombstone).toEqual({ reason: "removed", moved_to: target, path });
    expect(String((await read(health, target)).json.data?.markdown)).toContain(marker);
    const newHistory = versionsOf((await rest(`/v1/history?id=${newId}`, ADMIN)).json).map((version) => version.body ?? "");
    expect(newHistory.some((body) => body.includes("qxv1") || body.includes("qxv2"))).toBe(false);
    // Updating the moved note needs write:sensitive/health. The etag from the 201 is not enough without it.
    const blocked = await put(writer, { path, body: `More synthetic diagnosis ${marker}`, type: "note", if_match: v3.json.data?.etag });
    expect(blocked.status).toBe(403);
    const allowed = await put(healthWriter, { path: target, body: `Updated synthetic diagnosis ${marker}`, type: "note", if_match: v3.json.data?.etag });
    expect(allowed.status, allowed.text).toBe(200);
    expect(await auditText()).not.toContain(marker);
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    expect((await read(reader, path)).status).toBe(404);
    expect((await read(ADMIN, path)).json.data?.status).toBe("forgotten");
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE path = ?").bind(target).first<{ n: number }>())?.n).toBe(1);
    expect(results((await rest(`/v1/search?q=${marker}`, reader)).json)).toEqual([]);
  });

  it("a fact update that adds sensitive text moves the fact and drops it from the profile summary", async () => {
    await resetVault();
    const marker = `qxfactmove${nid()}`;
    const key = `rr-mv-${nid()}`;
    const first = await rest("/v1/facts", writer, {
      method: "POST",
      body: JSON.stringify({ key, statement: `Prefers tea qxneutral${marker}`, observed_at: "2099-01-01T00:00:00Z", scope: "shared" }),
    });
    expect(first.status).toBe(200);
    expect((await read(reader, "profile/summary.md")).text).toContain(`qxneutral${marker}`);
    const moved = await rest("/v1/facts", writer, {
      method: "POST",
      body: JSON.stringify({ key, statement: `Takes insulin twice a day ${marker}`, observed_at: "2099-02-01T00:00:00Z", scope: "shared" }),
    });
    expect(moved.status, moved.text).toBe(201);
    expect(moved.json.data).toMatchObject({ path: `sensitive/health/profile/facts/${key}.md`, outcome: "moved", rerouted: true });
    expect((await read(reader, `profile/facts/${key}.md`)).status).toBe(404);
    const summary = await read(reader, "profile/summary.md");
    expect(summary.text).not.toContain(marker);
    const history = versionsOf((await rest(`/v1/history?id=${first.json.data?.id}`, ADMIN)).json).map((version) => version.body ?? "");
    expect(history.some((body) => body.includes("insulin"))).toBe(false);
    expect(history.some((body) => body.includes("qxneutral"))).toBe(true);
    const active = await testEnv().DB.prepare("SELECT path FROM notes WHERE owner = 'shared' AND fact_key = ? AND status = 'active'").bind(key).all<{ path: string }>();
    expect(active.results?.map((row) => row.path)).toEqual([`sensitive/health/profile/facts/${key}.md`]);
  });

  it("extra frontmatter, a sensitivity of normal, or an ordinary domain cannot lower what the text classifies as", async () => {
    await resetVault();
    const marker = `qxdowngrade${nid()}`;
    const path = `shared/rr-dg-${nid()}.md`;
    const written = await put(writer, {
      path,
      body: `Allergy test results ${marker}`,
      type: "note",
      sensitivity: "normal",
      domain: "deals",
      extra: { sensitivity: "normal", domain: "deals", status: "active", owner: "someone", vault_id: "01FAKE0000000000000000000", title: "Nothing here" },
    });
    expect(written.status, written.text).toBe(201);
    expect(written.json.data?.path).toBe(`sensitive/health/${path}`);
    // A title in extra is classified too.
    const titled = await put(writer, { path: `shared/rr-t-${nid()}.md`, body: "plain", type: "note", extra: { title: "Dentist visit" } });
    expect(titled.status).toBe(201);
  });

  it("an outside edit that puts health text in shared/ is moved before anything indexes it there", async () => {
    await resetVault();
    const marker = `qxoutside${nid()}`;
    const path = `shared/rr-ext-${nid()}.md`;
    await testEnv().VAULT.put(`vault/${path}`, `---\nsensitivity: normal\ndomain: deals\n---\nSynthetic blood pressure log ${marker}\n`, { httpMetadata: { contentType: "text/markdown" } });
    expect((await deliverEvent("PutObject", `vault/${path}`)).acked).toBe(true);
    const target = `sensitive/health/${path}`;
    expect(await testEnv().VAULT.head(`vault/${path}`)).toBeNull();
    const moved = await testEnv().VAULT.get(`vault/${target}`);
    const movedText = await moved!.text();
    expect(movedText).toContain(marker);
    expect(movedText).toMatch(/vault_id: [0-9A-Z]{26}/);
    expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(path).first()).toBeNull();
    const tombstone = await testEnv().DB.prepare("SELECT reason, moved_to FROM tombstones WHERE path = ?").bind(path).first<{ reason: string; moved_to: string }>();
    expect(tombstone).toEqual({ reason: "removed", moved_to: target });
    const audit = await testEnv().DB.prepare("SELECT detail FROM audit_log WHERE action = 'reroute_move' AND path = ?").bind(target).first<{ detail: string }>();
    expect(JSON.parse(audit!.detail)).toMatchObject({ requested_path: path, sensitive_domain: "health" });
    expect(await auditText()).not.toContain(marker);
    await expectHidden(reader, [path, target], [], marker);
    expect(results((await rest(`/v1/search?q=${marker}`, health)).json).map((row) => row.path)).toEqual([target]);
    // The bucket's own events for the move change nothing.
    const versions = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions").first<{ n: number }>();
    await deliverEvent("PutObject", `vault/${target}`);
    await deliverEvent("DeleteObject", `vault/${path}`);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions").first<{ n: number }>())?.n).toBe(versions?.n);
    expect((await read(health, target)).json.data?.status).toBe("active");

    // An existing neutral note edited outside with finance text moves under a new id.
    const notePath = `shared/rr-ext2-${nid()}.md`;
    const created = await put(writer, { path: notePath, body: "Neutral qxbefore", type: "note" });
    await testEnv().VAULT.put(`vault/${notePath}`, `Synthetic paycheck stub ${marker}\n`);
    await deliverEvent("PutObject", `vault/${notePath}`);
    const row = await testEnv().DB.prepare("SELECT id, status FROM notes WHERE path = ?").bind(`sensitive/finance/${notePath}`).first<{ id: string; status: string }>();
    expect(row?.status).toBe("active");
    expect(row?.id).not.toBe(created.json.data?.id);
    expect((await read(reader, notePath)).status).toBe(404);
    expect((await read(ADMIN, notePath)).json.data?.status).toBe("forgotten");

    // A fake key put through R2 stays where it is, active and searchable. Content is not filtered.
    const keyPath = `shared/rr-key-${nid()}.md`;
    await testEnv().VAULT.put(`vault/${keyPath}`, `token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 qxkeyed${marker}\n`);
    await deliverEvent("PutObject", `vault/${keyPath}`);
    expect((await read(reader, keyPath)).json.data?.status).toBe("active");
    expect(results((await rest(`/v1/search?q=qxkeyed${marker}`, reader)).json).map((row) => row.path)).toEqual([keyPath]);
  });

  it("a rebuild and a reconcile move sensitive text they find at a shared path", async () => {
    await resetVault();
    const marker = `qxsweep${nid()}`;
    const first = `shared/rr-rb-${nid()}.md`;
    await testEnv().VAULT.put(`vault/${first}`, `Chemotherapy schedule ${marker}\n`);
    expect((await runJob("/v1/admin/reindex")).job.data?.counts).toMatchObject({ moved: 1 });
    expect(await testEnv().VAULT.head(`vault/${first}`)).toBeNull();
    expect((await read(health, `sensitive/health/${first}`)).status).toBe(200);
    expect(results((await rest(`/v1/search?q=${marker}`, reader)).json)).toEqual([]);
    const second = `shared/rr-rc-${nid()}.md`;
    await testEnv().VAULT.put(`vault/${second}`, `Tax return draft ${marker}\n`);
    expect((await runJob("/v1/admin/reconcile")).job.data?.counts).toMatchObject({ moved: 1 });
    expect(await testEnv().VAULT.head(`vault/${second}`)).toBeNull();
    expect((await read(finance, `sensitive/finance/${second}`)).status).toBe(200);
    // A second rebuild finds nothing left to move and nothing at the shared paths.
    expect((await runJob("/v1/admin/reindex")).job.data?.counts).toMatchObject({ moved: 0 });
    expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path IN (?, ?)").bind(first, second).first()).toBeNull();
  });

  it("writes with fake secrets, a test card, a password line, and employer text are stored as written, and no log line echoes a body", async () => {
    await resetVault();
    const marker = `qxsmoke${nid()}`;
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    const samples = ["sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "Card 4242 4242 4242 4242", "password: x", "Contoso Q3 roadmap for the Qx account team"];
    for (const sample of samples) {
      const path = `shared/rr-smoke-${nid()}.md`;
      const written = await put(writer, { path, body: `${marker} ${sample}`, type: "note" });
      expect(written.status, written.text).toBe(200);
      expect(String((await read(reader, path)).json.data?.markdown)).toContain(sample);
    }
    const journal = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "smoke", body: `${marker} password: x`, at: "2099-07-01T12:00:00Z" }) });
    expect(journal.status).toBe(200);
    vi.restoreAllMocks();
    expect(logged.join("\n")).not.toContain(marker);
    expect(await auditText()).not.toContain(marker);
  });
});

export type { Envelope };
