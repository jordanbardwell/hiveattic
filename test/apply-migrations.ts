import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

type Migration = { name: string; queries: string[] };

const testEnv = env as Env & { TEST_MIGRATIONS: Migration[] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
