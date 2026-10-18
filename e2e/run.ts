import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Status = "passed" | "failed" | "skipped" | "partial";
// One HTTP or MCP response a check looked at. status is null for MCP, which has no HTTP status per tool call.
type SubResponse = { label: string; via: "rest" | "mcp"; status: number | null; ok: boolean; error_code: string | null; request_id: string | null };
type Check = { name: string; status: Status; detail?: string; responses: SubResponse[] };
type Case = { id: string; status: Status; details: string; duration_ms: number; checks: Check[] };

// Staging only, and fail-closed. The harness reads HIVEATTIC_STAGING_* names and nothing else for
// its target and tokens. It never falls back to an unprefixed name, and it refuses to start when
// one of the production names is set at all, so a stray prod token in the shell cannot be used.
// The one exception is the run plan's own mapping: HIVEATTIC_REVIEWER_TOKEN may be set when it is
// the same value as HIVEATTIC_STAGING_REVIEWER_TOKEN (compared here, never printed). It is still
// never read.
const PROD_NAMED = ["HIVEATTIC_BASE_URL", "HIVEATTIC_ADMIN_TOKEN", "HIVEATTIC_REVIEWER_TOKEN", "HIVEATTIC_E2E_READ_ONLY", "HIVEATTIC_E2E_MODE", "HIVEATTIC_CF_API"];
const PROD_HOSTS = new Set(["hiveattic.example.workers.dev", "hiveattic.com", "vault.hiveattic.com"]);
const stagingBase = (process.env.HIVEATTIC_STAGING_BASE_URL ?? "").trim().replace(/\/$/, "");
const stagingAdmin = process.env.HIVEATTIC_STAGING_ADMIN_TOKEN ?? "";
const suppliedReviewer = process.env.HIVEATTIC_STAGING_REVIEWER_TOKEN ?? "";
const outPath = process.env.HIVEATTIC_E2E_OUT ?? "e2e-results/results.json";
const writeRoot = stagingBase;
const admin = stagingAdmin;
// The only wrangler command the harness runs is a tail of the staging worker, and it names this config.
const STAGING_CONFIG = process.env.HIVEATTIC_STAGING_WRANGLER_CONFIG?.trim() || "wrangler.staging.example.jsonc";
const JOB_CEILING_MS = 10 * 60 * 1000;

const dryRun = process.argv.includes("--dry-run") || process.env.HIVEATTIC_E2E_DRY_RUN === "1";
const runId = `e2e${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const cases: Case[] = [];
const minted: { id: string }[] = [];
let reviewer = suppliedReviewer;
let readerX = "";
let financeRw = "";
let financeRo = "";
let chief = "";
let sharedWriter = "";
let sharedReader = "";
let healthReader = "";
let dlqDepth: number | null = null;
let stagingOk = false;
let exitCode = 0;
let tailChild: ChildProcess | null = null;
let tailText = "";

class StopRun extends Error {
  exitStatus: number;
  constructor(exitStatus: number, message: string) {
    super(message);
    this.exitStatus = exitStatus;
  }
}

// A staging target is the hiveattic-staging workers.dev host over https. A dry run talks to a local mock only.
function stagingUrlProblem(raw: string, dry: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "HIVEATTIC_STAGING_BASE_URL is not a URL";
  }
  const host = url.hostname.toLowerCase();
  if (dry) return host === "127.0.0.1" || host === "localhost" ? null : "a dry run only talks to a local mock on 127.0.0.1 or localhost";
  if (PROD_HOSTS.has(host)) return `${host} is a production host`;
  if (!/^hiveattic-staging[.-]/.test(host) || !host.endsWith(".workers.dev")) return "the staging URL must be the hiveattic-staging workers.dev host";
  if (url.protocol !== "https:") return "the staging URL must use https";
  return null;
}

function stagingBucketProblem(bucket: string | undefined): string | null {
  if (!bucket) return "R2_BUCKET is not set";
  return /^hiveattic-staging-[a-z0-9-]+$/.test(bucket) ? null : `R2_BUCKET ${bucket} is not a hiveattic-staging-* bucket`;
}

function refuseIfMisconfigured(): void {
  const mappedReviewer = (name: string) =>
    name === "HIVEATTIC_REVIEWER_TOKEN" && suppliedReviewer !== "" && process.env.HIVEATTIC_REVIEWER_TOKEN === suppliedReviewer;
  const prodSet = PROD_NAMED.filter((name) => (process.env[name] ?? "").trim() !== "" && !mappedReviewer(name));
  if (prodSet.length) {
    throw new StopRun(2, `Refusing to run: ${prodSet.join(", ")} ${prodSet.length === 1 ? "is" : "are"} set. This harness reads only HIVEATTIC_STAGING_* names. Unset them first.`);
  }
  if (!stagingBase || !stagingAdmin) {
    throw new StopRun(2, "Refusing to run: set HIVEATTIC_STAGING_BASE_URL and HIVEATTIC_STAGING_ADMIN_TOKEN. A dry run needs a local mock URL.");
  }
  const urlProblem = stagingUrlProblem(stagingBase, dryRun);
  if (urlProblem) throw new StopRun(2, `Refusing to run: ${urlProblem}.`);
  const r2 = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_BUCKET"];
  if (r2.some((name) => process.env[name])) {
    const bucketProblem = stagingBucketProblem(process.env.R2_BUCKET);
    if (bucketProblem) throw new StopRun(2, `Refusing to run: ${bucketProblem}. Unset every R2_* name to skip T-11.`);
  }
  const worker = process.env.HIVEATTIC_WORKER_NAME?.trim();
  if (worker && !worker.startsWith("hiveattic-staging")) throw new StopRun(2, `Refusing to run: HIVEATTIC_WORKER_NAME ${worker} is not the staging worker.`);
  if (!/staging/.test(STAGING_CONFIG)) throw new StopRun(2, `Refusing to run: HIVEATTIC_STAGING_WRANGLER_CONFIG ${STAGING_CONFIG} is not a staging config.`);
  const dlq = process.env.HIVEATTIC_DLQ_NAME?.trim();
  if (dlq && !dlq.includes("staging")) throw new StopRun(2, `Refusing to run: HIVEATTIC_DLQ_NAME ${dlq} is not a staging queue.`);
}

async function assertStaging(): Promise<void> {
  const who = await rest("/v1/whoami", stagingAdmin, "GET", undefined, stagingBase);
  if (who.status !== 200 || who.json.data?.deploy_env !== "staging" || who.json.data?.staging_resources !== true) {
    throw new StopRun(2, "Refusing writes: target is not flagged as staging.");
  }
}

async function prepare(): Promise<void> {
  reviewer = suppliedReviewer || (await mint(`${runId}-reviewer`, [], `${runId}-reviewer`, "reviewer"));
  readerX = await mint(`${runId}-reader-x`, ["read:shared", "read:own", "write:own", "read:domain/x", "write:domain/x"], `${runId}-reader-x`);
  financeRw = await mint(
    `${runId}-finance-rw`,
    ["read:shared", "read:own", "write:own", "read:domain/finance", "write:domain/finance", "read:sensitive/finance", "write:sensitive/finance"],
    `${runId}-finance-rw`,
  );
  financeRo = await mint(`${runId}-finance-ro`, ["read:shared", "read:own", "write:own", "read:domain/finance", "read:sensitive/finance"], `${runId}-finance-ro`);
  chief = await mint(`${runId}-chief`, ["read:shared", "read:inbox", "read:sensitive:summary/health", "read:sensitive:summary/finance"], `${runId}-chief`);
  sharedWriter = await mint(`${runId}-shared-writer`, ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], `${runId}-shared-writer`);
  sharedReader = await mint(`${runId}-shared-reader`, ["read:shared"], `${runId}-shared-reader`);
  healthReader = await mint(`${runId}-health-reader`, ["read:shared", "read:sensitive/health"], `${runId}-health-reader`);
  const boot = await rest("/v1/admin/bootstrap", admin, "POST", {});
  if (boot.status !== 200) throw new Error(`bootstrap ${boot.status}`);
}

async function scopeCase(): Promise<Check[]> {
  const marker = `qxfinance${runId}`;
  const path = `domains/finance/${runId}-ledger.md`;
  const client = await mcpClient(financeRw);
  try {
    const written = await tool(client, "vault_write_note", { path, body: `Ledger note ${marker}`, type: "note" });
    const denied = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    const readerClient = await mcpClient(readerX);
    let hidden: Envelope;
    try {
      hidden = await tool(readerClient, "vault_search", { q: marker });
    } finally {
      await readerClient.close();
    }
    const role = await rest("/v1/notes", readerX, "PUT", { path: `bots/${runId}-finance-rw/role.md`, body: "nope", type: "role" });
    const reviewerRead = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, reviewer);
    const reviewerWrite = await rest("/v1/notes", reviewer, "PUT", { path: `shared/${runId}-reviewer.md`, body: "no", type: "note" });
    const shared = await rest("/v1/notes", sharedWriter, "PUT", { path: `shared/${runId}-visible.md`, body: `Shared ${runId}`, type: "note" });
    const reviewerShared = await rest(`/v1/notes?path=${encodeURIComponent(`shared/${runId}-visible.md`)}`, reviewer);
    const financeRead = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, financeRo);
    const financeWrite = await rest("/v1/notes", financeRo, "PUT", { path, body: "nope", type: "note" });
    const ownFinance = await rest("/v1/notes", financeRo, "PUT", {
      path: `bots/${runId}-finance-ro/${runId}-own.md`,
      body: "Brokerage rebalanced",
      type: "note",
      domain: "finance",
    });
    const summaryPath = `domains/finance/summaries/${runId}.md`;
    const summary = await rest("/v1/notes", financeRw, "PUT", { path: summaryPath, body: `Summary ${runId}`, type: "note" });
    const chiefSummary = await rest(`/v1/notes?path=${encodeURIComponent(summaryPath)}`, chief);
    const chiefFull = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, chief);
    const healthPath = `domains/health/${runId}-note.md`;
    const health = await rest("/v1/notes", admin, "PUT", { path: healthPath, body: `Health ${runId}`, type: "note" });
    const reviewerHealth = await rest(`/v1/notes?path=${encodeURIComponent(healthPath)}`, reviewer);
    return [
      check("finance write", written.ok === true, undefined, { written }),
      check("reader denied", denied.status === 404, undefined, { denied }),
      check("reader search empty", Array.isArray(hidden.data?.results) && hidden.data.results.length === 0, undefined, { hidden }),
      check("reader cannot write finance role", role.status === 403, undefined, { role }),
      check("reviewer cannot read finance", reviewerRead.status === 404, undefined, { reviewerRead }),
      check("reviewer cannot read health", health.status === 200 && reviewerHealth.status === 404, undefined, { health, reviewerHealth }),
      check("reviewer cannot write", reviewerWrite.status === 403, undefined, { reviewerWrite }),
      check("reviewer can read shared", shared.status === 200 && reviewerShared.status === 200, undefined, { shared, reviewerShared }),
      check("finance-ro can read", financeRead.status === 200, undefined, { financeRead }),
      check("finance-ro cannot write", financeWrite.status === 403, undefined, { financeWrite }),
      check("finance-ro cannot write own finance", ownFinance.status === 403, undefined, { ownFinance }),
      check("chief sees summary only", summary.status === 200 && chiefSummary.status === 200 && chiefFull.status === 404, undefined, { summary, chiefSummary, chiefFull }),
    ];
  } finally {
    await client.close();
  }
}

// HiveAttic does not filter content. Bots must never write secrets; these samples are fake and the server stores them as sent.

// Filter-removal smoke, in place of the retired T-02, T-03, and T-04. HiveAttic does not filter
// content. These samples are fake: each write is accepted and stored as written, and neither
// Workers Logs nor tail echo a body. Bots must still never write real secrets.
async function filterSmokeCase(): Promise<Check[]> {
  const started = Date.now();
  const samples = [
    { label: "fake key", text: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" },
    { label: "test card", text: "4242 4242 4242 4242" },
    { label: "password line", text: "password: x" },
    { label: "employer text", text: "Contoso Q3 roadmap for the Qx account team" },
  ];
  const checks: Check[] = [];
  const fragments: string[] = [];
  for (const sample of samples) {
    const marker = `${runId}smoke${fragments.length}`;
    const path = `shared/${runId}-smoke-${fragments.length}.md`;
    const body = `${marker} ${sample.text}`;
    fragments.push(marker);
    const written = await rest("/v1/notes", sharedWriter, "PUT", { path, body, type: "note" });
    const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, sharedReader);
    checks.push(check(`${sample.label} accepted`, written.status === 200 && written.json.data?.rerouted !== true, `status ${written.status}`, { written }));
    checks.push(check(`${sample.label} stored as written`, read.status === 200 && String(read.json.data?.markdown ?? "").includes(body), undefined, { read }));
  }
  const client = await mcpClient(sharedWriter);
  try {
    const mcpPath = `shared/${runId}-smoke-mcp.md`;
    const viaMcp = await tool(client, "vault_write_note", { path: mcpPath, body: `${runId}smokemcp password: x`, type: "note" });
    fragments.push(`${runId}smokemcp`);
    checks.push(check("mcp accepts a password line", viaMcp.ok === true, undefined, { viaMcp }));
  } finally {
    await client.close();
  }
  const audit = await rest("/v1/admin/audit?limit=50", admin);
  checks.push(check("audit rows carry no body", audit.status === 200 && !fragments.some((fragment) => audit.text.includes(fragment)), undefined, { audit }));
  checks.push(await logsOmit("SMOKE", fragments, started));
  return checks;
}

// T-15 on staging: health text written to shared/ lands in sensitive/health/, a read:shared token
// cannot find it, and a health reader can. Breaker's probe covers the full matrix.
async function rerouteCase(): Promise<Check[]> {
  const marker = `${runId}reroute`;
  const path = `shared/${runId}-h-note.md`;
  const target = `sensitive/health/${path}`;
  const key = `${runId}-reroute-key`;
  const written = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `Synthetic flu shot ${marker}`, type: "note", idempotency_key: key });
  const retry = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `Synthetic flu shot ${marker}`, type: "note", idempotency_key: key });
  const readerShared = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, sharedReader);
  const readerTarget = await rest(`/v1/notes?path=${encodeURIComponent(target)}`, sharedReader);
  const readerSearch = await rest(`/v1/search?q=${marker}`, sharedReader);
  const writerRead = await rest(`/v1/notes?path=${encodeURIComponent(target)}`, sharedWriter);
  const healthRead = await rest(`/v1/notes?path=${encodeURIComponent(target)}`, healthReader);
  const journal = await rest("/v1/journal", sharedWriter, "POST", { target: "shared", title: "health", body: `Synthetic flu shot booked ${marker}j`, at: "2099-06-01T16:00:00Z" });
  const day = await rest("/v1/notes?path=journal/2099/06/2099-06-01.md", sharedReader);
  return [
    check("health note rerouted with 201", written.status === 201 && written.json.data?.path === target && written.json.data?.sensitive_domain === "health", `status ${written.status}`, { written }),
    check("idempotent retry returns the same 201", retry.status === 201 && JSON.stringify(retry.json.data) === JSON.stringify(written.json.data), undefined, { retry }),
    check("read:shared token gets 404 at both paths", readerShared.status === 404 && readerTarget.status === 404, undefined, { readerShared, readerTarget }),
    check("read:shared search finds nothing", results(readerSearch.json).length === 0, undefined, { readerSearch }),
    check("writer without read:sensitive/health gets 404", writerRead.status === 404, undefined, { writerRead }),
    check("health reader reads it", healthRead.status === 200, undefined, { healthRead }),
    check("shared journal entry rerouted", journal.status === 201 && journal.json.data?.rerouted === true, `status ${journal.status}`, { journal }),
    check("shared day file has no trace of it", !day.text.includes(`${marker}j`), undefined, { day }),
  ];
}

async function concurrencyCase(): Promise<Check[]> {
  const blocked = rateLimitBlocked();
  if (blocked) return [blocked];
  const at = "2099-11-11T15:00:00.000Z";
  const seen = new Set<string>();
  const sent: RestResult[] = [];
  const batches = 20;
  for (let run = 0; run < batches; run++) {
    const batch = await Promise.all(
      Array.from({ length: 7 }, (_, slot) =>
        rest("/v1/journal", sharedWriter, "POST", {
          target: "own",
          title: `r${run}s${slot}`,
          body: `${runId}-marker-${run}-${slot}`,
          at,
          tags: [runId],
        }),
      ),
    );
    sent.push(...batch);
    for (const item of batch) {
      if (item.status === 429) return [check("seven by twenty", false, rateLimitDetail(), { sent })];
      if (item.status !== 200) return [check("seven by twenty", false, `status ${item.status}`, { sent })];
      const ref = String(item.json.data?.block_ref ?? "");
      if (!ref || seen.has(ref)) return [check("unique block refs", false, "duplicate or missing block_ref", { sent })];
      seen.add(ref);
    }
  }
  const journalPath = `bots/${runId}-shared-writer/journal/2099/11/2099-11-11.md`;
  const note = await rest(`/v1/notes?path=${encodeURIComponent(journalPath)}`, sharedWriter);
  const markdown = String(note.json.data?.markdown ?? "");
  const blocks = markdown.split(/\n(?=## )/);
  let missing = 0;
  let torn = 0;
  for (let run = 0; run < batches; run++) {
    for (let slot = 0; slot < 7; slot++) {
      const marker = `${runId}-marker-${run}-${slot}`;
      if (!markdown.includes(marker)) missing += 1;
      const hits = blocks.filter((block) => block.includes(marker));
      if (hits.length !== 1) torn += 1;
    }
  }
  // One batch to the shared day file from seven different tokens.
  const tokens: string[] = [];
  for (let slot = 0; slot < 7; slot++) tokens.push(await mint(`${runId}-day-${slot}`, ["read:shared", "write:shared"], `${runId}-day-${slot}`));
  const sharedAt = "2099-11-12T15:00:00.000Z";
  const sharedBatch = await Promise.all(tokens.map((token, slot) => rest("/v1/journal", token, "POST", { target: "shared", title: `t${slot}`, body: `${runId}-shared-${slot}`, at: sharedAt })));
  const sharedPath = "journal/2099/11/2099-11-12.md";
  const sharedNote = await rest(`/v1/notes?path=${encodeURIComponent(sharedPath)}`, sharedWriter);
  const sharedMarkdown = String(sharedNote.json.data?.markdown ?? "");
  const sharedOrder = await rest(`/v1/admin/journal-order?path=${encodeURIComponent(sharedPath)}`, admin);
  const sharedRefs = Array.isArray(sharedOrder.json.data?.block_refs) ? (sharedOrder.json.data?.block_refs as string[]) : [];
  const sharedFileOrder = [...sharedMarkdown.matchAll(/\^([0-9A-HJKMNP-TV-Z]{26})/g)].map((match) => `^${match[1]}`);
  const path = `shared/${runId}-etag.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: "one", type: "note" });
  const etag = String(created.json.data?.etag ?? "");
  const updated = await rest("/v1/notes", sharedWriter, "PUT", { path, body: "two", type: "note", if_match: etag });
  const stale = await rest("/v1/notes", sharedWriter, "PUT", { path, body: "stale", type: "note", if_match: etag });
  const fileOrder = [...markdown.matchAll(/\^([0-9A-HJKMNP-TV-Z]{26})/g)].map((match) => `^${match[1]}`);
  const order = await rest(`/v1/admin/journal-order?path=${encodeURIComponent(journalPath)}`, admin);
  const stored = Array.isArray(order.json.data?.block_refs) ? (order.json.data?.block_refs as string[]) : [];
  const rebuilt = await runJob("/v1/admin/reindex");
  const after = await rest(`/v1/notes?path=${encodeURIComponent(journalPath)}`, sharedWriter);
  const afterMarkdown = String(after.json.data?.markdown ?? "");
  let stillMissing = 0;
  for (const ref of seen) if (!afterMarkdown.includes(ref)) stillMissing += 1;
  return [
    check("one hundred forty refs", seen.size === batches * 7 && missing === 0, missing ? `${missing} markers missing` : `${seen.size} refs`, { sent, note }),
    check("entries intact", torn === 0, torn ? `${torn} entries were split or duplicated` : undefined, { note }),
    check("journal order", order.status === 200 && stored.join() === fileOrder.join(), `status ${order.status}`, { order }),
    check(
      "shared day file from seven tokens",
      sharedBatch.every((item) => item.status === 200) && sharedRefs.length >= 7 && sharedRefs.join() === sharedFileOrder.join() && tokens.every((_, slot) => sharedMarkdown.includes(`${runId}-shared-${slot}`)),
      `${sharedRefs.length} refs`,
      { sharedBatch, sharedOrder },
    ),
    check("stale etag", stale.status === 409 && stale.json.error?.code === "conflict_etag", `status ${stale.status}`, { created, updated, stale }),
    check("reindex job", rebuilt.job?.status === "done", jobDetail(rebuilt), { started: rebuilt.started }),
    check("entries survive rebuild", stillMissing === 0 && after.json.data?.status === "active", stillMissing ? `${stillMissing} refs missing after rebuild` : undefined, { after }),
  ];
}

async function newestCase(): Promise<Check[]> {
  const key = `${runId}-city`;
  const older = await rest("/v1/facts", readerX, "POST", { key, statement: `Lives in cedar ${runId}old`, observed_at: "2020-01-01T00:00:00Z", scope: "own" });
  const client = await mcpClient(readerX);
  try {
    const newer = await tool(client, "vault_write_fact", { key, statement: `Lives in maple ${runId}new`, observed_at: "2024-01-01T00:00:00Z", scope: "own" });
    const path = `bots/${runId}-reader-x/facts/${key}.md`;
    const active = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, admin);
    const bodies = versions(history.json).map((version) => String(version.body ?? ""));
    return [
      check("updated", older.status === 200 && newer.data?.outcome === "updated", undefined, { older, newer }),
      check("active is newer", String(active.json.data?.markdown ?? "").includes(`${runId}new`) && !String(active.json.data?.markdown ?? "").includes(`${runId}old`), undefined, { active }),
      check("history has both", bodies.some((body) => body.includes(`${runId}old`)) && bodies.some((body) => body.includes(`${runId}new`)), undefined, { history }),
    ];
  } finally {
    await client.close();
  }
}


async function appendOnlyCase(): Promise<Check[]> {
  const client = await mcpClient(sharedWriter);
  try {
    const rewrite = await tool(client, "vault_write_note", { path: `bots/${runId}-shared-writer/journal/2099/11/2099-11-11.md`, body: "rewritten", type: "note" });
    const probe = await rest("/v1/admin/audit/verify-append-only", admin, "POST", {});
    return [
      check("journal rewrite rejected", rewrite.error?.code === "invalid", undefined, { rewrite }),
      check("audit mutations abort", probe.json.data?.update_aborted === true && probe.json.data?.delete_aborted === true, undefined, { probe }),
    ];
  } finally {
    await client.close();
  }
}

async function idempotencyCase(): Promise<Check[]> {
  const key = `${runId}-idem`;
  const body = { target: "own", title: "once", body: `same ${runId}`, at: "2099-11-11T16:00:00.000Z", idempotency_key: key };
  const first = await rest("/v1/journal", readerX, "POST", body);
  const client = await mcpClient(readerX);
  try {
    const second = await tool(client, "vault_append_journal", body);
    return [check("same response", JSON.stringify(first.json.data) === JSON.stringify(second.data) && first.status === 200, undefined, { first, second })];
  } finally {
    await client.close();
  }
}

async function forgetCase(): Promise<Check[]> {
  const marker = `qxforget${runId}`;
  const path = `bots/${runId}-reader-x/${runId}-note.md`;
  const client = await mcpClient(readerX);
  try {
    const written = await tool(client, "vault_write_note", { path, body: `Remember ${marker}`, type: "note" });
    const forgotten = await tool(client, "vault_forget", { path, reason: "no longer needed" });
    const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    const search = await rest(`/v1/search?q=${marker}`, readerX);
    const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, admin);
    return [
      check("forgotten", written.ok === true && forgotten.ok === true && read.json.data?.status === "forgotten", undefined, { written, forgotten, read }),
      check("stub", String(read.json.data?.markdown ?? "").includes("Forgotten") && !String(read.json.data?.markdown ?? "").includes(marker), undefined, { read }),
      check("search empty", results(search.json).length === 0, undefined, { search }),
      check("history kept", versions(history.json).length > 0, undefined, { history }),
      { name: "vector deletion", status: "partial", detail: "FTS covered: search is empty, the read is a stub, and history is kept. Vector deletion is deferred to M2.", responses: [] },
    ];
  } finally {
    await client.close();
  }
}


async function humanEditCase(): Promise<Check[]> {
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_ENDPOINT || !process.env.R2_BUCKET) {
    return [{ name: "s3 edit", status: "skipped", detail: "Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, and R2_BUCKET (a hiveattic-staging-* bucket)", responses: [] }];
  }
  const bucket = process.env.R2_BUCKET;
  const path = `shared/${runId}-human.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `Original ${runId}alpha`, type: "note" });
  const started = Date.now();
  await s3Put(bucket, `vault/${path}`, `Updated ${runId}beta from outside the api\n`);
  let found = false;
  let lastSearch: RestResult | undefined;
  while (Date.now() - started < 10_000) {
    lastSearch = await rest(`/v1/search?q=${runId}beta`, sharedWriter);
    if (results(lastSearch.json).some((row) => row.path === path)) {
      found = true;
      break;
    }
    await sleep(400);
  }
  const elapsed = Date.now() - started;
  const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, admin);
  const day = await rest("/v1/journal", sharedWriter, "POST", { target: "shared", title: "outside", body: `${runId}dayentry`, at: "2099-04-04T16:00:00Z" });
  const dayPath = String(day.json.data?.path ?? "");
  const dayBefore = await rest(`/v1/notes?path=${encodeURIComponent(dayPath)}`, sharedWriter);
  const dayBytes = String(dayBefore.json.data?.markdown ?? "");
  await s3Put(bucket, `vault/${dayPath}`, `${dayBytes}\n`);
  let dayActive = false;
  let dayRead: RestResult | undefined;
  const dayStarted = Date.now();
  while (Date.now() - dayStarted < 10_000) {
    dayRead = await rest(`/v1/notes?path=${encodeURIComponent(dayPath)}`, admin);
    if (dayRead.json.data?.status === "active" && String(dayRead.json.data.markdown ?? "").includes(`${runId}dayentry`)) {
      dayActive = true;
      break;
    }
    await sleep(400);
  }
  // A fake secret pasted through S3 is not filtered: it stays active and searchable.
  const keyPath = `shared/${runId}-s3key.md`;
  await s3Put(bucket, `vault/${keyPath}`, `token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 ${runId}s3key\n`);
  let keyActive = false;
  let keyRead: RestResult | undefined;
  const keyStarted = Date.now();
  while (Date.now() - keyStarted < 10_000) {
    keyRead = await rest(`/v1/notes?path=${encodeURIComponent(keyPath)}`, sharedReader);
    const hits = results((await rest(`/v1/search?q=${runId}s3key`, sharedReader)).json);
    if (keyRead.json.data?.status === "active" && hits.some((row) => row.path === keyPath)) {
      keyActive = true;
      break;
    }
    await sleep(400);
  }
  // Health text pasted into shared/ through S3 is moved to sensitive/health/ and never readable at the shared path.
  const healthPath = `shared/${runId}-h-ext.md`;
  await s3Put(bucket, `vault/${healthPath}`, `Synthetic flu shot ${runId}s3health\n`);
  let movedOk = false;
  let movedRead: RestResult | undefined;
  let sharedRead: RestResult | undefined;
  const movedStarted = Date.now();
  while (Date.now() - movedStarted < 10_000) {
    movedRead = await rest(`/v1/notes?path=${encodeURIComponent(`sensitive/health/${healthPath}`)}`, healthReader);
    sharedRead = await rest(`/v1/notes?path=${encodeURIComponent(healthPath)}`, sharedReader);
    if (movedRead.status === 200 && sharedRead.status === 404) {
      movedOk = true;
      break;
    }
    await sleep(400);
  }
  const healthSearch = await rest(`/v1/search?q=${runId}s3health`, sharedReader);
  const dst = `shared/${runId}-copy.md`;
  await s3Copy(bucket, `vault/${dst}`, `${bucket}/vault/${path}`);
  await s3Delete(bucket, `vault/${path}`);
  let copied = false;
  let sourceForgotten = false;
  let dstRead: RestResult | undefined;
  let srcRead: RestResult | undefined;
  const copyStarted = Date.now();
  while (Date.now() - copyStarted < 10_000) {
    dstRead = await rest(`/v1/notes?path=${encodeURIComponent(dst)}`, admin);
    srcRead = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, admin);
    copied = dstRead.json.data?.status === "active";
    sourceForgotten = srcRead.json.data?.status === "forgotten";
    if (copied && sourceForgotten) break;
    await sleep(400);
  }
  const deletedRead = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, sharedWriter);
  const audits = await rest(`/v1/admin/audit?path=${encodeURIComponent(dst)}&limit=20`, admin);
  const sourceAudits = await rest(`/v1/admin/audit?path=${encodeURIComponent(path)}&limit=20`, admin);
  const auditText = JSON.stringify([audits.json.data?.entries, sourceAudits.json.data?.entries]);
  const settle = await runJob("/v1/admin/reconcile");
  const versionsBefore = versions((await rest(`/v1/history?path=${encodeURIComponent(dst)}`, admin)).json).length;
  const auditsBefore = ((await rest(`/v1/admin/audit?path=${encodeURIComponent(dst)}&limit=50`, admin)).json.data?.entries as unknown[] | undefined)?.length ?? 0;
  const second = await runJob("/v1/admin/reconcile");
  const versionsAfter = versions((await rest(`/v1/history?path=${encodeURIComponent(dst)}`, admin)).json).length;
  const auditsAfter = ((await rest(`/v1/admin/audit?path=${encodeURIComponent(dst)}&limit=50`, admin)).json.data?.entries as unknown[] | undefined)?.length ?? 0;
  const gonePath = `shared/${runId}-drop.md`;
  const gone = await rest("/v1/notes", sharedWriter, "PUT", { path: gonePath, body: `${runId}dropme`, type: "note" });
  await s3Delete(bucket, `vault/${gonePath}`);
  const dropReconcile = await runJob("/v1/admin/reconcile");
  let dropped = false;
  let goneRead: RestResult | undefined;
  const dropStarted = Date.now();
  while (Date.now() - dropStarted < 8_000) {
    goneRead = await rest(`/v1/notes?path=${encodeURIComponent(gonePath)}`, sharedWriter);
    const hits = results((await rest(`/v1/search?q=${runId}dropme`, sharedWriter)).json);
    if (goneRead.json.data?.status === "forgotten" && hits.length === 0) {
      dropped = true;
      break;
    }
    await sleep(400);
  }
  dlqDepth = await readDlqDepth();
  return [
    check("created", created.status === 200, undefined, { created }),
    check("keyword searchable within 10s", found && elapsed <= 10_000, `${elapsed}ms`, { lastSearch }),
    check("history snapshot", versions(history.json).some((version) => String(version.body ?? "").includes(`${runId}alpha`)), undefined, { history }),
    check("edited journal stays active", day.status === 200 && dayActive, undefined, { day, dayRead }),
    check("fake secret via S3 stays active and searchable", keyActive, undefined, { keyRead }),
    check("health text via S3 is moved out of shared/", movedOk && results(healthSearch.json).length === 0, undefined, { movedRead, sharedRead, healthSearch }),
    check("copy indexed and source forgotten", copied && sourceForgotten, undefined, { dstRead, srcRead }),
    check("outside delete returns a stub without the body", deletedRead.json.data?.status === "forgotten" && !deletedRead.text.includes(`${runId}beta`), undefined, { deletedRead }),
    check("external audit has no identity", auditText.includes("external_copy") && auditText.includes("external_delete") && auditText.includes("r2-event"), undefined, { audits, sourceAudits }),
    check(
      "second reconcile is quiet",
      settle.job?.status === "done" && second.job?.status === "done" && versionsAfter === versionsBefore && auditsAfter === auditsBefore,
      `${jobDetail(settle)}; ${jobDetail(second)}`,
      { settle: settle.started, second: second.started },
    ),
    check("missing object is forgotten", gone.status === 200 && dropReconcile.job?.status === "done" && dropped, jobDetail(dropReconcile), { gone, goneRead }),
    check("dlq depth", dlqDepth === 0, dlqDepth === null ? "DLQ depth was not readable" : `depth ${dlqDepth}`),
  ];
}

async function rebuildCase(): Promise<Check[]> {
  const marker = `qxrebuild${runId}`;
  const path = `shared/${runId}-rebuild.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `${marker} before`, type: "note" });
  const etag = String(created.json.data?.etag ?? "");
  const edited = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `${marker} after [[shared/${runId}-target]]`, type: "note", if_match: etag });
  const linked = await rest("/v1/notes", sharedWriter, "PUT", { path: `shared/${runId}-target.md`, body: `${marker} target`, type: "note" });
  const journal = await rest("/v1/journal", sharedWriter, "POST", {
    target: "shared",
    title: "one",
    body: `${marker} journal one`,
    at: "2099-05-05T16:00:00Z",
  });
  const journalPath = String(journal.json.data?.path ?? "");
  const journalTwo = await rest("/v1/journal", sharedWriter, "POST", { target: "shared", title: "two", body: `${marker} journal two`, at: "2099-05-05T17:00:00Z" });
  const decision = await rest("/v1/journal", sharedWriter, "POST", { target: "decisions", title: "keep", body: `${marker} decision`, at: "2099-05-05T18:00:00Z" });
  const own = await rest("/v1/journal", readerX, "POST", {
    target: "own",
    title: "once",
    body: `${marker} own`,
    at: "2099-05-05T19:00:00Z",
    idempotency_key: `${runId}-rebuild-key`,
  });
  const forgottenPath = `shared/${runId}-forgotten.md`;
  const toForget = await rest("/v1/notes", sharedWriter, "PUT", { path: forgottenPath, body: `${marker} forgotten`, type: "note" });
  const forget = await rest("/v1/forget", sharedWriter, "POST", { path: forgottenPath, reason: "rebuild check" });
  const before = await rest(`/v1/search?q=${marker}`, sharedWriter);
  const entriesBefore = await rest(`/v1/admin/journal-order?path=${encodeURIComponent(journalPath)}`, admin);
  // A write that lands while the job runs must survive it.
  const rebuilt = await runJob("/v1/admin/reindex", {}, async () => {
    const during = await rest("/v1/notes", sharedWriter, "PUT", { path: `shared/${runId}-during.md`, body: `${marker} during`, type: "note" }, writeRoot, { "idempotency-key": `${runId}-during` });
    duringWrites.push(during);
  });
  const audit = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(String(rebuilt.started?.json.request_id ?? ""))}&limit=10`, admin);
  const reindexRow = auditEntries(audit.json).find((entry) => entry.action === "reindex");
  const after = await rest(`/v1/search?q=${marker}`, sharedWriter);
  const entriesAfter = await rest(`/v1/admin/journal-order?path=${encodeURIComponent(journalPath)}`, admin);
  const day = await rest(`/v1/notes?path=${encodeURIComponent(journalPath)}`, sharedWriter);
  const decisions = await rest("/v1/notes?path=shared/decisions.md", sharedWriter);
  const duringRead = await rest(`/v1/notes?path=${encodeURIComponent(`shared/${runId}-during.md`)}`, sharedWriter);
  const retry = await rest("/v1/journal", readerX, "POST", {
    target: "own",
    title: "once",
    body: `${marker} own`,
    at: "2099-05-05T19:00:00Z",
    idempotency_key: `${runId}-rebuild-key`,
  });
  const forgotten = await rest(`/v1/notes?path=${encodeURIComponent(forgottenPath)}`, admin);
  const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, admin);
  const prior = versions(history.json).find((version) => String(version.body ?? "").includes(`${marker} before`));
  const restored = await rest("/v1/admin/restore", admin, "POST", { path, version_ts: prior?.version_ts });
  const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, sharedWriter);
  const appended = await rest("/v1/journal", sharedWriter, "POST", { target: "shared", title: "three", body: `${marker} journal three`, at: "2099-05-05T20:00:00Z" });
  const reread = await rest(`/v1/notes?path=${encodeURIComponent(journalPath)}`, sharedWriter);
  const markdown = String(reread.json.data?.markdown ?? "");
  const beforePaths = paths(before.json);
  const afterPaths = paths(after.json).filter((item) => item !== `shared/${runId}-during.md`);
  return [
    check("setup writes", [created, edited, linked, journal, journalTwo, toForget, forget].every((item) => item.status === 200), undefined, { created, edited, linked, journal, journalTwo, toForget, forget }),
    check("decision write", decision.status === 200, `status ${decision.status}`, { decision }),
    check("own journal write", own.status === 200, `status ${own.status}`, { own }),
    check("reindex job", rebuilt.job?.status === "done", jobDetail(rebuilt), { started: rebuilt.started }),
    check("reindex audited", reindexRow?.outcome === "ok", reindexRow ? `${reindexRow.outcome} ${reindexRow.detail ?? ""}`.slice(0, 240) : "no reindex audit row", { audit }),
    duringWrites.length === 0
      ? { name: "write during the job survives", status: "skipped", detail: "the job finished before the first poll, so no write landed during it", responses: [] }
      : check("write during the job survives", duringWrites.every((item) => item.status === 200) && duringRead.json.data?.status === "active", `${duringWrites.length} writes`, { duringRead }),
    check("search matches", beforePaths.join() === afterPaths.join() && afterPaths.includes(path), undefined, { before, after }),
    check("journals stay active", day.json.data?.status === "active" && decisions.json.data?.status === "active", undefined, { day, decisions }),
    check("journal order unchanged", JSON.stringify(entriesBefore.json.data?.block_refs ?? []) === JSON.stringify(entriesAfter.json.data?.block_refs ?? []), undefined, { entriesBefore, entriesAfter }),
    check("idempotent retry", retry.json.data?.entry_id === own.json.data?.entry_id, undefined, { retry }),
    check("forgotten stays forgotten", forgotten.json.data?.status === "forgotten", undefined, { forgotten }),
    check("restore", restored.status === 200 && String(read.json.data?.markdown ?? "").includes(`${marker} before`), prior ? undefined : "prior version missing from history", { history, restored, read }),
    check("post-rebuild append keeps earlier entries", appended.status === 200 && markdown.includes(`${marker} journal one`) && markdown.includes(`${marker} journal two`) && markdown.includes(`${marker} journal three`), undefined, { appended, reread }),
  ];
}

const duringWrites: RestResult[] = [];

async function cleanupCase(): Promise<Check[]> {
  // Cleanup only ever runs against the staging URL the guards accepted. Production is never contacted.
  const problem = stagingUrlProblem(writeRoot, dryRun);
  if (problem) return [check("staging cleanup", false, `refused: ${problem}`)];
  const cleaned = await settled(await rest("/v1/admin/cleanup", admin, "POST", { run_id: runId }));
  const audit = await rest("/v1/admin/audit?limit=30", admin);
  const left = await rest(`/v1/search?q=${runId}`, admin);
  const remainingNotes = cleaned.json.data?.remaining_notes;
  const remainingObjects = cleaned.json.data?.remaining_objects;
  return [
    check("staging cleanup", cleaned.status === 200, `status ${cleaned.status}`, { cleaned }),
    check("staging cleanup audited", auditEntries(audit.json).some((entry) => entry.action === "cleanup"), undefined, { audit }),
    check("namespaced notes gone", results(left.json).length === 0, undefined, { left }),
    check("no leftovers", remainingNotes === 0 && remainingObjects === 0, `notes ${remainingNotes} objects ${remainingObjects}`, { cleaned }),
  ];
}

async function mint(agentId: string, scopes: string[], label: string, preset?: "reviewer"): Promise<string> {
  const response = await rest("/v1/admin/tokens", admin, "POST", preset ? { preset, label, agent_id: agentId } : { agent_id: agentId, display_name: agentId, kind: "agent", scopes, label });
  const token = response.json.data?.token;
  const tokenId = response.json.data?.token_id;
  if (response.status !== 200 || typeof token !== "string" || typeof tokenId !== "string") throw new Error(`mint failed for ${agentId}`);
  minted.push({ id: tokenId });
  return token;
}

type RestResult = { status: number; json: Envelope; text: string };

async function rest(path: string, token: string, method = "GET", body?: unknown, root = writeRoot, headers: Record<string, string> = {}): Promise<RestResult> {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Envelope = { ok: false };
  try {
    json = JSON.parse(text) as Envelope;
  } catch {
    json = { ok: false };
  }
  return { status: response.status, json, text };
}

// A write still running after 25 s answers 202 with an operation id. Wait for its stored result.
async function settled(response: RestResult): Promise<RestResult> {
  const operation = response.json.data?.operation_id;
  if (response.status !== 202 || response.json.data?.pending !== true || typeof operation !== "string") return response;
  const stop = Date.now() + JOB_CEILING_MS;
  while (Date.now() < stop) {
    await sleep(1000);
    const polled = await rest(`/v1/operations/${operation}`, admin);
    if (polled.json.data?.status !== "done") continue;
    const status = Number(polled.json.data?.http_status ?? 200);
    const result = polled.json.data?.result;
    const error = polled.json.data?.error;
    const json: Envelope = result ? { ok: true, data: result as Record<string, unknown>, request_id: response.json.request_id } : { ok: false, error: error as Envelope["error"], request_id: response.json.request_id };
    return { status, json, text: JSON.stringify(json) };
  }
  return response;
}

type JobRun = { started: RestResult | undefined; job: Record<string, unknown> | undefined; detail: string };

// Admin jobs answer 202 with a job id. Poll GET /v1/admin/jobs/:id until done or failed, for at most ten minutes.
async function runJob(path: string, body: Record<string, unknown> = {}, whileRunning?: () => Promise<void>): Promise<JobRun> {
  const started = await rest(path, admin, "POST", body);
  const id = started.json.data?.job_id;
  if (started.status !== 202 || typeof id !== "string") {
    return { started, job: undefined, detail: `start ${started.status} ${started.json.error?.code ?? ""} ${started.json.error?.message ?? ""}`.trim() };
  }
  const stop = Date.now() + JOB_CEILING_MS;
  let ran = false;
  let last: RestResult | undefined;
  while (Date.now() < stop) {
    last = await rest(`/v1/admin/jobs/${id}`, admin);
    const status = last.json.data?.status;
    if (status === "done" || status === "failed") return { started, job: last.json.data, detail: String(status) };
    if (whileRunning && !ran) {
      ran = true;
      await whileRunning();
    }
    await sleep(1000);
  }
  return { started, job: last?.json.data, detail: `job ${id} passed the ten-minute ceiling` };
}

function jobDetail(run: JobRun): string {
  if (!run.job) return run.detail;
  const counts = (run.job.counts ?? {}) as Record<string, unknown>;
  const parts = [`${String(run.job.kind)} ${String(run.job.status)}`, `pages ${String(run.job.pages)}`];
  for (const name of ["files", "notes", "versions", "moved", "swept", "updated", "forgotten", "duration_ms"]) if (name in counts) parts.push(`${name} ${String(counts[name])}`);
  if (run.job.error) parts.push(`error ${String(run.job.error)}`);
  return parts.join(", ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every S3 call goes through these, and each one checks the bucket first.
function assertStagingBucket(bucket: string): void {
  const problem = stagingBucketProblem(bucket);
  if (problem) throw new StopRun(2, `Refusing the S3 call: ${problem}.`);
}

async function s3Put(bucket: string, key: string, body: string): Promise<void> {
  assertStagingBucket(bucket);
  await s3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/markdown" }));
}

async function s3Copy(bucket: string, key: string, source: string): Promise<void> {
  assertStagingBucket(bucket);
  assertStagingBucket(source.split("/")[0] ?? "");
  await s3Client().send(new CopyObjectCommand({ Bucket: bucket, Key: key, CopySource: source }));
}

async function s3Delete(bucket: string, key: string): Promise<void> {
  assertStagingBucket(bucket);
  await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

function s3Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "" },
  });
}

async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${writeRoot}/mcp`), { authProvider: { token: async () => token } });
  const client = new Client({ name: "hiveattic-e2e", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((item) => item.type === "text" && "text" in item)?.text ?? "{}";
  return JSON.parse(text) as Envelope;
}

type Envelope = { ok?: boolean; request_id?: string; data?: Record<string, unknown>; error?: { code?: string; message?: string; reasons?: string[]; limit?: string; job_id?: string } };

function results(json: Envelope): { path?: string }[] {
  const value = json.data?.results;
  return Array.isArray(value) ? (value as { path?: string }[]) : [];
}

function paths(json: Envelope): string[] {
  return results(json).map((row) => row.path ?? "").sort();
}

function versions(json: Envelope): { version_ts?: string; body?: string }[] {
  const value = json.data?.versions;
  return Array.isArray(value) ? (value as { version_ts?: string; body?: string }[]) : [];
}

function auditEntries(json: Envelope): { action?: string; outcome?: string; detail?: string | null }[] {
  const value = json.data?.entries;
  return Array.isArray(value) ? (value as { action?: string; outcome?: string; detail?: string | null }[]) : [];
}

type Recorded = RestResult | Envelope | undefined;

function subResponse(label: string, response: RestResult | Envelope): SubResponse {
  if ("json" in response && typeof (response as RestResult).status === "number") {
    const item = response as RestResult;
    return { label, via: "rest", status: item.status, ok: item.json.ok === true, error_code: item.json.error?.code ?? null, request_id: item.json.request_id ?? null };
  }
  const envelope = response as Envelope;
  return { label, via: "mcp", status: null, ok: envelope.ok === true, error_code: envelope.error?.code ?? null, request_id: envelope.request_id ?? null };
}

// Every check lists the responses it judged, so a failure in a live run names the request to look up.
function check(name: string, ok: boolean, detail?: string, responses: Record<string, Recorded | RestResult[]> = {}): Check {
  const recorded: SubResponse[] = [];
  for (const [label, value] of Object.entries(responses)) {
    if (Array.isArray(value)) value.forEach((item, index) => recorded.push(subResponse(`${label}[${index}]`, item)));
    else if (value) recorded.push(subResponse(label, value));
  }
  return { name, status: ok ? "passed" : "failed", ...(detail ? { detail } : {}), responses: recorded };
}

// The harness never changes a deployed limit. Forge raises and restores it.
function rateLimitDetail(): string {
  return "T-06 sends 140 journal writes in one window, more than the default 60 per minute. Ask Forge to raise the staging write limit to at least 140 before T-06 and to restore 60 afterwards. Set HIVEATTIC_RATE_LIMIT_WRITES_PER_MIN to the value Forge confirms (0 means no limit) so the suite can stop before the burst.";
}

function rateLimitBlocked(): Check | null {
  const raw = process.env.HIVEATTIC_RATE_LIMIT_WRITES_PER_MIN;
  if (raw === undefined || raw.trim() === "") return null;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit === 0 || limit >= 140) return null;
  return check("write rate limit", false, rateLimitDetail());
}

const LOG_OPERATOR =
  "The log check uses Workers Logs when CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set, and otherwise `pnpm exec wrangler tail hiveattic-staging --config wrangler.staging.example.jsonc`. Set HIVEATTIC_LOG_MODE=tail to force tail, or HIVEATTIC_LOG_MODE=api to use only the API.";

function workerName(): string {
  return process.env.HIVEATTIC_WORKER_NAME?.trim() || "hiveattic-staging";
}

// `pnpm` is `pnpm.cmd` on Windows, which Node only starts through a shell. The arguments are fixed
// strings and the worker name the guards accepted, so the shell sees nothing a caller chose.
function startTail(): ChildProcess {
  const script = process.env.HIVEATTIC_TAIL_SCRIPT?.trim();
  if (script) return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const args = ["exec", "wrangler", "tail", workerName(), "--config", STAGING_CONFIG, "--format", "json"];
  return spawn("pnpm", args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
}

async function ensureTail(): Promise<void> {
  if (tailChild || process.env.HIVEATTIC_LOG_MODE === "api") return;
  tailText = "";
  const child = startTail();
  tailChild = child;
  child.on("error", (err) => {
    tailText += `\n${err.name}`;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    tailText += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    tailText += chunk.toString();
  });
  const attachRaw = Number(process.env.HIVEATTIC_TAIL_ATTACH_MS ?? "1500");
  const attachMs = Number.isFinite(attachRaw) && attachRaw >= 0 ? attachRaw : 1500;
  await sleep(attachMs);
}

async function stopTail(): Promise<void> {
  const child = tailChild;
  tailChild = null;
  if (!child) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// Workers Logs (or tail) must not contain any of the written fragments.
async function logsOmit(label: string, fragments: string[], fromMs: number): Promise<Check> {
  const name = `${label} logs omit bodies`;
  const needles = fragments.filter((item) => item.length > 0);
  const mode = process.env.HIVEATTIC_LOG_MODE?.trim() || "auto";
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (mode !== "tail" && token && accountId) {
    const waitRaw = Number(process.env.HIVEATTIC_LOG_WAIT_MS ?? "15000");
    const waitMs = Number.isFinite(waitRaw) && waitRaw >= 0 ? waitRaw : 15000;
    const deadline = Date.now() + waitMs;
    let sawEvents = false;
    let lastError = "";
    do {
      const page = await queryWorkerLogs(token, accountId, workerName(), fromMs).catch((err: unknown) => ({
        ok: false as const,
        detail: err instanceof Error ? err.name : "workers logs query failed",
      }));
      if (!page.ok) {
        lastError = page.detail;
        break;
      }
      if (page.events > 0) sawEvents = true;
      if (needles.some((needle) => page.text.includes(needle))) return check(name, false, "workers logs echoed a written body");
      if (Date.now() >= deadline) break;
      await sleep(3000);
    } while (Date.now() <= deadline);
    if (sawEvents) return check(name, true);
    if (mode === "api") return check(name, false, sanitize(lastError || "Workers Logs returned no events", needles));
  }
  await ensureTail();
  const waitRaw = Number(process.env.HIVEATTIC_LOG_WAIT_MS ?? "8000");
  const waitMs = Number.isFinite(waitRaw) && waitRaw >= 0 ? Math.min(waitRaw, 20000) : 8000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (needles.some((needle) => tailText.includes(needle))) return check(name, false, "the staging tail echoed a written body");
    await sleep(500);
  }
  if (!tailText.trim()) return check(name, false, sanitize(`The staging tail produced no output. ${LOG_OPERATOR}`, needles));
  return check(name, true);
}

async function queryWorkerLogs(token: string, accountId: string, script: string, fromMs: number): Promise<{ ok: true; text: string; events: number } | { ok: false; detail: string }> {
  const to = Math.max(Date.now(), fromMs + 1);
  let offset: string | undefined;
  let combined = "";
  let events = 0;
  for (let page = 0; page < 5; page++) {
    const response = await fetch(cfApi(`/accounts/${accountId}/workers/observability/telemetry/query`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        queryId: "hiveattic-e2e",
        dry: true,
        limit: 100,
        timeframe: { from: Math.max(0, fromMs - 5000), to },
        parameters: {
          datasets: ["cloudflare-workers"],
          filterCombination: "and",
          filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: script }],
          limit: 100,
          view: "events",
        },
        ...(offset ? { offset } : {}),
      }),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, detail: `workers logs status ${response.status}` };
    let body: { success?: boolean; errors?: { message?: string }[]; result?: { events?: { count?: number; events?: { $metadata?: { id?: string } }[] } } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return { ok: false, detail: "workers logs response was not json" };
    }
    if (body.success === false) return { ok: false, detail: body.errors?.[0]?.message || "workers logs query failed" };
    const rows = body.result?.events?.events ?? [];
    events += rows.length;
    combined += text;
    const count = body.result?.events?.count ?? rows.length;
    const next = rows.at(-1)?.$metadata?.id;
    if (!next || rows.length === 0 || events >= count) break;
    offset = next;
  }
  return { ok: true, text: combined, events };
}

function sanitize(text: string, fragments: string[]): string {
  let out = text;
  for (const fragment of fragments) {
    if (fragment) out = out.split(fragment).join("[filtered]");
  }
  return out.slice(0, 240);
}

// The Cloudflare API token only ever goes to the real API origin, over https. There is no override.
const CF_API_ROOT = "https://api.cloudflare.com/client/v4";

function cfApi(path: string): string {
  return `${CF_API_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
}

// Only the staging dead-letter queue is ever read.
function dlqName(): string {
  return process.env.HIVEATTIC_DLQ_NAME?.trim() || "hiveattic-staging-index-dlq";
}

async function readDlqDepth(): Promise<number | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (!token || !accountId) return null;
  const queueId = await queueIdByName(token, accountId, dlqName());
  if (!queueId) return null;
  const sampled = await backlogFromGraphQL(token, accountId, queueId);
  if (typeof sampled === "number") return sampled;
  return backlogFromMetrics(token, accountId, queueId);
}

async function queueIdByName(token: string, accountId: string, name: string): Promise<string | null> {
  const listed = await fetch(cfApi(`/accounts/${accountId}/queues`), {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!listed?.ok) return null;
  const body = (await listed.json()) as { result?: { queue_id?: string; queue_name?: string }[] };
  return (body.result ?? []).find((item) => item.queue_name === name)?.queue_id ?? null;
}

async function backlogFromGraphQL(token: string, accountId: string, queueId: string): Promise<number | null> {
  const end = new Date();
  const start = new Date(end.getTime() - 15 * 60 * 1000);
  for (const field of ["queueBacklogAdaptiveGroups", "queuesBacklogAdaptiveGroups"]) {
    const sampled = await graphqlBacklog(token, accountId, queueId, field, start, end);
    if (sampled === "error") continue;
    if (typeof sampled === "number") return sampled;
  }
  return null;
}

async function graphqlBacklog(
  token: string,
  accountId: string,
  queueId: string,
  field: string,
  start: Date,
  end: Date,
): Promise<number | "empty" | "error"> {
  const response = await fetch(cfApi("/graphql"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: `query QueueBacklog($accountTag: string!, $queueId: string!, $datetimeStart: Time!, $datetimeEnd: Time!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            ${field}(
              limit: 20
              filter: { queueId: $queueId, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }
              orderBy: [datetime_DESC]
            ) {
              avg { messages }
              dimensions { datetime }
            }
          }
        }
      }`,
      variables: { accountTag: accountId, queueId, datetimeStart: start.toISOString(), datetimeEnd: end.toISOString() },
    }),
  }).catch(() => null);
  if (!response?.ok) return "error";
  const body = (await response.json()) as {
    errors?: unknown[];
    data?: { viewer?: { accounts?: Record<string, { avg?: { messages?: number | null }; dimensions?: { datetime?: string } }[] | undefined>[] } };
  };
  if (body.errors?.length) return "error";
  const groups = body.data?.viewer?.accounts?.[0]?.[field] ?? [];
  if (!groups.length) return "empty";
  const newest = [...groups].sort((left, right) => String(right.dimensions?.datetime ?? "").localeCompare(String(left.dimensions?.datetime ?? "")))[0];
  const messages = newest?.avg?.messages;
  return typeof messages === "number" && Number.isFinite(messages) ? messages : "empty";
}

async function backlogFromMetrics(token: string, accountId: string, queueId: string): Promise<number | null> {
  const response = await fetch(cfApi(`/accounts/${accountId}/queues/${queueId}/metrics`), {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json()) as { result?: { backlog_count?: number } };
  const count = body.result?.backlog_count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

function skipped(id: string, details: string): Case {
  return { id, status: "skipped", details, duration_ms: 0, checks: [{ name: id, status: "skipped", detail: details, responses: [] }] };
}


async function record(id: string, run: () => Promise<Check[]>): Promise<Case> {
  const started = Date.now();
  try {
    const checks = await run();
    const failed = checks.some((item) => item.status === "failed");
    const partial = checks.some((item) => item.status === "partial");
    const skippedOnly = checks.every((item) => item.status === "skipped");
    const status: Status = failed ? "failed" : partial ? "partial" : skippedOnly ? "skipped" : "passed";
    return { id, status, details: checks.map((item) => `${item.status} ${item.name}${item.detail ? ` (${item.detail})` : ""}`).join("; "), duration_ms: Date.now() - started, checks };
  } catch (err) {
    if (err instanceof StopRun) throw err;
    const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 240) : "error";
    return { id, status: "failed", details: detail, duration_ms: Date.now() - started, checks: [{ name: id, status: "failed", detail, responses: [] }] };
  }
}

function render(items: Case[]): string {
  const lines = ["# HiveAttic live E2E", "", `Run ${runId}`, ""];
  for (const item of items) lines.push(`- ${item.id}: ${item.status.toUpperCase()} (${item.duration_ms} ms) — ${item.details}`);
  const failed = items.filter((item) => item.status === "failed").length;
  const partial = items.filter((item) => item.status === "partial").length;
  lines.push("", failed === 0 ? "No failed cases." : `${failed} failed case(s).`);
  if (partial > 0) lines.push(`${partial} partial case(s). T-09 stays partial in M1: FTS is covered and vector deletion is deferred to M2.`);
  for (const item of items) {
    for (const failure of item.checks.filter((entry) => entry.status === "failed")) {
      const subs = failure.responses.map((sub) => `${sub.label} ${sub.via} ${sub.status ?? "-"} ${sub.error_code ?? "ok"} ${sub.request_id ?? "no-request-id"}`).join(", ");
      lines.push(`  - ${item.id} ${failure.name}: ${subs || "no responses recorded"}`);
    }
  }
  lines.push("", `DLQ depth: ${dlqDepth === null ? "unknown" : String(dlqDepth)}`);
  return lines.join("\n");
}

function quiet(work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    () => undefined,
  );
}

function writeArtifacts(): void {
  const failed = cases.filter((item) => item.status === "failed").length;
  const summary = render(cases);
  mkdirSync(dirname(outPath), { recursive: true });
  const target = dryRun ? "dry-run" : "staging";
  writeFileSync(outPath, JSON.stringify({ run_id: runId, target, failed, dlq_depth: dlqDepth, cases }, null, 2));
  const summaryPath = outPath.endsWith(".json") ? `${outPath.slice(0, -".json".length)}.summary.md` : `${outPath}.summary.md`;
  writeFileSync(summaryPath, summary);
  writeFileSync(`${dirname(outPath)}/dlq.json`, JSON.stringify({ dlq_depth: dlqDepth, queue: dlqName() }, null, 2));
  console.log(summary);
}

async function runCases(): Promise<void> {
  await assertStaging();
  stagingOk = true;
  await prepare();
  if (dryRun) {
    cases.push({
      id: "DRY-RUN",
      status: "passed",
      details: "setup and cleanup",
      duration_ms: 0,
      checks: [{ name: "dry-run", status: "passed", responses: [] }],
    });
    return;
  }
  cases.push(await record("T-01", () => scopeCase()));
  // T-02, T-03, and T-04 are retired. Their ids stay reserved. The smoke below replaces them.
  cases.push(await record("SMOKE", () => filterSmokeCase()));
  cases.push(await record("T-15", () => rerouteCase()));
  cases.push(await record("T-05", () => newestCase()));
  cases.push(await record("T-06", () => concurrencyCase()));
  cases.push(await record("T-07", () => appendOnlyCase()));
  cases.push(await record("T-08", () => idempotencyCase()));
  cases.push(await record("T-09", () => forgetCase()));
  cases.push(await record("T-11", () => humanEditCase()));
  cases.push(await record("T-12", () => rebuildCase()));
  cases.push(await record("T-CLEANUP", () => cleanupCase()));
  cases.push(skipped("T-10", "deferred to a later milestone"));
  cases.push(skipped("T-13", "deferred to a later milestone"));
  cases.push(skipped("T-14", "deferred to a later milestone"));
}

async function finish(): Promise<void> {
  await stopTail();
  if (!stagingOk) {
    writeArtifacts();
    return;
  }
  for (const item of minted) {
    await quiet(rest("/v1/admin/tokens/revoke", admin, "POST", { token_id: item.id }, writeRoot));
  }
  if (!stagingUrlProblem(stagingBase, dryRun)) {
    await quiet(rest("/v1/admin/cleanup", stagingAdmin, "POST", { run_id: runId }, stagingBase).then((first) => settled(first)));
  }
  if (!dryRun) dlqDepth = await readDlqDepth().catch(() => null);
  writeArtifacts();
}

async function main(): Promise<number> {
  try {
    refuseIfMisconfigured();
    await runCases();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "aborted";
    if (err instanceof StopRun) {
      console.error(err.message);
      exitCode = err.exitStatus;
    } else {
      console.error(detail);
      exitCode = 1;
    }
    cases.push({ id: "ABORT", status: "failed", details: detail, duration_ms: 0, checks: [{ name: "abort", status: "failed", detail, responses: [] }] });
  } finally {
    try {
      await finish();
    } catch (err) {
      console.error(err instanceof Error ? err.message : "cleanup failed");
      if (exitCode === 0) exitCode = 1;
      try {
        writeArtifacts();
      } catch {
        console.error("results artifact was not written");
      }
    }
  }
  if (exitCode === 0 && cases.some((item) => item.status === "failed")) exitCode = 1;
  return exitCode;
}

// Let the event loop drain instead of calling process.exit while fetch sockets close. On Windows,
// exiting mid-close trips a libuv assertion and turns a clean run into a crash. The unref'd timer
// still ends a run that something keeps alive.
process.exitCode = await main();
setTimeout(() => process.exit(process.exitCode), 5000).unref();
