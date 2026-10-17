import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, deliverEvent, mcp, mint, nid, resetVault, rest, testEnv } from "./helpers";

// T-18. Two 413 limits: the whole request is capped at 256,000 bytes and is checked first, before
// anything parses it; a note body or fact statement is capped at 200,000 bytes of UTF-8 after
// decoding. Schema limits stay 400.

const BACKSLASH = String.fromCharCode(92);
let writer = "";

beforeAll(async () => {
  writer = await mint("limit-writer", ["read:shared", "read:own", "write:own", "write:shared"], "limit-writer");
});

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function putRaw(raw: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  const response = await SELF.fetch("https://hiveattic.test/v1/notes", {
    method: "PUT",
    headers: { authorization: `Bearer ${writer}`, "content-type": "application/json", ...headers },
    body: raw,
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as { ok: boolean; error?: { code?: string; limit?: string; reasons?: string[] }; request_id?: string } };
}

// A note request padded to an exact byte size with an `extra` field, so content and request size vary on their own.
function sized(body: string, total: number, pad = "x"): string {
  const base = JSON.stringify({ path: `shared/limit-${nid()}.md`, body, type: "note", extra: { pad: "" } });
  const missing = total - bytes(base);
  if (missing < 0) throw new Error("base already over");
  const unit = bytes(pad);
  const padding = pad.repeat(Math.floor(missing / unit)) + "x".repeat(missing % unit);
  const out = base.replace('"pad":""', `"pad":"${padding}"`);
  expect(bytes(out)).toBe(total);
  return out;
}

async function mcpCall(token: string, args: Record<string, unknown>, raw?: string) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await SELF.fetch("https://hiveattic.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
  });
  await init.text();
  const session = init.headers.get("mcp-session-id");
  const next = session ? { ...headers, "mcp-session-id": session } : headers;
  const response = await SELF.fetch("https://hiveattic.test/mcp", {
    method: "POST",
    headers: next,
    body: raw ?? JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_write_note", arguments: args } }),
  });
  return { status: response.status, text: await response.text() };
}

describe("T-18 size limits", () => {
  it("a note body is capped at 200,000 bytes of UTF-8, counted after decoding", async () => {
    await resetVault();
    const cases: { body: string; status: number }[] = [
      { body: "a".repeat(200_000), status: 200 },
      { body: "a".repeat(200_001), status: 413 },
      { body: `${"€".repeat(66_666)}ab`, status: 200 },
      { body: "€".repeat(66_667), status: 413 },
      { body: "😀".repeat(50_000), status: 200 },
      { body: `${"😀".repeat(50_000)}a`, status: 413 },
      { body: "é".repeat(100_000), status: 200 },
      { body: `${"é".repeat(100_000)}a`, status: 413 },
    ];
    for (const item of cases) {
      const path = `shared/limit-${nid()}.md`;
      const response = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body: item.body, type: "note" }) });
      expect(response.status, `${bytes(item.body)} bytes`).toBe(item.status);
      if (item.status === 413) {
        expect(response.json.error).toMatchObject({ code: "payload_too_large", limit: "content", reasons: ["content"] });
        expect(response.json.request_id).toBeTruthy();
        expect(response.text.length).toBeLessThan(400);
      } else {
        const stored = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, writer);
        expect(String(stored.json.data?.markdown)).toContain(item.body.slice(0, 50));
      }
    }
    // Escaped text is counted after decoding: 33,000 escaped euro signs are 198,000 bytes on the wire and 99,000 decoded.
    const escaped = `${BACKSLASH}u20ac`.repeat(33_000);
    const ok = await putRaw(`{"path":"shared/limit-${nid()}.md","type":"note","body":"${escaped}"}`);
    expect(ok.status, ok.text).toBe(200);
  });

  it("the whole request is capped at 256,000 bytes and that cap wins when both are over", async () => {
    await resetVault();
    expect((await putRaw(sized("small", 256_000))).status).toBe(200);
    const over = await putRaw(sized("small", 256_001));
    expect(over.status).toBe(413);
    expect(over.json.error).toMatchObject({ code: "payload_too_large", limit: "request" });
    // Multibyte padding: 256,001 bytes but fewer characters.
    expect((await putRaw(sized("small", 256_001, "€"))).json.error?.limit).toBe("request");
    expect((await putRaw(sized("small", 256_000, "€"))).status).toBe(200);
    expect((await putRaw(sized("b".repeat(199_999), 250_000))).status).toBe(200);
    const both = await putRaw(sized("c".repeat(200_001), 256_001));
    expect(both.json.error?.limit).toBe("request");
    // 128,000 newlines are 128,000 bytes of content but 256,000 bytes of escapes on the wire.
    expect((await putRaw(JSON.stringify({ path: "shared/nl.md", type: "note", body: "\n".repeat(128_000) }))).json.error?.limit).toBe("request");
    const escaped = `${BACKSLASH}u20ac`.repeat(66_667);
    expect((await putRaw(`{"path":"shared/limit-esc.md","type":"note","body":"${escaped}"}`)).json.error?.limit).toBe("request");
    const huge = await putRaw("x".repeat(5_000_000));
    expect(huge.status).toBe(413);
    expect(huge.json.error?.limit).toBe("request");
  });

  it("a chunked body with no Content-Length is counted as it streams and stopped past the cap", async () => {
    await resetVault();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 400_000) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode("y".repeat(20_000)));
        sent += 20_000;
      },
    });
    const response = await putRaw(stream);
    expect(response.status).toBe(413);
    expect(response.json.error?.limit).toBe("request");
  });

  it("/mcp answers HTTP 413 with the same tags, before rate-limit parsing, and does not charge the rate limit", async () => {
    await resetVault();
    const env = testEnv();
    const saved = env.RATE_LIMIT_WRITES_PER_MIN;
    (env as { RATE_LIMIT_WRITES_PER_MIN: string }).RATE_LIMIT_WRITES_PER_MIN = "1000";
    try {
      const content = await mcpCall(writer, { path: `shared/m-${nid()}.md`, body: "a".repeat(200_001), type: "note" });
      expect(content.status).toBe(413);
      expect(JSON.parse(content.text).error).toMatchObject({ code: "payload_too_large", limit: "content" });
      const padded = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_write_note", arguments: { path: "shared/m.md", body: "small", type: "note", pad: "p".repeat(256_000) } } });
      const request = await mcpCall(writer, {}, padded);
      expect(request.status).toBe(413);
      expect(JSON.parse(request.text).error).toMatchObject({ code: "payload_too_large", limit: "request" });
      const charged = await env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_counters WHERE kind = 'write'").first<{ n: number }>();
      expect(charged?.n).toBe(0);
      const fine = await mcpCall(writer, { path: `shared/m-${nid()}.md`, body: "a".repeat(200_000), type: "note" });
      expect(fine.status).toBe(200);
      expect(fine.text).toContain('\\"ok\\":true');
    } finally {
      (env as { RATE_LIMIT_WRITES_PER_MIN: string }).RATE_LIMIT_WRITES_PER_MIN = saved;
      await env.DB.prepare("DELETE FROM rate_counters").run();
    }
  });

  it("a fact statement over 200,000 bytes answers 413 content on REST and MCP; over 2,000 characters it is a schema 400", async () => {
    await resetVault();
    const statement = "a".repeat(200_001);
    const viaRest = await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ key: `big-${nid()}`, statement, observed_at: "2099-01-01T00:00:00Z" }) });
    expect(viaRest.status).toBe(413);
    expect(viaRest.json.error).toMatchObject({ code: "payload_too_large", limit: "content" });
    const viaMcp = await mcp(writer, "vault_write_fact", { key: `big-${nid()}`, statement, observed_at: "2099-01-01T00:00:00Z" });
    expect(viaMcp.status).toBe(413);
    expect((await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ key: `big-${nid()}`, statement: "a".repeat(2001), observed_at: "2099-01-01T00:00:00Z" }) })).status).toBe(400);
  });

  it("schema limits stay 400, and a stored file over 1,900,000 bytes answers 413 file", async () => {
    await resetVault();
    const fact = await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ key: `f-${nid()}`, statement: "€".repeat(2001), observed_at: "2099-01-01T00:00:00Z" }) });
    expect(fact.status).toBe(400);
    expect((await rest("/v1/facts", writer, { method: "POST", body: JSON.stringify({ key: `f-${nid()}`, statement: "€".repeat(2000), observed_at: "2099-01-01T00:00:00Z" }) })).status).toBe(200);
    const journal = (length: number) => rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ target: "shared", title: "long", body: "j".repeat(length), at: "2099-09-09T12:00:00Z" }) });
    expect((await journal(8001)).status).toBe(400);
    expect((await journal(8000)).status).toBe(200);
    const day = "journal/2099/09/2099-09-09.md";
    const current = await (await testEnv().VAULT.get(`vault/${day}`))!.text();
    await testEnv().VAULT.put(`vault/${day}`, `${current}\n${"q".repeat(1_895_000 - bytes(current))}\n`);
    expect((await deliverEvent("PutObject", `vault/${day}`)).retried).toBe(false);
    const full = await journal(8000);
    expect(full.status).toBe(413);
    expect(full.json.error).toMatchObject({ code: "payload_too_large", limit: "file" });
    // An outside object past the file cap is recorded as oversize, audited, and never retried into the DLQ.
    await testEnv().VAULT.put("vault/shared/huge.md", "z".repeat(2_000_000));
    const delivered = await deliverEvent("PutObject", "vault/shared/huge.md");
    expect(delivered).toEqual({ acked: true, retried: false });
    expect(await testEnv().DB.prepare("SELECT id FROM notes WHERE path = 'shared/huge.md'").first()).toBeNull();
    expect(await testEnv().DB.prepare("SELECT 1 FROM audit_log WHERE action = 'oversize' AND path = 'shared/huge.md'").first()).toBeTruthy();
    expect((await rest("/v1/notes?path=shared/huge.md", ADMIN)).json.error).toMatchObject({ code: "payload_too_large", limit: "file" });
  });
});
