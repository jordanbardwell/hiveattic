import { beforeAll, describe, expect, it } from "vitest";
import { mint, nid, rest } from "./helpers";

// D1 refuses a LIKE pattern longer than 50 bytes. A list prefix, an agent id, a domain name, and a
// read:prefix: scope can each be longer than that, so none of them may turn into a LIKE pattern.

let writer = "";
const m = nid();
const folder = `shared/lp-${m}/a-folder-name-that-is-quite-long/`;
const deep = `${folder}and-another-long-folder/`;

beforeAll(async () => {
  writer = await mint("prefix-writer", ["read:shared", "read:own", "write:own", "write:shared"], "prefix-writer");
  for (const [path, body] of [
    [`${deep}deep.md`, `# Deep\n\nqxprefix deep ${m}`],
    [`shared/lp-${m}/a_b/under.md`, `# Under\n\nqxprefix under ${m}`],
    [`shared/lp-${m}/axb/other.md`, `# Other\n\nqxprefix other ${m}`],
    [`bots/prefix-writer/notes/lp-${m}.md`, `# Own\n\nqxprefix own ${m}`],
  ]) {
    const written = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path, body, type: "note" }) });
    expect(written.status, written.text).toBe(200);
  }
});

async function listed(token: string, prefix: string): Promise<string[]> {
  const page = await rest(`/v1/list?prefix=${encodeURIComponent(prefix)}`, token);
  expect(page.status, page.text).toBe(200);
  return ((page.json.data?.notes ?? []) as { path: string }[]).map((note) => note.path).sort();
}

async function found(token: string, word: string): Promise<string[]> {
  const page = await rest(`/v1/search?q=${encodeURIComponent(word)}`, token);
  expect(page.status, page.text).toBe(200);
  return ((page.json.data?.results ?? []) as { path: string }[]).map((hit) => hit.path).sort();
}

describe("prefixes longer than the LIKE pattern limit of D1", () => {
  it("lists a folder whose path is longer than 50 bytes", async () => {
    expect(await listed(writer, deep)).toEqual([`${deep}deep.md`]);
  });

  it("reads _ and % in a list prefix as ordinary characters, and case counts", async () => {
    expect(await listed(writer, `shared/lp-${m}/a_b/`)).toEqual([`shared/lp-${m}/a_b/under.md`]);
    expect(await listed(writer, `shared/lp-${m}/a%`)).toEqual([]);
    expect(await listed(writer, `SHARED/lp-${m}/`)).toEqual([]);
    expect(await listed(writer, `shared/lp-${m}/a`)).toEqual([`${deep}deep.md`, `shared/lp-${m}/a_b/under.md`, `shared/lp-${m}/axb/other.md`]);
  });

  it("lets an agent with a 64-character id list and search", async () => {
    const id = `lp-${m}-${"long-agent-id-".repeat(4)}`.slice(0, 64).replace(/-$/, "x");
    expect(id.length).toBe(64);
    const token = await mint(id, ["read:shared", "read:own", "write:own"], "prefix-long-agent");
    expect(await listed(token, `shared/lp-${m}/axb/`)).toEqual([`shared/lp-${m}/axb/other.md`]);
    expect(await found(token, `qxprefix ${m}`)).toContain(`shared/lp-${m}/axb/other.md`);
    const own = await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path: `bots/${id}/notes/mine.md`, body: "# Mine", type: "note" }) });
    expect(own.status, own.text).toBe(200);
    expect(await listed(token, `bots/${id}/`)).toEqual([`bots/${id}/notes/mine.md`]);
  });

  it("lets a token with a long domain scope search", async () => {
    // The note in another bot's folder makes the search test the domain scope.
    const token = await mint(`lp-domain-${m}`, ["read:shared", `read:domain/${"a-long-domain-name-".repeat(3)}x`], "prefix-long-domain");
    const paths = await found(token, `qxprefix ${m}`);
    expect(paths).toContain(`shared/lp-${m}/axb/other.md`);
    expect(paths).not.toContain(`bots/prefix-writer/notes/lp-${m}.md`);
  });

  it("gives a read:prefix scope with a long prefix the notes under it", async () => {
    const long = await mint(`lp-reader-${m}`, [`read:prefix:${folder}`], "prefix-long-reader");
    expect(await listed(long, `shared/lp-${m}/`)).toEqual([`${deep}deep.md`]);
  });

  it("gives a read:prefix scope with _ in it the notes under it, and no others", async () => {
    const under = await mint(`lp-under-${m}`, [`read:prefix:shared/lp-${m}/a_b/`], "prefix-under-reader");
    expect(await listed(under, `shared/lp-${m}/`)).toEqual([`shared/lp-${m}/a_b/under.md`]);
    expect(await found(under, `qxprefix ${m}`)).toEqual([`shared/lp-${m}/a_b/under.md`]);
  });
});
