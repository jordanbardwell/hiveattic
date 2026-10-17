import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TOKEN_PEPPER: "hiveattic-test-pepper",
          ADMIN_TOKEN_HASH: "b9f983206b87828b3ebcd8b28e4e6e99c8e0c4c0c336c19f0a837f4c02672b08",
          JOURNAL_MAC_KEY: "hiveattic-test-journal-mac",
          GIT_SHA: "abc123deploy",
          RATE_LIMIT_WRITES_PER_MIN: "0",
          RATE_LIMIT_READS_PER_MIN: "0",
          TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    reporters: ["default", "./test/partial-reporter.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
