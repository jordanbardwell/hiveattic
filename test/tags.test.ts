import { beforeAll, describe, expect, it } from "vitest";
import { deliverEvent, mcp, mint, nid, resetVault, rest, results, runJob, testEnv, type Envelope } from "./helpers";

// Tags on notes, facts, and journal entries, searching by them, and the tag list.

let writer = "";
let reader = "";
let other = "";
let health = "";
let everything = "";

beforeAll(async () => {
  await resetVault();
  writer = await mint("tg-writer", ["read:shared", "read:own", "write:own", "write:shared"], "tg-writer");
  reader = await mint("tg-reader", ["read:shared"], "tg-reader");
  other = await mint("tg-other", ["read:own", "write:own"], "tg-other");
  health = await mint("tg-health", ["read:shared", "write:shared", "read:sensitive/health", "write:sensitive/health"], "tg-health");
  everything = await mint("tg-all", ["read:all"], "tg-all");
});

async function putNote(token: string, path: string, body: string, fields: Record<string, unknown> = {}): Promise<Envelope> {
  const reply = await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path, body, ...fields }) });
  expect(reply.status, reply.text).toBeLessThan(300);
  return reply.json;
}

async function journal(token: string, title: string, body: string, tags: string[]): Promise<string> {
  const reply = await rest("/v1/journal", token, { method: "POST", body: JSON.stringify({ target: "own", title, body, tags }) });
  expect(reply.status, reply.text).toBe(200);
  return String(reply.json.data?.path);
}

async function tagsAt(path: string): Promise<string[]> {
  const rows = await testEnv()
    .DB.prepare("SELECT t.tag FROM note_tags t JOIN notes n ON n.id = t.note_id WHERE n.path = ? ORDER BY t.tag")
    .bind(path)
    .all<{ tag: string }>();
  return (rows.results ?? []).map((row) => row.tag);
}

async function tagged(token: string, tags: string[], q = ""): Promise<{ path?: string; tags?: string[] }[]> {
  const query = new URLSearchParams({ tags: tags.join(",") });
  if (q) query.set("q", q);
  const reply = await rest(`/v1/search?${query}`, token);
  expect(reply.status, reply.text).toBe(200);
  return (reply.json.data?.results ?? []) as { path?: string; tags?: string[] }[];
}

async function tagList(token: string, prefix = "", cursor = ""): Promise<{ tags: { tag: string; count: number; partial?: boolean }[]; cursor: string | null }> {
  const reply = await rest(`/v1/tags?${new URLSearchParams({ prefix, cursor })}`, token);
  expect(reply.status, reply.text).toBe(200);
  return reply.json.data as unknown as { tags: { tag: string; count: number }[]; cursor: string | null };
}

async function allTagRows(): Promise<string[]> {
  const rows = await testEnv().DB.prepare("SELECT tag, note_id FROM note_tags ORDER BY tag, note_id").all<{ tag: string; note_id: string }>();
  return (rows.results ?? []).map((row) => `${row.tag} ${row.note_id}`);
}

describe("tags", () => {
  it("indexes the tags of a note, a fact, and every journal entry in one form", async () => {
    const note = `shared/tg-form-${nid()}.md`;
    await putNote(writer, note, "Seed starting plan.", { tags: ["Garden", "#Projects/HiveAttic", "  spaced tag ", "garden"] });
    expect(await tagsAt(note)).toEqual(["garden", "projects/hiveattic", "spaced tag"]);

    const fact = await rest("/v1/facts", writer, {
      method: "POST",
      body: JSON.stringify({ key: `tg-fact-${nid()}`, statement: "The tomatoes go in the north bed.", observed_at: new Date().toISOString(), tags: ["Garden"] }),
    });
    expect(fact.status, fact.text).toBe(200);
    expect(await tagsAt(String(fact.json.data?.path))).toEqual(["garden"]);

    // A later entry in the same day file adds its tags to the file's tags.
    const day = await journal(writer, "Shopping", "Bought seed trays.", ["Groceries", "Weekly Review"]);
    expect(await tagsAt(day)).toEqual(["groceries", "weekly review"]);
    expect(await journal(writer, "Errands", "Picked up potting soil.", ["groceries", "#errands/costco"])).toBe(day);
    expect(await tagsAt(day)).toEqual(["errands/costco", "groceries", "weekly review"]);
  });

  it("does not take tags from a caller's own Tags: line in a journal body or from a note body", async () => {
    const day = await journal(other, "Forged", "Tags: forged-tag\nordinary text", ["real-tag"]);
    expect(await tagsAt(day)).toEqual(["real-tag"]);
    const note = `shared/tg-line-${nid()}.md`;
    await putNote(writer, note, "Tags: not-a-tag\nA plain note.");
    expect(await tagsAt(note)).toEqual([]);
  });

  it("finds notes by tag: nested tags, every tag given, words and tags together, newest first", async () => {
    const run = nid();
    const garden = `shared/tg-a-${run}.md`;
    const old = `shared/tg-b-${run}.md`;
    const seeds = `shared/tg-c-${run}.md`;
    await putNote(writer, garden, `Tomatoes along the fence ${run}.`, { tags: [`p${run}/garden`] });
    await putNote(writer, old, `Tomatoes in pots ${run}.`, { tags: [`p${run}-old`] });
    await putNote(writer, seeds, `Peppers by the shed ${run}.`, { tags: [`p${run}/garden`, `s${run}`] });
    // Siblings that sort before and after `/` (`-` and letters) are other tags, not nested ones.
    await putNote(writer, `shared/tg-d-${run}.md`, `Archived plans ${run}.`, { tags: [`p${run}archive`] });

    expect((await tagged(reader, [`p${run}`])).map((row) => row.path)).toEqual([seeds, garden]);
    expect((await tagged(reader, [`P${run}`.toUpperCase()])).map((row) => row.path)).toEqual([seeds, garden]);
    expect((await tagged(reader, [`p${run}/garden`, `s${run}`])).map((row) => row.path)).toEqual([seeds]);
    expect((await tagged(reader, [`p${run}`], "tomatoes")).map((row) => row.path)).toEqual([garden]);
    expect((await tagged(reader, [`p${run}-old`], "tomatoes")).map((row) => row.path)).toEqual([old]);
    expect((await tagged(reader, [`p${run}/garden`, `missing${run}`])).map((row) => row.path)).toEqual([]);
    const [first] = await tagged(reader, [`s${run}`]);
    expect(first?.tags).toEqual([`p${run}/garden`, `s${run}`]);
    // A plain keyword search lists each result's tags too.
    const plain = results((await rest(`/v1/search?q=peppers ${run}`, reader)).json) as { path?: string; tags?: string[] }[];
    expect(plain.map((row) => [row.path, row.tags])).toEqual([[seeds, [`p${run}/garden`, `s${run}`]]]);
  });

  it("never shows a note the caller cannot read, and the tag list never names its tags", async () => {
    const run = nid();
    await putNote(other, `bots/tg-other/own-${run}.md`, "My own list.", { tags: [`ownonly${run}`] });
    const sick = await putNote(health, `shared/tg-h-${run}.md`, "Synthetic flu shot on Friday.", { tags: [`healthonly${run}`] });
    expect(String(sick.data?.path)).toBe(`sensitive/health/shared/tg-h-${run}.md`);
    const phone = await putNote(writer, `shared/tg-r-${run}.md`, "Call 206-555-0142 about the fence.", { tags: [`restrictedonly${run}`] });
    expect(String(phone.data?.path)).toBe(`sensitive/restricted/shared/tg-r-${run}.md`);

    const names = async (token: string) => (await tagList(token)).tags.map((item) => item.tag);
    for (const token of [reader, writer]) {
      expect(await tagged(token, [`ownonly${run}`])).toEqual([]);
      expect(await tagged(token, [`healthonly${run}`])).toEqual([]);
      expect(await tagged(token, [`restrictedonly${run}`])).toEqual([]);
      const listed = await names(token);
      expect(listed).not.toContain(`ownonly${run}`);
      expect(listed).not.toContain(`healthonly${run}`);
      expect(listed).not.toContain(`restrictedonly${run}`);
    }
    expect((await tagged(other, [`ownonly${run}`])).length).toBe(1);
    expect((await tagged(health, [`healthonly${run}`])).length).toBe(1);
    expect(await names(health)).toContain(`healthonly${run}`);
    // sensitive/restricted/ is the admin token's alone, read:all included.
    expect(await tagged(everything, [`restrictedonly${run}`])).toEqual([]);
    expect(await names(everything)).not.toContain(`restrictedonly${run}`);
  });

  it("moves a note whose tag reads as health, the same as its text would", async () => {
    const path = `shared/tg-move-${nid()}.md`;
    const written = await putNote(health, path, "A plain checklist.", { tags: ["chemotherapy"] });
    expect(String(written.data?.path)).toBe(`sensitive/health/${path}`);
    expect(await tagged(reader, ["chemotherapy"])).toEqual([]);
  });

  it("replaces a note's tags on each write and refuses tags named twice", async () => {
    const path = `shared/tg-replace-${nid()}.md`;
    const first = await putNote(writer, path, "Version one.", { tags: ["first"] });
    expect(await tagsAt(path)).toEqual(["first"]);
    const second = await putNote(writer, path, "Version two.", { if_match: first.data?.etag });
    expect(await tagsAt(path)).toEqual([]);
    const third = await putNote(writer, path, "---\ntags: [old]\ntitle: Kept\n---\nVersion three.", { if_match: second.data?.etag, tags: ["new"] });
    expect(await tagsAt(path)).toEqual(["new"]);
    // extra.tags still works for callers that send it there, and a comma in it splits the tag.
    await putNote(writer, path, "Version four.", { if_match: third.data?.etag, extra: { tags: ["from-extra", "x,y"] } });
    expect(await tagsAt(path)).toEqual(["from-extra", "x", "y"]);

    const twice = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: `shared/tg-twice-${nid()}.md`, body: "x", tags: ["a"], extra: { tags: ["b"] } }) });
    expect(twice.status).toBe(400);
    expect(twice.json.error?.reasons).toEqual(["tags"]);
  });

  it("refuses a tag with a comma on every write, and bad tags in a search", async () => {
    const note = await rest("/v1/notes", writer, { method: "PUT", body: JSON.stringify({ path: `shared/tg-comma-${nid()}.md`, body: "x", tags: ["a,b"] }) });
    expect(note.status).toBe(400);
    const fact = await rest("/v1/facts", writer, {
      method: "POST",
      body: JSON.stringify({ key: `tg-comma-${nid()}`, statement: "x", observed_at: new Date().toISOString(), tags: ["a,b"] }),
    });
    expect(fact.status).toBe(400);
    const entry = await rest("/v1/journal", writer, { method: "POST", body: JSON.stringify({ title: "x", body: "x", tags: ["a,b"] }) });
    expect(entry.status).toBe(400);

    for (const tags of [["#"], ["   "], ["x".repeat(65)], Array.from({ length: 11 }, (_, index) => `t${index}`)]) {
      const reply = await mcp(reader, "vault_search", { tags });
      expect(reply.json.error?.code, JSON.stringify(tags)).toBe("invalid");
      expect(reply.json.error?.reasons).toEqual(["tags"]);
    }
    const prefix = await rest("/v1/tags?prefix=%23", reader);
    expect(prefix.status).toBe(400);
    // Without q or tags, a search is still refused.
    expect((await rest("/v1/search", reader)).status).toBe(400);
  });

  it("drops a forgotten note from tag search", async () => {
    const run = nid();
    const path = `shared/tg-forget-${run}.md`;
    await putNote(writer, path, "Short-lived.", { tags: [`gone${run}`] });
    expect((await tagged(reader, [`gone${run}`])).length).toBe(1);
    const forgot = await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ path, reason: "test" }) });
    expect(forgot.status, forgot.text).toBe(200);
    expect(await tagged(reader, [`gone${run}`])).toEqual([]);
    expect(await tagsAt(path)).toEqual([]);
  });

  it("indexes an outside edit's tags, a comma-separated string included, and keeps at most 200 per note", async () => {
    const run = nid();
    const listed = `shared/tg-out-list-${run}.md`;
    const string = `shared/tg-out-string-${run}.md`;
    const many = `shared/tg-out-many-${run}.md`;
    await testEnv().VAULT.put(`vault/${listed}`, "---\ntags:\n  - Gamma\n  - '#Delta/Sub'\n  - 'One, two'\n  - \"line\\nbreak\"\n---\nOutside list.\n");
    await testEnv().VAULT.put(`vault/${string}`, '---\ntags: "alpha, #beta ,"\n---\nOutside string.\n');
    const lots = Array.from({ length: 250 }, (_, index) => `bulk${String(index).padStart(3, "0")}`);
    await testEnv().VAULT.put(`vault/${many}`, `---\ntags: [${lots.join(", ")}]\n---\nOutside many.\n`);
    for (const path of [listed, string, many]) expect((await deliverEvent("PutObject", `vault/${path}`)).acked).toBe(true);
    expect(await tagsAt(listed)).toEqual(["delta/sub", "gamma", "one", "two"]);
    expect(await tagsAt(string)).toEqual(["alpha", "beta"]);
    expect(await tagsAt(many)).toEqual(lots.slice(0, 200));
  });

  it("lists tags with counts, a prefix, and whole-tag pages", async () => {
    await resetVault();
    for (const [index, tags] of [["a", "b"], ["a"], ["proj/x"], ["proj/y", "a"]].entries()) {
      await putNote(writer, `shared/tg-list-${index}.md`, `List note ${index}.`, { tags });
    }
    await putNote(other, "bots/tg-other/hidden.md", "Hidden.", { tags: ["a", "hidden"] });
    expect(await tagList(reader)).toEqual({
      tags: [
        { tag: "a", count: 3 },
        { tag: "b", count: 1 },
        { tag: "proj/x", count: 1 },
        { tag: "proj/y", count: 1 },
      ],
      cursor: null,
    });
    expect((await tagList(reader, "proj/")).tags.map((item) => item.tag)).toEqual(["proj/x", "proj/y"]);
    expect((await tagList(reader, "PROJ")).tags.map((item) => item.tag)).toEqual(["proj/x", "proj/y"]);

    // 220 tags on 11 notes: the first page holds 200, the cursor is its last tag, and the second the rest.
    for (let note = 0; note < 11; note++) {
      const tags = Array.from({ length: 20 }, (_, index) => `page${String(note * 20 + index).padStart(3, "0")}`);
      await putNote(writer, `shared/tg-page-${note}.md`, `Page note ${note}.`, { tags });
    }
    const first = await tagList(reader, "page");
    expect(first.tags.length).toBe(200);
    expect(first.cursor).toBe("page199");
    const second = await tagList(reader, "page", first.cursor!);
    expect(second.tags.map((item) => item.tag)).toEqual(Array.from({ length: 20 }, (_, index) => `page${200 + index}`));
    expect(second.cursor).toBeNull();
  });

  it("serves vault_search with tags and vault_tags over MCP", async () => {
    await putNote(writer, "shared/tg-mcp.md", "Over MCP.", { tags: ["via-mcp"] });
    const found = await mcp(reader, "vault_search", { tags: ["via-mcp"] });
    expect(found.json.ok, found.text).toBe(true);
    expect(results(found.json).map((row) => row.path)).toEqual(["shared/tg-mcp.md"]);
    const listed = await mcp(reader, "vault_tags", { prefix: "via" });
    expect(listed.json.data?.tags).toEqual([{ tag: "via-mcp", count: 1 }]);
    const guide = await mcp(reader, "vault_guide", {});
    expect(String(guide.json.data?.guide)).toContain("vault_tags");
  });

  it("keeps the tag table equal to the notes: the migration's statement, a reindex, and a reconcile", async () => {
    await journal(writer, "Kept", "Entry for the table check.", ["kept-entry"]);
    const db = testEnv().DB;
    const kept = await allTagRows();
    expect(kept.length).toBeGreaterThan(200);

    // The migration fills the table from the notes. Running its statement again gives the same rows.
    const migrations = (testEnv() as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
    const fill = migrations.find((item) => item.name.startsWith("0007"))!.queries.find((query) => query.includes("INSERT INTO note_tags"))!;
    await db.batch([db.prepare("DELETE FROM note_tags"), db.prepare(fill)]);
    expect(await allTagRows()).toEqual(kept);

    await db.prepare("DELETE FROM note_tags").run();
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    expect(await allTagRows()).toEqual(kept);

    const clean = await runJob("/v1/admin/reconcile");
    expect(clean.job.data?.counts).toMatchObject({ tags: 0 });
    const [missing] = kept.map((row) => row.split(" "));
    // A write that missed the table: a row is gone and a row names a tag the note does not have.
    await db.batch([
      db.prepare("DELETE FROM note_tags WHERE tag = ? AND note_id = ?").bind(missing![0], missing![1]),
      db.prepare("INSERT INTO note_tags (tag, note_id) VALUES ('tg-stale', ?)").bind(missing![1]),
    ]);
    expect(await allTagRows()).not.toEqual(kept);
    const repaired = await runJob("/v1/admin/reconcile");
    expect(repaired.job.data?.counts).toMatchObject({ tags: 2 });
    expect(await allTagRows()).toEqual(kept);
  });

  it("returns a tag on more rows than one call reads alone, marked partial, and goes on after it", async () => {
    await resetVault();
    const db = testEnv().DB;
    // 13,000 rows of one tag is more than one call reads (24 reads of 500). The notes are made in
    // SQL, not through the API, so the test stays fast; the read path does not care how they came.
    await db.batch([
      db.prepare(
        `INSERT INTO notes (id, path, type, owner, body, frontmatter, content_hash, r2_key, created_at, updated_at, last_writer)
         WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 13000)
         SELECT printf('BIG%023d', i), printf('shared/tg-big-%05d.md', i), 'note', 'shared', 'x', '{"tags":["big"]}', 'h',
                printf('vault/shared/tg-big-%05d.md', i), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'tg-writer' FROM k`,
      ),
      db.prepare(`INSERT INTO note_tags (tag, note_id) SELECT 'big', id FROM notes WHERE id LIKE 'BIG%'`),
    ]);
    await putNote(writer, "shared/tg-after-big.md", "After.", { tags: ["bigger"] });
    const first = await tagList(reader, "big");
    expect(first.tags).toHaveLength(1);
    expect(first.tags[0]).toMatchObject({ tag: "big", partial: true });
    expect(first.tags[0]!.count).toBeGreaterThanOrEqual(12_000);
    expect(first.tags[0]!.count).toBeLessThan(13_000);
    expect(first.cursor).toBe("big");
    expect(await tagList(reader, "big", "big")).toEqual({ tags: [{ tag: "bigger", count: 1 }], cursor: null });
    // The seeded notes have no files; leave the vault clean for whatever runs next.
    await resetVault();
  });
});
