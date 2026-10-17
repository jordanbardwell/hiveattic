import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Counts = { whoami: number; minted: string[]; revoked: string[]; cleanup: number; bootstrap: number };

const counts: Counts = { whoami: 0, minted: [], revoked: [], cleanup: 0, bootstrap: 0 };

let requests = 0;

// HiveAttic envelopes carry a request_id. The mock adds one so the harness can record it per check.
function send(response: ServerResponse, status: number, body: unknown): void {
  requests += 1;
  const enveloped = body && typeof body === "object" && "ok" in body ? { ...body, request_id: `mock-${requests}` } : body;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(enveloped));
}

type Artifact = {
  target?: string;
  failed?: number;
  cases?: { id?: string; status?: string; checks?: { name?: string; responses?: { label?: string; via?: string; status?: number | null; request_id?: string | null }[] }[] }[];
};

function assertResponsesRecorded(artifact: Artifact, label: string): void {
  for (const item of artifact.cases ?? []) {
    for (const entry of item.checks ?? []) {
      if (!Array.isArray(entry.responses)) throw new Error(`${label}: ${item.id} ${entry.name} has no responses list`);
    }
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

const server = createServer(async (request, response) => {
  const url = request.url ?? "";
  const body = await readBody(request);
  if (request.method === "GET" && url.startsWith("/v1/whoami")) {
    counts.whoami += 1;
    send(response, 200, { ok: true, data: { deploy_env: "staging", staging_resources: true, admin: true, agent_id: "owner", scopes: ["admin"] } });
    return;
  }
  if (request.method === "POST" && url === "/v1/admin/tokens") {
    const id = `tok-${counts.minted.length + 1}`;
    counts.minted.push(id);
    send(response, 200, { ok: true, data: { token: `secret-${id}`, token_id: id } });
    return;
  }
  if (request.method === "POST" && url === "/v1/admin/tokens/revoke") {
    const parsed = JSON.parse(body) as { token_id?: string };
    if (parsed.token_id) counts.revoked.push(parsed.token_id);
    send(response, 200, { ok: true, data: { revoked: true } });
    return;
  }
  if (request.method === "POST" && url === "/v1/admin/bootstrap") {
    counts.bootstrap += 1;
    send(response, 200, { ok: true, data: { created: [] } });
    return;
  }
  if (request.method === "POST" && url === "/v1/admin/cleanup") {
    counts.cleanup += 1;
    send(response, 200, { ok: true, data: { purged: 0 } });
    return;
  }
  send(response, 404, { ok: false, error: { code: "not_found", message: url } });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock did not bind");
const mockUrl = `http://127.0.0.1:${address.port}`;
const root = mkdtempSync(join(tmpdir(), "hiveattic-e2e-"));
const dryOut = join(root, "results.json");
const abortOut = join(root, "abort.json");

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    SystemRoot: process.env.SystemRoot ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...extra,
  };
}

function runHarness(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "e2e/run.ts", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`e2e harness timed out\n${output}`));
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

// Each of these must stop before the harness sends a single request, prod-named or not.
const dryStaging = { HIVEATTIC_STAGING_BASE_URL: mockUrl, HIVEATTIC_STAGING_ADMIN_TOKEN: "dry-admin" };
const refusals: { label: string; args: string[]; env: Record<string, string>; says: string }[] = [
  { label: "no target", args: [], env: {}, says: "HIVEATTIC_STAGING_BASE_URL" },
  { label: "prod base url set", args: ["--dry-run"], env: { ...dryStaging, HIVEATTIC_BASE_URL: mockUrl }, says: "HIVEATTIC_BASE_URL" },
  { label: "prod admin token set", args: ["--dry-run"], env: { ...dryStaging, HIVEATTIC_ADMIN_TOKEN: "prod-admin" }, says: "HIVEATTIC_ADMIN_TOKEN" },
  { label: "prod reviewer token set", args: ["--dry-run"], env: { ...dryStaging, HIVEATTIC_REVIEWER_TOKEN: "prod-reviewer" }, says: "HIVEATTIC_REVIEWER_TOKEN" },
  { label: "read-only prod mode", args: ["--dry-run"], env: { ...dryStaging, HIVEATTIC_E2E_READ_ONLY: "1" }, says: "HIVEATTIC_E2E_READ_ONLY" },
  { label: "live run against a local url", args: [], env: dryStaging, says: "hiveattic-staging workers.dev" },
  { label: "live run against the prod host", args: [], env: { HIVEATTIC_STAGING_BASE_URL: "https://hiveattic.example.workers.dev", HIVEATTIC_STAGING_ADMIN_TOKEN: "x" }, says: "production host" },
  { label: "live run over http", args: [], env: { HIVEATTIC_STAGING_BASE_URL: "http://hiveattic-staging.example.workers.dev", HIVEATTIC_STAGING_ADMIN_TOKEN: "x" }, says: "https" },
  { label: "dry run against a remote url", args: ["--dry-run"], env: { HIVEATTIC_STAGING_BASE_URL: "https://hiveattic-staging.example.workers.dev", HIVEATTIC_STAGING_ADMIN_TOKEN: "x" }, says: "local mock" },
  { label: "prod bucket", args: ["--dry-run"], env: { ...dryStaging, R2_BUCKET: "hiveattic-vault", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_ENDPOINT: "https://r2.invalid" }, says: "hiveattic-staging-*" },
  { label: "prod worker name", args: ["--dry-run"], env: { ...dryStaging, HIVEATTIC_WORKER_NAME: "hiveattic" }, says: "HIVEATTIC_WORKER_NAME" },
  { label: "prod dlq", args: ["--dry-run"], env: { ...dryStaging, HIVEATTIC_DLQ_NAME: "hiveattic-index-dlq" }, says: "HIVEATTIC_DLQ_NAME" },
  { label: "prod wrangler config", args: ["--dry-run"], env: { ...dryStaging, HIVEATTIC_STAGING_WRANGLER_CONFIG: "wrangler.jsonc" }, says: "HIVEATTIC_STAGING_WRANGLER_CONFIG" },
];

try {
  for (const refusal of refusals) {
    const before = requests;
    const refused = await runHarness(refusal.args, baseEnv({ HIVEATTIC_E2E_OUT: abortOut, ...refusal.env }));
    if (refused.code !== 2) throw new Error(`${refusal.label}: exited ${refused.code}, expected 2\n${refused.output}`);
    if (!refused.output.includes(refusal.says)) throw new Error(`${refusal.label}: output does not name ${refusal.says}\n${refused.output}`);
    if (requests !== before) throw new Error(`${refusal.label}: the harness sent ${requests - before} request(s) before refusing`);
    const abortArtifact = JSON.parse(readFileSync(abortOut, "utf8")) as { cases?: { id?: string; status?: string }[] };
    if (!abortArtifact.cases?.some((item) => item.id === "ABORT" && item.status === "failed")) {
      throw new Error(`${refusal.label}: refused run did not write an ABORT artifact\n${refused.output}`);
    }
  }

  const dry = await runHarness(["--dry-run"], baseEnv({ HIVEATTIC_E2E_OUT: dryOut, ...dryStaging }));
  if (dry.code !== 0) throw new Error(`dry-run exited ${dry.code}\n${dry.output}`);
  const artifact = JSON.parse(readFileSync(dryOut, "utf8")) as Artifact;
  if (artifact.target !== "dry-run" || artifact.failed !== 0) throw new Error(`dry-run artifact was not a clean pass\n${dry.output}`);
  if (!artifact.cases?.some((item) => item.id === "DRY-RUN" && item.status === "passed")) {
    throw new Error(`dry-run did not record setup\n${dry.output}`);
  }
  if (artifact.cases.some((item) => item.id === "ABORT")) throw new Error(`dry-run aborted\n${dry.output}`);
  assertResponsesRecorded(artifact, "dry-run");
  if (counts.whoami < 1 || counts.bootstrap !== 1) throw new Error(`setup did not reach whoami and bootstrap: ${JSON.stringify(counts)}`);
  if (counts.minted.length < 8 || counts.revoked.length !== counts.minted.length) {
    throw new Error(`finally did not revoke every minted token: ${JSON.stringify(counts)}`);
  }
  if (counts.cleanup !== 1) throw new Error(`finally did not call cleanup: ${JSON.stringify(counts)}`);
  if (!dry.output.includes("DRY-RUN")) throw new Error(`dry-run summary missing\n${dry.output}`);
  const stagingDlq = JSON.parse(readFileSync(join(root, "dlq.json"), "utf8")) as { queue?: string; dlq_depth?: number | null };
  if (stagingDlq.queue !== "hiveattic-staging-index-dlq") throw new Error(`dry-run labeled the wrong DLQ: ${stagingDlq.queue}`);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Static checks on the harness, the docs, and the example env.
const harness = readFileSync("e2e/run.ts", "utf8");
for (const forbidden of ["secretCase", "financialCase", "employerCase", "wrangler deploy", "HIVEATTIC_BASE_URL ??", "process.env.HIVEATTIC_ADMIN_TOKEN", "/v1/admin/policy", "quarantined"]) {
  if (harness.includes(forbidden)) throw new Error(`e2e/run.ts still contains ${forbidden}`);
}
for (const required of ["logsOmit", "shell: process.platform === \"win32\"", "\"--config\"", "Ask Forge", "JOB_CEILING_MS"]) {
  if (!harness.includes(required)) throw new Error(`e2e/run.ts is missing ${required}`);
}
const example = readFileSync(".e2e.env.example", "utf8");
if (/^R2_BUCKET=hiveattic-vault\s*$/m.test(example)) throw new Error(".e2e.env.example defaults R2_BUCKET to the production bucket");
if (/^HIVEATTIC_(BASE_URL|ADMIN_TOKEN|REVIEWER_TOKEN)=/m.test(example)) throw new Error(".e2e.env.example still names a production variable");

// Every wrangler command in the README and the harness names its config file.
const readme = readFileSync("README.md", "utf8");
for (const [file, text] of [["README.md", readme], ["e2e/run.ts", harness]] as const) {
  for (const line of text.split("\n")) {
    const command = /(?:^|\s|`)(?:pnpm exec )?wrangler (deploy|secret|d1|r2|queues|tail|dev|types)\b/.exec(line);
    if (command && !line.includes("--config")) throw new Error(`${file}: a wrangler command has no --config: ${line.trim()}`);
  }
}
for (const required of ["wrangler secret put JOURNAL_MAC_KEY", "wrangler secret put AUDIT_KEY", "VAULT_TZ", "GET /v1/search", "202", "413", "/v1/admin/migrations/quarantine-erase", "Idempotency-Key"]) {
  if (!readme.includes(required)) throw new Error(`README.md does not document ${required}`);
}
if (!readFileSync(".dev.vars.example", "utf8").includes("VAULT_TZ")) throw new Error(".dev.vars.example does not document VAULT_TZ");

// The vault rule card is guidance only. Nothing may say the server blocks content.
const blockClaims = /(?:server|it) (?:rejects|blocks|quarantines|filters out) (?:them|it|content|secrets|writes)|the server rejects them|rejected by the (?:secret|financial|employer) filter|(?:are|is) quarantined/i;
for (const file of ["AGENTS.md", "content/vault/AGENTS.md", "content/vault/README.md", "README.md"]) {
  const text = readFileSync(file, "utf8");
  if (blockClaims.test(text)) throw new Error(`${file} claims the server rejects, blocks, or quarantines content`);
}
if (readFileSync("AGENTS.md", "utf8") !== readFileSync("content/vault/AGENTS.md", "utf8")) {
  throw new Error("AGENTS.md and content/vault/AGENTS.md must be the same rule card");
}
for (const file of ["AGENTS.md", "content/vault/AGENTS.md"]) {
  const text = readFileSync(file, "utf8").toLowerCase();
  for (const required of ["password", "api key", "card", "account number", "employer", "does not block"]) {
    if (!text.includes(required)) throw new Error(`${file} does not mention ${required}`);
  }
}

// T-20. Every domain the repo names must be classified in the deploy configs, and no config may list
// a name as both sensitive and ordinary. A few test fixtures name unclassified domains on purpose.
function jsonc(file: string): { vars?: Record<string, string> } {
  const text = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(text) as { vars?: Record<string, string> };
}
function names(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
const classified = new Set<string>();
for (const file of ["wrangler.jsonc", "wrangler.example.jsonc", "wrangler.staging.example.jsonc"]) {
  const vars = jsonc(file).vars ?? {};
  const sensitive = names(vars.SENSITIVE_DOMAINS || "health,finance");
  const ordinary = names(vars.ORDINARY_DOMAINS);
  const both = sensitive.filter((name) => ordinary.includes(name));
  if (both.length) throw new Error(`${file} lists ${both.join(", ")} as both sensitive and ordinary`);
  if ([...sensitive, ...ordinary].includes("restricted")) throw new Error(`${file} uses restricted as a domain name`);
  for (const name of [...sensitive, ...ordinary]) classified.add(name);
}
const UNCLASSIFIED_FIXTURES = new Set(["legal", "medical"]);
const SPECIAL = new Set(["pii", "restricted"]);
const domainPatterns = [
  /domains\/([a-z0-9-]+)\//g,
  /sensitive\/([a-z0-9-]+)\//g,
  /(?:read|write):domain\/([a-z0-9-]+)/g,
  /(?:read|write):sensitive\/([a-z0-9-]+)/g,
  /read:sensitive:summary\/([a-z0-9-]+)/g,
  /domain["']?\s*[:=]\s*["']([a-z0-9-]+)["']/g,
];
const skipDir = new Set(["node_modules", ".git", "e2e-results", "dist", ".wrangler"]);
function sourceFiles(dir: string): string[] {
  const info = statSync(dir);
  if (info.isFile()) return /\.(ts|md|json|txt)$/.test(dir) ? [dir] : [];
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skipDir.has(name)) continue;
    const full = join(dir, name);
    const child = statSync(full);
    if (child.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|md|json|txt)$/.test(name) && name !== "worker-configuration.d.ts") found.push(full);
  }
  return found;
}
const missing = new Set<string>();
for (const file of ["src", "e2e", "test", "examples", "content", "README.md", "AGENTS.md"].flatMap((item) => sourceFiles(item))) {
  const text = readFileSync(file, "utf8");
  const isTest = file.replaceAll("\\", "/").startsWith("test/");
  for (const pattern of domainPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[1] ?? "";
      if (!name || SPECIAL.has(name) || classified.has(name)) continue;
      if (isTest && UNCLASSIFIED_FIXTURES.has(name)) continue;
      missing.add(`${name} (${file})`);
    }
  }
}
if (missing.size > 0) {
  throw new Error(`Unclassified domains:\n${[...missing].sort().join("\n")}`);
}

console.log("e2e dry-run check passed");
