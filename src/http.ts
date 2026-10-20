import { authenticate, countryOf, enforceRateLimit } from "./auth";
import { consoleResponse } from "./console";
import { configure, CONTENT_LIMIT_BYTES, REQUEST_LIMIT_BYTES, requireSecrets, utf8Length } from "./config";
import { ulid } from "./crypto";
import { adminAgents, adminOverview } from "./dashboard";
import { asVaultError, errorBody, VaultError } from "./errors";
import { logEvent } from "./log";
import {
  appendJournal,
  bootstrap,
  cleanupRun,
  currentAgent,
  forgetNote,
  getJob,
  getOperation,
  health,
  history,
  journalOrder,
  list,
  listAudit,
  mintToken,
  purgeNote,
  readById,
  readPath,
  restoreVersion,
  revokeToken,
  search,
  setTokenScopes,
  startJob,
  toolRateKind,
  verifyAuditAppendOnly,
  writeFact,
  writeNote,
  type Reply,
  type Session,
} from "./service";
import {
  cleanupSchema,
  factSchema,
  forgetSchema,
  jobSchema,
  journalSchema,
  noteSchema,
  parseInput,
  purgeSchema,
  quarantineEraseSchema,
  restoreSchema,
  revokeSchema,
  tokenSchema,
  tokenScopesSchema,
} from "./schemas";

export type McpHandler = (request: Request, env: Env, ctx: ExecutionContext, original: Request) => Promise<Response>;

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext, mcp: McpHandler): Promise<Response> {
  const url = new URL(request.url);
  const requestId = ulid();
  const clientRequestId = request.headers.get("x-request-id")?.slice(0, 80) || null;
  const page = consoleResponse(request, url);
  if (page) return page;
  if (url.pathname === "/v1/health" && request.method === "GET") {
    // A bad or missing token still gets the plain health answer, never a 401.
    let authenticated = false;
    if (request.headers.get("authorization")) {
      authenticated = await authenticate(request, env, ctx).then(
        () => true,
        () => false,
      );
    }
    return json(200, envelope(await health(env, authenticated), requestId, clientRequestId));
  }
  try {
    configure(env);
    requireSecrets(env);
    // The request cap comes first: bytes are counted off the stream before anything authenticates,
    // parses, or clones the body, so it answers 413 `request` even when the content is also too big.
    const raw = await readBodyLimited(request, REQUEST_LIMIT_BYTES);
    if (url.pathname === "/mcp") {
      const access = await authenticate(request, env, ctx);
      const parsed = parseLoose(raw);
      assertMcpContent(parsed);
      const rate = mcpRateCost(request.method, parsed);
      await enforceRateLimit(env, access.tokenId, rate.kind, rate.cost);
      const forwarded = new Request(request.url, { method: request.method, headers: request.headers, body: raw && raw.length ? raw : undefined });
      return mcp(forwarded, env, ctx, request);
    }
    const access = await authenticate(request, env, ctx);
    const write = request.method !== "GET" && request.method !== "HEAD";
    await enforceRateLimit(env, access.tokenId, write ? "write" : "read");
    const session: Session = { access, requestId, client: "rest", country: countryOf(request) };
    const reply = await route(request, env, url, session, raw);
    return json(reply.status, envelope(reply.data, requestId, clientRequestId));
  } catch (err) {
    const vault = asVaultError(err);
    if (!(err instanceof VaultError)) logEvent({ event: "request_failed", name: err instanceof Error ? err.name : "error", request_id: requestId });
    const headers: Record<string, string> = {};
    if (vault.code === "rate_limited" && vault.reasons[0]) headers["retry-after"] = vault.reasons[0];
    return json(vault.status, { ok: false, error: errorBody(vault), request_id: requestId }, headers);
  }
}

async function route(request: Request, env: Env, url: URL, session: Session, raw: Uint8Array | null): Promise<Reply> {
  const { pathname } = url;
  const method = request.method;
  const ok = (data: Record<string, unknown>): Reply => ({ status: 200, data });
  const body = () => readJson(raw);
  const idempotency = request.headers.get("idempotency-key");
  // Every admin route answers 403 to a non-admin token before it reads the body. The audit read
  // also takes `audit:read`, so it checks for itself.
  if (pathname.startsWith("/v1/admin/") && pathname !== "/v1/admin/audit" && !session.access.admin) {
    throw new VaultError("forbidden_scope", "Admin scope required");
  }
  if (method === "GET" && pathname === "/v1/whoami") return ok(await currentAgent(env, session));
  if (method === "GET" && pathname === "/v1/notes") {
    const id = url.searchParams.get("id");
    if (id) return ok(await readById(env, session, id));
    return ok(await readPath(env, session, requiredQuery(url, "path")));
  }
  // GET is the canonical search. There is no POST /v1/search.
  if (method === "GET" && pathname === "/v1/search") {
    const q = url.searchParams.get("q") ?? url.searchParams.get("query");
    if (!q) throw new VaultError("invalid", "A required query parameter is missing", ["q"]);
    return ok(
      await search(env, session, q, url.searchParams.get("mode") ?? "keyword", {
        limit: Number(url.searchParams.get("limit") ?? "20"),
        domains: splitList(url.searchParams.get("domains")),
        types: splitList(url.searchParams.get("types")),
        since: url.searchParams.get("since") ?? undefined,
      }),
    );
  }
  if (method === "GET" && pathname === "/v1/list") return ok(await list(env, session, url.searchParams.get("prefix") ?? "", url.searchParams.get("cursor") ?? ""));
  if (method === "GET" && pathname === "/v1/history") return ok(await history(env, session, url.searchParams.get("path") ?? undefined, url.searchParams.get("id") ?? undefined));
  if (method === "POST" && pathname === "/v1/facts") {
    const parsed = await body();
    // A statement over the content cap answers 413 like a note body; the 2,000-character schema limit stays 400.
    assertContentField(parsed, "statement");
    return writeFact(env, session, parseInput(factSchema, parsed), idempotency);
  }
  if (method === "POST" && pathname === "/v1/journal") return appendJournal(env, session, parseInput(journalSchema, await body()), idempotency);
  if (method === "PUT" && pathname === "/v1/notes") {
    const parsed = await body();
    // The content cap is checked on the decoded body before the schema, so it answers 413, not 400.
    assertContentField(parsed, "body");
    return writeNote(env, session, parseInput(noteSchema, parsed), request.headers.get("if-match"), idempotency);
  }
  if (method === "POST" && pathname === "/v1/forget") return forgetNote(env, session, parseInput(forgetSchema, await body()), idempotency);
  const operation = /^\/v1\/operations\/([^/]+)$/.exec(pathname);
  if (method === "GET" && operation) return getOperation(env, session, operation[1]!);
  if (method === "POST" && pathname === "/v1/admin/bootstrap") return bootstrap(env, session);
  if (method === "POST" && pathname === "/v1/admin/tokens") return ok(await mintToken(env, session, parseInput(tokenSchema, await body())));
  if (method === "POST" && pathname === "/v1/admin/tokens/scopes") return ok(await setTokenScopes(env, session, parseInput(tokenScopesSchema, await body())));
  if (method === "POST" && pathname === "/v1/admin/tokens/revoke") return ok(await revokeToken(env, session, parseInput(revokeSchema, await body())));
  if (method === "POST" && pathname === "/v1/admin/reindex") return startJob(env, session, "reindex");
  if (method === "POST" && pathname === "/v1/admin/rebuild") return startJob(env, session, "rebuild");
  if (method === "POST" && pathname === "/v1/admin/reconcile") return startJob(env, session, "reconcile");
  if (method === "POST" && pathname === "/v1/admin/jobs") {
    const input = parseInput(jobSchema, await body());
    return startJob(env, session, input.kind);
  }
  if (method === "POST" && pathname === "/v1/admin/migrations/quarantine-erase") {
    const input = parseInput(quarantineEraseSchema, await body());
    return startJob(env, session, "quarantine-erase", { dryRun: input.dry_run, confirmCount: input.confirm_count });
  }
  const job = /^\/v1\/admin\/jobs\/([^/]+?)(\/report)?$/.exec(pathname);
  if (method === "GET" && job) return getJob(env, session, job[1]!, Boolean(job[2]));
  if (method === "GET" && pathname === "/v1/admin/journal-order") return ok(await journalOrder(env, session, requiredQuery(url, "path")));
  if (method === "POST" && pathname === "/v1/admin/restore") return restoreVersion(env, session, parseInput(restoreSchema, await body()));
  if (method === "DELETE" && pathname === "/v1/admin/purge") return purgeNote(env, session, parseInput(purgeSchema, await body()));
  if (method === "POST" && pathname === "/v1/admin/cleanup") return cleanupRun(env, session, parseInput(cleanupSchema, await body()).run_id);
  if (method === "GET" && pathname === "/v1/admin/audit") {
    return ok(
      await listAudit(
        env,
        session,
        Number(url.searchParams.get("limit") ?? "50"),
        url.searchParams.get("request_id") ?? undefined,
        url.searchParams.get("path") ?? undefined,
      ),
    );
  }
  if (method === "GET" && pathname === "/v1/admin/agents") return ok(await adminAgents(env, session));
  if (method === "GET" && pathname === "/v1/admin/overview") return ok(await adminOverview(env, session));
  if (method === "POST" && pathname === "/v1/admin/audit/verify-append-only") return ok(await verifyAuditAppendOnly(env, session));
  throw new VaultError("not_found", "Route not found");
}

export function tooLarge(limit: "request" | "content"): VaultError {
  const cap = limit === "request" ? REQUEST_LIMIT_BYTES : CONTENT_LIMIT_BYTES;
  return new VaultError("payload_too_large", `The ${limit} is over ${cap} bytes`, [limit], { limit });
}

function assertContent(text: string): void {
  if (utf8Length(text) > CONTENT_LIMIT_BYTES) throw tooLarge("content");
}

function assertContentField(parsed: unknown, field: "body" | "statement"): void {
  if (!parsed || typeof parsed !== "object") return;
  const value = (parsed as Record<string, unknown>)[field];
  if (typeof value === "string") assertContent(value);
}

// Reads the body as bytes and stops at the cap. A declared Content-Length over the cap is refused
// unread. A chunked body with no Content-Length is counted chunk by chunk and cancelled when it passes.
export async function readBodyLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw tooLarge("request");
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    total += chunk.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge("request");
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseLoose(raw: Uint8Array | null): unknown {
  if (!raw || raw.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return undefined;
  }
}

function rpcMessages(parsed: unknown): { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }[] {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.filter((message): message is { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } => Boolean(message) && typeof message === "object");
}

// The MCP note body and fact statement get the same 413 `content` answer as REST, as an HTTP 413,
// before the tool runs.
function assertMcpContent(parsed: unknown): void {
  for (const message of rpcMessages(parsed)) {
    if (message.method !== "tools/call") continue;
    if (message.params?.name === "vault_write_note") assertContentField(message.params.arguments, "body");
    if (message.params?.name === "vault_write_fact") assertContentField(message.params.arguments, "statement");
  }
}

// A JSON-RPC batch runs every call it holds, so it costs one write unit per write call, or one read
// unit per message when it holds no writes. Counting the request once let a batch skip the limit.
function mcpRateCost(method: string, parsed: unknown): { kind: "read" | "write"; cost: number } {
  if (method !== "POST") return { kind: "read", cost: 1 };
  const messages = rpcMessages(parsed);
  const writes = messages.filter((message) => message.method === "tools/call" && toolRateKind(message.params?.name) === "write").length;
  if (writes > 0) return { kind: "write", cost: writes };
  return { kind: "read", cost: Math.max(1, messages.length) };
}

function splitList(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function envelope(data: Record<string, unknown>, requestId: string, clientRequestId: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { ok: true, data, request_id: requestId };
  if (clientRequestId) body.client_request_id = clientRequestId;
  return body;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new VaultError("invalid", "A required query parameter is missing", [name]);
  return value;
}

function readJson(raw: Uint8Array | null): unknown {
  const text = raw ? new TextDecoder().decode(raw) : "";
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new VaultError("invalid", "Request body must be JSON");
  }
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
