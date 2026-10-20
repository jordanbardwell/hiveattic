import { describe, expect, it } from "vitest";
import { mcp, mint, nid } from "./helpers";

// An agent often reads a note and writes the whole file back, frontmatter included. The vault
// keeps one frontmatter block, so the old block never shows as text in the note.

describe("a note written back with its frontmatter", () => {
  it("keeps one frontmatter block and the caller's own keys", async () => {
    const id = `fm-${nid()}`;
    const token = await mint(id, ["read:own", "write:own"], "fm");
    const path = `bots/${id}/recipes/apple-pie.md`;
    const first = await mcp(token, "vault_write_note", { path, body: "# Apple pie\n\n- 6 apples\n", extra: { title: "Apple pie" }, idempotency_key: `k-${nid()}` });
    expect(first.json.ok, first.text).toBe(true);
    const read = await mcp(token, "vault_read", { path });
    const markdown = String(read.json.data?.markdown);
    expect(markdown.startsWith("---\n")).toBe(true);

    const again = await mcp(token, "vault_write_note", { path, body: `${markdown}- 1 cup sugar\n`, if_match: read.json.data?.etag, idempotency_key: `k-${nid()}` });
    expect(again.json.ok, again.text).toBe(true);
    const stored = String((await mcp(token, "vault_read", { path })).json.data?.markdown);
    expect(stored.match(/^---$/gm)?.length).toBe(2);
    expect(stored.match(/vault_id:/g)?.length).toBe(1);
    expect(stored).toContain("title: Apple pie");
    expect(stored).toContain("# Apple pie\n\n- 6 apples\n- 1 cup sugar\n");
  });

  it("lets extra win over a key in the pasted block", async () => {
    const id = `fm-${nid()}`;
    const token = await mint(id, ["read:own", "write:own"], "fm");
    const path = `bots/${id}/pie.md`;
    const written = await mcp(token, "vault_write_note", { path, body: "---\ntitle: Old\nvault_id: FAKE\nowner: someone-else\n---\nText", extra: { title: "New" } });
    expect(written.json.ok, written.text).toBe(true);
    const stored = String((await mcp(token, "vault_read", { path })).json.data?.markdown);
    expect(stored).toContain("title: New");
    expect(stored).not.toContain("FAKE");
    expect(stored).not.toContain("someone-else");
    expect(stored.endsWith("---\nText\n")).toBe(true);
  });
});
