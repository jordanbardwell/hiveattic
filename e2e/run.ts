import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Status = "passed" | "failed" | "skipped" | "partial";
type Check = { name: string; status: Status; detail?: string };
type Case = { id: string; status: Status; details: string; duration_ms: number; checks: Check[] };

const prodBase = (process.env.HIVEATTIC_BASE_URL ?? "").replace(/\/$/, "");
const stagingBase = (process.env.HIVEATTIC_STAGING_BASE_URL ?? "").replace(/\/$/, "");
const stagingAdmin = process.env.HIVEATTIC_STAGING_ADMIN_TOKEN ?? "";
const prodAdmin = process.env.HIVEATTIC_ADMIN_TOKEN ?? "";
const suppliedReviewer = process.env.HIVEATTIC_REVIEWER_TOKEN ?? "";
const readOnly = /^(1|true|yes|read-only)$/i.test(process.env.HIVEATTIC_E2E_READ_ONLY ?? "") || process.env.HIVEATTIC_E2E_MODE === "read-only";
const account = accountFixture();
const outPath = process.env.HIVEATTIC_E2E_OUT ?? "e2e-results/results.json";
const writeRoot = stagingBase;
const admin = stagingAdmin;


const dryRun = process.argv.includes("--dry-run") || process.env.HIVEATTIC_E2E_DRY_RUN === "1";
const runId = `e2e${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const policySubject = `Qxsubject${runId}`;
const policyQualifier = `qxqual${runId}`;
const cases: Case[] = [];
const minted: { id: string }[] = [];
const addedTerms: string[] = [];
let reviewer = suppliedReviewer;
let readerX = "";
let financeRw = "";
let financeRo = "";
let chief = "";
let sharedWriter = "";
let prodPolicyBefore = "";
let dlqDepth: number | null = null;
let stagingOk = false;
let tailChild: ChildProcess | null = null;
let tailText = "";
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
  return [
    check("whoami", who.status === 200 && who.json.data?.admin === false, `status ${who.status}`),
    check("search", search.status === 200, `status ${search.status}`),
    check("no writes sent", true),
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
    await rest("/v1/notes", admin, "PUT", { path: healthPath, body: `Health ${runId}`, type: "note" });
    const reviewerHealth = await rest(`/v1/notes?path=${encodeURIComponent(healthPath)}`, reviewer);
    return [
      check("finance write", written.ok === true),
      check("reader denied", denied.status === 404),
      check("reader search empty", Array.isArray(hidden.data?.results) && hidden.data.results.length === 0),
      check("reader cannot write finance role", role.status === 403),
      check("reviewer cannot read finance", reviewerRead.status === 404),
      check("reviewer cannot read health", reviewerHealth.status === 404),
      check("reviewer cannot write", reviewerWrite.status === 403),
      check("reviewer can read shared", shared.status === 200 && reviewerShared.status === 200),
      check("finance-ro can read", financeRead.status === 200),
      check("finance-ro cannot write", financeWrite.status === 403),
      check("finance-ro cannot write own finance", ownFinance.status === 403),
      check("chief sees summary only", summary.status === 200 && chiefSummary.status === 200 && chiefFull.status === 404),
    ];
  } finally {
    await client.close();
  }
}

async function secretCase(): Promise<Check[]> {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const started = Date.now();
  const response = await rest("/v1/notes", sharedWriter, "PUT", { path: `shared/${runId}-secret.md`, body: `prefix ${secret}`, type: "note" });
  const client = await mcpClient(sharedWriter);
  try {
    const mcpReject = await tool(client, "vault_write_note", { path: `shared/${runId}-secret-mcp.md`, body: "password: hunter2", type: "note" });
    const mcpText = JSON.stringify(mcpReject);
    return [
      check("rest rejects secret", response.status === 422 && response.json.error?.code === "rejected_secret", `status ${response.status}`),
      responseOmits("rest secret", secret, response.text),
      await auditOmits("rest secret", secret, String(response.json.request_id ?? "")),
      check("mcp rejects password", mcpReject.error?.code === "rejected_secret"),
      responseOmits("mcp password", "hunter2", mcpText),
      await auditOmits("mcp password", "hunter2", String(mcpReject.request_id ?? "")),
      await logsOmit("T-02", [secret, "hunter2"], started),
    ];
  } finally {
    await client.close();
  }
}

async function financialCase(): Promise<Check[]> {
  const cardNumber = "4242424242424242";
  const routingNumber = "021000021";
  const started = Date.now();
  const card = await rest("/v1/notes", sharedWriter, "PUT", { path: `shared/${runId}-card.md`, body: `Card ${cardNumber} on file`, type: "note" });
  const routing = await rest("/v1/facts", sharedWriter, "POST", { key: `${runId}-route`, statement: `routing ${routingNumber}`, observed_at: "2026-01-01T00:00:00Z", scope: "own" });
  const benign = await rest("/v1/notes", sharedWriter, "PUT", { path: `shared/${runId}-price.md`, body: "The price is $51.00 and ticker ACME rose.", type: "note" });
  const fragments = [cardNumber, routingNumber];
  const checks: Check[] = [
    check("card rejected", card.status === 422 && card.json.error?.reasons?.includes("financial_card"), `status ${card.status}`),
    responseOmits("card", cardNumber, card.text),
    await auditOmits("card", cardNumber, String(card.json.request_id ?? "")),
    check("routing rejected", routing.status === 422 && routing.json.error?.reasons?.includes("financial_routing"), `status ${routing.status}`),
    responseOmits("routing", routingNumber, routing.text),
    await auditOmits("routing", routingNumber, String(routing.json.request_id ?? "")),
    await auditNotPlainSha("routing", `routing ${routingNumber}\n\n`, String(routing.json.request_id ?? "")),
    check("benign accepted", benign.status === 200),
  ];
  if (!account) {
    checks.push({ name: "account fixture", status: "skipped", detail: "T-03 account fixture absent: set HIVEATTIC_ACCOUNT_NUMBER or HIVEATTIC_ACCOUNT_FIXTURE" });
  } else {
    const statement = /\d{6,}/.test(account) && /account|acct|acc#|brokerage|iban/i.test(account) ? account : `The brokerage account ${account} is on file.`;
    const response = await rest("/v1/notes", sharedWriter, "PUT", { path: `shared/${runId}-acct.md`, body: statement, type: "note" });
    const rejected = response.status === 422 && response.json.error?.reasons?.includes("financial_account");
    const leaked = response.text.includes(account);
    checks.push(check("account fixture rejected", rejected, leaked ? "response echoed the account fixture" : `status ${response.status}`));
    checks.push(responseOmits("account", account, response.text));
    checks.push(await auditOmits("account", account, String(response.json.request_id ?? "")));
    fragments.push(account);
  }
  checks.push(await logsOmit("T-03", fragments, started));
  return checks;
}

async function employerCase(): Promise<Check[]> {
  const before = await rest("/v1/admin/policy", admin);
  const existing = new Set(((before.json.data?.terms as { term?: string }[] | undefined) ?? []).map((term) => String(term.term ?? "")));
  if (!existing.has(policySubject)) {
    await rest("/v1/admin/policy", admin, "POST", { term: policySubject, kind: "context_subject" });
    addedTerms.push(policySubject);
  }
  if (!existing.has(policyQualifier)) {
    await rest("/v1/admin/policy", admin, "POST", { term: policyQualifier, kind: "context_qualifier" });
    addedTerms.push(policyQualifier);
  }
  const rejected = await rest("/v1/facts", readerX, "POST", {
    key: `${runId}-work`,
    statement: `${policySubject} ${policyQualifier} migration notes`,
    observed_at: "2026-02-01T00:00:00Z",
    scope: "own",
  });
  const client = await mcpClient(readerX);
  try {
    const accepted = await tool(client, "vault_write_fact", {
      key: `${runId}-career`,
      statement: `I start at ${policySubject} next month as an analyst`,
      observed_at: "2026-02-02T00:00:00Z",
      scope: "own",
    });
    return [check("employer context rejected", rejected.json.error?.code === "rejected_employer"), check("career fact accepted", accepted.ok === true)];
  } finally {
    await client.close();
  }
}

async function newestCase(): Promise<Check[]> {
  const key = `${runId}-city`;
  await rest("/v1/facts", readerX, "POST", { key, statement: `Lives in cedar ${runId}old`, observed_at: "2020-01-01T00:00:00Z", scope: "own" });
  const client = await mcpClient(readerX);
  try {
    const newer = await tool(client, "vault_write_fact", { key, statement: `Lives in maple ${runId}new`, observed_at: "2024-01-01T00:00:00Z", scope: "own" });
    const path = `bots/${runId}-reader-x/facts/${key}.md`;
    const active = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, admin);
    const bodies = versions(history.json).map((version) => String(version.body ?? ""));
    return [
      check("updated", newer.data?.outcome === "updated"),
      check("active is newer", String(active.json.data?.markdown ?? "").includes(`${runId}new`) && !String(active.json.data?.markdown ?? "").includes(`${runId}old`)),
      check("history has both", bodies.some((body) => body.includes(`${runId}old`)) && bodies.some((body) => body.includes(`${runId}new`))),
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
    for (const item of batch) {
      if (item.status === 429) return [check("seven by one hundred", false, rateLimitDetail())];
      if (item.status !== 200) return [check("seven by one hundred", false, `status ${item.status}`)];
      const ref = String(item.json.data?.block_ref ?? "");
      if (!ref || seen.has(ref)) return [check("unique block refs", false, "duplicate or missing block_ref")];
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
  await rest("/v1/notes", sharedWriter, "PUT", { path, body: "two", type: "note", if_match: etag });
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
    check("one hundred forty refs", seen.size === batches * 7 && missing === 0, missing ? `${missing} markers missing` : `${seen.size} refs`),
    check("entries intact", torn === 0, torn ? `${torn} entries were split or duplicated` : undefined),
    check("journal order", order.status === 200 && stored.join() === fileOrder.join(), `status ${order.status}`),
    check("stale etag", stale.status === 409 && stale.json.error?.code === "conflict_etag", `status ${stale.status}`),
    check("entries survive rebuild", rebuilt.status === 200 && stillMissing === 0 && after.json.data?.status === "active", stillMissing ? `${stillMissing} refs missing after rebuild` : undefined),
  ];
}

async function appendOnlyCase(): Promise<Check[]> {
  const client = await mcpClient(sharedWriter);
  try {
    const rewrite = await tool(client, "vault_write_note", { path: `bots/${runId}-shared-writer/journal/2099/11/2099-11-11.md`, body: "rewritten", type: "note" });
    const probe = await rest("/v1/admin/audit/verify-append-only", admin, "POST", {});
    return [
      check("journal rewrite rejected", rewrite.error?.code === "invalid"),
      check("audit mutations abort", probe.json.data?.update_aborted === true && probe.json.data?.delete_aborted === true),
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
    return [check("same response", JSON.stringify(first.json.data) === JSON.stringify(second.data) && first.status === 200)];
  } finally {
    await client.close();
  }
}

async function forgetCase(): Promise<Check[]> {
  const marker = `qxforget${runId}`;
  const path = `bots/${runId}-reader-x/${runId}-note.md`;
  const client = await mcpClient(readerX);
  try {
    await tool(client, "vault_write_note", { path, body: `Remember ${marker}`, type: "note" });
    const forgotten = await tool(client, "vault_forget", { path, reason: "no longer needed" });
    const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, readerX);
    const search = await rest(`/v1/search?q=${marker}`, readerX);
    const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, admin);
    return [
      check("forgotten", forgotten.ok === true && read.json.data?.status === "forgotten"),
      check("stub", String(read.json.data?.markdown ?? "").includes("Forgotten") && !String(read.json.data?.markdown ?? "").includes(marker)),
      check("search empty", results(search.json).length === 0),
      check("history kept", versions(history.json).length > 0),
      { name: "vector deletion", status: "partial", detail: "FTS covered: search is empty, the read is a stub, and history is kept. Vector deletion is deferred to M2." },
    ];
  } finally {
    await client.close();
  }
}

async function humanEditCase(): Promise<Check[]> {
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_ENDPOINT || !process.env.R2_BUCKET) {
    return [{ name: "s3 edit", status: "skipped", detail: "Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, and R2_BUCKET" }];
  }
  const bucket = process.env.R2_BUCKET;
  const path = `shared/${runId}-human.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `Original ${runId}alpha`, type: "note" });
  const s3 = s3Client();
  const started = Date.now();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `vault/${path}`, Body: `Updated ${runId}beta from outside the api\n`, ContentType: "text/markdown" }));
  let found = false;
  while (Date.now() - started < 10_000) {
    const search = await rest(`/v1/search?q=${runId}beta`, sharedWriter);
    if (results(search.json).some((row) => row.path === path)) {
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
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `vault/${dayPath}`, Body: dayBytes.endsWith("\n") ? `${dayBytes}\n` : `${dayBytes}\n`, ContentType: "text/markdown" }));
  let dayActive = false;
  const dayStarted = Date.now();
  while (Date.now() - dayStarted < 10_000) {
    const read = await rest(`/v1/notes?path=${encodeURIComponent(dayPath)}`, admin);
    if (read.json.data?.status === "active" && String(read.json.data.markdown ?? "").includes(`${runId}dayentry`)) {
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
  const copyStarted = Date.now();
  while (Date.now() - copyStarted < 10_000) {
    const dstRow = await rest(`/v1/notes?path=${encodeURIComponent(dst)}`, admin);
    const srcRow = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, admin);
    copied = dstRow.json.data?.status === "active";
    sourceForgotten = srcRow.json.data?.status === "forgotten";
    if (copied && sourceForgotten) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const audits = await rest(`/v1/admin/audit?path=${encodeURIComponent(dst)}&limit=20`, admin);
  const sourceAudits = await rest(`/v1/admin/audit?path=${encodeURIComponent(path)}&limit=20`, admin);
  const auditText = JSON.stringify([audits.json.data?.entries, sourceAudits.json.data?.entries]);
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const secretPath = `shared/${runId}-secret-object.md`;
  await rest("/v1/notes", sharedWriter, "PUT", { path: secretPath, body: `Plain ${runId}plain`, type: "note" });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `vault/${secretPath}`, Body: `${secret}\n${runId}secretmarker\n`, ContentType: "text/markdown" }));
  let quarantined = false;
  const secretStarted = Date.now();
  while (Date.now() - secretStarted < 10_000) {
    const read = await rest(`/v1/notes?path=${encodeURIComponent(secretPath)}`, admin);
    if (read.json.data?.status === "quarantined") {
      quarantined = !String(read.json.data.markdown ?? "").includes(secret);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const versionsBefore = versions((await rest(`/v1/history?path=${encodeURIComponent(secretPath)}`, admin)).json).length;
  const auditsBefore = ((await rest(`/v1/admin/audit?path=${encodeURIComponent(secretPath)}&limit=50`, admin)).json.data?.entries as unknown[] | undefined)?.length ?? 0;
  await rest("/v1/admin/reconcile", admin, "POST", {});
  const versionsAfter = versions((await rest(`/v1/history?path=${encodeURIComponent(secretPath)}`, admin)).json).length;
  const auditsAfter = ((await rest(`/v1/admin/audit?path=${encodeURIComponent(secretPath)}&limit=50`, admin)).json.data?.entries as unknown[] | undefined)?.length ?? 0;
  const leaked = results((await rest(`/v1/search?q=${runId}secretmarker`, admin)).json);
  const gonePath = `shared/${runId}-drop.md`;
  await rest("/v1/notes", sharedWriter, "PUT", { path: gonePath, body: `${runId}dropme`, type: "note" });
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `vault/${gonePath}` }));
  await rest("/v1/admin/reconcile", admin, "POST", {});
  let dropped = false;
  const dropStarted = Date.now();
  while (Date.now() - dropStarted < 8_000) {
    const read = await rest(`/v1/notes?path=${encodeURIComponent(gonePath)}`, admin);
    const hits = results((await rest(`/v1/search?q=${runId}dropme`, sharedWriter)).json);
    if (read.json.data?.status === "forgotten" && hits.length === 0) {
      dropped = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  dlqDepth = await readDlqDepth();
  return [
    check("created", created.status === 200),
    check("keyword searchable within 10s", found && elapsed <= 10_000, `${elapsed}ms`),
    check("history snapshot", versions(history.json).some((version) => String(version.body ?? "").includes(`${runId}alpha`))),
    check("edited journal stays active", day.status === 200 && dayActive),
    check("copy indexed and source forgotten", copied && sourceForgotten),
    check("external audit has no identity", auditText.includes("external_copy") && auditText.includes("external_delete") && auditText.includes("r2-event")),
    check("secret quarantined from search", quarantined && leaked.length === 0),
    check("second reconcile is quiet", versionsAfter === versionsBefore && auditsAfter === auditsBefore),
    check("missing object is forgotten", dropped),
    check("dlq depth", dlqDepth === 0, dlqDepth === null ? "DLQ depth was not readable" : `depth ${dlqDepth}`),
  ];
}

async function rebuildCase(): Promise<Check[]> {
  const marker = `qxrebuild${runId}`;
  const path = `shared/${runId}-rebuild.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `${marker} before`, type: "note" });
  const etag = String(created.json.data?.etag ?? "");
  await rest("/v1/notes", sharedWriter, "PUT", { path, body: `${marker} after`, type: "note", if_match: etag });
  const journal = await rest("/v1/journal", sharedWriter, "POST", {
    target: "shared",
    title: "one",
    body: `${marker} journal one`,
    at: "2099-05-05T16:00:00Z",
  });
  const journalPath = String(journal.json.data?.path ?? "");
  await rest("/v1/journal", sharedWriter, "POST", { target: "shared", title: "two", body: `${marker} journal two`, at: "2099-05-05T17:00:00Z" });
  const decision = await rest("/v1/journal", sharedWriter, "POST", { target: "decisions", title: "keep", body: `${marker} decision`, at: "2099-05-05T18:00:00Z" });
  const own = await rest("/v1/journal", readerX, "POST", {
    target: "own",
    title: "once",
    body: `${marker} own`,
    at: "2099-05-05T19:00:00Z",
    idempotency_key: `${runId}-rebuild-key`,
  });
  const forgottenPath = `shared/${runId}-forgotten.md`;
  await rest("/v1/notes", sharedWriter, "PUT", { path: forgottenPath, body: `${marker} forgotten`, type: "note" });
  await rest("/v1/forget", sharedWriter, "POST", { path: forgottenPath, reason: "rebuild check" });
  const before = await rest(`/v1/search?q=${marker}`, sharedWriter);
  const entriesBefore = await rest(`/v1/admin/journal-order?path=${encodeURIComponent(journalPath)}`, admin);
  const rebuilt = await rest("/v1/admin/reindex", admin, "POST", {});
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
    check("reindex", rebuilt.status === 200 && decision.status === 200 && own.status === 200),
    check("search matches", paths(before.json).join() === paths(after.json).join() && paths(after.json).includes(path)),
    check("journals stay active", day.json.data?.status === "active" && decisions.json.data?.status === "active"),
    check("journal order unchanged", JSON.stringify(entriesBefore.json.data?.block_refs ?? []) === JSON.stringify(entriesAfter.json.data?.block_refs ?? [])),
    check("idempotent retry", retry.json.data?.entry_id === own.json.data?.entry_id),
    check("forgotten stays forgotten", forgotten.json.data?.status === "forgotten"),
    check("restore", restored.status === 200 && String(read.json.data?.markdown ?? "").includes(`${marker} before`)),
    check("post-rebuild append keeps earlier entries", appended.status === 200 && markdown.includes(`${marker} journal one`) && markdown.includes(`${marker} journal two`) && markdown.includes(`${marker} journal three`)),
  ];
}

async function cleanupCase(): Promise<Check[]> {
  const checks: Check[] = [];
  if (prodBase && prodAdmin) {
    const denied = await rest("/v1/admin/cleanup", prodAdmin, "POST", { run_id: runId }, prodBase);
    checks.push(check("prod cleanup is 404", denied.status === 404, `status ${denied.status}`));
    const after = JSON.stringify((await rest("/v1/admin/policy", prodAdmin, "GET", undefined, prodBase)).json.data ?? {});
    checks.push(check("prod policy unchanged", after === prodPolicyBefore));
  } else {
    checks.push({ name: "prod cleanup is 404", status: "skipped", detail: "Set HIVEATTIC_BASE_URL and HIVEATTIC_ADMIN_TOKEN to prove prod cleanup returns 404" });
  }
  const cleaned = await rest("/v1/admin/cleanup", admin, "POST", { run_id: runId });
  const audit = await rest("/v1/admin/audit?limit=30", admin);
  const entries = Array.isArray(audit.json.data?.entries) ? (audit.json.data?.entries as { action?: string }[]) : [];
  const left = await rest(`/v1/search?q=${runId}`, admin);
  checks.push(check("staging cleanup", cleaned.status === 200, `status ${cleaned.status}`));
  checks.push(check("staging cleanup audited", entries.some((entry) => entry.action === "cleanup")));
  checks.push(check("namespaced notes gone", results(left.json).length === 0));
  const remainingNotes = cleaned.json.data?.remaining_notes;
  const remainingObjects = cleaned.json.data?.remaining_objects;
  checks.push(check("no leftovers", remainingNotes === 0 && remainingObjects === 0, `notes ${remainingNotes} objects ${remainingObjects}`));
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

async function rest(path: string, token: string, method = "GET", body?: unknown, root = writeRoot): Promise<{ status: number; json: Envelope; text: string }> {
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

function accountFixture(): string {
  const fromEnv = process.env.HIVEATTIC_ACCOUNT_NUMBER?.trim();
  if (fromEnv) return fromEnv;
  const fixture = process.env.HIVEATTIC_ACCOUNT_FIXTURE || "test/fixtures/account-number.local.txt";
  if (existsSync(fixture)) return readFileSync(fixture, "utf8").trim();
  return "";
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

function check(name: string, ok: boolean, detail?: string): Check {
  return { name, status: ok ? "passed" : "failed", ...(detail ? { detail } : {}) };
}

function responseOmits(label: string, fragment: string, text: string): Check {
  const leaked = fragment.length > 0 && text.includes(fragment);
  return check(`${label} response omits fragment`, !leaked, leaked ? "response echoed a filtered fragment" : undefined);
}

async function auditOmits(label: string, fragment: string, requestId: string): Promise<Check> {
  const name = `${label} audit omits fragment`;
  if (!requestId) return check(name, false, "response had no request_id");
  const audit = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(requestId)}&limit=20`, admin);
  if (audit.status !== 200) return check(name, false, `audit status ${audit.status}`);
  const entries = audit.json.data?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return check(name, false, "audit row missing");
  const leaked = fragment.length > 0 && JSON.stringify(entries).includes(fragment);
  return check(name, !leaked, leaked ? "audit row echoed a filtered fragment" : undefined);
}

async function auditNotPlainSha(label: string, text: string, requestId: string): Promise<Check> {
  const name = `${label} audit hash is keyed`;
  const audit = await rest(`/v1/admin/audit?request_id=${encodeURIComponent(requestId)}&limit=20`, admin);
  const entries = audit.json.data?.entries;
  const hash = Array.isArray(entries) ? String((entries[0] as { content_hash?: string } | undefined)?.content_hash ?? "") : "";
  const plain = await sha256Hex(text);
  return check(name, hash.length > 0 && hash !== plain, hash ? undefined : "audit hash missing");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const LOG_OPERATOR =
  "The log check uses Workers Logs when CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set, and otherwise `wrangler tail`. Set HIVEATTIC_LOG_MODE=tail to force tail, or HIVEATTIC_LOG_MODE=api to use only the API. HIVEATTIC_WORKER_NAME defaults to hiveattic-staging.";

function workerName(): string {
  return process.env.HIVEATTIC_WORKER_NAME?.trim() || "hiveattic-staging";
}

function startTail(): ChildProcess {
  const script = process.env.HIVEATTIC_TAIL_SCRIPT?.trim();
  if (script) return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const override = process.env.HIVEATTIC_TAIL_COMMAND?.trim();
  if (override) return spawn(override, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  return spawn("pnpm", ["exec", "wrangler", "tail", workerName(), "--format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
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
  await new Promise((resolve) => setTimeout(resolve, attachMs));
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

async function logsOmit(label: string, fragments: string[], fromMs: number): Promise<Check> {
  const name = `${label} logs omit fragment`;
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
      if (needles.some((needle) => page.text.includes(needle))) return check(name, false, "workers logs echoed a filtered fragment");
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } while (Date.now() <= deadline);
    if (sawEvents) return check(name, true);
    if (mode === "api") return check(name, false, sanitize(lastError || "Workers Logs returned no events", needles));
  }
  await ensureTail();
  const waitRaw = Number(process.env.HIVEATTIC_LOG_WAIT_MS ?? "8000");
  const waitMs = Number.isFinite(waitRaw) && waitRaw >= 0 ? Math.min(waitRaw, 20000) : 8000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (needles.some((needle) => tailText.includes(needle))) return check(name, false, "wrangler tail echoed a filtered fragment");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!tailText.trim()) return check(name, false, sanitize(`wrangler tail produced no output. ${LOG_OPERATOR}`, needles));
  return check(name, true);
}

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
  const listed = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`, {
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
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
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
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/metrics`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json()) as { result?: { backlog_count?: number } };
  const count = body.result?.backlog_count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

function scrub(text: string): string {
  const fragments = [
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    "hunter2",
    "4242424242424242",
    "021000021",
    account,
    policySubject,
    policyQualifier,
  ].filter((item) => item.length > 0);
  let out = text;
  for (const fragment of fragments) out = out.split(fragment).join("[filtered]");
  return out;
}

async function queryWorkerLogs(token: string, accountId: string, script: string, fromMs: number): Promise<{ ok: true; text: string; events: number } | { ok: false; detail: string }> {
  const to = Math.max(Date.now(), fromMs + 1);
  let offset: string | undefined;
  let combined = "";
  let events = 0;
  for (let page = 0; page < 5; page++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`, {
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

function skipped(id: string, details: string): Case {
  return { id, status: "skipped", details, duration_ms: 0, checks: [{ name: id, status: "skipped", detail: details }] };
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
    return { id, status: "failed", details: err instanceof Error ? err.name : "error", duration_ms: Date.now() - started, checks: [{ name: id, status: "failed", detail: err instanceof Error ? err.name : "error" }] };
  }
}

function render(items: Case[]): string {
  const lines = ["# HiveAttic live E2E", "", `Run ${runId}`, ""];
  for (const item of items) lines.push(`- ${item.id}: ${item.status.toUpperCase()} (${item.duration_ms} ms) — ${item.details}`);
  const failed = items.filter((item) => item.status === "failed").length;
  const partial = items.filter((item) => item.status === "partial").length;
  lines.push("", failed === 0 ? "No failed cases." : `${failed} failed case(s).`);
  if (partial > 0) lines.push(`${partial} partial case(s). T-09 stays partial in M1: FTS is covered and vector deletion is deferred to M2.`);
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
  const artifact = scrub(JSON.stringify({ run_id: runId, target, failed, dlq_depth: dlqDepth, cases }, null, 2));
  writeFileSync(outPath, artifact);
  const summaryPath = outPath.endsWith(".json") ? `${outPath.slice(0, -".json".length)}.summary.md` : `${outPath}.summary.md`;
  writeFileSync(summaryPath, scrub(summary));
  writeFileSync(`${dirname(outPath)}/dlq.json`, JSON.stringify({ dlq_depth: dlqDepth, queue: dlqName() }, null, 2));
  console.log(scrub(summary));
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
    await ensureTail();
    cases.push({
      id: "DRY-RUN",
      status: "passed",
      details: "setup, log capture, and cleanup",
      duration_ms: 0,
      checks: [{ name: "dry-run", status: "passed" }],
    });
    return;
  }
  if (readOnly) {
    cases.push(await record("T-01", () => readOnlyReviewer()));
    for (const id of ["T-02", "T-03", "T-04", "T-05", "T-06", "T-07", "T-08", "T-09", "T-11", "T-12"]) {
      cases.push(skipped(id, "Read-only smoke does not write"));
    }
  } else {
    await assertStaging();
    stagingOk = true;
    if (prodBase && prodAdmin) prodPolicyBefore = JSON.stringify((await rest("/v1/admin/policy", prodAdmin, "GET", undefined, prodBase)).json.data ?? {});
    await prepare();
    cases.push(await record("T-01", () => scopeCase()));
    await ensureTail();
    cases.push(await record("T-02", () => secretCase()));
    cases.push(await record("T-03", () => financialCase()));
    await stopTail();
    cases.push(await record("T-04", () => employerCase()));
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
  await quiet(stopTail());
  for (const item of minted) {
    await quiet(rest("/v1/admin/tokens/revoke", admin, "POST", { token_id: item.id }, writeRoot));
  }
  for (const term of addedTerms) {
    await quiet(rest("/v1/admin/policy", admin, "DELETE", { term }, writeRoot));
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
    cases.push({ id: "ABORT", status: "failed", details: detail, duration_ms: 0, checks: [{ name: "abort", status: "failed", detail }] });
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

process.exit(await main());
