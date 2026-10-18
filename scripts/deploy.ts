// `pnpm run deploy`: what Deploy to Cloudflare and Workers Builds run on every push. It makes the
// queues if they are missing, applies D1 migrations before the new code goes live (once the
// database exists), deploys, applies them again for a first deploy that just created the database,
// and adds the R2 event notification for outside edits. Each step is safe to repeat.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const configPath = process.env.HIVEATTIC_CONFIG ?? "wrangler.jsonc";

type Config = {
  vars?: Record<string, string>;
  r2_buckets?: { bucket_name: string }[];
  d1_databases?: { database_name: string }[];
  queues?: { producers?: { queue: string }[]; consumers?: { queue: string; dead_letter_queue?: string }[] };
};

const config = JSON.parse(
  readFileSync(configPath, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
) as Config;

function wrangler(args: string[], quiet = false): { ok: boolean; stdout: string } {
  const run = spawnSync("pnpm", ["exec", "wrangler", ...args, "--config", configPath], {
    stdio: quiet ? "pipe" : "inherit",
    encoding: "utf8",
  });
  return { ok: run.status === 0, stdout: run.stdout ?? "" };
}

function must(args: string[]): void {
  if (!wrangler(args).ok) {
    console.error(`wrangler ${args.join(" ")} failed`);
    process.exit(1);
  }
}

const queues = new Set<string>();
for (const producer of config.queues?.producers ?? []) queues.add(producer.queue);
for (const consumer of config.queues?.consumers ?? []) {
  queues.add(consumer.queue);
  if (consumer.dead_letter_queue) queues.add(consumer.dead_letter_queue);
}
for (const queue of queues) {
  if (!wrangler(["queues", "info", queue], true).ok) must(["queues", "create", queue]);
}

const database = config.d1_databases?.[0]?.database_name;
if (!database) {
  console.error(`${configPath} names no D1 database`);
  process.exit(1);
}
if (wrangler(["d1", "info", database], true).ok) must(["d1", "migrations", "apply", database, "--remote"]);

let sha = process.env.WORKERS_CI_COMMIT_SHA ?? "";
if (!sha) {
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    sha = "";
  }
}
must(["deploy", ...(sha ? ["--var", `GIT_SHA:${sha}`] : [])]);
must(["d1", "migrations", "apply", database, "--remote"]);

// The notification only feeds outside edits (Obsidian, direct R2 writes) to the index. Writes
// through the API are indexed without it, so a token that cannot create it does not fail the deploy.
const bucket = config.r2_buckets?.[0]?.bucket_name;
const jobs = config.queues?.producers?.[0]?.queue;
const prefix = config.vars?.VAULT_PREFIX ?? "vault/";
if (bucket && jobs && !wrangler(["r2", "bucket", "notification", "list", bucket], true).stdout.includes(jobs)) {
  const made = wrangler([
    "r2", "bucket", "notification", "create", bucket,
    "--event-type", "object-create", "--event-type", "object-delete",
    "--prefix", prefix, "--queue", jobs,
  ]).ok;
  if (!made) {
    console.warn(
      `Could not create the R2 notification for ${bucket}. API writes are still indexed. To index outside edits, run: ` +
        `wrangler r2 bucket notification create ${bucket} --event-type object-create --event-type object-delete --prefix ${prefix} --queue ${jobs}`,
    );
  }
}
