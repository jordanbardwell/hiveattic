import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hmacSha256Hex, sha256Hex } from "../src/crypto";
import worker from "../src/index";
import { ADMIN, auditText, mint, nid, resetVault, rest, results, runInWriter, runJob, testEnv, waitJob } from "./helpers";

// T-16. The one-time migration that retires the old quarantine. It erases quarantined notes and
// every quarantine record, and touches nothing else.

const AUDIT_KEY = "hiveattic-test-audit-key";
let writer = "";

beforeAll(async () => {
  writer = await mint("q-writer", ["read:shared", "read:own", "write:own", "write:shared"], "q-writer");
});

type Seeded = {
  id: string;
  path: string;
  secret: string;
  sentinel: string;
  sentinelId: string;
  fixed: string;
  lost: string;
  lostId: string;
  historyKey: string;
};

// The shape the old filter left behind: the original text still in the vault object, a stub row in
// D1 with status quarantined, history snapshots, a record per hit, and the inbox alert file.
async function seed(): Promise<Seeded> {
  const n = nid();
  const id = `01QUAR${n.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0").padEnd(20, "0").slice(0, 20)}`;
  const path = `shared/a-${n}.md`;
  const secret = `sk-live-qxsecret${n}`;
  const original = `---\nvault_id: ${id}\n---\nkey ${secret}\n`;
  const put = await testEnv().VAULT.put(`vault/${path}`, original, { httpMetadata: { contentType: "text/markdown" } });
  const historyKey = `sys/history/${id}/20260101T000000000Z0000-${(await sha256Hex("earlier")).slice(0, 8)}.md`;
  await testEnv().VAULT.put(historyKey, "earlier clean version");
  const now = new Date().toISOString();
  const stub = `---\nvault_id: ${id}\nstatus: quarantined\nsensitivity: sensitive\n---\nThis note was quarantined by the content filter.\n`;
  await testEnv().DB.batch([
    testEnv().DB.prepare(
      `INSERT INTO notes (id, path, type, owner, sensitivity, title, body, frontmatter, content_hash, r2_etag, r2_key, status, created_at, updated_at, last_writer)
       VALUES (?, ?, 'note', 'shared', 'sensitive', ?, ?, '{}', ?, ?, ?, 'quarantined', ?, ?, 'external')`,
    ).bind(id, path, path, stub, await sha256Hex(stub), put.etag, `vault/${path}`, now, now),
    testEnv().DB.prepare("INSERT INTO note_versions (note_id, version_ts, r2_key, content_hash, writer, reason) VALUES (?, '20260101T000000000Z0000', ?, 'abc', 'external', 'quarantine')").bind(id, historyKey),
  ]);
  const hash = await hmacSha256Hex(AUDIT_KEY, original);
  await testEnv().VAULT.put(`sys/quarantine/${hash}.json`, JSON.stringify({ path, at: now, reason_codes: ["secret_openai"], content_hash: hash, agent_id: "external" }));
  // Same name in another folder. Exact matching must leave it alone.
  const sentinel = `bots/q-${n}/${path}`;
  const sentinelWrite = await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: sentinel, body: "sentinel qxsentinel one", type: "note" }) });
  await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: sentinel, body: "sentinel qxsentinel two", type: "note", if_match: sentinelWrite.json.data?.etag }) });
  // A record for a note that was edited clean later: an orphan. The note stays.
  const fixed = `shared/fixed-${n}.md`;
  await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: fixed, body: "clean now qxfixed", type: "note" }) });
  await testEnv().VAULT.put(`sys/quarantine/orphan-${n}.json`, JSON.stringify({ path: fixed, at: now, reason_codes: ["secret_aws"], content_hash: "0".repeat(64) }));
  // A record that does not parse is an error, never a match.
  await testEnv().VAULT.put(`sys/quarantine/garbage-${n}.json`, "not json at all");
  // A quarantined file with no D1 row left: matched by its exact path and an HMAC of the object.
  const lost = `shared/lost-${n}.md`;
  const lostId = `01LOST${id.slice(6)}`;
  const lostText = `---\nvault_id: ${lostId}\n---\npassword: qxlost${n}\n`;
  await testEnv().VAULT.put(`vault/${lost}`, lostText);
  await testEnv().VAULT.put(`sys/history/${lostId}/20260101T000000000Z0000-00000000.md`, "lost history");
  const lostHash = await hmacSha256Hex(AUDIT_KEY, lostText);
  await testEnv().VAULT.put(`sys/quarantine/${lostHash}.json`, JSON.stringify({ path: lost, at: now, reason_codes: ["secret_password"], content_hash: lostHash }));
  await rest("/v1/notes", ADMIN, { method: "PUT", body: JSON.stringify({ path: "inbox/quarantine.md", body: `# Quarantine\n\n## ${now} · quarantine\nHash ${hash}.`, type: "note" }) });
  return { id, path, secret, sentinel, sentinelId: String(sentinelWrite.json.data?.id), fixed, lost, lostId, historyKey };
}

async function clearRetiredFlag(): Promise<void> {
  await runInWriter((state) => state.storage.sql.exec("DELETE FROM writer_state WHERE key = 'quarantine_retired_at'"));
}

async function useStaging<T>(work: () => Promise<T>): Promise<T> {
  const env = testEnv();
  const saved = { E: env.ENVIRONMENT, D: env.DEPLOY_ENV, B: env.VAULT_BUCKET, N: env.DB_NAME, W: env.WORKER_NAME };
  Object.assign(env, { ENVIRONMENT: "staging", DEPLOY_ENV: "staging", VAULT_BUCKET: "hiveattic-staging-vault", DB_NAME: "hiveattic-staging-index", WORKER_NAME: "hiveattic-staging" });
  try {
    return await work();
  } finally {
    Object.assign(env, { ENVIRONMENT: saved.E, DEPLOY_ENV: saved.D, VAULT_BUCKET: saved.B, DB_NAME: saved.N, WORKER_NAME: saved.W });
  }
}

describe("T-16 quarantine erase migration", () => {
  it("rebuild, reconcile, and the nightly cron refuse to start while quarantine records exist", async () => {
    await resetVault();
    await clearRetiredFlag();
    await seed();
    for (const [path, body] of [
      ["/v1/admin/reindex", {}],
      ["/v1/admin/rebuild", {}],
      ["/v1/admin/reconcile", {}],
      ["/v1/admin/jobs", { kind: "rebuild" }],
    ] as const) {
      const refused = await rest(path, ADMIN, { method: "POST", body: JSON.stringify(body) });
      expect(refused.status, path).toBe(409);
      expect(refused.json.error?.code).toBe("migration_required");
    }
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "15 7 * * *" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const skipped = await testEnv().DB.prepare("SELECT outcome, reason_codes FROM audit_log WHERE action = 'reconcile_skipped' ORDER BY seq DESC LIMIT 1").first<{ outcome: string; reason_codes: string }>();
    expect(skipped).toEqual({ outcome: "skipped", reason_codes: JSON.stringify(["migration_required"]) });
    const jobs = await runInWriter((state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind != 'quarantine-erase' AND status IN ('queued', 'running')").toArray()[0]?.n);
    expect(jobs).toBe(0);
  });

  it("a dry run counts and erases nothing; the job shows counts only and the admin report lists what matched", async () => {
    await resetVault();
    await clearRetiredFlag();
    const seeded = await seed();
    const dry = await runJob("/v1/admin/migrations/quarantine-erase", { dry_run: true });
    expect(dry.job.data?.status).toBe("done");
    expect(dry.job.data?.dry_run).toBe(true);
    expect(dry.job.data?.counts).toMatchObject({ quarantined_notes: 1, records: 4, unindexed_matches: 1, errors: 1, orphans_deleted: 1, alert_file: 1, erased: 0, total: 5 });
    const shown = JSON.stringify(dry.job);
    expect(shown).not.toContain(seeded.path);
    expect(shown).not.toContain(seeded.lost);
    const report = await rest(`/v1/admin/jobs/${dry.job.data?.job_id}/report`, ADMIN);
    expect(report.json.data?.paths).toEqual([seeded.path, seeded.lost]);
    expect(report.json.data?.note_ids).toEqual([seeded.id, seeded.lostId]);
    expect(await testEnv().VAULT.head(`vault/${seeded.path}`)).toBeTruthy();
    expect((await testEnv().VAULT.list({ prefix: "sys/quarantine/" })).objects.length).toBe(4);
    expect((await testEnv().DB.prepare("SELECT status FROM notes WHERE id = ?").bind(seeded.id).first<{ status: string }>())?.status).toBe("quarantined");
    expect((await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" })).status).toBe(409);
  });

  it("on production the erase needs confirm_count equal to the current count, then erases only quarantined content", async () => {
    await resetVault();
    await clearRetiredFlag();
    const seeded = await seed();
    const missing = await rest("/v1/admin/migrations/quarantine-erase", ADMIN, { method: "POST", body: "{}" });
    expect(missing.status).toBe(409);
    expect(missing.json.error).toMatchObject({ code: "count_mismatch", reasons: ["current_count:5"] });
    const wrong = await rest("/v1/admin/migrations/quarantine-erase", ADMIN, { method: "POST", body: JSON.stringify({ confirm_count: 4 }) });
    expect(wrong.json.error?.code).toBe("count_mismatch");
    const erase = await runJob("/v1/admin/migrations/quarantine-erase", { confirm_count: 5 });
    expect(erase.job.data?.status, JSON.stringify(erase.job)).toBe("done");
    expect(erase.job.data?.counts).toMatchObject({ quarantined_notes: 1, unindexed_matches: 1, erased: 2, records: 4, errors: 1, alert_file: 1 });
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE status = 'quarantined'").first<{ n: number }>())?.n).toBe(0);
    expect((await testEnv().VAULT.list({ prefix: "sys/quarantine/" })).objects).toEqual([]);
    for (const key of [`vault/${seeded.path}`, `vault/${seeded.lost}`, seeded.historyKey, "vault/inbox/quarantine.md"]) expect(await testEnv().VAULT.head(key), key).toBeNull();
    expect((await testEnv().VAULT.list({ prefix: `sys/history/${seeded.id}/` })).objects).toEqual([]);
    expect((await testEnv().VAULT.list({ prefix: `sys/history/${seeded.lostId}/` })).objects).toEqual([]);
    for (const table of ["notes WHERE id = ?", "note_versions WHERE note_id = ?", "chunks WHERE note_id = ?"]) {
      expect(await testEnv().DB.prepare(`SELECT 1 FROM ${table}`).bind(seeded.id).first(), table).toBeNull();
    }
    expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = 'inbox/quarantine.md'").first()).toBeNull();
    const tombstone = await testEnv().DB.prepare("SELECT reason, content_hash FROM tombstones WHERE note_id = ?").bind(seeded.id).first<{ reason: string; content_hash: string }>();
    expect(tombstone?.reason).toBe("quarantine_retired");
    expect(tombstone?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // Exact matching: the sentinel with the same file name in another folder, and the clean note, survive with their history.
    expect((await rest(`/v1/notes?path=${encodeURIComponent(seeded.sentinel)}`, ADMIN)).json.data?.status).toBe("active");
    expect((await testEnv().VAULT.list({ prefix: `sys/history/${seeded.sentinelId}/` })).objects.length).toBeGreaterThan(0);
    expect((await rest(`/v1/notes?path=${encodeURIComponent(seeded.fixed)}`, writer)).json.data?.status).toBe("active");
    const audit = await testEnv().DB.prepare("SELECT action, detail FROM audit_log WHERE request_id = ? ORDER BY seq").bind(erase.requestId).all<{ action: string; detail: string }>();
    expect(audit.results?.map((row) => row.action)).toEqual(["quarantine_erase_started", "quarantine_erase"]);
    const detail = JSON.parse(audit.results![1]!.detail) as Record<string, unknown>;
    expect(detail.note_ids).toEqual([seeded.id, seeded.lostId]);
    expect(audit.results![1]!.detail).not.toContain(seeded.path);
    expect(await auditText()).not.toContain(seeded.secret);
    // A second run finds nothing.
    const again = await runJob("/v1/admin/migrations/quarantine-erase", { confirm_count: 0 });
    expect(again.job.data?.counts).toMatchObject({ erased: 0, records: 0, quarantined_notes: 0, total: 0 });
    // Rebuild is allowed now and brings nothing back.
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path IN (?, ?)").bind(seeded.path, seeded.lost).first()).toBeNull();
    expect(results((await rest(`/v1/search?q=${seeded.secret}`, ADMIN)).json)).toEqual([]);
    // After the migration, a stray record is an orphan that rebuild deletes and audits.
    await testEnv().VAULT.put("sys/quarantine/stray.json", JSON.stringify({ path: "shared/none.md" }));
    const rebuilt = await runJob("/v1/admin/reindex");
    expect(rebuilt.job.data?.counts).toMatchObject({ orphans_deleted: 1 });
    expect((await testEnv().VAULT.list({ prefix: "sys/quarantine/" })).objects).toEqual([]);
    expect(await testEnv().DB.prepare("SELECT 1 FROM audit_log WHERE action = 'quarantine_orphans_deleted'").first()).toBeTruthy();
  });

  it("on staging the erase runs without confirm_count, a concurrent start gets 409 with the running job id, and the retire-quarantine alias maps report and apply", async () => {
    await resetVault();
    await clearRetiredFlag();
    const seeded = await seed();
    await useStaging(async () => {
      for (const bad of ["{}", JSON.stringify({ mode: "delete" }), "not json"]) {
        expect((await rest("/v1/admin/migrations/retire-quarantine", ADMIN, { method: "POST", body: bad })).status, bad).toBe(400);
      }
      expect((await rest("/v1/admin/migrations/quarantine-erase", ADMIN, { method: "POST", body: JSON.stringify({ dry_run: "yes" }) })).status).toBe(400);
      expect((await rest("/v1/admin/migrations/quarantine-erase", writer, { method: "POST", body: "{}" })).status).toBe(403);
      const report = await rest("/v1/admin/migrations/retire-quarantine", ADMIN, { method: "POST", body: JSON.stringify({ mode: "report" }) });
      expect(report.status).toBe(202);
      const running = String(report.json.data?.job_id);
      const concurrent = await rest("/v1/admin/migrations/retire-quarantine", ADMIN, { method: "POST", body: JSON.stringify({ mode: "apply" }) });
      expect(concurrent.status).toBe(409);
      expect(concurrent.json.error).toMatchObject({ code: "job_running", job_id: running });
      expect((await rest(`/v1/admin/jobs/${running}`, writer)).status).toBe(403);
      const reported = await waitJob(running);
      expect(reported.data).toMatchObject({ dry_run: true, status: "done" });
      expect(await testEnv().VAULT.head(`vault/${seeded.path}`)).toBeTruthy();
      const applied = await runJob("/v1/admin/migrations/retire-quarantine", { mode: "apply" });
      expect(applied.job.data).toMatchObject({ dry_run: false, status: "done" });
      expect(applied.job.data?.counts).toMatchObject({ erased: 2 });
      expect(await testEnv().VAULT.head(`vault/${seeded.path}`)).toBeNull();
      expect((await rest(`/v1/notes?path=${encodeURIComponent(seeded.sentinel)}`, ADMIN)).json.data?.status).toBe("active");
    });
  });
});
