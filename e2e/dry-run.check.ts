import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Counts = { whoami: number; minted: string[]; revoked: string[]; cleanup: number; bootstrap: number };

const counts: Counts = { whoami: 0, minted: [], revoked: [], cleanup: 0, bootstrap: 0 };

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
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
    HIVEATTIC_TAIL_SCRIPT: "console.log('tail-ready'); setInterval(() => {}, 60000)",
    HIVEATTIC_TAIL_ATTACH_MS: "200",
    HIVEATTIC_LOG_MODE: "tail",
  }));
  if (dry.code !== 0) throw new Error(`dry-run exited ${dry.code}\n${dry.output}`);
  const artifact = JSON.parse(readFileSync(dryOut, "utf8")) as {
    target?: string;
    failed?: number;
    cases?: { id?: string; status?: string }[];
  };
  if (artifact.target !== "dry-run" || artifact.failed !== 0) throw new Error(`dry-run artifact was not a clean pass\n${dry.output}`);
  if (!artifact.cases?.some((item) => item.id === "DRY-RUN" && item.status === "passed")) {
    throw new Error(`dry-run did not record setup\n${dry.output}`);
  }
  if (artifact.cases.some((item) => item.id === "ABORT")) throw new Error(`dry-run aborted\n${dry.output}`);
  if (counts.whoami < 1 || counts.bootstrap !== 1) throw new Error(`setup did not reach whoami and bootstrap: ${JSON.stringify(counts)}`);
  if (counts.minted.length < 6 || counts.revoked.length !== counts.minted.length) {
    throw new Error(`finally did not revoke every minted token: ${JSON.stringify(counts)}`);
  }
  if (counts.cleanup !== 1) throw new Error(`finally did not call cleanup: ${JSON.stringify(counts)}`);
  if (!dry.output.includes("DRY-RUN")) throw new Error(`dry-run summary missing\n${dry.output}`);
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
for (const file of ["src", "e2e", "examples", "policy", "README.md"].flatMap((root) => sourceFiles(root))) {
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
