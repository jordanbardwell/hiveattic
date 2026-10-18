import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, deliverEvent, mcp, mint, nid, resetVault, rest, results, runJob, testEnv } from "./helpers";

// T-17 oversize. A stored object over 1,900,000 bytes is not indexed, not deleted, and not served:
// D1 records its path and size with status oversize, reads answer 413 limit "file", search and list
// skip it, an audit row records it, and jobs count it and carry on.

let reader = "";
let outsider = "";

beforeAll(async () => {
  reader = await mint("big-reader", ["read:shared", "read:own", "write:own", "write:shared"], "big-reader");
  outsider = await mint("big-outsider", ["read:own", "write:own"], "big-outsider");
});

function bigText(marker: string, bytes = 2_000_000): string {
  const head = `# Big ${marker}\n\n${marker} oversize file\n`;
  return head + "x".repeat(bytes - head.length);
}

async function oversizeRow(path: string): Promise<{ path: string; size: number; status: string } | null> {
  return testEnv().DB.prepare("SELECT path, size, status FROM oversize_files WHERE path = ?").bind(path).first();
}

describe("T-17 oversize files", () => {
  it("an outside edit over the file limit is recorded, never indexed or served, and indexed again once it shrinks", async () => {
    await resetVault();
    const marker = `qxbig${nid()}`;
    const path = `shared/${marker}-big.md`;
    await testEnv().VAULT.put(`vault/${path}`, bigText(marker), { httpMetadata: { contentType: "text/markdown" } });
    expect((await deliverEvent("PutObject", `vault/${path}`)).acked).toBe(true);
    // Not deleted, recorded with path and size only, and no note row or chunks.
    expect(await testEnv().VAULT.head(`vault/${path}`)).toBeTruthy();
    expect(await oversizeRow(path)).toEqual({ path, size: 2_000_000, status: "oversize" });
    expect(await testEnv().DB.prepare("SELECT 1 FROM notes WHERE path = ?").bind(path).first()).toBeNull();
    // Reads answer 413 file to anyone who could read the path, on REST and MCP; others get 404.
    for (const token of [ADMIN, reader]) {
      const read = await rest(`/v1/notes?path=${encodeURIComponent(path)}`, token);
      expect(read.status).toBe(413);
      expect(read.json.error).toMatchObject({ code: "payload_too_large", limit: "file" });
      expect(read.text).not.toContain("xxxxxxxx");
      expect((await rest(`/v1/history?path=${encodeURIComponent(path)}`, token)).status).toBe(413);
    }
    const viaMcp = await mcp(reader, "vault_read", { path });
    expect(viaMcp.json.error).toMatchObject({ code: "payload_too_large", limit: "file" });
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, outsider)).status).toBe(404);
    // Excluded from search and list.
    expect(results((await rest(`/v1/search?q=${marker}`, ADMIN)).json)).toEqual([]);
    expect(JSON.stringify((await rest("/v1/list?prefix=shared/", ADMIN)).json.data)).not.toContain(path);
    // Audited with the path and size, no content.
    const audit = await testEnv().DB.prepare("SELECT action, outcome, bytes, content_hash, detail FROM audit_log WHERE path = ? AND action = 'oversize'").bind(path).all<{ bytes: number; content_hash: string | null; detail: string | null }>();
    expect(audit.results?.length).toBe(1);
    expect(audit.results?.[0]).toMatchObject({ outcome: "skipped", bytes: 2_000_000, content_hash: null });
    expect(JSON.stringify(audit.results)).not.toContain(marker);
    // The same object seen again is not audited twice.
    await deliverEvent("PutObject", `vault/${path}`);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE path = ? AND action = 'oversize'").bind(path).first<{ n: number }>())?.n).toBe(1);
    // Shrinking the file indexes it normally.
    await testEnv().VAULT.put(`vault/${path}`, `# Small\n\n${marker} small again\n`, { httpMetadata: { contentType: "text/markdown" } });
    await deliverEvent("PutObject", `vault/${path}`);
    expect(await oversizeRow(path)).toBeNull();
    expect((await rest(`/v1/notes?path=${encodeURIComponent(path)}`, reader)).status).toBe(200);
    expect(results((await rest(`/v1/search?q=${marker}`, reader)).json).map((hit) => hit.path)).toContain(path);
  });

  it("a note that grows past the limit outside the API stops being served by id, searched, or written to", async () => {
    await resetVault();
    const marker = `qxgrow${nid()}`;
    const path = `shared/${marker}.md`;
    const made = await rest("/v1/notes", reader, { method: "PUT", body: JSON.stringify({ path, body: `${marker} small`, type: "note" }) });
    expect(made.status).toBe(200);
    const id = String(made.json.data?.id);
    await testEnv().VAULT.put(`vault/${path}`, bigText(marker));
    await deliverEvent("PutObject", `vault/${path}`);
    expect(await oversizeRow(path)).toMatchObject({ path, status: "oversize" });
    expect((await rest(`/v1/notes?id=${id}`, reader)).status).toBe(413);
    expect(results((await rest(`/v1/search?q=${marker}`, ADMIN)).json)).toEqual([]);
    const write = await rest("/v1/notes", reader, { method: "PUT", body: JSON.stringify({ path, body: "replace", type: "note", if_match: made.json.data?.etag }) });
    expect(write.status).toBe(413);
    expect(write.json.error?.limit).toBe("file");
    // History rows stay for the admin to inspect after the file is fixed.
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE id = ?").bind(id).first<{ n: number }>())?.n).toBe(1);
  });

  it("reconcile and rebuild jobs count an oversize object, finish, and index every page after it", async () => {
    await resetVault();
    const marker = `qxjob${nid()}`;
    const big = `aaa/${marker}-big.md`;
    await testEnv().VAULT.put(`vault/${big}`, bigText(marker));
    for (let i = 0; i < 110; i++) {
      await testEnv().VAULT.put(`vault/zzz/${marker}-${String(i).padStart(3, "0")}.md`, `# n ${i}\n\n${marker} page file ${i}\n`);
    }
    await testEnv().VAULT.put(`vault/zzz/${marker}-sentinel.md`, `# sentinel\n\n${marker}sentinel after the big file\n`);
    const reconcile = await runJob("/v1/admin/reconcile");
    expect(reconcile.job.data?.status, JSON.stringify(reconcile.job)).toBe("done");
    expect(reconcile.job.data?.counts).toMatchObject({ oversize: 1 });
    expect(results((await rest(`/v1/search?q=${marker}sentinel`, ADMIN)).json).map((hit) => hit.path)).toEqual([`zzz/${marker}-sentinel.md`]);
    for (const kind of ["rebuild", "reindex"]) {
      const rebuilt = await runJob(`/v1/admin/${kind}`);
      expect(rebuilt.job.data?.status, JSON.stringify(rebuilt.job)).toBe("done");
      expect(rebuilt.job.data?.counts).toMatchObject({ oversize: 1 });
      expect(Number(rebuilt.job.data?.pages)).toBeGreaterThan(1);
      expect(await oversizeRow(big)).toMatchObject({ status: "oversize" });
      expect((await testEnv().DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE path LIKE ?").bind(`zzz/${marker}-%`).first<{ n: number }>())?.n).toBe(111);
      expect((await rest(`/v1/notes?path=${encodeURIComponent(big)}`, ADMIN)).status).toBe(413);
    }
    // Once the object is gone, a rebuild drops the record.
    await testEnv().VAULT.delete(`vault/${big}`);
    await runJob("/v1/admin/rebuild");
    expect(await oversizeRow(big)).toBeNull();
  });

  it("a journal append to an oversize day file answers 413 file and writes nothing", async () => {
    await resetVault();
    const at = "2099-05-05T12:00:00Z";
    const first = await rest("/v1/journal", reader, { method: "POST", body: JSON.stringify({ target: "own", title: "start", body: "first entry", at }) });
    expect(first.status).toBe(200);
    const path = String(first.json.data?.path);
    await testEnv().VAULT.put(`vault/${path}`, bigText(`qxday${nid()}`));
    await deliverEvent("PutObject", `vault/${path}`);
    const next = await rest("/v1/journal", reader, { method: "POST", body: JSON.stringify({ target: "own", title: "next", body: "second entry", at }) });
    expect(next.status).toBe(413);
    expect(next.json.error?.limit).toBe("file");
    expect((await testEnv().VAULT.head(`vault/${path}`))?.size).toBe(2_000_000);
  });
});
