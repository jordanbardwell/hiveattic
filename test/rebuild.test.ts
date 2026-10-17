import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, mint, nid, resetVault, rest, testEnv } from "./helpers";

// A live T-12 reindex returned an error on a staging vault of roughly this size. These tests
// rebuild a vault that size, count the D1 and R2 round trips the writer makes, and check the
// audit trail a rebuild leaves for both outcomes.

type Stats = { d1Calls: number; d1Statements: number; r2Gets: number; r2Lists: number; sql: string[] };
type AuditRow = { action: string; outcome: string; reason_codes: string | null; detail: string | null; request_id: string };

let writer = "";
let financeRw = "";

beforeAll(async () => {
  writer = await mint("volume-writer", ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], "volume-writer");
  financeRw = await mint(
    "volume-finance",
    ["read:shared", "read:own", "write:own", "read:domain/finance", "write:domain/finance", "read:sensitive/finance", "write:sensitive/finance"],
    "volume-finance",
  );
});

describe("rebuild at realistic volume", () => {
  it("rebuilds about 150 notes with history in a bounded number of round trips and audits the result", async () => {
    await resetVault();
    const vault = await seedVault();
    const before = await snapshot(vault);

    const stats: Stats = { d1Calls: 0, d1Statements: 0, r2Gets: 0, r2Lists: 0, sql: [] };
    const rebuilt = await withInstrumentedWriter(stats, () => rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" }));
    console.log(`rebuild round trips: ${JSON.stringify({ ...stats, sql: undefined, ...rebuilt.json.data })}`);
    expect(rebuilt.status, rebuilt.text).toBe(200);

    const after = await snapshot(vault);
    expect(after.notes).toBe(before.notes);
    expect(after.search).toEqual(before.search);
    expect(after.journalRefs).toEqual(before.journalRefs);
    expect(after.history).toEqual(before.history);
    expect(after.statuses).toEqual(before.statuses);

    const data = rebuilt.json.data ?? {};
    expect(data.notes).toBe(before.notes);
    expect(data.files).toBe(before.notes);
    expect(data.versions).toBe(before.historyObjects);
    expect(data.tombstones).toBe(1);
    expect(typeof data.duration_ms).toBe("number");

    // Remote D1 and R2 calls each cost milliseconds from a Durable Object. A rebuild that issues one
    // query per chunk and one read per history file outruns the request deadline on a vault this size.
    expect(stats.d1Calls).toBeLessThan(40);
    expect(stats.r2Gets).toBeLessThanOrEqual(before.notes);
    expect(data.history_reads).toBe(0);

    const audits = await auditRows(String(rebuilt.json.request_id));
    expect(audits.map((row) => `${row.action}:${row.outcome}`)).toEqual(["reindex_started:ok", "reindex:ok"]);
    const detail = JSON.parse(audits[1]!.detail ?? "{}") as Record<string, unknown>;
    expect(detail.notes).toBe(before.notes);
    expect(detail.versions).toBe(before.historyObjects);
    expect(detail.files).toBe(before.notes);
    expect(detail.duration_ms).toBe(data.duration_ms);

    const retry = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify(vault.idempotent.body) });
    expect(retry.json.data?.entry_id).toBe(vault.idempotent.entryId);
    const prior = (await history(vault.updated[0]!)).find((version) => version.body?.includes("first draft"));
    const restored = await rest("/v1/admin/restore", ADMIN, { method: "POST", body: JSON.stringify({ path: vault.updated[0], version_ts: prior?.version_ts }) });
    expect(restored.status, restored.text).toBe(200);
    const appended = await rest("/v1/journal", writer, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: "after", body: `${vault.marker} after rebuild`, at: "2099-06-06T23:00:00Z" }),
    });
    expect(appended.status).toBe(200);
    const day = await rest(`/v1/notes?path=${encodeURIComponent(vault.dayPath)}`, writer);
    expect(String(day.json.data?.markdown)).toContain(`${vault.marker} entry 0`);
    expect(String(day.json.data?.markdown)).toContain(`${vault.marker} after rebuild`);
  }, 240_000);

  it("rebuilds from R2 alone when D1 has lost its version rows", async () => {
    await resetVault();
    const vault = await seedVault(40);
    const before = await snapshot(vault);
    await testEnv().DB.prepare("DELETE FROM note_versions").run();
    const stats: Stats = { d1Calls: 0, d1Statements: 0, r2Gets: 0, r2Lists: 0, sql: [] };
    const rebuilt = await withInstrumentedWriter(stats, () => rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" }));
    expect(rebuilt.status, rebuilt.text).toBe(200);
    expect(rebuilt.json.data?.versions).toBe(before.historyObjects);
    expect(rebuilt.json.data?.history_reads).toBe(before.historyObjects);
    const after = await snapshot(vault);
    expect(after.notes).toBe(before.notes);
    expect(after.search).toEqual(before.search);
    expect(after.history.map(({ note_id, version_ts, r2_key, content_hash }) => ({ note_id, version_ts, r2_key, content_hash }))).toEqual(
      before.history.map(({ note_id, version_ts, r2_key, content_hash }) => ({ note_id, version_ts, r2_key, content_hash })),
    );
    expect(after.history.every((row) => row.writer === "rebuild" && row.reason === "history")).toBe(true);
  }, 240_000);

  it("a failed rebuild leaves the live index alone and audits the failure with its phase and counts", async () => {
    await resetVault();
    const vault = await seedVault(20);
    const before = await snapshot(vault);
    const stats: Stats = { d1Calls: 0, d1Statements: 0, r2Gets: 0, r2Lists: 0, sql: [] };
    const rebuilt = await withInstrumentedWriter(stats, () => rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" }), (sql) =>
      /INSERT INTO notes SELECT/i.test(sql),
    );
    expect(rebuilt.status).toBe(400);
    const after = await snapshot(vault);
    expect(after.notes).toBe(before.notes);
    expect(after.search).toEqual(before.search);
    expect(after.history).toEqual(before.history);
    const audits = await auditRows(String(rebuilt.json.request_id));
    expect(audits.map((row) => `${row.action}:${row.outcome}`)).toEqual(["reindex_started:ok", "reindex:failed"]);
    const detail = JSON.parse(audits[1]!.detail ?? "{}") as Record<string, unknown>;
    expect(detail.phase).toBe("swap");
    expect(detail.files).toBe(before.notes);
    expect(typeof detail.duration_ms).toBe("number");
    expect(String(detail.error)).toContain("injected");
    const retry = await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" });
    expect(retry.status, retry.text).toBe(200);
    expect((await snapshot(vault)).search).toEqual(before.search);
  }, 240_000);

  // An Obsidian "duplicate file" copies the frontmatter: same vault_id, same fact key. Before the
  // rebuild staged ids and fact keys in memory, both copies were inserted and the swap failed on a key.
  it("duplicated files that share a vault_id or a fact key survive a rebuild after D1 lost the original", async () => {
    await resetVault();
    const marker = `qxtwin${nid()}`;
    const firstPath = `shared/twin-a-${nid()}.md`;
    const first = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: firstPath, body: `${marker} a`, type: "note" }) });
    expect(first.status).toBe(200);
    const id = String(first.json.data?.id);
    const copyPath = `shared/twin-b-${nid()}.md`;
    const original = await (await testEnv().VAULT.get(`vault/${firstPath}`))!.text();
    await testEnv().VAULT.put(`vault/${copyPath}`, original.replace(`${marker} a`, `${marker} b`), {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: { "vault-writer": "do", "vault-id": id },
    });
    const key = `twin-${nid()}`;
    const fact = await rest("/v1/facts", writer, {
      method: "POST",
      body: JSON.stringify({ key, statement: `${marker} fact`, observed_at: "2026-01-01T00:00:00Z", scope: "shared" }),
    });
    expect(fact.status).toBe(200);
    const factPath = String(fact.json.data?.path);
    const factCopy = `shared/${key}-copy.md`;
    await testEnv().VAULT.put(`vault/${factCopy}`, (await (await testEnv().VAULT.get(`vault/${factPath}`))!.text()).replace(/vault_id: .+\n/, ""), {
      httpMetadata: { contentType: "text/markdown" },
    });
    const db = testEnv().DB;
    await db.batch([
      db.prepare("DELETE FROM chunks WHERE note_id = ?").bind(id),
      db.prepare("DELETE FROM note_versions WHERE note_id = ?").bind(id),
      db.prepare("DELETE FROM links WHERE src_note_id = ?").bind(id),
      db.prepare("DELETE FROM notes WHERE id = ?").bind(id),
    ]);
    const rebuilt = await rest("/v1/admin/reindex", ADMIN, { method: "POST", body: "{}" });
    expect(rebuilt.status, rebuilt.text).toBe(200);
    const rows = await db.prepare("SELECT id, path, fact_key FROM notes WHERE path IN (?, ?, ?, ?)").bind(firstPath, copyPath, factPath, factCopy).all<{ id: string; path: string; fact_key: string | null }>();
    const byPath = new Map((rows.results ?? []).map((row) => [row.path, row]));
    expect(byPath.size).toBe(4);
    expect(new Set([byPath.get(firstPath)?.id, byPath.get(copyPath)?.id]).size).toBe(2);
    expect([byPath.get(firstPath)?.id, byPath.get(copyPath)?.id]).toContain(id);
    expect([byPath.get(factPath)?.fact_key, byPath.get(factCopy)?.fact_key].filter(Boolean)).toEqual([key]);
    const found = await rest(`/v1/search?q=${marker}`, writer);
    expect((found.json.data?.results as { path: string }[]).map((row) => row.path).filter((path) => path !== "profile/summary.md").sort()).toEqual([copyPath, factCopy, factPath, firstPath].sort());
  });
});

type Vault = {
  marker: string;
  paths: string[];
  updated: string[];
  dayPath: string;
  idempotent: { body: Record<string, unknown>; entryId: string };
};

async function seedVault(noteCount = 110): Promise<Vault> {
  const marker = `qxvol${nid()}`;
  const paths: string[] = [];
  const updated: string[] = [];
  for (let i = 0; i < noteCount; i++) {
    const path = `shared/volume/${marker}-${i}.md`;
    const body = `# Note ${i}\n\n${marker} first draft ${i}\n\n${"Some ordinary prose about the garden and the week. ".repeat(20 + (i % 5) * 20)}`;
    const created = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body, type: "note" }) });
    expect(created.status, created.text).toBe(200);
    paths.push(path);
    if (i % 3 === 0) {
      const next = await rest("/v1/notes", writer, {
        method: "PUT",
        body: JSON.stringify({ path, body: `# Note ${i}\n\n${marker} second draft ${i}\n\n[[shared/volume/${marker}-${i + 1}]]`, type: "note", if_match: created.json.data?.etag }),
      });
      expect(next.status, next.text).toBe(200);
      updated.push(path);
    }
  }
  const factCount = Math.max(4, Math.round(noteCount / 5));
  for (let i = 0; i < factCount; i++) {
    const key = `${marker}-fact-${i}`;
    const fact = await rest("/v1/facts", writer, {
      method: "POST",
      body: JSON.stringify({ key, statement: `${marker} fact ${i} old`, observed_at: "2026-01-01T00:00:00Z", scope: i % 2 ? "own" : "shared" }),
    });
    expect(fact.status, fact.text).toBe(200);
    paths.push(String(fact.json.data?.path));
    if (i % 2 === 0) {
      const newer = await rest("/v1/facts", writer, {
        method: "POST",
        body: JSON.stringify({ key, statement: `${marker} fact ${i} new`, observed_at: "2026-02-01T00:00:00Z", scope: "shared" }),
      });
      expect(newer.status, newer.text).toBe(200);
    }
  }
  let dayPath = "";
  for (let i = 0; i < 25; i++) {
    const entry = await rest("/v1/journal", writer, {
      method: "POST",
      body: JSON.stringify({ target: "shared", title: `entry ${i}`, body: `${marker} entry ${i}`, at: `2099-06-06T${String(10 + (i % 10)).padStart(2, "0")}:00:00Z` }),
    });
    expect(entry.status, entry.text).toBe(200);
    dayPath = String(entry.json.data?.path);
  }
  for (let i = 0; i < 5; i++) {
    const decision = await rest("/v1/journal", writer, {
      method: "POST",
      body: JSON.stringify({ target: "decisions", title: `decision ${i}`, body: `${marker} decision ${i}`, at: "2099-06-06T12:00:00Z" }),
    });
    expect(decision.status).toBe(200);
  }
  const idempotentBody = { target: "own", title: "once", body: `${marker} once`, at: "2099-06-07T12:00:00Z", idempotency_key: `${marker}-once` };
  const idem = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify(idempotentBody) });
  expect(idem.status).toBe(200);
  for (let i = 0; i < 3; i++) {
    const finance = await rest("/v1/notes", financeRw, {
      method: "PUT",
      body: JSON.stringify({ path: `domains/finance/${marker}-${i}.md`, body: `${marker} ledger ${i}`, type: "note" }),
    });
    expect(finance.status).toBe(200);
    paths.push(`domains/finance/${marker}-${i}.md`);
  }
  const sensitive = await rest("/v1/journal", writer, {
    method: "POST",
    body: JSON.stringify({ target: "own", title: "private", body: `${marker} private`, at: "2099-06-08T12:00:00Z", sensitivity: "sensitive" }),
  });
  expect(sensitive.status, sensitive.text).toBe(200);
  expect(String(sensitive.json.data?.path)).toContain("/journal-sensitive/");
  const forgotten = `shared/volume/${marker}-forgotten.md`;
  await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: forgotten, body: `${marker} forget me`, type: "note" }) });
  expect((await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ path: forgotten, reason: "volume" }) })).status).toBe(200);
  paths.push(forgotten, dayPath, "shared/decisions.md", String(idem.json.data?.path), String(sensitive.json.data?.path));
  return { marker, paths, updated, dayPath, idempotent: { body: idempotentBody, entryId: String(idem.json.data?.entry_id) } };
}

type VersionRow = { note_id: string; version_ts: string; r2_key: string; content_hash: string; writer: string; reason: string | null };

// Version rows that point at sys/history snapshots. Rows for created and updated point at the live
// object, which a rebuild cannot date, so they are not compared.
async function snapshot(vault: Vault): Promise<{
  notes: number;
  historyObjects: number;
  search: string[];
  journalRefs: string[];
  history: VersionRow[];
  statuses: string[];
}> {
  const db = testEnv().DB;
  const notes = (await db.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>())?.n ?? 0;
  const search = (await db.prepare("SELECT n.path AS path FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid JOIN notes n ON n.id = c.note_id WHERE chunks_fts MATCH ? ORDER BY n.path, c.n").bind(vault.marker).all<{ path: string }>()).results?.map((row) => row.path) ?? [];
  const journalRefs = (await db.prepare("SELECT block_ref FROM journal_entries ORDER BY block_ref").all<{ block_ref: string }>()).results?.map((row) => row.block_ref) ?? [];
  const history =
    (await db.prepare("SELECT note_id, version_ts, r2_key, content_hash, writer, reason FROM note_versions WHERE r2_key LIKE 'sys/history/%' ORDER BY note_id, version_ts").all<VersionRow>())
      .results ?? [];
  const statuses = (await db.prepare("SELECT path || ':' || status || ':' || sensitivity AS s FROM notes ORDER BY path").all<{ s: string }>()).results?.map((row) => row.s) ?? [];
  let historyObjects = 0;
  let cursor: string | undefined;
  do {
    const page = await testEnv().VAULT.list({ prefix: "sys/history/", cursor });
    historyObjects += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { notes, historyObjects, search, journalRefs, history, statuses };
}

async function history(path: string): Promise<{ version_ts?: string; body?: string }[]> {
  return ((await rest(`/v1/history?path=${encodeURIComponent(path)}`, ADMIN)).json.data?.versions ?? []) as { version_ts?: string; body?: string }[];
}

async function auditRows(requestId: string): Promise<AuditRow[]> {
  const rows = await testEnv().DB.prepare("SELECT action, outcome, reason_codes, detail, request_id FROM audit_log WHERE request_id = ? ORDER BY seq").bind(requestId).all<AuditRow>();
  return rows.results ?? [];
}

// Swaps the writer's D1 and R2 bindings for counting wrappers while \`work\` runs. \`fail\` makes a
// matching statement throw, to prove a failed rebuild leaves the live tables alone.
async function withInstrumentedWriter<T>(stats: Stats, work: () => Promise<T>, fail?: (sql: string) => boolean): Promise<T> {
  const stub = env.WRITER.get(env.WRITER.idFromName("main"));
  let original: Env | undefined;
  await runInDurableObject(stub, (instance) => {
    const holder = instance as unknown as { env: Env };
    original = holder.env;
    holder.env = { ...original, DB: countingD1(original.DB, stats, fail), VAULT: countingR2(original.VAULT, stats) } as Env;
  });
  try {
    return await work();
  } finally {
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Env }).env = original!;
    });
  }
}

function countingD1(db: D1Database, stats: Stats, fail?: (sql: string) => boolean): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => {
            stats.d1Calls += 1;
            stats.d1Statements += 1;
            stats.sql.push(sql);
            if (fail?.(sql)) return Promise.reject(new Error("injected failure"));
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, statement);
    sqlOf.set(proxy, sql);
    return proxy;
  };
  const sqlOf = new WeakMap<object, string>();
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          stats.d1Calls += 1;
          stats.d1Statements += statements.length;
          const sqls = statements.map((statement) => sqlOf.get(statement) ?? "");
          stats.sql.push(...sqls);
          if (fail && sqls.some((sql) => fail(sql))) return Promise.reject(new Error("injected failure"));
          return target.batch(statements.map((statement) => real.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function countingR2(bucket: R2Bucket, stats: Stats): R2Bucket {
  return new Proxy(bucket, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (prop === "get") stats.r2Gets += 1;
        if (prop === "list") stats.r2Lists += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
