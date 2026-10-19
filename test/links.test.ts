import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, mint, nid, rest, runJob, testEnv, withInstrumentedWriter, type Stats } from "./helpers";

// A [[link]] resolves to the note that its target names: the path, the path without .md, a part of
// the path after a slash, a fact key, or an alias, without regard to case. A path or a key wins over
// an alias. A link from outside sensitive/ never resolves into it, and a link never resolves to the
// note that holds it.

let writer = "";
let healthWriter = "";

beforeAll(async () => {
  writer = await mint("links-writer", ["read:shared", "read:own", "write:own", "write:shared"], "links-writer");
  healthWriter = await mint("links-health", ["read:shared", "write:shared", "read:sensitive/health", "write:sensitive/health"], "links-health");
});

async function put(path: string, body: string, extra: Record<string, unknown> = {}, token = writer, ifMatch?: string) {
  const written = await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path, body, type: "note", extra, ...(ifMatch ? { if_match: ifMatch } : {}) }) });
  expect([200, 201], written.text).toContain(written.status);
  return { id: String(written.json.data?.id), path: String(written.json.data?.path), etag: String(written.json.data?.etag) };
}

async function fact(key: string) {
  const written = await rest("/v1/facts", writer, {
    method: "POST",
    body: JSON.stringify({ key, statement: `qxlinks statement for ${key}`, observed_at: "2099-01-01T00:00:00Z", scope: "shared" }),
  });
  expect(written.status, written.text).toBe(200);
  return { id: String(written.json.data?.id), path: String(written.json.data?.path) };
}

async function targets(srcId: string): Promise<Record<string, string | null>> {
  const rows = await testEnv().DB.prepare("SELECT target, dst_note_id FROM links WHERE src_note_id = ?").bind(srcId).all<{ target: string; dst_note_id: string | null }>();
  return Object.fromEntries((rows.results ?? []).map((row) => [row.target, row.dst_note_id]));
}

async function names(): Promise<string[]> {
  const rows = await testEnv().DB.prepare("SELECT name || ' ' || note_id || ' ' || kind AS row FROM note_names ORDER BY name, note_id").all<{ row: string }>();
  return (rows.results ?? []).map((row) => row.row);
}

describe("link resolution", () => {
  it("resolves a link by path, path without .md, part of the path, fact key, or alias", async () => {
    const m = nid();
    const alpha = await put(`shared/lk-${m}/deep/alpha-${m}.md`, "# Alpha", { aliases: [`Alpha Nick ${m}`] });
    const key = await fact(`lk-key-${m}`);
    const links = [
      alpha.path,
      alpha.path.replace(/\.md$/, ""),
      `deep/alpha-${m}`,
      `alpha-${m}.md`,
      `ALPHA-${m}`,
      `alpha nick ${m}`,
      `lk-key-${m}`,
      `lk-missing-${m}`,
    ];
    const source = await put(`shared/lk-${m}/source.md`, `# Source\n\n${links.map((link) => `[[${link}]]`).join(" ")}`);
    expect(await targets(source.id)).toEqual({
      [links[0]!]: alpha.id,
      [links[1]!]: alpha.id,
      [links[2]!]: alpha.id,
      [links[3]!]: alpha.id,
      [links[4]!]: alpha.id,
      [links[5]!]: alpha.id,
      [links[6]!]: key.id,
      [links[7]!]: null,
    });
  });

  it("prefers a path over an alias, and never resolves a link to the note that holds it", async () => {
    const m = nid();
    const beta = await put(`shared/lk-${m}/beta-${m}.md`, "# Beta");
    await put(`shared/lk-${m}/nick.md`, "# Nick", { aliases: [`beta-${m}`] });
    // The older note is tie-<m>.md.md, but the link names tie-<m>.md exactly.
    await put(`shared/lk-${m}/tie-${m}.md.md`, "# Tie twice");
    const exact = await put(`shared/lk-${m}/tie-${m}.md`, "# Tie");
    const self = await put(`shared/lk-${m}/self-${m}.md`, `# Self\n\n[[self-${m}]] [[beta-${m}]] [[tie-${m}.md]]`);
    expect(await targets(self.id)).toEqual({ [`self-${m}`]: null, [`beta-${m}`]: beta.id, [`tie-${m}.md`]: exact.id });
  });

  it("resolves into sensitive/ only from a note that is in sensitive/ too", async () => {
    const m = nid();
    const gamma = await put(`shared/lk-${m}/gamma-${m}.md`, `Got a synthetic flu shot today ${m}`, {}, healthWriter);
    expect(gamma.path).toBe(`sensitive/health/shared/lk-${m}/gamma-${m}.md`);
    const outside = await put(`shared/lk-${m}/outside.md`, `# Outside\n\n[[gamma-${m}]]`);
    expect(await targets(outside.id)).toEqual({ [`gamma-${m}`]: null });
    const inside = await put(`shared/lk-${m}/inside.md`, `Another synthetic flu shot booked [[gamma-${m}]]`, {}, healthWriter);
    expect(inside.path.startsWith("sensitive/health/")).toBe(true);
    expect(await targets(inside.id)).toEqual({ [`gamma-${m}`]: gamma.id });
  });

  it("takes a link whose target is longer than the 50-byte LIKE pattern limit of D1", async () => {
    const m = nid();
    const long = await put(`shared/lk-${m}/a-folder-name-that-is-long/and-a-long-file-name-${m}.md`, "# Long");
    const source = await put(`shared/lk-${m}/long-source.md`, `# Source\n\n[[${long.path}]] [[and-a-long-file-name-${m}]] [[no-such-note-with-a-long-name-${m}-${m}]]`);
    expect(await targets(source.id)).toEqual({
      [long.path]: long.id,
      [`and-a-long-file-name-${m}`]: long.id,
      [`no-such-note-with-a-long-name-${m}-${m}`]: null,
    });
  });

  it("looks up all the links of a write in one D1 call", async () => {
    const m = nid();
    const stats: Stats = { d1Calls: 0, d1Statements: 0, r2Gets: 0, r2Lists: 0, sql: [] };
    await withInstrumentedWriter(stats, () => put(`shared/lk-${m}/many.md`, `# Many\n\n[[lk-none-a-${m}]] [[lk-none-b-${m}]] [[lk-none-c-${m}]]`));
    // The read batch, the link lookup, and the write batch.
    expect(stats.d1Calls, stats.sql.join("\n")).toBe(3);
  });

  it("resolves every link the same way in a reindex as on the writes", async () => {
    const db = testEnv().DB;
    const linkRows = async () =>
      (await db.prepare("SELECT src_note_id || ' ' || target || ' ' || ifnull(dst_note_id, '-') AS row FROM links ORDER BY 1").all<{ row: string }>()).results ?? [];
    const before = await linkRows();
    expect(before.length).toBeGreaterThan(10);
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    expect(await linkRows()).toEqual(before);
  });

  it("follows an alias change, a forget, and a purge", async () => {
    const m = nid();
    const epsilon = await put(`shared/lk-${m}/epsilon.md`, "# Epsilon", { aliases: [`old-nick-${m}`] });
    const first = await put(`shared/lk-${m}/first.md`, `# First\n\n[[old-nick-${m}]]`);
    expect(await targets(first.id)).toEqual({ [`old-nick-${m}`]: epsilon.id });
    await put(epsilon.path, "# Epsilon again", { aliases: [`new-nick-${m}`] }, writer, epsilon.etag);
    const second = await put(`shared/lk-${m}/second.md`, `# Second\n\n[[old-nick-${m}]] [[new-nick-${m}]]`);
    expect(await targets(second.id)).toEqual({ [`old-nick-${m}`]: null, [`new-nick-${m}`]: epsilon.id });
    const forgot = await rest("/v1/forget", writer, { method: "POST", body: JSON.stringify({ path: epsilon.path, reason: "test" }) });
    expect(forgot.status, forgot.text).toBe(200);
    const third = await put(`shared/lk-${m}/third.md`, `# Third\n\n[[new-nick-${m}]] [[epsilon]]`);
    expect(await targets(third.id)).toEqual({ [`new-nick-${m}`]: null, epsilon: null });
    const purged = await rest("/v1/admin/purge", ADMIN, { method: "DELETE", body: JSON.stringify({ id: epsilon.id }) });
    expect(purged.status, purged.text).toBe(200);
    const left = await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM note_names WHERE note_id = ?").bind(epsilon.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("keeps the name table the same as names made again from the notes, also after a reindex", async () => {
    const db = testEnv().DB;
    const kept = await names();
    expect(kept.length).toBeGreaterThan(20);
    // The migration fills the table from the notes. Running its statement again gives the same rows.
    const migrations = (testEnv() as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
    const fill = migrations.find((item) => item.name.startsWith("0006"))!.queries.find((query) => query.includes("INSERT INTO note_names"))!;
    await db.batch([db.prepare("DELETE FROM note_names"), db.prepare(fill)]);
    expect(await names()).toEqual(kept);
    expect((await runJob("/v1/admin/reindex")).job.data?.status).toBe("done");
    expect(await names()).toEqual(kept);
  });

  it("repairs the name table in a reconcile, and changes nothing when it is right", async () => {
    const db = testEnv().DB;
    const kept = await names();
    const clean = await runJob("/v1/admin/reconcile");
    expect(clean.job.data?.counts).toMatchObject({ names: 0 });
    const [missing, wrong] = kept.map((row) => row.split(" ")).filter((parts) => parts.length === 3);
    // A write that missed the table: a row is gone, a row has the wrong kind, and a row names nothing.
    await db.batch([
      db.prepare("DELETE FROM note_names WHERE name = ? AND note_id = ?").bind(missing![0], missing![1]),
      db.prepare("UPDATE note_names SET kind = 3 - kind WHERE name = ? AND note_id = ?").bind(wrong![0], wrong![1]),
      db.prepare("INSERT INTO note_names (name, note_id, kind) VALUES ('lk-stale-name', ?, 0)").bind(missing![1]),
    ]);
    expect(await names()).not.toEqual(kept);
    const repaired = await runJob("/v1/admin/reconcile");
    expect(repaired.job.data?.counts).toMatchObject({ names: 4 });
    expect(await names()).toEqual(kept);
  });
});
