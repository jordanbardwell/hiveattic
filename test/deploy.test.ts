import { afterEach, describe, expect, it } from "vitest";
import { clearAuthCache } from "../src/auth";
import { ADMIN, rest, testEnv } from "./helpers";

// Deploy to Cloudflare asks for the plain ADMIN_TOKEN, not its hash.
describe("plain ADMIN_TOKEN", () => {
  const saved = testEnv().ADMIN_TOKEN_HASH;

  afterEach(() => {
    testEnv().ADMIN_TOKEN_HASH = saved;
    testEnv().ADMIN_TOKEN = undefined;
    clearAuthCache();
  });

  it("is the admin token when no hash is set", async () => {
    testEnv().ADMIN_TOKEN_HASH = undefined;
    testEnv().ADMIN_TOKEN = ADMIN;
    clearAuthCache();
    const response = await rest("/v1/admin/agents", ADMIN);
    expect(response.status).toBe(200);
    expect((await rest("/v1/admin/agents", "not-the-admin-token-at-all")).status).toBe(401);
  });

  it("replaces ADMIN_TOKEN_HASH when both are set", async () => {
    testEnv().ADMIN_TOKEN = "another-admin-password-1234";
    clearAuthCache();
    expect((await rest("/v1/admin/agents", "another-admin-password-1234")).status).toBe(200);
    expect((await rest("/v1/admin/agents", ADMIN)).status).toBe(401);
  });

  it("must be set when there is no hash, and long enough", async () => {
    testEnv().ADMIN_TOKEN_HASH = undefined;
    clearAuthCache();
    const missing = await rest("/v1/admin/agents", ADMIN);
    expect(missing.status).toBe(500);
    expect(missing.text).toContain("ADMIN_TOKEN");
    testEnv().ADMIN_TOKEN = "short-password";
    const short = await rest("/v1/admin/agents", "short-password");
    expect(short.status).toBe(500);
    expect(short.text).toContain("at least 16 characters");
  });
});
