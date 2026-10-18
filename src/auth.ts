import { RESERVED_AGENT_IDS, type Access } from "./access";
import { hashToken, timingSafeEqual } from "./crypto";
import { VaultError } from "./errors";
import { logEvent } from "./log";

type Cached = { exp: number; access: Access };

const cache = new Map<string, Cached>();
const AUTH_CACHE_MS = 10_000;

export function clearAuthCache(): void {
  cache.clear();
}

type TokenRow = {
  token_id: string;
  agent_id: string;
  scopes_override: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  scopes: string;
  disabled_at: string | null;
};

export async function authenticate(request: Request, env: Env, ctx: ExecutionContext): Promise<Access> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) throw new VaultError("unauthorized", "Bearer token required");
  if (!env.TOKEN_PEPPER) throw new VaultError("unauthorized", "Auth is not configured");
  const tokenHash = await hashToken(env.TOKEN_PEPPER, match[1]);
  const now = Date.now();
  const cached = cache.get(tokenHash);
  if (cached && cached.exp > now) return cached.access;

  if (env.ADMIN_TOKEN_HASH && timingSafeEqual(tokenHash, env.ADMIN_TOKEN_HASH)) {
    const access: Access = { agentId: "owner", tokenId: "secret-admin", scopes: ["admin"], admin: true };
    cache.set(tokenHash, { exp: now + AUTH_CACHE_MS, access });
    return access;
  }

  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, t.agent_id, t.scopes_override, t.expires_at, t.revoked_at, a.scopes, a.disabled_at
     FROM tokens t JOIN agents a ON a.id = t.agent_id
     WHERE t.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<TokenRow>();
  if (!row || row.revoked_at || row.disabled_at) throw new VaultError("unauthorized", "Token is not valid");
  if (RESERVED_AGENT_IDS.has(row.agent_id)) throw new VaultError("unauthorized", "Token is not valid");
  if (row.expires_at && Date.parse(row.expires_at) <= now) throw new VaultError("unauthorized", "Token is not valid");
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes_override || row.scopes) as unknown;
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) throw new Error("bad scopes");
    scopes = parsed;
  } catch {
    throw new VaultError("unauthorized", "Token is not valid");
  }
  const access: Access = {
    agentId: row.agent_id,
    tokenId: row.token_id,
    scopes,
    // Only the admin token is admin. A stored scope list never grants it.
    admin: false,
  };
  cache.set(tokenHash, { exp: now + AUTH_CACHE_MS, access });
  ctx.waitUntil(
    env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
      .bind(new Date(now).toISOString(), row.token_id)
      .run()
      .then(() => undefined)
      .catch(() => {
        logEvent({ event: "last_used_failed", token_id: row.token_id });
      }),
  );
  return access;
}

// cost is the number of operations in the request. A JSON-RPC batch on /mcp counts each call.
export async function enforceRateLimit(env: Env, tokenId: string, kind: "read" | "write", cost = 1): Promise<void> {
  const limit = numberVar(kind === "write" ? env.RATE_LIMIT_WRITES_PER_MIN : env.RATE_LIMIT_READS_PER_MIN, kind === "write" ? 60 : 300);
  if (limit <= 0) return;
  const windowMs = 60_000;
  const now = Date.now();
  const bucket = String(Math.floor(now / windowMs));
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (token_id, bucket_start, kind, count) VALUES (?, ?, ?, ?)
     ON CONFLICT (token_id, bucket_start, kind) DO UPDATE SET count = count + excluded.count
     RETURNING count`,
  )
    .bind(tokenId, bucket, kind, cost)
    .first<{ count: number }>();
  if ((row?.count ?? cost) > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
    throw new VaultError("rate_limited", `Rate limit exceeded; retry after ${retryAfter}s`, [String(retryAfter)]);
  }
}

export async function pruneRateCounters(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 60_000) - 180;
  await env.DB.prepare("DELETE FROM rate_counters WHERE CAST(bucket_start AS INTEGER) < ?").bind(cutoff).run();
}

function numberVar(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function countryOf(request: Request): string | null {
  const cf = request.cf as { country?: string } | undefined;
  return cf?.country ?? request.headers.get("cf-ipcountry");
}
