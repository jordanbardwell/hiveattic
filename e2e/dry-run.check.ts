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
    const reviewer = (request.headers.authorization ?? "").includes("reviewer-token");
    send(response, 200, {
      ok: true,
      data: {
        deploy_env: "staging",
        staging_resources: true,
        admin: !reviewer,
        agent_id: reviewer ? "reviewer" : "owner",
        scopes: reviewer ? ["read:shared"] : ["admin"],
      },
    });
    return;
  }
  if (request.method === "GET" && url.startsWith("/v1/search")) {
    send(response, 200, { ok: true, data: { results: [] } });
    return;
  }
  if (request.method === "GET" && url.includes("/queues") && !url.includes("/metrics")) {
    send(response, 200, { result: [{ queue_id: "queue-prod-dlq", queue_name: "hiveattic-index-dlq" }] });
    return;
  }
  if (request.method === "POST" && url.includes("/graphql")) {
    send(response, 200, {
      data: {
        viewer: {
          accounts: [
            {
              queueBacklogAdaptiveGroups: [{ avg: { messages: 0 }, dimensions: { datetime: "2026-10-17T19:00:00Z" } }],
            },
          ],
        },
      },
    });
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
const root = mkdtempSync(join(tmpdir(), "hiveattic-e2e-"));
const dryOut = join(root, "results.json");
const abortOut = join(root, "abort.json");

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...extra,
  };
}

function runHarness(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--experimental-strip-types", "e2e/run.ts", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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

try {
  const aborted = await runHarness([], baseEnv({ HIVEATTIC_E2E_OUT: abortOut }));
  if (aborted.code !== 2) throw new Error(`refused run exited ${aborted.code}, expected 2\n${aborted.output}`);
  const abortArtifact = JSON.parse(readFileSync(abortOut, "utf8")) as { cases?: { id?: string; status?: string }[] };
  if (!abortArtifact.cases?.some((item) => item.id === "ABORT" && item.status === "failed")) {
    throw new Error(`refused run did not write an ABORT artifact\n${aborted.output}`);
  }

  const dry = await runHarness(["--dry-run"], baseEnv({
    HIVEATTIC_E2E_OUT: dryOut,
    HIVEATTIC_STAGING_BASE_URL: `http://127.0.0.1:${address.port}`,
    HIVEATTIC_STAGING_ADMIN_TOKEN: "dry-admin",
  }));
  if (dry.code !== 0) throw new Error(`dry-run exited ${dry.code}\n${dry.output}`);
  const artifact = JSON.parse(readFileSync(dryOut, "utf8")) as Artifact;
  if (artifact.target !== "dry-run" || artifact.failed !== 0) throw new Error(`dry-run artifact was not a clean pass\n${dry.output}`);
  if (!artifact.cases?.some((item) => item.id === "DRY-RUN" && item.status === "passed")) {
    throw new Error(`dry-run did not record setup\n${dry.output}`);
  }
  if (artifact.cases.some((item) => item.id === "ABORT")) throw new Error(`dry-run aborted\n${dry.output}`);
  assertResponsesRecorded(artifact, "dry-run");
  if (counts.whoami < 1 || counts.bootstrap !== 1) throw new Error(`setup did not reach whoami and bootstrap: ${JSON.stringify(counts)}`);
  if (counts.minted.length < 6 || counts.revoked.length !== counts.minted.length) {
    throw new Error(`finally did not revoke every minted token: ${JSON.stringify(counts)}`);
  }
  if (counts.cleanup !== 1) throw new Error(`finally did not call cleanup: ${JSON.stringify(counts)}`);
  if (!dry.output.includes("DRY-RUN")) throw new Error(`dry-run summary missing\n${dry.output}`);
  const stagingDlq = JSON.parse(readFileSync(join(root, "dlq.json"), "utf8")) as { queue?: string; dlq_depth?: number | null };
  if (stagingDlq.queue !== "hiveattic-staging-index-dlq") throw new Error(`dry-run labeled the wrong DLQ: ${stagingDlq.queue}`);

  const readOnlyOut = join(root, "readonly", "results.json");
  const readOnly = await runHarness([], baseEnv({
    HIVEATTIC_E2E_OUT: readOnlyOut,
    HIVEATTIC_E2E_READ_ONLY: "1",
    HIVEATTIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    HIVEATTIC_REVIEWER_TOKEN: "reviewer-token",
    HIVEATTIC_CF_API: `http://127.0.0.1:${address.port}/client/v4`,
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acct",
  }));
  if (readOnly.code !== 0) throw new Error(`read-only exited ${readOnly.code}\n${readOnly.output}`);
  const readOnlyDlq = JSON.parse(readFileSync(join(root, "readonly", "dlq.json"), "utf8")) as { queue?: string; dlq_depth?: number | null };
  if (readOnlyDlq.queue !== "hiveattic-index-dlq") throw new Error(`read-only labeled the wrong DLQ: ${readOnlyDlq.queue}`);
  if (readOnlyDlq.dlq_depth !== 0) throw new Error(`read-only DLQ depth was not read: ${String(readOnlyDlq.dlq_depth)}`);
  if (!readOnly.output.includes("dlq depth")) throw new Error(`read-only summary missing DLQ depth\n${readOnly.output}`);
  const readOnlyArtifact = JSON.parse(readFileSync(readOnlyOut, "utf8")) as Artifact;
  assertResponsesRecorded(readOnlyArtifact, "read-only");
  const smoke = readOnlyArtifact.cases?.find((item) => item.id === "T-01");
  for (const name of ["whoami", "search"]) {
    const recorded = smoke?.checks?.find((entry) => entry.name === name)?.responses ?? [];
    if (recorded.length !== 1 || recorded[0]?.via !== "rest" || recorded[0]?.status !== 200 || !recorded[0]?.request_id?.startsWith("mock-")) {
      throw new Error(`read-only ${name} did not record its status and request_id: ${JSON.stringify(recorded)}`);
    }
  }
  if (readOnlyArtifact.cases?.some((item) => item.id === "T-04")) throw new Error("read-only still lists T-04");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function domainSet(source: string, name: string): Set<string> {
  const match = new RegExp(`export const ${name} = new Set\\(\\[([^\\]]+)\\]\\)`).exec(source);
  if (!match?.[1]) throw new Error(`${name} is missing from src/access.ts`);
  return new Set([...match[1].matchAll(/"([a-z0-9-]+)"/g)].map((item) => item[1]!).filter((item) => item.length > 0));
}
const accessSource = readFileSync("src/access.ts", "utf8");
const classified = new Set<string>([...domainSet(accessSource, "SENSITIVE_DOMAINS"), ...domainSet(accessSource, "NON_SENSITIVE_DOMAINS")]);
if (classified.size < 2) throw new Error("domain classification is empty");
const domainPatterns = [
  /domains\/([a-z0-9-]+)\//g,
  /(?:read|write):domain\/([a-z0-9-]+)/g,
  /(?:read|write):sensitive\/([a-z0-9-]+)/g,
  /read:sensitive:summary\/([a-z0-9-]+)/g,
  /domain["']?\s*[:=]\s*["']([a-z0-9-]+)["']/g,
];
const skipDir = new Set(["node_modules", ".git", "e2e-results", "dist"]);
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
for (const file of ["src", "e2e", "examples", "README.md"].flatMap((root) => sourceFiles(root))) {
  const text = readFileSync(file, "utf8");
  for (const pattern of domainPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[1] ?? "";
      if (!name || name === "pii") continue;
      if (!classified.has(name)) missing.add(`${name} (${file})`);
    }
  }
}
if (missing.size > 0) {
  throw new Error(`Unclassified domains:\n${[...missing].sort().join("\n")}`);
}

console.log("e2e dry-run check passed");
