import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Status = "passed" | "failed" | "skipped" | "partial";
// One HTTP or MCP response a check looked at. status is null for MCP, which has no HTTP status per tool call.
type SubResponse = { label: string; via: "rest" | "mcp"; status: number | null; ok: boolean; error_code: string | null; request_id: string | null };
type Check = { name: string; status: Status; detail?: string; responses: SubResponse[] };
type Case = { id: string; status: Status; details: string; duration_ms: number; checks: Check[] };

const prodBase = (process.env.HIVEATTIC_BASE_URL ?? "").replace(/\/$/, "");
const stagingBase = (process.env.HIVEATTIC_STAGING_BASE_URL ?? "").replace(/\/$/, "");
const stagingAdmin = process.env.HIVEATTIC_STAGING_ADMIN_TOKEN ?? "";
const prodAdmin = process.env.HIVEATTIC_ADMIN_TOKEN ?? "";
const suppliedReviewer = process.env.HIVEATTIC_REVIEWER_TOKEN ?? "";
const readOnly = /^(1|true|yes|read-only)$/i.test(process.env.HIVEATTIC_E2E_READ_ONLY ?? "") || process.env.HIVEATTIC_E2E_MODE === "read-only";
const outPath = process.env.HIVEATTIC_E2E_OUT ?? "e2e-results/results.json";
const writeRoot = stagingBase;
const admin = stagingAdmin;

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
let dlqDepth: number | null = null;
let stagingOk = false;
let exitCode = 0;

class StopRun extends Error {
  exitStatus: number;
  constructor(exitStatus: number, message: string) {
    super(message);
    this.exitStatus = exitStatus;
  }
}

async function assertStaging(): Promise<void> {
  const who = await rest("/v1/whoami", stagingAdmin, "GET", undefined, stagingBase);
  if (who.status !== 200 || who.json.data?.deploy_env !== "staging" || who.json.data?.staging_resources !== true) {
    throw new StopRun(2, "Refusing writes: target is not flagged as staging.");
  }
}

async function prepare(): Promise<void> {
  reviewer = suppliedReviewer || (await mint("reviewer", [], `${runId}-reviewer`, "reviewer"));
  readerX = await mint(`${runId}-reader-x`, ["read:shared", "read:own", "write:own", "read:domain/x", "write:domain/x"], `${runId}-reader-x`);
  financeRw = await mint(
    `${runId}-finance-rw`,
    ["read:shared", "read:own", "write:own", "read:domain/finance", "write:domain/finance", "read:sensitive/finance", "write:sensitive/finance"],
    `${runId}-finance-rw`,
  );
  financeRo = await mint(`${runId}-finance-ro`, ["read:shared", "read:own", "write:own", "read:domain/finance", "read:sensitive/finance"], `${runId}-finance-ro`);
  chief = await mint(`${runId}-chief`, ["read:shared", "read:inbox", "read:sensitive:summary/health", "read:sensitive:summary/finance"], `${runId}-chief`);
  sharedWriter = await mint(`${runId}-shared-writer`, ["read:shared", "read:own", "write:own", "write:shared", "write:decisions"], `${runId}-shared-writer`);
  const boot = await rest("/v1/admin/bootstrap", admin, "POST", {});
  if (boot.status !== 200) throw new Error(`bootstrap ${boot.status}`);
}

async function readOnlyReviewer(): Promise<Check[]> {
  const root = prodBase || stagingBase;
  const who = await rest("/v1/whoami", suppliedReviewer, "GET", undefined, root);
  const search = await rest("/v1/search?q=vault", suppliedReviewer, "GET", undefined, root);
  dlqDepth = await readDlqDepth();
  return [
    check("whoami", who.status === 200 && who.json.data?.admin === false, `status ${who.status}`, { who }),
    check("search", search.status === 200, `status ${search.status}`, { search }),
    check("no writes sent", true),
    check("dlq depth", typeof dlqDepth === "number", dlqDepth === null ? "DLQ depth was not readable" : `depth ${dlqDepth}`),
  ];
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
async function keyLikeCase(): Promise<Check[]> {
  const sample = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const path = `shared/${runId}-keylike.md`;
  const written = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `prefix ${sample} ${runId}keylike`, type: "note" });
  const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, sharedWriter);
  const client = await mcpClient(sharedWriter);
  try {
    const mcpPath = `shared/${runId}-keylike-mcp.md`;
    const viaMcp = await tool(client, "vault_write_note", { path: mcpPath, body: "password: hunter2", type: "note" });
    const mcpRead = await rest(`/v1/notes?path=${encodeURIComponent(mcpPath)}`, sharedWriter);
    return [
      check("rest accepts key-like string", written.status === 200, `status ${written.status}`, { written }),
      check("key-like string stored", read.status === 200 && String(read.json.data?.markdown ?? "").includes(sample), undefined, { read }),
      check("mcp accepts password line", viaMcp.ok === true, undefined, { viaMcp }),
      check("password line stored", String(mcpRead.json.data?.markdown ?? "").includes("hunter2"), undefined, { mcpRead }),
    ];
  } finally {
    await client.close();
  }
}

async function cardAccountCase(): Promise<Check[]> {
  const cardNumber = "4242424242424242";
  const accountNumber = "5839201746";
  const routingNumber = "021000021";
  const cardPath = `shared/${runId}-card.md`;
  const accountPath = `shared/${runId}-acct.md`;
  const card = await rest("/v1/notes", sharedWriter, "PUT", { path: cardPath, body: `Card ${cardNumber} on file`, type: "note" });
  const account = await rest("/v1/notes", sharedWriter, "PUT", { path: accountPath, body: `The brokerage account ${accountNumber} is on file.`, type: "note" });
  const routing = await rest("/v1/facts", sharedWriter, "POST", { key: `${runId}-route`, statement: `routing ${routingNumber}`, observed_at: "2026-01-01T00:00:00Z", scope: "own" });
  const cardRead = await rest(`/v1/notes?path=${encodeURIComponent(cardPath)}`, sharedWriter);
  const accountRead = await rest(`/v1/notes?path=${encodeURIComponent(accountPath)}`, sharedWriter);
  return [
    check("card accepted", card.status === 200, `status ${card.status}`, { card }),
    check("card stored", String(cardRead.json.data?.markdown ?? "").includes(cardNumber), undefined, { cardRead }),
    check("account accepted", account.status === 200, `status ${account.status}`, { account }),
    check("account stored", String(accountRead.json.data?.markdown ?? "").includes(accountNumber), undefined, { accountRead }),
    check("routing fact accepted", routing.status === 200, `status ${routing.status}`, { routing }),
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
      if (item.status === 429) return [check("seven by one hundred", false, rateLimitDetail(), { sent })];
      if (item.status !== 200) return [check("seven by one hundred", false, `status ${item.status}`, { sent })];
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
  const path = `shared/${runId}-etag.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: "one", type: "note" });
  const etag = String(created.json.data?.etag ?? "");
  const updated = await rest("/v1/notes", sharedWriter, "PUT", { path, body: "two", type: "note", if_match: etag });
  const stale = await rest("/v1/notes", sharedWriter, "PUT", { path, body: "stale", type: "note", if_match: etag });
  const fileOrder = [...markdown.matchAll(/\^([0-9A-HJKMNP-TV-Z]{26})/g)].map((match) => `^${match[1]}`);
  const order = await rest(`/v1/admin/journal-order?path=${encodeURIComponent(journalPath)}`, admin);
  const stored = Array.isArray(order.json.data?.block_refs) ? (order.json.data?.block_refs as string[]) : [];
  const rebuilt = await rest("/v1/admin/reindex", admin, "POST", {});
  const after = await rest(`/v1/notes?path=${encodeURIComponent(journalPath)}`, sharedWriter);
  const afterMarkdown = String(after.json.data?.markdown ?? "");
  let stillMissing = 0;
  for (const ref of seen) if (!afterMarkdown.includes(ref)) stillMissing += 1;
  return [
    check("one hundred forty refs", seen.size === batches * 7 && missing === 0, missing ? `${missing} markers missing` : `${seen.size} refs`, { sent, note }),
    check("entries intact", torn === 0, torn ? `${torn} entries were split or duplicated` : undefined, { note }),
    check("journal order", order.status === 200 && stored.join() === fileOrder.join(), `status ${order.status}`, { order }),
    check("stale etag", stale.status === 409 && stale.json.error?.code === "conflict_etag", `status ${stale.status}`, { created, updated, stale }),
    check("reindex", rebuilt.status === 200, rebuildDetail(rebuilt), { rebuilt }),
    check("entries survive rebuild", stillMissing === 0 && after.json.data?.status === "active", stillMissing ? `${stillMissing} refs missing after rebuild` : undefined, { after }),
  ];
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
    return [{ name: "s3 edit", status: "skipped", detail: "Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, and R2_BUCKET", responses: [] }];
  }
  const bucket = process.env.R2_BUCKET;
  const path = `shared/${runId}-human.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `Original ${runId}alpha`, type: "note" });
  const s3 = s3Client();
  const started = Date.now();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `vault/${path}`, Body: `Updated ${runId}beta from outside the api\n`, ContentType: "text/markdown" }));
  let found = false;
  let lastSearch: RestResult | undefined;
  while (Date.now() - started < 10_000) {
    lastSearch = await rest(`/v1/search?q=${runId}beta`, sharedWriter);
    if (results(lastSearch.json).some((row) => row.path === path)) {
      found = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const elapsed = Date.now() - started;
  const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, admin);
  const day = await rest("/v1/journal", sharedWriter, "POST", { target: "shared", title: "outside", body: `${runId}dayentry`, at: "2099-04-04T16:00:00Z" });
  const dayPath = String(day.json.data?.path ?? "");
  const dayBefore = await rest(`/v1/notes?path=${encodeURIComponent(dayPath)}`, sharedWriter);
  const dayBytes = String(dayBefore.json.data?.markdown ?? "");
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `vault/${dayPath}`, Body: `${dayBytes}\n`, ContentType: "text/markdown" }));
  let dayActive = false;
  let dayRead: RestResult | undefined;
  const dayStarted = Date.now();
  while (Date.now() - dayStarted < 10_000) {
    dayRead = await rest(`/v1/notes?path=${encodeURIComponent(dayPath)}`, admin);
    if (dayRead.json.data?.status === "active" && String(dayRead.json.data.markdown ?? "").includes(`${runId}dayentry`)) {
      dayActive = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const dst = `shared/${runId}-copy.md`;
  await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: `vault/${dst}`, CopySource: `${bucket}/vault/${path}` }));
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `vault/${path}` }));
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
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const audits = await rest(`/v1/admin/audit?path=${encodeURIComponent(dst)}&limit=20`, admin);
  const sourceAudits = await rest(`/v1/admin/audit?path=${encodeURIComponent(path)}&limit=20`, admin);
  const auditText = JSON.stringify([audits.json.data?.entries, sourceAudits.json.data?.entries]);
  const settle = await rest("/v1/admin/reconcile", admin, "POST", {});
  const versionsBefore = versions((await rest(`/v1/history?path=${encodeURIComponent(dst)}`, admin)).json).length;
  const auditsBefore = ((await rest(`/v1/admin/audit?path=${encodeURIComponent(dst)}&limit=50`, admin)).json.data?.entries as unknown[] | undefined)?.length ?? 0;
  const second = await rest("/v1/admin/reconcile", admin, "POST", {});
  const versionsAfter = versions((await rest(`/v1/history?path=${encodeURIComponent(dst)}`, admin)).json).length;
  const auditsAfter = ((await rest(`/v1/admin/audit?path=${encodeURIComponent(dst)}&limit=50`, admin)).json.data?.entries as unknown[] | undefined)?.length ?? 0;
  const gonePath = `shared/${runId}-drop.md`;
  const gone = await rest("/v1/notes", sharedWriter, "PUT", { path: gonePath, body: `${runId}dropme`, type: "note" });
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `vault/${gonePath}` }));
  const dropReconcile = await rest("/v1/admin/reconcile", admin, "POST", {});
  let dropped = false;
  let goneRead: RestResult | undefined;
  const dropStarted = Date.now();
  while (Date.now() - dropStarted < 8_000) {
    goneRead = await rest(`/v1/notes?path=${encodeURIComponent(gonePath)}`, admin);
    const hits = results((await rest(`/v1/search?q=${runId}dropme`, sharedWriter)).json);
    if (goneRead.json.data?.status === "forgotten" && hits.length === 0) {
      dropped = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  dlqDepth = await readDlqDepth();
  return [
    check("created", created.status === 200, undefined, { created }),
    check("keyword searchable within 10s", found && elapsed <= 10_000, `${elapsed}ms`, { lastSearch }),
    check("history snapshot", versions(history.json).some((version) => String(version.body ?? "").includes(`${runId}alpha`)), undefined, { history }),
    check("edited journal stays active", day.status === 200 && dayActive, undefined, { day, dayRead }),
    check("copy indexed and source forgotten", copied && sourceForgotten, undefined, { dstRead, srcRead }),
    check("external audit has no identity", auditText.includes("external_copy") && auditText.includes("external_delete") && auditText.includes("r2-event"), undefined, { audits, sourceAudits }),
    check("second reconcile is quiet", settle.status === 200 && second.status === 200 && versionsAfter === versionsBefore && auditsAfter === auditsBefore, undefined, { settle, second }),
    check("missing object is forgotten", gone.status === 200 && dropped, undefined, { gone, dropReconcile, goneRead }),
    check("dlq depth", dlqDepth === 0, dlqDepth === null ? "DLQ depth was not readable" : `depth ${dlqDepth}`),
  ];
}

async function rebuildCase(): Promise<Check[]> {
  const marker = `qxrebuild${runId}`;
  const path = `shared/${runId}-rebuild.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `${marker} before`, type: "note" });
  const etag = String(created.json.data?.etag ?? "");
  const edited = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `${marker} after`, type: "note", if_match: etag });
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
  const rebuilt = await rest("/v1/admin/reindex", admin, "POST", {});
  const audit = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(String(rebuilt.json.request_id ?? ""))}&limit=10`, admin);
  const reindexRow = auditEntries(audit.json).find((entry) => entry.action === "reindex");
  const after = await rest(`/v1/search?q=${marker}`, sharedWriter);
  const entriesAfter = await rest(`/v1/admin/journal-order?path=${encodeURIComponent(journalPath)}`, admin);
  const day = await rest(`/v1/notes?path=${encodeURIComponent(journalPath)}`, sharedWriter);
  const decisions = await rest("/v1/notes?path=shared/decisions.md", sharedWriter);
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
  return [
    check("setup writes", [created, edited, journal, journalTwo, toForget, forget].every((item) => item.status === 200), undefined, { created, edited, journal, journalTwo, toForget, forget }),
    check("decision write", decision.status === 200, `status ${decision.status}`, { decision }),
    check("own journal write", own.status === 200, `status ${own.status}`, { own }),
    check("reindex", rebuilt.status === 200, rebuildDetail(rebuilt), { rebuilt }),
    check("reindex audited", reindexRow?.outcome === "ok", reindexRow ? `${reindexRow.outcome} ${reindexRow.detail ?? ""}`.slice(0, 240) : "no reindex audit row", { audit }),
    check("search matches", paths(before.json).join() === paths(after.json).join() && paths(after.json).includes(path), undefined, { before, after }),
    check("journals stay active", day.json.data?.status === "active" && decisions.json.data?.status === "active", undefined, { day, decisions }),
    check("journal order unchanged", JSON.stringify(entriesBefore.json.data?.block_refs ?? []) === JSON.stringify(entriesAfter.json.data?.block_refs ?? []), undefined, { entriesBefore, entriesAfter }),
    check("idempotent retry", retry.json.data?.entry_id === own.json.data?.entry_id, undefined, { retry }),
    check("forgotten stays forgotten", forgotten.json.data?.status === "forgotten", undefined, { forgotten }),
    check("restore", restored.status === 200 && String(read.json.data?.markdown ?? "").includes(`${marker} before`), prior ? undefined : "prior version missing from history", { history, restored, read }),
    check("post-rebuild append keeps earlier entries", appended.status === 200 && markdown.includes(`${marker} journal one`) && markdown.includes(`${marker} journal two`) && markdown.includes(`${marker} journal three`), undefined, { appended, reread }),
  ];
}

async function cleanupCase(): Promise<Check[]> {
  const checks: Check[] = [];
  if (prodBase && prodAdmin) {
    const denied = await rest("/v1/admin/cleanup", prodAdmin, "POST", { run_id: runId }, prodBase);
    checks.push(check("prod cleanup is 404", denied.status === 404, `status ${denied.status}`, { denied }));
  } else {
    checks.push({ name: "prod cleanup is 404", status: "skipped", detail: "Set HIVEATTIC_BASE_URL and HIVEATTIC_ADMIN_TOKEN to prove prod cleanup returns 404", responses: [] });
  }
  const cleaned = await rest("/v1/admin/cleanup", admin, "POST", { run_id: runId });
  const audit = await rest("/v1/admin/audit?limit=30", admin);
  const left = await rest(`/v1/search?q=${runId}`, admin);
  checks.push(check("staging cleanup", cleaned.status === 200, `status ${cleaned.status}`, { cleaned }));
  checks.push(check("staging cleanup audited", auditEntries(audit.json).some((entry) => entry.action === "cleanup"), undefined, { audit }));
  checks.push(check("namespaced notes gone", results(left.json).length === 0, undefined, { left }));
  const remainingNotes = cleaned.json.data?.remaining_notes;
  const remainingObjects = cleaned.json.data?.remaining_objects;
  checks.push(check("no leftovers", remainingNotes === 0 && remainingObjects === 0, `notes ${remainingNotes} objects ${remainingObjects}`, { cleaned }));
  return checks;
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

async function rest(path: string, token: string, method = "GET", body?: unknown, root = writeRoot): Promise<RestResult> {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

type Envelope = { ok?: boolean; request_id?: string; data?: Record<string, unknown>; error?: { code?: string; message?: string; reasons?: string[] } };

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

function rebuildDetail(rebuilt: RestResult): string {
  if (rebuilt.status !== 200) return `status ${rebuilt.status} ${rebuilt.json.error?.code ?? ""} ${rebuilt.json.error?.message ?? ""}`.trim();
  const data = rebuilt.json.data ?? {};
  return `notes ${String(data.notes)} versions ${String(data.versions)} in ${String(data.duration_ms)} ms`;
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

function rateLimitDetail(): string {
  return "T-06 sends 140 journal writes in one window. Raise the limit, run the suite, then restore 60 from wrangler.jsonc: pnpm exec wrangler deploy --var RATE_LIMIT_WRITES_PER_MIN:10000 ; pnpm e2e ; pnpm exec wrangler deploy. Set HIVEATTIC_RATE_LIMIT_WRITES_PER_MIN to the deployed value (0 disables the limit) so the suite can stop before the burst.";
}

function rateLimitBlocked(): Check | null {
  const raw = process.env.HIVEATTIC_RATE_LIMIT_WRITES_PER_MIN;
  if (raw === undefined || raw.trim() === "") return null;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit === 0 || limit >= 140) return null;
  return check("write rate limit", false, rateLimitDetail());
}

function cfApi(path: string): string {
  const root = (process.env.HIVEATTIC_CF_API ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  return `${root}${path.startsWith("/") ? path : `/${path}`}`;
}

function dlqName(): string {
  const configured = process.env.HIVEATTIC_DLQ_NAME?.trim();
  if (configured) return configured;
  return readOnly ? "hiveattic-index-dlq" : "hiveattic-staging-index-dlq";
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
  const target = dryRun ? "dry-run" : readOnly ? "read-only" : "staging";
  writeFileSync(outPath, JSON.stringify({ run_id: runId, target, failed, dlq_depth: dlqDepth, cases }, null, 2));
  const summaryPath = outPath.endsWith(".json") ? `${outPath.slice(0, -".json".length)}.summary.md` : `${outPath}.summary.md`;
  writeFileSync(summaryPath, summary);
  writeFileSync(`${dirname(outPath)}/dlq.json`, JSON.stringify({ dlq_depth: dlqDepth, queue: dlqName() }, null, 2));
  console.log(summary);
}

function refuseIfMisconfigured(): void {
  if (dryRun) {
    if (!stagingBase || !stagingAdmin) {
      throw new StopRun(2, "Dry-run needs HIVEATTIC_STAGING_BASE_URL and HIVEATTIC_STAGING_ADMIN_TOKEN. A local mock is enough.");
    }
    return;
  }
  if (!readOnly && (!stagingBase || !stagingAdmin)) {
    throw new StopRun(
      2,
      "Refusing to run: write tests target only HIVEATTIC_STAGING_BASE_URL with HIVEATTIC_STAGING_ADMIN_TOKEN. Set HIVEATTIC_E2E_READ_ONLY=1 for a read-only smoke against HIVEATTIC_BASE_URL.",
    );
  }
  if (!readOnly && prodBase && prodBase === stagingBase) {
    throw new StopRun(2, "Refusing to run: HIVEATTIC_STAGING_BASE_URL is the same as HIVEATTIC_BASE_URL.");
  }
  if (readOnly && (!(prodBase || stagingBase) || !suppliedReviewer)) {
    throw new StopRun(2, "Read-only smoke needs HIVEATTIC_BASE_URL (or the staging URL) and HIVEATTIC_REVIEWER_TOKEN. It does not mint tokens or send writes.");
  }
}

async function runCases(): Promise<void> {
  if (dryRun) {
    await assertStaging();
    stagingOk = true;
    await prepare();
    cases.push({
      id: "DRY-RUN",
      status: "passed",
      details: "setup and cleanup",
      duration_ms: 0,
      checks: [{ name: "dry-run", status: "passed", responses: [] }],
    });
    return;
  }
  if (readOnly) {
    cases.push(await record("T-01", () => readOnlyReviewer()));
    for (const id of ["T-02", "T-03", "T-05", "T-06", "T-07", "T-08", "T-09", "T-11", "T-12"]) {
      cases.push(skipped(id, "Read-only smoke does not write"));
    }
  } else {
    await assertStaging();
    stagingOk = true;
    await prepare();
    cases.push(await record("T-01", () => scopeCase()));
    cases.push(await record("T-02", () => keyLikeCase()));
    cases.push(await record("T-03", () => cardAccountCase()));
    cases.push(await record("T-05", () => newestCase()));
    cases.push(await record("T-06", () => concurrencyCase()));
    cases.push(await record("T-07", () => appendOnlyCase()));
    cases.push(await record("T-08", () => idempotencyCase()));
    cases.push(await record("T-09", () => forgetCase()));
    cases.push(await record("T-11", () => humanEditCase()));
    cases.push(await record("T-12", () => rebuildCase()));
    cases.push(await record("T-CLEANUP", () => cleanupCase()));
  }
  cases.push(skipped("T-10", "deferred to a later milestone"));
  cases.push(skipped("T-13", "deferred to a later milestone"));
  cases.push(skipped("T-14", "deferred to a later milestone"));
}

async function finish(): Promise<void> {
  for (const item of minted) {
    await quiet(rest("/v1/admin/tokens/revoke", admin, "POST", { token_id: item.id }, writeRoot));
  }
  if (stagingOk && stagingBase && stagingAdmin) {
    await quiet(rest("/v1/admin/cleanup", stagingAdmin, "POST", { run_id: runId }, stagingBase));
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
