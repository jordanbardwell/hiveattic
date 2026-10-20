import { beforeAll, describe, expect, it } from "vitest";
import { mcp, mint, nid } from "./helpers";

// An agent that gets a bare "invalid" or "forbidden" on a note write tends to give up and write a
// fact instead. Each refusal says what to change.

let agent = "";
let id = "";

beforeAll(async () => {
  id = `notes-${nid()}`;
  agent = await mint(id, ["read:all", "read:own", "write:own", "write:shared"], "console test");
});

describe("note write errors say what to change", () => {
  it("names the path rule that failed", async () => {
    const cases: [string, string][] = [
      [`bots/${id}/Apple Pie.md`, "no spaces"],
      [`bots/${id}/recipes/apple-pie`, "must end in .md"],
      [`bots/${id}/café.md`, "no spaces"],
      [`.hidden/x.md`, "must start with a letter or a digit"],
    ];
    for (const [path, words] of cases) {
      const written = await mcp(agent, "vault_write_note", { path, body: "Flour, apples, sugar." });
      expect(written.json.error?.code, path).toBe("invalid");
      expect(written.json.error?.message, path).toContain(words);
    }
  });

  it("names the folders the token can write", async () => {
    const written = await mcp(agent, "vault_write_note", { path: `recipes/apple-pie-${nid()}.md`, body: "Flour, apples, sugar." });
    expect(written.json.error?.code).toBe("forbidden_scope");
    expect(written.json.error?.message).toContain(`bots/${id}/`);
    expect(written.json.error?.message).toContain("shared/");
  });

  it("says to send if_match when the note already exists", async () => {
    const path = `bots/${id}/recipes/apple-pie-${nid()}.md`;
    expect((await mcp(agent, "vault_write_note", { path, body: "Flour, apples." })).json.ok).toBe(true);
    const again = await mcp(agent, "vault_write_note", { path, body: "Flour, apples, sugar." });
    expect(again.json.error?.code).toBe("conflict_etag");
    expect(again.json.error?.message).toContain("send its etag as if_match");
    const read = await mcp(agent, "vault_read", { path });
    const replaced = await mcp(agent, "vault_write_note", { path, body: "Flour, apples, sugar.", if_match: read.json.data?.etag });
    expect(replaced.json.ok, replaced.text).toBe(true);
    const stale = await mcp(agent, "vault_write_note", { path, body: "x", if_match: read.json.data?.etag });
    expect(stale.json.error?.message).toBe("if_match does not match the current etag");
  });
});
