import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { clearAuthCache } from "../src/auth";

export const ADMIN = "test-admin-token-not-a-secret";

export type Envelope = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; reasons: string[] } & Record<string, unknown>;
  request_id?: string;
};

export function testEnv(): Env {
  return env as Env;
}

export function nid(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

export async function rest(path: string, token: string | null, init: RequestInit = {}): Promise<{ status: number; json: Envelope; text: string; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await SELF.fetch(`https://hiveattic.test${path}`, { ...init, headers });
  const text = await response.text();
  let json: Envelope = { ok: false };
  try {
    json = JSON.parse(text) as Envelope;
  } catch {
    json = { ok: false, error: { code: "invalid", message: "non-json response", reasons: [] } };
  }
  return { status: response.status, json, text, headers: response.headers };
}

export async function mcp(
  token: string,
  name: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: Envelope; text: string }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  const init = await SELF.fetch("https://hiveattic.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hiveattic-test", version: "0.1.0" } },
    }),
  });
  const initText = await init.text();
  if (init.status === 401) return { status: 401, json: parseRpc(initText), text: initText };
  const session = init.headers.get("mcp-session-id");
  const nextHeaders = session ? { ...headers, "mcp-session-id": session } : headers;
  await SELF.fetch("https://hiveattic.test/mcp", {
    method: "POST",
    headers: nextHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const response = await SELF.fetch("https://hiveattic.test/mcp", {
    method: "POST",
    headers: nextHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  return { status: response.status, json: toolEnvelope(text), text };
}

export async function mint(agentId: string, scopes: string[], label: string): Promise<string> {
  const response = await rest("/v1/admin/tokens", ADMIN, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, display_name: agentId, kind: "agent", scopes, label }),
  });
  if (response.status !== 200 || typeof response.json.data?.token !== "string") {
    throw new Error(`mint failed for ${agentId}: ${response.status} ${response.json.error?.code ?? ""}`);
  }
  return response.json.data.token;
}

export function writerStub(): DurableObjectStub {
  return testEnv().WRITER.get(testEnv().WRITER.idFromName("main"));
}

// Drives a writer job to its end. Each alarm runs one page, the way the deployed writer does.
export async function waitJob(id: string, limitMs = 120_000): Promise<Envelope> {
  const stop = Date.now() + limitMs;
  for (;;) {
    const job = await rest(`/v1/admin/jobs/${id}`, ADMIN);
    const status = job.json.data?.status;
    if (status === "done" || status === "failed") return job.json;
    if (Date.now() > stop) throw new Error(`job ${id} did not finish: ${job.text}`);
    await runDurableObjectAlarm(writerStub());
  }
}

// Starts a job through its route, expects 202, and waits for it.
export async function runJob(path = "/v1/admin/reindex", body: Record<string, unknown> = {}): Promise<{ started: Envelope; job: Envelope; requestId: string }> {
  const started = await rest(path, ADMIN, { method: "POST", body: JSON.stringify(body) });
  if (started.status !== 202 || typeof started.json.data?.job_id !== "string") throw new Error(`job did not start: ${started.status} ${started.text}`);
  const job = await waitJob(started.json.data.job_id);
  return { started: started.json, job, requestId: String(started.json.request_id) };
}

// Finishes any job a previous test left running, so the next start does not get 409 job_running.
export async function drainJobs(): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    const active = await runInWriter((state) =>
      state.storage.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE status IN ('queued', 'running') LIMIT 1").toArray()[0]?.id ?? null,
    );
    if (!active) return;
    await runDurableObjectAlarm(writerStub());
  }
}

export async function runInWriter<T>(work: (state: DurableObjectState) => T | Promise<T>): Promise<T> {
  return runInDurableObject(writerStub(), async (_instance: unknown, state: DurableObjectState) => work(state));
}

export async function resetVault(): Promise<void> {
  await drainJobs();
  clearAuthCache();
  const db = testEnv().DB;
  await db.batch([
    db.prepare("DELETE FROM links"),
    db.prepare("DELETE FROM journal_entries"),
    db.prepare("DELETE FROM note_versions"),
    db.prepare("DELETE FROM tombstones"),
    db.prepare("DELETE FROM conflicts"),
    db.prepare("DELETE FROM chunks"),
    db.prepare("DELETE FROM note_tags"),
    db.prepare("DELETE FROM vector_delete_queue"),
    db.prepare("DELETE FROM idempotency"),
    db.prepare("DELETE FROM rate_counters"),
    db.prepare("DELETE FROM notes"),
  ]);
  await db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')").run();
  await deletePrefix("vault/");
  await deletePrefix("sys/");
  const boot = await rest("/v1/admin/bootstrap", ADMIN, { method: "POST", body: "{}" });
  if (boot.status !== 200) throw new Error(`bootstrap failed: ${boot.status}`);
}

async function deletePrefix(prefix: string): Promise<void> {
  const bucket = testEnv().VAULT;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

function toolEnvelope(text: string): Envelope {
  const rpc = parseRpc(text) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };
  const payload = rpc.result?.content?.find((item) => item.text)?.text;
  if (payload) {
    try {
      return JSON.parse(payload) as Envelope;
    } catch {
      return { ok: false, error: { code: "invalid", message: "tool payload was not json", reasons: [] } };
    }
  }
  if (rpc.error) return { ok: false, error: { code: "invalid", message: "tool call failed", reasons: [] } };
  return { ok: false, error: { code: "invalid", message: "empty tool response", reasons: [] } };
}

function parseRpc(text: string): Envelope & { result?: unknown; error?: { message?: string } } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Envelope;
  const data = [...trimmed.matchAll(/^data:\s*(.+)$/gm)].map((match) => match[1]).filter((line) => line && line !== "[DONE]");
  const last = data.at(-1);
  if (!last) return { ok: false };
  return JSON.parse(last) as Envelope;
}

// Delivers one R2 event notification to the queue consumer, as the bucket would.
export async function deliverEvent(action: string, key: string, extra: Record<string, unknown> = {}): Promise<{ acked: boolean; retried: boolean }> {
  const { createExecutionContext, createMessageBatch, getQueueResult } = await import("cloudflare:test");
  const worker = (await import("../src/index")).default;
  const batch = createMessageBatch("hiveattic-index-jobs", [
    {
      id: nid(),
      timestamp: new Date(),
      attempts: 1,
      body: { account: "test", action, bucket: "hiveattic-vault", object: { key, size: 1, eTag: "event-etag" }, eventTime: new Date().toISOString(), ...extra },
    },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, testEnv(), ctx);
  const result = await getQueueResult(batch, ctx);
  return { acked: result.ackAll || result.explicitAcks.length > 0, retried: result.retryBatch.retry || result.retryMessages.length > 0 };
}

export function results(json: Envelope): { id?: string; path?: string }[] {
  const value = json.data?.results;
  return Array.isArray(value) ? (value as { id?: string; path?: string }[]) : [];
}

export function versionsOf(json: Envelope): { version_ts?: string; body?: string | null; reason?: string | null }[] {
  const value = json.data?.versions;
  return Array.isArray(value) ? (value as { version_ts?: string; body?: string | null; reason?: string | null }[]) : [];
}

export async function auditText(): Promise<string> {
  const rows = await testEnv().DB.prepare("SELECT * FROM audit_log").all();
  return JSON.stringify(rows.results ?? []);
}

// Counts the D1 and R2 round trips the writer makes while `work` runs. `fail` makes a matching
// statement fail, to test what a write or job does when D1 errors.
export type Stats = { d1Calls: number; d1Statements: number; r2Gets: number; r2Lists: number; sql: string[] };

export async function withInstrumentedWriter<T>(stats: Stats, work: () => Promise<T>, fail?: (sql: string) => boolean): Promise<T> {
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
