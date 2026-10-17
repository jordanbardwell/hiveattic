import { createExecutionContext, createScheduledController, evictDurableObject, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { ADMIN, drainJobs, mcp, mint, nid, resetVault, rest, results, runInWriter, runJob, testEnv, waitJob, writerStub } from "./helpers";

// T-12 and T-17. Rebuild, reindex, reconcile, and the quarantine erase are paged jobs in the writer.
// Writes keep a 25 s caller-facing timeout, and a timeout never causes a duplicate.

let writer = "";
let other = "";

beforeAll(async () => {
  writer = await mint("job-writer", ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], "job-writer");
  other = await mint("job-other", ["read:shared", "read:own", "write:own", "write:shared"], "job-other");
});

async function seedFiles(count: number, marker: string): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = `shared/bulk/${marker}-${String(i).padStart(4, "0")}.md`;
    await testEnv().VAULT.put(`vault/${path}`, `# Bulk ${i}\n\n${marker} bulk file ${i}\n`, { httpMetadata: { contentType: "text/markdown" } });
    paths.push(path);
  }
  return paths;
}

async function startJob(path: string, body: Record<string, unknown> = {}) {
  return rest(path, ADMIN, { method: "POST", body: JSON.stringify(body) });
}

describe("paged admin jobs", () => {
  it("reindex, rebuild, and reconcile answer 202 with a job id, and the job reports its status, pages, and counts", async () => {
    await resetVault();
    const started = await startJob("/v1/admin/reindex");
    expect(started.status, started.text).toBe(202);
    expect(started.json.data).toMatchObject({ kind: "reindex", status: "queued" });
    const id = String(started.json.data?.job_id);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const queued = await rest(`/v1/admin/jobs/${id}`, ADMIN);
    expect(["queued", "running"]).toContain(queued.json.data?.status);
    // Only one job at a time. The second start names the running job.
    const second = await startJob("/v1/admin/reconcile");
    expect(second.status).toBe(409);
    expect(second.json.error).toMatchObject({ code: "job_running", job_id: id, reasons: [id] });
    expect((await rest(`/v1/admin/jobs/${id}`, writer)).status).toBe(403);
    expect((await startJob("/v1/admin/reindex")).status).toBe(409);
    expect((await rest("/v1/admin/reindex", writer, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await rest("/v1/admin/jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV", ADMIN)).status).toBe(404);
    expect((await rest("/v1/admin/jobs/not-a-job", ADMIN)).status).toBe(404);
    const done = await waitJob(id);
    expect(done.data).toMatchObject({ job_id: id, kind: "reindex", status: "done", error: null, errors: [] });
    expect(Number(done.data?.pages)).toBeGreaterThan(0);
    expect(done.data?.progress).toMatchObject({ phase: "done" });
    expect(done.data?.counts).toMatchObject({ files: 2, notes: 2, swept: 0 });
    const audit = await rest(`/v1/admin/audit?request_id=${started.json.request_id}`, ADMIN);
    expect((audit.json.data?.entries as { action: string }[]).map((row) => row.action).sort()).toEqual(["reindex", "reindex_started"]);
    const rebuild = await runJob("/v1/admin/rebuild");
    expect(rebuild.job.data).toMatchObject({ kind: "rebuild", status: "done" });
    const viaJobs = await runJob("/v1/admin/jobs", { kind: "reconcile" });
    expect(viaJobs.job.data).toMatchObject({ kind: "reconcile", status: "done" });
    expect((await startJob("/v1/admin/jobs", { kind: "nope" })).status).toBe(400);
    expect((await rest("/v1/admin/reindex", ADMIN, { method: "GET" })).status).toBe(404);
  });

  it("ordinary writes land between pages, are not lost or overwritten by the job, and survive a second rebuild", async () => {
    await resetVault();
    const marker = `qxpaged${nid()}`;
    const paths = await seedFiles(230, marker);
    const started = await startJob("/v1/admin/reindex");
    expect(started.status).toBe(202);
    const id = String(started.json.data?.job_id);
    await runDurableObjectAlarm(writerStub());
    const mid = await rest(`/v1/admin/jobs/${id}`, ADMIN);
    expect(mid.json.data?.status).toBe("running");
    expect(mid.json.data?.phase).toBe("files");
    // The first page indexed the first 100 files. Overwrite one of them, write new things, and let the job go on.
    const processed = paths[3]!;
    const firstRead = await rest(`/v1/notes?path=${encodeURIComponent(processed)}`, writer);
    expect(firstRead.status).toBe(200);
    const during = `shared/during-${nid()}.md`;
    const writes = await Promise.all([
      rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: during, body: `${marker} written during the job`, type: "note" }) }),
      rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: processed, body: `${marker} replaced mid job`, type: "note", if_match: firstRead.json.data?.etag }) }),
      rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: paths[220], body: `${marker} not yet reached`, type: "note", if_match: null }) }),
      rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "during", body: `${marker} journal during`, at: "2099-03-03T10:00:00Z" }) }),
      rest("/v1/facts", writer, { method: "POST", headers: { "idempotency-key": `job-fact-${marker}` }, body: JSON.stringify({ key: `during-${nid()}`, statement: `${marker} fact during`, observed_at: "2099-01-01T00:00:00Z", scope: "shared" }) }),
    ]);
    expect(writes[0]!.status, writes[0]!.text).toBe(200);
    expect(writes[1]!.status, writes[1]!.text).toBe(200);
    // paths[220] has no row yet, so an update without if_match is a create of an existing object: 409.
    expect(writes[2]!.status).toBe(409);
    expect(writes[3]!.status).toBe(200);
    expect(writes[4]!.status).toBe(200);
    const done = await waitJob(id);
    expect(done.data?.status, JSON.stringify(done)).toBe("done");
    expect(Number(done.data?.pages)).toBeGreaterThan(3);
    const check = async () => {
      expect(String((await rest(`/v1/notes?path=${encodeURIComponent(during)}`, writer)).json.data?.markdown)).toContain("written during the job");
      expect(String((await rest(`/v1/notes?path=${encodeURIComponent(processed)}`, writer)).json.data?.markdown)).toContain("replaced mid job");
      expect(String((await rest("/v1/notes?path=journal/2099/03/2099-03-03.md", writer)).json.data?.markdown)).toContain("journal during");
      expect(results((await rest(`/v1/search?q=${marker}&limit=50`, writer)).json).length).toBeGreaterThan(20);
      const count = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE path LIKE 'shared/bulk/%'").first<{ n: number }>();
      expect(count?.n).toBe(230);
      const facts = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE type = 'fact' AND body LIKE ?").bind(`%${marker} fact during%`).first<{ n: number }>();
      expect(facts?.n).toBe(1);
    };
    await check();
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    await check();
  }, 120_000);

  it("a job resumes after the writer is evicted mid-run", async () => {
    await resetVault();
    const marker = `qxresume${nid()}`;
    await seedFiles(180, marker);
    const started = await startJob("/v1/admin/reindex");
    const id = String(started.json.data?.job_id);
    await runDurableObjectAlarm(writerStub());
    expect((await rest(`/v1/admin/jobs/${id}`, ADMIN)).json.data?.status).toBe("running");
    await evictDurableObject(writerStub());
    const done = await waitJob(id);
    expect(done.data?.status).toBe("done");
    expect(done.data?.counts).toMatchObject({ files: 182 });
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE path LIKE 'shared/bulk/%'").first<{ n: number }>())?.n).toBe(180);
  }, 120_000);

  it("the nightly cron starts a reconcile job", async () => {
    await resetVault();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "15 7 * * *" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const job = await runInWriter((state) => state.storage.sql.exec<{ kind: string }>("SELECT kind FROM jobs ORDER BY created_at DESC LIMIT 1").toArray()[0]);
    expect(job?.kind).toBe("reconcile");
    await drainJobs();
  });

  it("rebuild restores created_at and the links table from R2", async () => {
    await resetVault();
    const target = `shared/link-target-${nid()}.md`;
    const source = `shared/link-source-${nid()}.md`;
    const created = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: target, body: "Target note", type: "note" }) });
    const linking = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: source, body: `See [[${target.replace(/\.md$/, "")}]]`, type: "note" }) });
    const sourceId = String(linking.json.data?.id);
    const originalCreated = (await testEnv().DB.prepare("SELECT created_at FROM notes WHERE id = ?").bind(sourceId).first<{ created_at: string }>())?.created_at;
    const db = testEnv().DB;
    await db.batch([
      db.prepare("DELETE FROM links"),
      db.prepare("DELETE FROM chunks WHERE note_id = ?").bind(sourceId),
      db.prepare("DELETE FROM note_versions WHERE note_id = ?").bind(sourceId),
      db.prepare("DELETE FROM notes WHERE id = ?").bind(sourceId),
    ]);
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    const row = await db.prepare("SELECT id, created_at FROM notes WHERE path = ?").bind(source).first<{ id: string; created_at: string }>();
    expect(row?.id).toBe(sourceId);
    expect(row?.created_at).toBe(originalCreated);
    const link = await db.prepare("SELECT dst_note_id FROM links WHERE src_note_id = ?").bind(sourceId).first<{ dst_note_id: string }>();
    expect(link?.dst_note_id).toBe(created.json.data?.id);
  });
});

describe("write timeouts and idempotency keys", () => {
  it("a write that outlasts the caller timeout answers 202 with an operation id, and a retry with the same key writes once", async () => {
    await resetVault();
    testEnv().WRITE_TIMEOUT_MS = "60";
    try {
      await runInDurableObject(writerStub(), (instance: unknown) => {
        const holder = instance as { tail: Promise<unknown> };
        holder.tail = holder.tail.then(() => new Promise((resolve) => setTimeout(resolve, 600)));
      });
      const key = `slow-${nid()}`;
      const body = { target: "own", title: "slow", body: `qxslow${key}`, at: "2099-04-04T10:00:00Z" };
      const first = await rest("/v1/journal", writer, { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body) });
      expect(first.status, first.text).toBe(202);
      expect(first.json.data?.pending).toBe(true);
      const operation = String(first.json.data?.operation_id);
      const retry = await rest("/v1/journal", writer, { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body) });
      expect(retry.status).toBe(202);
      expect(retry.json.data?.operation_id).toBe(operation);
      expect((await rest(`/v1/operations/${operation}`, other)).status).toBe(404);
      let polled = await rest(`/v1/operations/${operation}`, writer);
      for (let i = 0; i < 50 && polled.json.data?.status !== "done"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        polled = await rest(`/v1/operations/${operation}`, writer);
      }
      expect(polled.json.data).toMatchObject({ operation_id: operation, status: "done", http_status: 200 });
      const result = polled.json.data?.result as { entry_id?: string };
      testEnv().WRITE_TIMEOUT_MS = undefined;
      const third = await rest("/v1/journal", writer, { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body) });
      expect(third.status).toBe(200);
      expect(third.json.data?.entry_id).toBe(result.entry_id);
      const rows = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE idempotency_key = ?").bind(key).first<{ n: number }>();
      expect(rows?.n).toBe(1);
      expect((await rest("/v1/operations/01ARZ3NDEKTSV4RRFFQ69G5FAV", writer)).status).toBe(404);
    } finally {
      testEnv().WRITE_TIMEOUT_MS = undefined;
    }
  });

  it("note PUT, fact upsert, journal append, and forget take an Idempotency-Key header or an idempotency_key field", async () => {
    await resetVault();
    const path = `shared/idem-${nid()}.md`;
    const key = `note-${nid()}`;
    const first = await rest("/v1/notes", writer, { method: "PUT", headers: { "idempotency-key": key }, body: JSON.stringify({ path, body: "first body", type: "note" }) });
    expect(first.status).toBe(200);
    const retry = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body: "first body", type: "note", idempotency_key: key }) });
    expect(retry.status).toBe(200);
    expect(retry.json.data).toEqual(first.json.data);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").bind(first.json.data?.id).first<{ n: number }>())?.n).toBe(1);
    const frontmatter = await (await testEnv().VAULT.get(`vault/${path}`))!.text();
    expect(frontmatter).toContain(`vault_idempotency: ${key}`);
    const differ = await rest("/v1/notes", writer, { method: "PUT", headers: { "idempotency-key": "one" }, body: JSON.stringify({ path, body: "x", type: "note", idempotency_key: "two" }) });
    expect(differ.status).toBe(400);
    expect(differ.json.error?.reasons).toContain("idempotency_key");
    expect((await rest("/v1/notes", writer, { method: "PUT", headers: { "idempotency-key": "bad key!" }, body: JSON.stringify({ path, body: "x", type: "note" }) })).status).toBe(400);
    const factKey = `fact-${nid()}`;
    const fact = { key: `idem-${nid()}`, statement: "Likes rain", observed_at: "2099-01-01T00:00:00Z", scope: "own" };
    const factFirst = await rest("/v1/facts", writer, { method: "POST", headers: { "idempotency-key": factKey }, body: JSON.stringify(fact) });
    const factRetry = await rest("/v1/facts", writer, { method: "POST", headers: { "idempotency-key": factKey }, body: JSON.stringify({ ...fact, statement: "Likes snow" }) });
    expect(factRetry.json.data).toEqual(factFirst.json.data);
    const forgetKey = `forget-${nid()}`;
    const forgotten = await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ path, reason: "done", idempotency_key: forgetKey }) });
    expect(forgotten.status).toBe(200);
    const forgetRetry = await rest("/v1/forget", writer, { method: "POST", headers: { "idempotency-key": forgetKey }, body: JSON.stringify({ path, reason: "done" }) });
    expect(forgetRetry.json.data).toEqual(forgotten.json.data);
    const mcpKey = `mcp-${nid()}`;
    const mcpPath = `shared/idem-mcp-${nid()}.md`;
    const viaMcp = await mcp(writer, "vault_write_note", { path: mcpPath, body: "mcp body", type: "note", idempotency_key: mcpKey });
    const viaMcpAgain = await mcp(writer, "vault_write_note", { path: mcpPath, body: "mcp body", type: "note", idempotency_key: mcpKey });
    expect(viaMcpAgain.json.data).toEqual(viaMcp.json.data);
    // A key is per agent: another agent's identical key is a different write.
    const otherPath = `shared/idem-other-${nid()}.md`;
    expect((await rest("/v1/notes", other, { method: "PUT", headers: { "idempotency-key": key }, body: JSON.stringify({ path: otherPath, body: "other", type: "note" }) })).json.data?.path).toBe(otherPath);
  });
});
