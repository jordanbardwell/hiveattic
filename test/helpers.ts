import { env, SELF } from "cloudflare:test";
import { clearAuthCache } from "../src/auth";

export const ADMIN = "test-admin-token-not-a-secret";

export type Envelope = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; reasons: string[] };
  request_id?: string;
};

type TestEnv = Env & { ACCOUNT_FIXTURE?: string; BENIGN_CORPUS?: string };

export function testEnv(): TestEnv {
  return env as TestEnv;
}

export function nid(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

export async function rest(path: string, token: string | null, init: RequestInit = {}): Promise<{ status: number; json: Envelope; text: string; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await SELF.fetch(`https://hiveattic.test${path}`, { ...init, headers });
  const text = await response.text();
  let json: Envelope = { ok: false };
  try {
    json = JSON.parse(text) as Envelope;
  } catch {
    json = { ok: false, error: { code: "invalid", message: "non-json response", reasons: [] } };
  }
  return { status: response.status, json, text, headers: response.headers };
}

export async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<{ status: number; json: Envelope; text: string }> {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const init = await SELF.fetch("https://hiveattic.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hiveattic-test", version: "0.1.0" } },
    }),
  });
  const initText = await init.text();
  if (init.status === 401) return { status: 401, json: parseRpc(initText), text: initText };
  const session = init.headers.get("mcp-session-id");
  const nextHeaders = session ? { ...headers, "mcp-session-id": session } : headers;
  await SELF.fetch("https://hiveattic.test/mcp", {
    method: "POST",
    headers: nextHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const response = await SELF.fetch("https://hiveattic.test/mcp", {
    method: "POST",
    headers: nextHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  return { status: response.status, json: toolEnvelope(text), text };
}

export async function mint(agentId: string, scopes: string[], label: string): Promise<string> {
  const response = await rest("/v1/admin/tokens", ADMIN, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, display_name: agentId, kind: "agent", scopes, label }),
  });
  if (response.status !== 200 || typeof response.json.data?.token !== "string") {
    throw new Error(`mint failed for ${agentId}: ${response.status} ${response.json.error?.code ?? ""}`);
  }
  return response.json.data.token;
}

export async function resetVault(): Promise<void> {
  clearAuthCache();
  const db = testEnv().DB;
  await db.batch([
    db.prepare("DELETE FROM links"),
    db.prepare("DELETE FROM journal_entries"),
    db.prepare("DELETE FROM note_versions"),
    db.prepare("DELETE FROM tombstones"),
    db.prepare("DELETE FROM conflicts"),
    db.prepare("DELETE FROM chunks"),
    db.prepare("DELETE FROM vector_delete_queue"),
    db.prepare("DELETE FROM idempotency"),
    db.prepare("DELETE FROM rate_counters"),
    db.prepare("DELETE FROM notes"),
  ]);
  await db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')").run();
  await deletePrefix("vault/");
  await deletePrefix("sys/");
  const boot = await rest("/v1/admin/bootstrap", ADMIN, { method: "POST", body: "{}" });
  if (boot.status !== 200) throw new Error(`bootstrap failed: ${boot.status}`);
}

async function deletePrefix(prefix: string): Promise<void> {
  const bucket = testEnv().VAULT;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

function toolEnvelope(text: string): Envelope {
  const rpc = parseRpc(text) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };
  const payload = rpc.result?.content?.find((item) => item.text)?.text;
  if (payload) {
    try {
      return JSON.parse(payload) as Envelope;
    } catch {
      return { ok: false, error: { code: "invalid", message: "tool payload was not json", reasons: [] } };
    }
  }
  if (rpc.error) return { ok: false, error: { code: "invalid", message: "tool call failed", reasons: [] } };
  return { ok: false, error: { code: "invalid", message: "empty tool response", reasons: [] } };
}

function parseRpc(text: string): Envelope & { result?: unknown; error?: { message?: string } } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Envelope;
  const data = [...trimmed.matchAll(/^data:\s*(.+)$/gm)].map((match) => match[1]).filter((line) => line && line !== "[DONE]");
  const last = data.at(-1);
  if (!last) return { ok: false };
  return JSON.parse(last) as Envelope;
}
