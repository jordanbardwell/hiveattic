import { authenticate, countryOf, enforceRateLimit } from "./auth";
import { ulid } from "./crypto";
import { ERROR_STATUS, VaultError, asVaultError } from "./errors";
import { logEvent } from "./log";
import {
  appendJournal,
  bootstrap,
  cleanupRun,
  currentAgent,
  forgetNote,
  health,
  history,
  journalOrder,
  list,
  listAudit,
  mintToken,
  purgeNote,
  readById,
  readPath,
  reconcile,
  reindex,
  restoreVersion,
  revokeToken,
  search,
  verifyAuditAppendOnly,
  toolRateKind,
  writeFact,
  writeNote,
  type Session,
} from "./service";
import { cleanupSchema, factSchema, forgetSchema, journalSchema, noteSchema, parseInput, purgeSchema, restoreSchema, revokeSchema, tokenSchema } from "./schemas";

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext, mcp: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const requestId = ulid();
  const clientRequestId = request.headers.get("x-request-id")?.slice(0, 80) || null;
  if (url.pathname === "/v1/health" && request.method === "GET") return json(200, envelope(await health(env), requestId, clientRequestId));
  try {
    if (url.pathname === "/mcp") {
      const access = await authenticate(request, env, ctx);
      const kind = await mcpRateKind(request);
      await enforceRateLimit(env, access.tokenId, kind);
      return mcp(request, env, ctx);
    }
    const access = await authenticate(request, env, ctx);
    const write = request.method !== "GET" && request.method !== "HEAD";
    await enforceRateLimit(env, access.tokenId, write ? "write" : "read");
    const session: Session = { access, requestId, client: "rest", country: countryOf(request) };
    const data = await route(request, env, url, session);
    return json(200, envelope(data, requestId, clientRequestId));
  } catch (err) {
    const vault = asVaultError(err);
    if (!(err instanceof VaultError)) logEvent({ event: "request_failed", name: err instanceof Error ? err.name : "error", request_id: requestId });
    const headers: Record<string, string> = {};
    if (vault.code === "rate_limited" && vault.reasons[0]) headers["retry-after"] = vault.reasons[0];
    return json(vault.status || ERROR_STATUS[vault.code] || 400, { ok: false, error: { code: vault.code, message: vault.message, reasons: vault.reasons }, request_id: requestId }, headers);
  }
}

async function route(request: Request, env: Env, url: URL, session: Session): Promise<Record<string, unknown>> {
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/v1/whoami") return currentAgent(env, session);
  if (request.method === "GET" && pathname === "/v1/notes") {
    const id = url.searchParams.get("id");
    if (id) return readById(env, session, id);
    return readPath(env, session, requiredQuery(url, "path"));
  }
  if (request.method === "GET" && pathname === "/v1/search") {
    const q = url.searchParams.get("q") ?? url.searchParams.get("query");
    if (!q) throw new VaultError("invalid", "A required query parameter is missing", ["q"]);
    return search(env, session, q, url.searchParams.get("mode") ?? "keyword", {
      limit: Number(url.searchParams.get("limit") ?? "20"),
      domains: splitList(url.searchParams.get("domains")),
      types: splitList(url.searchParams.get("types")),
      since: url.searchParams.get("since") ?? undefined,
    });
  }
  if (request.method === "GET" && pathname === "/v1/list") return list(env, session, url.searchParams.get("prefix") ?? "", url.searchParams.get("cursor") ?? "");
  if (request.method === "GET" && pathname === "/v1/history") return history(env, session, url.searchParams.get("path") ?? undefined, url.searchParams.get("id") ?? undefined);
  if (request.method === "POST" && pathname === "/v1/facts") return writeFact(env, session, parseInput(factSchema, await readJson(request)));
  if (request.method === "POST" && pathname === "/v1/journal") return appendJournal(env, session, parseInput(journalSchema, await readJson(request)));
  if (request.method === "PUT" && pathname === "/v1/notes") {
    return writeNote(env, session, parseInput(noteSchema, await readJson(request)), request.headers.get("if-match"));
  }
  if (request.method === "POST" && pathname === "/v1/forget") return forgetNote(env, session, parseInput(forgetSchema, await readJson(request)));
  if (request.method === "POST" && pathname === "/v1/admin/bootstrap") return bootstrap(env, session);
  if (request.method === "POST" && pathname === "/v1/admin/tokens") return mintToken(env, session, parseInput(tokenSchema, await readJson(request)));
  if (request.method === "POST" && pathname === "/v1/admin/tokens/revoke") return revokeToken(env, session, parseInput(revokeSchema, await readJson(request)));
  if (request.method === "POST" && pathname === "/v1/admin/reindex") return reindex(env, session);
  if (request.method === "POST" && pathname === "/v1/admin/reconcile") return reconcile(env, session);
  if (request.method === "GET" && pathname === "/v1/admin/journal-order") return journalOrder(env, session, requiredQuery(url, "path"));
  if (request.method === "POST" && pathname === "/v1/admin/restore") return restoreVersion(env, session, parseInput(restoreSchema, await readJson(request)));
  if (request.method === "DELETE" && pathname === "/v1/admin/purge") return purgeNote(env, session, parseInput(purgeSchema, await readJson(request)));
  if (request.method === "POST" && pathname === "/v1/admin/cleanup") return cleanupRun(env, session, parseInput(cleanupSchema, await readJson(request)).run_id);
  if (request.method === "GET" && pathname === "/v1/admin/audit") {
    return listAudit(
      env,
      session,
      Number(url.searchParams.get("limit") ?? "50"),
      url.searchParams.get("request_id") ?? undefined,
      url.searchParams.get("path") ?? undefined,
    );
  }
  if (request.method === "POST" && pathname === "/v1/admin/audit/verify-append-only") return verifyAuditAppendOnly(env, session);
  throw new VaultError("not_found", "Route not found");
}

async function mcpRateKind(request: Request): Promise<"read" | "write"> {
  if (request.method !== "POST") return "read";
  try {
    const body = (await request.clone().json()) as unknown;
    const messages = Array.isArray(body) ? body : [body];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const call = message as { method?: string; params?: { name?: string } };
      if (call.method === "tools/call" && toolRateKind(call.params?.name) === "write") return "write";
    }
  } catch {
    return "read";
  }
  return "read";
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

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 256_000) throw new VaultError("invalid", "Request body is too large");
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
