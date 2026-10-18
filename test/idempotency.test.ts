import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, mcp, mint, nid, resetVault, rest, runInWriter, runJob, testEnv } from "./helpers";

// T-08. Idempotency on the four writes: note PUT, fact upsert, journal append, and forget.
// REST takes the Idempotency-Key header or the idempotency_key field; MCP takes only the tool
// argument. Same key and payload replays; another payload is 422; header and field that differ
// are 400 and write nothing. L5: the replay still returns the original response after a rebuild.

let writer = "";

beforeAll(async () => {
  writer = await mint("idem-writer", ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], "idem-writer");
});

type Call = { path: string; method: string; body: Record<string, unknown> };

// One call per write kind. `vary` is the same call with one field changed.
async function calls(): Promise<{ name: string; call: Call; vary: Call; count: () => Promise<number> }[]> {
  const n = nid();
  const notePath = `shared/idem-note-${n}.md`;
  const forgetPath = `shared/idem-forget-${n}.md`;
  const made = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: forgetPath, body: "to forget", type: "note" }) });
  expect(made.status).toBe(200);
  const forgetId = String(made.json.data?.id);
  const factKey = `idem-fact-${n}`;
  const title = `idem journal ${n}`;
  const db = testEnv().DB;
  return [
    {
      name: "note",
      call: { path: "/v1/notes", method: "PUT", body: { path: notePath, body: `note body ${n}`, type: "note" } },
      vary: { path: "/v1/notes", method: "PUT", body: { path: notePath, body: `other body ${n}`, type: "note" } },
      count: async () => (await db.prepare("SELECT COUNT(*) AS n FROM note_versions v JOIN notes x ON x.id = v.note_id WHERE x.path = ?").bind(notePath).first<{ n: number }>())?.n ?? 0,
    },
    {
      name: "fact",
      call: { path: "/v1/facts", method: "POST", body: { key: factKey, statement: `likes tea ${n}`, observed_at: "2099-01-01T00:00:00Z", scope: "own" } },
      vary: { path: "/v1/facts", method: "POST", body: { key: factKey, statement: `likes coffee ${n}`, observed_at: "2099-01-01T00:00:00Z", scope: "own" } },
      count: async () => (await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'write_fact' AND path LIKE ?").bind(`%${factKey}%`).first<{ n: number }>())?.n ?? 0,
    },
    {
      name: "journal",
      call: { path: "/v1/journal", method: "POST", body: { target: "own", title, body: `entry ${n}`, at: "2099-02-01T12:00:00Z" } },
      vary: { path: "/v1/journal", method: "POST", body: { target: "own", title, body: `another entry ${n}`, at: "2099-02-01T12:00:00Z" } },
      count: async () => (await db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE title = ?").bind(title).first<{ n: number }>())?.n ?? 0,
    },
    {
      name: "forget",
      call: { path: "/v1/forget", method: "POST", body: { id: forgetId, reason: "done" } },
      vary: { path: "/v1/forget", method: "POST", body: { id: forgetId, reason: "a different reason" } },
      count: async () => (await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'forget' AND note_id = ?").bind(forgetId).first<{ n: number }>())?.n ?? 0,
    },
  ];
}

function send(call: Call, init: { header?: string; field?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.header) headers["idempotency-key"] = init.header;
  const body = init.field ? { ...call.body, idempotency_key: init.field } : call.body;
  return rest(call.path, writer, { method: call.method, headers, body: JSON.stringify(body) });
}

const TOOL: Record<string, string> = { note: "vault_write_note", fact: "vault_write_fact", journal: "vault_append_journal", forget: "vault_forget" };

describe("T-08 idempotency on four writes", () => {
  it("REST: header and field agree, a mismatch is 400 and writes nothing, another payload is 422, the same payload replays", async () => {
    await resetVault();
    for (const { name, call, vary, count } of await calls()) {
      const key = `k-${name}-${nid()}`;
      // Header and field that differ: 400, nothing written.
      const conflict = await send(call, { header: `${key}-a`, field: `${key}-b` });
      expect(conflict.status, name).toBe(400);
      expect(conflict.json.error?.code, name).toBe("idempotency_key_conflict");
      expect(await count(), name).toBe(0);
      // Header and field that agree: accepted.
      const first = await send(call, { header: key, field: key });
      expect([200, 201], `${name} ${first.text}`).toContain(first.status);
      const written = await count();
      expect(written, name).toBeGreaterThan(0);
      // The same key and payload replays the original data under a new request id, header-only or field-only.
      for (const form of [{ header: key }, { field: key }]) {
        const again = await send(call, form);
        expect(again.status, name).toBe(first.status);
        expect(again.json.data, name).toEqual(first.json.data);
        expect(again.json.request_id).not.toBe(first.json.request_id);
      }
      // Another payload under the same key: 422, nothing written.
      const reused = await send(vary, { field: key });
      expect(reused.status, name).toBe(422);
      expect(reused.json.error?.code, name).toBe("idempotency_key_reused");
      expect(await count(), name).toBe(written);
      // A key is per agent and per payload: a fresh key runs the varied write.
      if (name === "fact" || name === "journal") {
        const fresh = await send(vary, { field: `${key}-fresh` });
        expect([200, 201], name).toContain(fresh.status);
      }
    }
  });

  it("MCP: only the tool argument counts; the header is ignored, so it never conflicts or replays", async () => {
    await resetVault();
    for (const { name, call, vary, count } of await calls()) {
      const tool = TOOL[name]!;
      const key = `m-${name}-${nid()}`;
      const first = await mcp(writer, tool, { ...call.body, idempotency_key: key });
      expect(first.json.ok, `${name} ${first.text}`).toBe(true);
      const written = await count();
      const again = await mcp(writer, tool, { ...call.body, idempotency_key: key });
      expect(again.json.data, name).toEqual(first.json.data);
      const reused = await mcp(writer, tool, { ...vary.body, idempotency_key: key });
      expect(reused.json.ok, name).toBe(false);
      expect(reused.json.error?.code, name).toBe("idempotency_key_reused");
      expect(await count(), name).toBe(written);
      // A header that differs from the argument is not a conflict: the argument governs.
      const header = await mcp(writer, tool, { ...call.body, idempotency_key: key }, { "idempotency-key": `${key}-header` });
      expect(header.json.ok, name).toBe(true);
      expect(header.json.data, name).toEqual(first.json.data);
    }
    // A header with no argument is no key at all: two calls under one header are two writes.
    const title = `mcp header ${nid()}`;
    const header = { "idempotency-key": `hdr-${nid()}` };
    for (let i = 0; i < 2; i++) {
      const appended = await mcp(writer, "vault_append_journal", { target: "own", title, body: "same body", at: "2099-03-01T12:00:00Z" }, header);
      expect(appended.json.ok).toBe(true);
    }
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE title = ?").bind(title).first<{ n: number }>())?.n).toBe(2);
    expect(await testEnv().DB.prepare("SELECT 1 FROM idempotency WHERE key = ?").bind(header["idempotency-key"]).first()).toBeNull();
  });

  it("a rerouted write replays its 201 envelope and stays one entry", async () => {
    await resetVault();
    const key = `rr-${nid()}`;
    const body = { target: "shared", title: "checkup", body: "synthetic flu shot at the clinic", at: "2099-04-01T12:00:00Z" };
    const first = await rest("/v1/journal", writer, { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({ rerouted: true, sensitive_domain: "health" });
    const again = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ ...body, idempotency_key: key }) });
    expect(again.status).toBe(201);
    expect(again.json.data).toEqual(first.json.data);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE idempotency_key = ?").bind(key).first<{ n: number }>())?.n).toBe(1);
  });

  it("L5: after D1 loses every row and a rebuild runs, all four writes replay their original response and created_at is unchanged", async () => {
    await resetVault();
    const list = await calls();
    const firsts = new Map<string, { status: number; data: unknown; key: string; requestId: string }>();
    for (const { name, call } of list) {
      const key = `l5-${name}-${nid()}`;
      const first = await send(call, { header: key });
      expect([200, 201], `${name} ${first.text}`).toContain(first.status);
      firsts.set(name, { status: first.status, data: first.json.data, key, requestId: String(first.json.request_id) });
    }
    // A rerouted fact too, so the 201 envelope is restored from frontmatter.
    const healthKey = `l5-health-${nid()}`;
    const healthFact = { key: `l5-health-${nid()}`, statement: "synthetic flu shot booked", observed_at: "2099-01-02T00:00:00Z", scope: "shared" };
    const healthFirst = await rest("/v1/facts", writer, { method: "POST", headers: { "idempotency-key": healthKey }, body: JSON.stringify(healthFact) });
    expect(healthFirst.status).toBe(201);
    const db = testEnv().DB;
    const created = await db.prepare("SELECT path, created_at FROM notes ORDER BY path").all<{ path: string; created_at: string }>();
    // Lose the whole index and the writer's operation cache. Only R2 is left.
    await db.batch(
      ["links", "journal_entries", "note_versions", "tombstones", "chunks", "idempotency", "notes"].map((table) => db.prepare(`DELETE FROM ${table}`)),
    );
    await runInWriter((state) => state.storage.sql.exec("DELETE FROM operations"));
    const rebuilt = await runJob("/v1/admin/rebuild");
    expect(rebuilt.job.data?.status, JSON.stringify(rebuilt.job)).toBe("done");
    const after = await db.prepare("SELECT path, created_at FROM notes ORDER BY path").all<{ path: string; created_at: string }>();
    const createdAfter = new Map((after.results ?? []).map((row) => [row.path, row.created_at]));
    for (const row of created.results ?? []) {
      if (row.path === "profile/summary.md") continue;
      expect(createdAfter.get(row.path), row.path).toBe(row.created_at);
    }
    for (const { name, call, vary } of list) {
      const first = firsts.get(name)!;
      for (const form of [{ header: first.key }, { field: first.key }]) {
        const replay = await send(call, form);
        expect(replay.status, name).toBe(first.status);
        expect(replay.json.data, name).toEqual(first.data);
        expect(replay.json.request_id).not.toBe(first.requestId);
      }
      const mcpReplay = await mcp(writer, TOOL[name]!, { ...call.body, idempotency_key: first.key });
      expect(mcpReplay.json.data, name).toEqual(first.data);
      const reused = await send(vary, { field: first.key });
      expect(reused.status, name).toBe(422);
    }
    const healthReplay = await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ ...healthFact, idempotency_key: healthKey }) });
    expect(healthReplay.status).toBe(201);
    expect(healthReplay.json.data).toEqual(healthFirst.json.data);
    // No write ran again: one journal entry, one forget audit row, one version per note.
    const forgetId = String(list.find((item) => item.name === "forget")!.call.body.id);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'forget' AND note_id = ?").bind(forgetId).first<{ n: number }>())?.n).toBe(1);
    const journal = list.find((item) => item.name === "journal")!;
    expect(await journal.count()).toBe(1);
  });

  it("a key in the admin's hands is the admin's: the same key from another agent is a separate write", async () => {
    await resetVault();
    const key = `shared-key-${nid()}`;
    const a = await rest("/v1/notes", writer, { method: "PUT", headers: { "idempotency-key": key }, body: JSON.stringify({ path: `shared/a-${nid()}.md`, body: "a", type: "note" }) });
    const b = await rest("/v1/notes", ADMIN, { method: "PUT", headers: { "idempotency-key": key }, body: JSON.stringify({ path: `shared/b-${nid()}.md`, body: "b", type: "note" }) });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.json.data?.id).not.toBe(a.json.data?.id);
  });
});
