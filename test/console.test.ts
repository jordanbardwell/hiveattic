import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { snippet } from "../src/dashboard";
import { ADMIN, mint, rest, resetVault } from "./helpers";

describe("owner console page", () => {
  it("serves the page without a token, under a nonce CSP", async () => {
    const response = await SELF.fetch("https://hiveattic.test/console");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    const html = await response.text();
    expect(html).not.toContain("__CSP_NONCE__");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("uses a new nonce for every response", async () => {
    const one = (await SELF.fetch("https://hiveattic.test/console/")).headers.get("content-security-policy");
    const two = (await SELF.fetch("https://hiveattic.test/console")).headers.get("content-security-policy");
    expect(one).not.toBe(two);
  });

  it("sends the root to the console", async () => {
    const response = await SELF.fetch("https://hiveattic.test/", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://hiveattic.test/console");
  });

  it("leaves other unknown paths behind auth", async () => {
    expect((await rest("/console/other", null)).status).toBe(401);
    expect((await SELF.fetch("https://hiveattic.test/console", { method: "POST" })).status).toBe(401);
  });
});

describe("console admin routes", () => {
  beforeEach(async () => {
    await resetVault();
  });

  it("are admin-only", async () => {
    const token = await mint("console-reader", ["read:shared", "audit:read"], "console-reader");
    for (const path of ["/v1/admin/agents", "/v1/admin/overview"]) {
      expect((await rest(path, null)).status).toBe(401);
      const denied = await rest(path, token);
      expect(denied.status).toBe(403);
      expect(denied.json.error?.code).toBe("forbidden_scope");
    }
  });

  it("lists agents with token metadata but never a token hash", async () => {
    const token = await mint("research", ["read:shared", "read:own", "write:own", "write:shared"], "laptop");
    const wrote = await rest("/v1/facts", token, {
      method: "POST",
      body: JSON.stringify({ key: "home-city", statement: "Lives in Portland.", scope: "shared", observed_at: "2026-10-17T10:00:00Z", idempotency_key: "console-k1" }),
    });
    expect(wrote.status).toBe(200);
    const response = await rest("/v1/admin/agents", ADMIN);
    expect(response.status).toBe(200);
    expect(response.text).not.toContain("token_hash");
    const agents = response.json.data?.agents as Record<string, unknown>[];
    const research = agents.find((agent) => agent.id === "research")!;
    expect(research.scopes).toEqual(["read:shared", "read:own", "write:own", "write:shared"]);
    expect(research.writes_24h).toBeGreaterThanOrEqual(1);
    expect(research.rejected_24h).toBe(0);
    const tokens = research.tokens as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.label).toBe("laptop");
    expect(tokens[0]!.revoked_at).toBeNull();
    expect(Object.keys(tokens[0]!).sort()).toEqual(["created_at", "expires_at", "id", "label", "last_used_at", "revoked_at", "scopes"]);
  });

  it("summarizes notes, links, and hourly writes", async () => {
    const token = await mint("research", ["read:shared", "read:own", "write:own", "write:shared"], "laptop");
    await rest("/v1/notes", token, { method: "PUT", body: JSON.stringify({ path: "bots/research/notes/bike.md", body: "# Bike\n\nCompare [[profile/facts/commute.md]] options.", idempotency_key: "console-k2" }) });
    await rest("/v1/facts", token, {
      method: "POST",
      body: JSON.stringify({ key: "commute", statement: "Wants an e-bike for the commute.", scope: "shared", observed_at: "2026-10-17T10:00:00Z", confidence: 0.9, links: ["bots/research/notes/bike.md"], idempotency_key: "console-k3" }),
    });
    const response = await rest("/v1/admin/overview", ADMIN);
    expect(response.status).toBe(200);
    const data = response.json.data!;
    const notes = data.notes as Record<string, unknown>[];
    const fact = notes.find((note) => note.path === "profile/facts/commute.md")!;
    expect(fact).toMatchObject({ type: "fact", fact_key: "commute", status: "active", confidence: 0.9, snippet: "Wants an e-bike for the commute.", last_writer: "research" });
    expect(fact).not.toHaveProperty("body");
    expect(fact).not.toHaveProperty("frontmatter");
    const bike = notes.find((note) => note.path === "bots/research/notes/bike.md")!;
    expect(bike.snippet).toBe("Compare profile/facts/commute.md options.");
    const links = data.links as [string, string][];
    expect(links).toContainEqual([fact.id, bike.id]);
    expect(links).toContainEqual([bike.id, fact.id]);
    const hourly = data.hourly as { hour: string; ok: number; rejected: number }[];
    expect(hourly).toHaveLength(24);
    expect(hourly.at(-1)!.hour.slice(0, 13)).toBe(new Date().toISOString().slice(0, 13));
    expect(hourly.reduce((sum, hour) => sum + hour.ok, 0)).toBeGreaterThanOrEqual(2);
    expect(data.vault).toMatchObject({ vault_tz: "UTC", sensitive_domains: ["health", "finance"] });
    expect(data.conflicts).toEqual([]);
  });
});

describe("owner fact corrections", () => {
  beforeEach(async () => {
    await resetVault();
  });

  it("settle the fact without opening a conflict", async () => {
    const research = await mint("research", ["read:shared", "write:shared"], "research");
    const finance = await mint("finance-bot", ["read:shared", "write:shared"], "finance");
    const fact = (statement: string, observedAt: string, key: string) =>
      JSON.stringify({ key: "gym", statement, scope: "shared", observed_at: observedAt, idempotency_key: key });
    await rest("/v1/facts", research, { method: "POST", body: fact("Gym Mon/Wed/Fri.", "2026-10-17T10:00:00Z", "own-1") });
    const corrected = await rest("/v1/facts", ADMIN, { method: "POST", body: fact("Gym Tue/Thu.", "2026-10-17T11:00:00Z", "own-2") });
    expect(corrected.status).toBe(200);
    expect(corrected.json.data?.outcome).toBe("updated");
    let overview = await rest("/v1/admin/overview", ADMIN);
    expect(overview.json.data?.conflicts).toEqual([]);
    // Another agent contradicting the owner within 24 hours is still flagged.
    const contradicted = await rest("/v1/facts", finance, { method: "POST", body: fact("Gym Mon/Wed.", "2026-10-17T12:00:00Z", "own-3") });
    expect(contradicted.json.data?.outcome).toBe("conflict_flagged");
    overview = await rest("/v1/admin/overview", ADMIN);
    expect(overview.json.data?.conflicts).toHaveLength(1);
  });
});

describe("snippet", () => {
  it("skips frontmatter, headings, markers, and bare links", () => {
    expect(snippet("---\ntype: note\n---\n# Title\n\n[[a/b.md]]\n<!-- hiveattic:e=x -->\n- First **point** with [[c/d.md]]\n")).toBe("First **point** with c/d.md");
    expect(snippet("")).toBe("");
    expect(snippet("x".repeat(300))).toHaveLength(200);
  });
});
