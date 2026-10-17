import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Status = "passed" | "failed" | "skipped" | "partial";
type Check = { name: string; status: Status; detail?: string };
type Case = { id: string; status: Status; details: string; duration_ms: number; checks: Check[] };

const base = (process.env.HIVEATTIC_BASE_URL ?? "").replace(/\/$/, "");
const stagingBase = (process.env.HIVEATTIC_STAGING_BASE_URL ?? "").replace(/\/$/, "");
const stagingAdmin = process.env.HIVEATTIC_STAGING_ADMIN_TOKEN ?? "";
const admin = process.env.HIVEATTIC_ADMIN_TOKEN ?? "";
const suppliedReviewer = process.env.HIVEATTIC_REVIEWER_TOKEN ?? "";
const account = accountFixture();
const outPath = process.env.HIVEATTIC_E2E_OUT ?? "e2e-results/results.json";

if (!base || (!admin && !suppliedReviewer)) {
  console.error("Set HIVEATTIC_BASE_URL and HIVEATTIC_ADMIN_TOKEN. A reviewer-only run also accepts HIVEATTIC_REVIEWER_TOKEN.");
  process.exit(2);
}

const runId = `e2e${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const cases: Case[] = [];
let reviewer = suppliedReviewer;
let readerX = "";
let financeRw = "";
let sharedWriter = "";

try {
  if (!admin) {
    cases.push(await record("T-01", () => readOnlyReviewer()));
    for (const id of ["T-02", "T-03", "T-04", "T-05", "T-06", "T-07", "T-08", "T-09", "T-11", "T-12"]) {
      cases.push(skipped(id, "Write checks need HIVEATTIC_ADMIN_TOKEN"));
    }
  } else {
    await prepare();
    cases.push(await record("T-01", () => scopeCase()));
    cases.push(await record("T-02", () => secretCase()));
    cases.push(await record("T-03", () => financialCase()));
    cases.push(await record("T-04", () => employerCase()));
    cases.push(await record("T-05", () => newestCase()));
    cases.push(await record("T-06", () => concurrencyCase()));
    cases.push(await record("T-07", () => appendOnlyCase()));
    cases.push(await record("T-08", () => idempotencyCase()));
    cases.push(await record("T-09", () => forgetCase()));
    cases.push(await record("T-11", () => humanEditCase()));
    cases.push(await record("T-12", () => rebuildCase()));
  }
  cases.push(skipped("T-10", "deferred to a later milestone"));
  cases.push(skipped("T-13", "deferred to a later milestone"));
  cases.push(skipped("T-14", "deferred to a later milestone"));
} finally {
  if (stagingBase && stagingAdmin) {
    await rest("/v1/admin/cleanup", stagingAdmin, "POST", { run_id: runId }, stagingBase).catch(() => undefined);
  }
}

const failed = cases.filter((item) => item.status === "failed").length;
const summary = render(cases);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ run_id: runId, base, failed, cases }, null, 2));
writeFileSync(outPath.replace(/\.json$/, "") + ".summary.md", summary);
console.log(summary);
process.exit(failed > 0 ? 1 : 0);

async function prepare(): Promise<void> {
  reviewer = suppliedReviewer || (await mint("reviewer", [], `${runId}-reviewer`, "reviewer"));
  readerX = await mint(`${runId}-reader-x`, ["read:shared", "read:own", "write:own", "read:domain/x", "write:domain/x"], `${runId}-reader-x`);
  financeRw = await mint(
    `${runId}-finance-rw`,
    ["read:shared", "read:own", "write:own", "read:domain/finance", "write:domain/finance", "read:sensitive/finance", "write:sensitive/finance"],
    `${runId}-finance-rw`,
  );
  sharedWriter = await mint(`${runId}-shared-writer`, ["read:shared", "read:own", "write:own", "write:shared"], `${runId}-shared-writer`);
  const boot = await rest("/v1/admin/bootstrap", admin, "POST", {});
  if (boot.status !== 200) throw new Error(`bootstrap ${boot.status}`);
}

async function readOnlyReviewer(): Promise<Check[]> {
  const who = await rest("/v1/whoami", suppliedReviewer);
  const search = await rest("/v1/search?q=vault", suppliedReviewer);
  const write = await rest("/v1/facts", suppliedReviewer, "POST", { key: "blocked", statement: "no", observed_at: new Date().toISOString(), scope: "own" });
  return [
    check("whoami", who.status === 200 && who.json.data?.admin === false, `status ${who.status}`),
    check("search", search.status === 200, `status ${search.status}`),
    check("write denied", write.status === 403, `status ${write.status}`),
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
    return [
      check("finance write", written.ok === true),
      check("reader denied", denied.status === 404),
      check("reader search empty", Array.isArray(hidden.data?.results) && hidden.data.results.length === 0),
      check("reader cannot write finance role", role.status === 403),
      check("reviewer cannot read finance", reviewerRead.status === 404),
      check("reviewer cannot write", reviewerWrite.status === 403),
      check("reviewer can read shared", shared.status === 200 && reviewerShared.status === 200),
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
  await rest("/v1/admin/policy", admin, "POST", { term: "Contoso Example Corp", kind: "context_subject" });
  await rest("/v1/admin/policy", admin, "POST", { term: "customer", kind: "context_qualifier" });
  const rejected = await rest("/v1/facts", readerX, "POST", {
    key: `${runId}-work`,
    statement: "Contoso Example Corp customer migration notes",
    observed_at: "2026-02-01T00:00:00Z",
    scope: "own",
  });
  const client = await mcpClient(readerX);
  try {
    const accepted = await tool(client, "vault_write_fact", {
      key: `${runId}-career`,
      statement: "I start at Contoso Example Corp next month as an analyst",
      observed_at: "2026-02-02T00:00:00Z",
      scope: "own",
    });
    await rest("/v1/admin/policy", admin, "DELETE", { term: "Contoso Example Corp" });
    await rest("/v1/admin/policy", admin, "DELETE", { term: "customer" });
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
  return [
    check("twenty batches", seen.size === batches * 7 && missing === 0, missing ? `${missing} markers missing` : `${seen.size} refs`),
    check("entries intact", torn === 0, torn ? `${torn} entries were split or duplicated` : undefined),
    check("journal order", order.status === 200 && stored.join() === fileOrder.join(), `status ${order.status}`),
    check("stale etag", stale.status === 409 && stale.json.error?.code === "conflict_etag", `status ${stale.status}`),
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
  const path = `shared/${runId}-human.md`;
  const created = await rest("/v1/notes", sharedWriter, "PUT", { path, body: `Original ${runId}alpha`, type: "note" });
  const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  const started = Date.now();
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `vault/${path}`, Body: `Updated ${runId}beta from outside the api\n`, ContentType: "text/markdown" }));
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
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `vault/${path}`, Body: `${secret}\n${runId}secretmarker\n`, ContentType: "text/markdown" }));
  let quarantined = false;
  const secretStarted = Date.now();
  while (Date.now() - secretStarted < 10_000) {
    const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, admin);
    if (read.json.data?.status === "quarantined") {
      quarantined = !String(read.json.data.markdown ?? "").includes(secret);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const leaked = results((await rest(`/v1/search?q=${runId}secretmarker`, admin)).json);
  return [
    check("created", created.status === 200),
    check("keyword searchable within 10s", found && elapsed <= 10_000, `${elapsed}ms`),
    check("history snapshot", versions(history.json).some((version) => String(version.body ?? "").includes(`${runId}alpha`))),
    check("secret quarantined from search", quarantined && leaked.length === 0),
  ];
}

async function rebuildCase(): Promise<Check[]> {
  if (!stagingBase || !stagingAdmin) {
    return [{ name: "staging target", status: "skipped", detail: "Set HIVEATTIC_STAGING_BASE_URL and HIVEATTIC_STAGING_ADMIN_TOKEN. T-12 and cleanup run only against the staging worker." }];
  }
  const marker = `qxrebuild${runId}`;
  const path = `shared/${runId}-rebuild.md`;
  const staged = await rest(
    "/v1/admin/tokens",
    stagingAdmin,
    "POST",
    { agent_id: `${runId}-stage`, display_name: `${runId}-stage`, kind: "agent", scopes: ["read:shared", "write:shared", "read:own", "write:own"], label: `${runId}-stage` },
    stagingBase,
  );
  const token = String(staged.json.data?.token ?? "");
  if (!token) return [check("staging token", false, `status ${staged.status}`)];
  const created = await rest("/v1/notes", token, "PUT", { path, body: `${marker} before`, type: "note" }, stagingBase);
  const etag = String(created.json.data?.etag ?? "");
  await rest("/v1/notes", token, "PUT", { path, body: `${marker} after`, type: "note", if_match: etag }, stagingBase);
  const before = await rest(`/v1/search?q=${marker}`, token, "GET", undefined, stagingBase);
  const rebuilt = await rest("/v1/admin/reindex", stagingAdmin, "POST", {}, stagingBase);
  const after = await rest(`/v1/search?q=${marker}`, token, "GET", undefined, stagingBase);
  const history = await rest(`/v1/history?path=${encodeURIComponent(path)}`, stagingAdmin, "GET", undefined, stagingBase);
  const prior = versions(history.json).find((version) => String(version.body ?? "").includes(`${marker} before`));
  const restored = await rest("/v1/admin/restore", stagingAdmin, "POST", { path, version_ts: prior?.version_ts }, stagingBase);
  const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, token, "GET", undefined, stagingBase);
  return [
    check("reindex", rebuilt.status === 200),
    check("search matches", paths(before.json).join() === paths(after.json).join() && paths(after.json).includes(path)),
    check("restore", restored.status === 200 && String(read.json.data?.markdown ?? "").includes(`${marker} before`)),
  ];
}

async function mint(agentId: string, scopes: string[], label: string, preset?: "reviewer"): Promise<string> {
  const response = await rest("/v1/admin/tokens", admin, "POST", preset ? { preset, label, agent_id: agentId } : { agent_id: agentId, display_name: agentId, kind: "agent", scopes, label });
  const token = response.json.data?.token;
  if (response.status !== 200 || typeof token !== "string") throw new Error(`mint failed for ${agentId}`);
  return token;
}

async function rest(path: string, token: string, method = "GET", body?: unknown, root = base): Promise<{ status: number; json: Envelope; text: string }> {
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

async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: { token: async () => token } });
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
  "Set CLOUDFLARE_API_TOKEN (Workers Observability Write) and CLOUDFLARE_ACCOUNT_ID to query Workers Logs. Otherwise, while pnpm e2e runs, start `pnpm exec wrangler tail hiveattic --format json` and confirm each filtered fragment is absent. The dashboard view is Workers Observability, dataset cloudflare-workers, filter $metadata.service equal to HIVEATTIC_WORKER_NAME (default hiveattic).";

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
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (!token || !accountId) return { name, status: "skipped", detail: LOG_OPERATOR };
  const needles = fragments.filter((item) => item.length > 0);
  const script = process.env.HIVEATTIC_WORKER_NAME?.trim() || "hiveattic";
  const waitRaw = Number(process.env.HIVEATTIC_LOG_WAIT_MS ?? "15000");
  const waitMs = Number.isFinite(waitRaw) && waitRaw >= 0 ? waitRaw : 15000;
  const deadline = Date.now() + waitMs;
  let sawEvents = false;
  let lastError = "";
  do {
    const page = await queryWorkerLogs(token, accountId, script, fromMs).catch((err: unknown) => ({
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
  if (lastError) return check(name, false, sanitize(lastError, needles));
  if (!sawEvents) return { name, status: "skipped", detail: `The Workers Logs query returned no events for this window. ${LOG_OPERATOR}` };
  return check(name, true);
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
  const logSkip = items.flatMap((item) => item.checks).find((item) => item.status === "skipped" && item.name.includes("logs"));
  if (logSkip?.detail) lines.push("", `Log check left for the operator: ${logSkip.detail}`);
  return lines.join("\n");
}
