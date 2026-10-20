import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcp, mint, nid } from "./helpers";

// An agent finds out how the vault stores things without the copied setup text: from the server
// instructions in the initialize reply, or from the vault_guide tool.

describe("vault guide", () => {
  it("vault_guide names the caller's own folder and every kind of note", async () => {
    const id = `guide-${nid()}`;
    const token = await mint(id, ["read:own", "write:own"], "guide");
    const guide = await mcp(token, "vault_guide", {});
    expect(guide.json.ok, guide.text).toBe(true);
    expect(guide.json.data?.own_folder).toBe(`bots/${id}/`);
    const text = String(guide.json.data?.guide);
    for (const words of [`bots/${id}/facts/`, `bots/${id}/journal/`, `bots/${id}/recipes/apple-pie.md`, "vault_write_note", "vault_write_fact", "vault_append_journal"]) {
      expect(text).toContain(words);
    }
  });

  it("initialize carries the same guide as server instructions", async () => {
    const token = await mint(`guide-${nid()}`, ["read:own"], "guide");
    const response = await SELF.fetch("https://hiveattic.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    const text = await response.text();
    const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
    const body = JSON.parse(line.replace(/^data:\s*/, "")) as { result: { instructions?: string } };
    expect(body.result.instructions).toContain("vault_write_note");
    expect(body.result.instructions).toContain("vault_guide");
  });
});
