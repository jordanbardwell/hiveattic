// `pnpm dev`: wrangler dev with every value in .dev.vars. When wrangler.jsonc lists
// secrets.required, wrangler dev loads only those names from .dev.vars, so TOKEN_PEPPER, AUDIT_KEY,
// and JOURNAL_MAC_KEY would be missing. This passes each line as a --var instead.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const vars: string[] = [];
if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) vars.push("--var", `${match[1]}:${match[2]!.replace(/^"(.*)"$/, "$1")}`);
  }
}
const run = spawnSync("pnpm", ["exec", "wrangler", "dev", "--config", "wrangler.jsonc", ...vars, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
