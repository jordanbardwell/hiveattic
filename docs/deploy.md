# Deploy

How to deploy, update, and configure a vault.

## Deploy to Cloudflare

`wrangler.jsonc` names resources but no `database_id`, so a deploy creates them. No Cloudflare account id, resource id, or secret belongs in git.

The Deploy to Cloudflare button in the [README](../README.md) sets up a new vault in your Cloudflare account. The button does these steps:

- It copies this repository into your GitHub account.
- It creates the R2 bucket, the D1 database, the Durable Object, and the queues from `wrangler.jsonc`.
- It asks for one secret, `ADMIN_TOKEN`.
- It deploys the worker with Workers Builds.

The button can read only a public repository.

1. Click the button. Sign in to Cloudflare and GitHub.
2. Enter your admin password in `ADMIN_TOKEN`. Use 16 characters or more.
3. Keep the password in a safe place.
4. If the form shows other settings, do not change their default values.
5. Wait for the deploy to finish.
6. Open `https://<worker>.<subdomain>.workers.dev/console`. Sign in with `ADMIN_TOKEN`.

The deploy script makes `TOKEN_PEPPER`, `AUDIT_KEY`, and `JOURNAL_MAC_KEY`. Each key is a random 32-byte value. The script sets only the keys that the worker does not have. It never changes a key that is set. You do not need to know these keys.

At the first admin sign-in, the console adds the vault documents (`POST /v1/admin/bootstrap`). Bootstrap writes only the files that are missing.

Every push to your copy runs `pnpm run deploy` (`scripts/deploy.ts`). It creates the queues if they are missing, applies D1 migrations before the new code goes live, deploys, and adds the R2 event notification that feeds outside edits to the index. If the build token cannot create the notification, the deploy still succeeds and logs the `wrangler r2 bucket notification create ... --config wrangler.jsonc` command to run by hand; API writes are indexed without it.

**Updates.** Your copy does not follow this repository on its own. `.github/workflows/sync-upstream.yml` fast-forwards your `main` to this repository's `main` once a day (or from the Actions tab), and that push deploys the update. If your `main` has its own commits, or an update changes a workflow file, the run fails and you merge `upstream/main` by hand. GitHub pauses scheduled workflows in a repository with no activity for 60 days; re-enable it from the Actions tab.

The worker accepts the admin token in two forms:

- `ADMIN_TOKEN` is the plain password. The worker hashes it with `TOKEN_PEPPER`.
- `ADMIN_TOKEN_HASH` is the hash of the password.

If both are set, `ADMIN_TOKEN` wins. Thus a new `ADMIN_TOKEN` replaces an older hashed admin token. Agent tokens do not change.

**An existing vault.** `wrangler.jsonc` lists `ADMIN_TOKEN` as required. Wrangler does not deploy a worker that does not have a required secret. A vault set up with `ADMIN_TOKEN_HASH` needs `ADMIN_TOKEN` before its first deploy of this config. Set it one time with one of these:

- `pnpm exec wrangler secret put ADMIN_TOKEN --config wrangler.jsonc`
- In the Cloudflare dashboard, open the worker. Go to **Settings**, then **Variables and Secrets**.

After that, use this password to sign in as admin and to the console. The old admin token stops working. The deploy script keeps the existing `TOKEN_PEPPER`, `AUDIT_KEY`, and `JOURNAL_MAC_KEY`, so the agent tokens and the journal signatures stay valid.

## Deploy by hand

Create the resources, add the D1 id, then deploy. These commands are the runbook. They are not run by CI. Every command names its config file: `wrangler.jsonc` here, or your copy of `wrangler.staging.example.jsonc` for staging.

```sh
pnpm exec wrangler d1 create hiveattic-index --config wrangler.jsonc
pnpm exec wrangler r2 bucket create hiveattic-vault --config wrangler.jsonc
pnpm exec wrangler queues create hiveattic-index-jobs --config wrangler.jsonc
pnpm exec wrangler queues create hiveattic-index-dlq --config wrangler.jsonc
pnpm exec wrangler r2 bucket notification create hiveattic-vault --event-type object-create --event-type object-delete --prefix vault/ --queue hiveattic-index-jobs --config wrangler.jsonc
```

Add the new D1 id to `wrangler.jsonc` as `d1_databases[0].database_id` in your working copy only; CI refuses a committed `database_id`. Then apply the migrations, set the four required secrets, and deploy:

```sh
pnpm exec wrangler d1 migrations apply hiveattic-index --remote --config wrangler.jsonc
pnpm exec wrangler secret put TOKEN_PEPPER --config wrangler.jsonc
pnpm exec wrangler secret put ADMIN_TOKEN --config wrangler.jsonc
pnpm exec wrangler secret put AUDIT_KEY --config wrangler.jsonc
pnpm exec wrangler secret put JOURNAL_MAC_KEY --config wrangler.jsonc
pnpm exec wrangler deploy --config wrangler.jsonc --var GIT_SHA:$(git rev-parse HEAD)
```

All four secrets are required. `ADMIN_TOKEN` is at least 16 characters; a config that lists `ADMIN_TOKEN_HASH` instead (the example configs) takes the hash from `pnpm hash-token`. A deploy missing one answers every request with 500 `misconfigured` naming it, rather than writing rows it cannot hash or sign.

| Secret | Purpose |
| --- | --- |
| `TOKEN_PEPPER` | Pepper for bearer-token hashes: the stored value is `sha256(pepper \|\| token)`. Rotating it invalidates every token, the admin token included. |
| `ADMIN_TOKEN` | The admin token itself, at least 16 characters; the worker hashes it with the pepper. Only that token is admin. It wins over `ADMIN_TOKEN_HASH`. |
| `ADMIN_TOKEN_HASH` | The admin token's hash, made with `pnpm hash-token`, for configs that list it instead (the example configs). |
| `AUDIT_KEY` | Keys the HMAC-SHA256 `content_hash` of the content of every write in the audit log, and of tombstones, so a hash cannot be checked against a guessed text. |
| `JOURNAL_MAC_KEY` | Signs journal entry markers, including the idempotency marker. Rebuild only restores entries and idempotency rows whose MAC verifies. |

`GET /v1/health` answers `{ status, service }` to anyone. A caller with a valid token also gets `version` and `git_sha` from the `GIT_SHA` var, plus `vault_tz`, so check a deploy with a token. Pass the `--var` on every production deploy so the running build can be checked against a commit.

Bootstrap the vault documents and mint the first agent tokens:

```sh
curl -X POST "$HIVEATTIC_BASE_URL/v1/admin/bootstrap" -H "authorization: Bearer $HIVEATTIC_ADMIN_TOKEN"
HIVEATTIC_BASE_URL=... HIVEATTIC_ADMIN_TOKEN=... pnpm provision
```

`pnpm provision` prints each pilot token once. It does not write tokens to disk. The Durable Object class is created by the `v1` migration during deploy. Set a $10/month budget alert on the Cloudflare account; that alert is account configuration, not a binding in this repo.

Production rate limits are 60 writes per minute and 300 reads per minute per token. `0` disables a limit. A JSON-RPC batch on `/mcp` is charged per call: one write unit for each write tool call it holds, or one read unit per message when it holds none. The live T-06 case sends 140 journal writes in one window. Raising the staging limit for that run is Forge's job, against the staging config only, and Forge restores 60 afterwards:

```sh
pnpm exec wrangler deploy --config wrangler.staging.jsonc --var RATE_LIMIT_WRITES_PER_MIN:140
pnpm exec wrangler deploy --config wrangler.staging.jsonc
```

`--var` overrides that one key for the deploy and leaves the other bindings in place. Secrets are left in place. If the dashboard holds extra plain vars that are absent from the config, add `--keep-vars` to both commands.

Copy `wrangler.example.jsonc` when you create an environment by hand. The tracked `wrangler.jsonc` names no `database_id`; it is the Deploy to Cloudflare config. Production stays on `workers.dev`: `workers_dev` is true and `wrangler.jsonc` has no routes. Staging is a separate worker, `hiveattic-staging`, with its own D1, R2 bucket, and queue; start from `wrangler.staging.example.jsonc`. Cleanup runs only when `E2E_CLEANUP_ENABLED` is `true`, `DEPLOY_ENV` is `staging`, `VAULT_BUCKET` and `DB_NAME` contain `-staging`, and `WORKER_NAME` contains `staging`. Otherwise `POST /v1/admin/cleanup` returns 404.

Plain vars: `VAULT_PREFIX`, `VAULT_TZ`, `SENSITIVE_DOMAINS`, `ORDINARY_DOMAINS`, `ENVIRONMENT`, `RATE_LIMIT_WRITES_PER_MIN`, `RATE_LIMIT_READS_PER_MIN`, `E2E_CLEANUP_ENABLED`, `DEPLOY_ENV`, `VAULT_BUCKET`, `DB_NAME`, `WORKER_NAME`, `GIT_SHA`. Production is any deploy that is not a verified staging deploy, or one that sets `ENVIRONMENT=production`.

`JOURNAL_MAC_KEY` signs journal entries and their idempotency markers. Rotating it makes existing entries fail verification on the next rebuild, so keep the old key until those files are rewritten. Rotating `TOKEN_PEPPER` invalidates every token, including the admin token. Revocation takes effect within 10 seconds. A reviewer token expires after 30 days; any mint can pass `ttl_days` (1-365), and the reply carries `expires_at`.

### Upgrading a deployed vault to this release

1. Apply migrations `0003_drop_policy_terms.sql` and `0004_jobs_and_reroute.sql` with `pnpm exec wrangler d1 migrations apply <db> --remote --config <your config>` before or with the deploy. `0004` adds `notes.index_gen`, `tombstones.moved_to`, `tombstones.path`, `idempotency.payload_hash`, and the `oversize_files` table.
2. Make sure `AUDIT_KEY` is set (`pnpm exec wrangler secret list --config <your config>`). If it is missing, `pnpm exec wrangler secret put AUDIT_KEY --config <your config>`.
3. Set `ORDINARY_DOMAINS` in your untracked deploy config. Its code default is empty, and a domain in neither list reads as sensitive and refuses writes, so `deals`, `x`, and any other ordinary domain must be listed. `SENSITIVE_DOMAINS` defaults to `health,finance`.
4. Set `VAULT_TZ` (staging: `America/New_York`). `TZ_DISPLAY` is still read when `VAULT_TZ` is unset, for one release.
5. Replace the vault copy of `AGENTS.md` with `content/vault/AGENTS.md`. Bootstrap does not overwrite an existing file.
6. Run the [quarantine migration](admin-jobs.md#quarantine-migration). Until it has run, rebuild, reindex, reconcile, and the nightly cron refuse to start while quarantine records exist (409 `migration_required`; the cron skips and audits `reconcile_skipped`).
7. Re-mint the reviewer token under a fresh agent id. A token whose stored scopes include a raw `admin` string is no longer an admin token: only the admin token is.
8. Anything that checks the deploy through `GET /v1/health` must send a token to see `git_sha`.
9. The first rebuild re-reads every file and moves any existing non-sensitive file whose text classifies as health, finance, or PII into `sensitive/`, including notes the old classifier flagged in place.
10. After the erase has run on every environment, a later migration can tighten the `notes.status` CHECK to `active|superseded|forgotten`.
