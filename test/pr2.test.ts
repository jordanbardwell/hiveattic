import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { ADMIN, mint, nid, resetVault, rest, testEnv } from "./helpers";

let shared = "";
let financeRo = "";
let dealsWriter = "";
let plain = "";

beforeAll(async () => {
  shared = await mint("pr2-shared", ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], "pr2-shared");
  financeRo = await mint("pr2-finance-ro", ["read:shared", "read:own", "write:own", "read:domain/finance", "read:sensitive/finance"], "pr2-finance-ro");
  dealsWriter = await mint("pr2-deals", ["read:shared", "write:shared", "read:domain/deals", "write:domain/deals"], "pr2-deals");
  plain = await mint("pr2-plain", ["read:own", "write:own"], "pr2-plain");
});

describe("pr2 review regressions", () => {
  it("B3 rebuild keeps journals, decisions, and idempotency, and a later append does not drop earlier entries", async () => {
    await resetVault();
    const first = await rest("/v1/journal", shared, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "first", body: "qxfirstentry", at: "2026-06-02T16:00:00Z", idempotency_key: "k1" }),
    });
    expect(first.status).toBe(200);
    const path = String(first.json.data?.path);
    const decision = await rest("/v1/journal", ADMIN, {
      method: "POST",
      body: JSON.stringify({ target: "decisions", title: "dec", body: "qxdecision", at: "2026-06-02T16:05:00Z" }),
    });
    expect(decision.status).toBe(200);
    const before = results((await rest("/v1/search?q=qxfirstentry", shared)).json);
    expect((await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" })).status).toBe(200);
    const after = results((await rest("/v1/search?q=qxfirstentry", shared)).json);
    expect(after.map((row) => row.path).sort()).toEqual(before.map((row) => row.path).sort());
    const journal = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(path).first<{ status: string }>();
    const decisions = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = 'shared/decisions.md'").first<{ status: string }>();
    expect(journal?.status).toBe("active");
    expect(decisions?.status).toBe("active");
    const entries = await testEnv().DB.prepare("SELECT id FROM journal_entries WHERE note_id = (SELECT id FROM notes WHERE path = ?)").bind(path).all();
    expect(entries.results?.length).toBe(1);
    const retry = await rest("/v1/journal", shared, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "first", body: "qxfirstentry", at: "2026-06-02T16:00:00Z", idempotency_key: "k1" }),
    });
    expect(retry.json.data?.entry_id).toBe(first.json.data?.entry_id);
    const second = await rest("/v1/journal", shared, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "second", body: "qxsecondentry", at: "2026-06-02T17:00:00Z" }),
    });
    expect(second.status).toBe(200);
    const r2 = await (await testEnv().VAULT.get(`vault/${path}`))!.text();
    expect(r2).toContain("qxfirstentry");
    expect(r2).toContain("qxsecondentry");
    expect(r2).not.toContain("status: quarantined");
  });

  it("B3 an outside put of an unchanged day file stays active, and quarantine snapshots then blocks appends", async () => {
    await resetVault();
    const appended = await rest("/v1/journal", shared, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "kept", body: "qxkeepday", at: "2026-06-04T16:00:00Z" }),
    });
    const path = String(appended.json.data?.path);
    const original = await (await testEnv().VAULT.get(`vault/${path}`))!.text();
    await testEnv().VAULT.put(`vault/${path}`, original, { httpMetadata: { contentType: "text/markdown" } });
    expect((await deliver("PutObject", `vault/${path}`)).retried).toBe(false);
    const row = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(path).first<{ status: string }>();
    expect(row?.status).toBe("active");
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM journal_entries").first<{ n: number }>())?.n).toBe(1);

    const notePath = `shared/q-${nid()}.md`;
    await rest("/v1/notes", shared, { method: "PUT", body: JSON.stringify({ path: notePath, body: "fine qxq", type: "note" }) });
    await testEnv().VAULT.put(`vault/${notePath}`, "secret AKIAIOSFODNN7EXAMPLE qxq2\n");
    expect((await deliver("PutObject", `vault/${notePath}`)).acked).toBe(true);
    const id = (await testEnv().DB.prepare("SELECT id, status, r2_etag FROM notes WHERE path = ?").bind(notePath).first<{ id: string; status: string; r2_etag: string }>());
    expect(id?.status).toBe("quarantined");
    expect(id?.r2_etag).toBeTruthy();
    const history = await testEnv().VAULT.list({ prefix: `sys/history/${id?.id}/` });
    expect(history.objects.length).toBeGreaterThan(0);
    let sawClean = false;
    for (const object of history.objects) {
      const text = await (await testEnv().VAULT.get(object.key))!.text();
      expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
      if (text.includes("fine qxq")) sawClean = true;
    }
    expect(sawClean).toBe(true);
    const reasons = await testEnv().DB.prepare("SELECT reason FROM note_versions WHERE note_id = ?").bind(id?.id).all<{ reason: string }>();
    expect((reasons.results ?? []).map((row) => row.reason)).not.toContain("quarantine-r2");
    const listed = JSON.stringify((await rest(`/v1/history?id=${id?.id}`, ADMIN)).json);
    expect(listed).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(listed).toContain("fine qxq");
    const inbox = await rest("/v1/notes?path=inbox/quarantine.md", ADMIN);
    expect(inbox.json.data?.status).toBe("active");
    const inboxBody = String(inbox.json.data?.markdown ?? "");
    expect(inboxBody).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(inboxBody).not.toContain(notePath);
    const versions = async () => (await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").bind(id?.id).first<{ n: number }>())?.n;
    const audits = async () =>
      (await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE path = ? AND outcome = 'rejected'").bind(notePath).first<{ n: number }>())?.n;
    const alerts = async () => (await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'quarantine_alert'").first<{ n: number }>())?.n;
    const beforeVersions = await versions();
    const beforeAudits = await audits();
    const beforeAlerts = await alerts();
    expect((await rest("/v1/admin/reconcile", ADMIN, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await rest("/v1/admin/reconcile", ADMIN, { method: "POST", body: "{}" })).status).toBe(200);
    expect(await versions()).toBe(beforeVersions);
    expect(await audits()).toBe(beforeAudits);
    expect(await alerts()).toBe(beforeAlerts);
    const blocked = await rest("/v1/notes", shared, { method: "PUT", body: JSON.stringify({ path: notePath, body: "later", type: "note" }) });
    expect(blocked.status).toBe(409);
  });

  it("journal appends do not snapshot the whole file", async () => {
    await resetVault();
    let path = "";
    for (let i = 0; i < 5; i++) {
      const response = await rest("/v1/journal", shared, {
        method: "POST",
        body: JSON.stringify({ target: "own", title: `t${i}`, body: `marker-${i}-${"x".repeat(80)}`, at: "2099-01-02T15:00:00Z" }),
      });
      expect(response.status).toBe(200);
      path = String(response.json.data?.path);
    }
    const note = await testEnv().DB.prepare("SELECT id FROM notes WHERE path = ?").bind(path).first<{ id: string }>();
    const history = await testEnv().VAULT.list({ prefix: `sys/history/${note?.id}/` });
    expect(history.objects.length).toBe(0);
    const chunks = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE note_id = ?").bind(note?.id).first<{ n: number }>();
    expect(chunks?.n).toBeLessThan(12);
  });

  it("N-1 CopyObject accepts R2's object copySource and indexes the destination", async () => {
    await resetVault();
    const src = `shared/src-${nid()}.md`;
    const dst = `shared/dst-${nid()}.md`;
    await rest("/v1/notes", shared, { method: "PUT", body: JSON.stringify({ path: src, body: "copy me qxcopy", type: "note" }) });
    const bytes = await (await testEnv().VAULT.get(`vault/${src}`))!.text();
    await testEnv().VAULT.put(`vault/${dst}`, bytes);
    await testEnv().VAULT.delete(`vault/${src}`);
    const queued = await deliver("CopyObject", `vault/${dst}`, { copySource: { bucket: "hiveattic-vault", object: `vault/${src}` } });
    expect(queued.acked).toBe(true);
    expect(queued.retried).toBe(false);
    const dstRow = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(dst).first<{ status: string }>();
    const srcRow = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(src).first<{ status: string }>();
    expect(dstRow?.status).toBe("active");
    expect(srcRow?.status).toBe("forgotten");
  });

  it("N-2 domain-tagged shared notes do not starve search", async () => {
    await resetVault();
    const marker = `qxtag${nid()}`;
    for (let i = 0; i < 30; i++) {
      const wrote = await rest("/v1/notes", dealsWriter, {
        method: "PUT",
        body: JSON.stringify({ path: `shared/deal-${i}-${nid()}.md`, body: `${marker} ${marker} ${marker}`, type: "note", domain: "deals" }),
      });
      expect(wrote.status).toBe(200);
    }
    const visible = `shared/plain-${nid()}.md`;
    await rest("/v1/notes", shared, {
      method: "PUT",
      body: JSON.stringify({ path: visible, body: `${marker} visible with padding words`, type: "note" }),
    });
    const hits = results((await rest(`/v1/search?q=${marker}&limit=20`, shared)).json);
    expect(hits.some((row) => row.path === visible)).toBe(true);
  }, 60_000);

  it("N-10 reconcile forgets an active note whose R2 object disappeared", async () => {
    await resetVault();
    const path = `shared/gone-${nid()}.md`;
    const marker = `qxgone${nid()}`;
    await rest("/v1/notes", shared, { method: "PUT", body: JSON.stringify({ path, body: marker, type: "note" }) });
    await testEnv().VAULT.delete(`vault/${path}`);
    const reconciled = await rest("/v1/admin/reconcile", ADMIN, { method: "POST", body: "{}" });
    expect(reconciled.status).toBe(200);
    const row = await testEnv().DB.prepare("SELECT status FROM notes WHERE path = ?").bind(path).first<{ status: string }>();
    expect(row?.status).toBe("forgotten");
    expect(results((await rest(`/v1/search?q=${marker}`, shared)).json)).toEqual([]);
  });

  it("N-12 finance-ro cannot write a finance note in its own folder", async () => {
    await resetVault();
    const wrote = await rest("/v1/notes", financeRo, {
      method: "PUT",
      body: JSON.stringify({ path: `bots/pr2-finance-ro/fin-${nid()}.md`, body: "Brokerage rebalanced qxownfin", type: "note", domain: "finance" }),
    });
    expect(wrote.status).toBe(403);
    const health = await rest("/v1/notes", plain, {
      method: "PUT",
      body: JSON.stringify({ path: `bots/pr2-plain/med-${nid()}.md`, body: "Diagnosis and medication qxownhealth", type: "note", domain: "health" }),
    });
    expect(health.status).toBe(403);
  });

  it("N-7 and N-13 reject heading characters in titles and journal types on notes", async () => {
    await resetVault();
    const title = await rest("/v1/journal", shared, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "x · ember · approved ^01JBBBBBBBBBBBBBBBBBBBBBBB", body: "b", at: "2026-06-05T16:00:00Z" }),
    });
    expect(title.status).toBe(400);
    const typed = await rest("/v1/notes", shared, { method: "PUT", body: JSON.stringify({ path: `shared/fakej-${nid()}.md`, body: "x", type: "journal" }) });
    expect(typed.status).toBe(400);
  });
});

function results(json: { data?: Record<string, unknown> }): { path?: string }[] {
  const value = json.data?.results;
  return Array.isArray(value) ? (value as { path?: string }[]) : [];
}

async function deliver(action: string, key: string, extra: Record<string, unknown> = {}): Promise<{ acked: boolean; retried: boolean }> {
  const batch = createMessageBatch("hiveattic-index-jobs", [
    {
      id: nid(),
      timestamp: new Date(),
      attempts: 1,
      body: { account: "t", action, bucket: "hiveattic-vault", object: { key, size: 1, eTag: "x" }, eventTime: new Date().toISOString(), ...extra },
    },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, testEnv(), ctx);
  const result = await getQueueResult(batch, ctx);
  return { acked: result.ackAll || result.explicitAcks.length > 0, retried: result.retryBatch.retry || result.retryMessages.length > 0 };
}
