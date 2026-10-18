# HiveAttic

HiveAttic is a shared memory vault for agents. Markdown in R2 is the source of truth. D1 is a rebuildable keyword index. A single Durable Object serializes writes and runs the long admin jobs.

This repository is the Milestone 1 vault: REST and MCP, bearer tokens and scopes, an append-only audit log, and a queue consumer for R2 object notifications. Semantic search, OAuth, and the cost load test are later milestones.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jordanbardwell/hiveattic)

`wrangler.jsonc` names resources but no `database_id`, so a deploy creates them. No Cloudflare account id, resource id, or secret belongs in git.

## Content is not filtered

HiveAttic does not filter content. It stores what a caller with the right scope sends, through the API or as an outside edit in R2. There is no secret, card-number, account-number, government-id, or employer filter, no quarantine, and no write is refused for what it says.

Bots must never write secrets: no passwords, API keys, tokens, private keys, card numbers, bank or brokerage account or routing numbers, or government IDs, and no employer work content. Nothing on the server catches them. Anything written is indexed for search, copied into `sys/history/` on the next change, and readable by every token whose scopes cover that path. Removing it takes an admin purge. `AGENTS.md` (the repo copy and the vault copy in `content/vault/AGENTS.md`, which bootstrap seeds) says the same thing to bots: guidance only, and the responsibility is theirs.

## Sensitive text is rerouted

The folder decides who can read a file, and the server picks the folder from the text. A write whose text reads as health, finance, or other personal detail, at a path that is not already sensitive, is stored under `sensitive/<d>/` at the same relative path instead. Nothing is refused.

| Text | Stored under | Readable with |
| --- | --- | --- |
| Health (a flu shot, a prescription, a diagnosis) | `sensitive/health/<path>` | `read:sensitive/health` |
| Finance (a budget, a salary, a mortgage, a tax return) | `sensitive/finance/<path>` | `read:sensitive/finance` |
| Notes and facts: health and finance together, PII alone (phone number, street address, date of birth), or `sensitivity: "sensitive"` with no domain | `sensitive/restricted/<path>` | the admin token only |
| Journal entries: PII alone, for an own, shared, or decisions target | `bots/<writer>/journal-sensitive/<YYYY-MM-DD>.md` | the writer, and the admin token |
| Journal entries: health and finance together, or the flag with no domain | `sensitive/restricted/journal/<writer>/<YYYY-MM-DD>.md` | the admin token only |

- A rerouted write answers **201** with `{ path, rerouted: true, sensitive_domain }` plus the usual fields. `path` is where the text went. The path the caller named gets nothing.
- The reroute works without `write:sensitive/<d>`. Reading a `sensitive/<d>/` result back needs `read:sensitive/<d>`, even for the writer. No scope reaches `sensitive/restricted/`: not `read:all`, not `read:sensitive/*`, and mint refuses any scope that names `restricted`.
- **A bot's own PII journal.** The writer always reads its own `bots/<writer>/journal-sensitive/` files, with or without any `read:sensitive` scope. This check runs before every other rule. Every other token gets 404 there, whatever it holds (`read:bots/<writer>`, `read:bots/*`, `read:sensitive/*`, and `read:all` included), and the admin token reads them. The reply's `sensitive_domain` is `pii`.
- A caller that declares a sensitive `domain` still needs `write:sensitive/<d>`, as before. Frontmatter, `extra`, `sensitivity: "normal"`, or an ordinary domain cannot lower what the text classifies as. The classifier reads the body and the caller's frontmatter, not server fields such as `source` or `owner`. A server field is skipped only when its value has the shape the server writes (an id, agent name, timestamp, hash, or enum), and only a line that is exactly a server journal marker is dropped. Any other `vault_*` key, a server key holding prose, and text beside a `<!-- hiveattic: -->` comment are classified like the rest of the file.
- **Journal entries.** A journal entry (shared, own, or decisions) whose text is sensitive is accepted and appended to one of the writer's sensitive day files: `sensitive/<d>/journal/<agent>/<YYYY-MM-DD>.md` for health alone or finance alone, `bots/<agent>/journal-sensitive/<YYYY-MM-DD>.md` for PII alone, and `sensitive/restricted/journal/<agent>/<YYYY-MM-DD>.md` otherwise. Dates are flat, in `VAULT_TZ`. The requested day file, the decisions log included, gets no entry and no placeholder, so a `read:shared` reader sees nothing of it in the file, search, history, or `journal-order`. The audit row is `journal_reroute` with `detail.requested_path`. A day file never takes the ordinary `domain` of one entry, so one tagged entry cannot change who reads the file.
- **An update that adds sensitive text moves the note.** The note continues under a new `vault_id` at `sensitive/<d>/<path>`. The old path is tombstoned like a forget, with a stub body and reason `removed`; its history keeps only the earlier versions, and the sensitive version is never stored under the old id. Readers other than the admin token get 404 at the old path, with no pointer to the new one. The old-to-new link is kept in `tombstones.moved_to`, which only the admin reads. Facts move the same way, and `profile/summary.md` drops them.
- **Outside edits.** A file saved under `shared/` (or any non-sensitive path) through R2 or Obsidian is classified before it is indexed. Sensitive text is moved to `sensitive/<d>/`, the shared object is deleted, and the move leaves a tombstone and a `reroute_move` audit row. It is never searchable at the shared path, not even briefly. Rebuild and reconcile run the same step, so they never bring it back.
- Updating a rerouted note needs `write:sensitive/<d>` and its etag.
- The classifier is a narrow word list for personal health and personal finance, plus the phone, address, and date-of-birth patterns. Engineering prose such as "tech debt", "error budget", or "diagnose the bug" stays where it was written. Card, account, and routing numbers are not signals.
- An update keeps a note's or fact's stored domain and sensitivity: it cannot drop a tag or lower them (a different domain is 400), and the caller must be allowed to write the note as it is stored.

Sensitive folders are `domains/<sensitive d>/`, `sensitive/<d>/`, and `bots/<a>/journal-sensitive/`. A write already in one is never rerouted.

## Layout

- `src/` Worker, Durable Object, REST, and MCP
- `migrations/` D1 schema. Add a new file for each change; never edit an applied migration
- `content/vault/` generic `AGENTS.md` and `README.md` seeded into the bucket
- `test/` acceptance tests named by spec id
- `e2e/run.ts` live suite against staging
- `scripts/` deploy, token hash, pilot provisioning, reviewer mint, and rebuild

## Local setup

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Put long random strings in `TOKEN_PEPPER`, `AUDIT_KEY`, and `JOURNAL_MAC_KEY`. Hash the admin token with the same pepper and put the hex digest in `ADMIN_TOKEN_HASH`:

```sh
printf '%s' 'the-admin-token' | TOKEN_PEPPER='the-pepper' pnpm hash-token
```

Apply migrations locally before the first request, start the dev server, then `POST /v1/admin/bootstrap`:

```sh
pnpm exec wrangler d1 migrations apply hiveattic-index --local --config wrangler.jsonc
pnpm dev
```

## Tests

```sh
pnpm typecheck
pnpm test
```

`pnpm typecheck` covers `src/`, `test/`, `e2e/`, and `scripts/`. `pnpm test` first runs `e2e/dry-run.check.ts`: the live harness against a local mock, every refusal the harness must make before it sends a request, static checks on the harness, the docs, and `.e2e.env.example`, and the T-20 domain check (every domain the repo names must be classified in the deploy configs, and no config lists one as both). Then it runs the vitest suites:

- `test/spec.test.ts`: T-01 through T-12. T-02 and T-03 are retired as filter tests and now check that key-like strings, card numbers, and account numbers are stored as written. T-06 is the 100-run CI soak of 7 parallel appends. The run ends with **T-09 PARTIAL**: full-text search after forget is covered and vector deletion is deferred to M2. T-10, T-13, and T-14 are skipped.
- `test/reroute.test.ts`: T-15 rerouting for notes, facts, journals, moves on update, outside edits, rebuild and reconcile, and the filter-removal smoke with a log check.
- `test/jobs.test.ts`: T-12 and T-17 paged jobs, writes during a job, resume after eviction, the cron, 202 on a write timeout, and idempotency keys.
- `test/quarantine.test.ts`: T-16 quarantine erase, including a quarantine left by an outside edit with its `inbox/quarantine.md` alert block.
- `test/limits.test.ts`: T-18 size limits on REST and `/mcp`.
- `test/hardening.test.ts`: T-19 and the review fixes, plus `VAULT_TZ`.
- `test/idempotency.test.ts`: T-08 on all four writes over REST and MCP, and L5 replays after a rebuild from R2 alone.
- `test/oversize.test.ts`: T-17 oversize files on outside edits, reads, search, list, jobs, and appends.
- `test/fixes.test.ts`, `test/summary.test.ts`, `test/gaps.test.ts`: the full review's remaining fixes (F11-F25, F33), the summary, and the PR #3 and PR #5 test gaps.
- `test/rebuild.test.ts`: a rebuild of about 150 notes as a paged job, with bounded D1 and R2 round trips, a rebuild after D1 lost its version, link, and idempotency rows, a failed page, and duplicated files.
- `test/review.test.ts`, `test/pr2.test.ts`, `test/classify.test.ts`: earlier review regressions and the classifier.

CI (`.github/workflows/test.yml`) runs install, typecheck, and the full suite on every push and pull request. It uses no secrets and deploys nothing.

## Deploy to Cloudflare

The button above sets up a new vault in your own Cloudflare account. It copies this repository into your GitHub account, creates the R2 bucket, the D1 database, the Durable Object, and the queues from `wrangler.jsonc`, asks for the four secrets, and deploys with Workers Builds. The repository must be public for the button to read it.

1. Click the button and sign in to Cloudflare and GitHub.
2. Fill in the secrets. `ADMIN_TOKEN` is your admin password, at least 16 characters; you sign in to the console with it. `TOKEN_PEPPER`, `AUDIT_KEY`, and `JOURNAL_MAC_KEY` are any long random strings, each different. Keep all four somewhere safe.
3. When the deploy finishes, open `https://<worker>.<subdomain>.workers.dev/console` and sign in with `ADMIN_TOKEN`.
4. Set up the vault documents once: `curl -X POST "https://<worker>.<subdomain>.workers.dev/v1/admin/bootstrap" -H "authorization: Bearer $ADMIN_TOKEN"`.

Every push to your copy runs `pnpm run deploy` (`scripts/deploy.ts`). It creates the queues if they are missing, applies D1 migrations before the new code goes live, deploys, and adds the R2 event notification that feeds outside edits to the index. If the build token cannot create the notification, the deploy still succeeds and logs the `wrangler r2 bucket notification create ... --config wrangler.jsonc` command to run by hand; API writes are indexed without it.

**Updates.** Your copy does not follow this repository on its own. `.github/workflows/sync-upstream.yml` fast-forwards your `main` to this repository's `main` once a day (or from the Actions tab), and that push deploys the update. If your `main` has its own commits, or an update changes a workflow file, the run fails and you merge `upstream/main` by hand. GitHub pauses scheduled workflows in a repository with no activity for 60 days; re-enable it from the Actions tab.

The worker accepts the admin token either as the plain `ADMIN_TOKEN`, which it hashes with `TOKEN_PEPPER`, or as `ADMIN_TOKEN_HASH`. `ADMIN_TOKEN` wins when both are set, so setting it replaces an older hashed admin token; agent tokens are unaffected.

**An existing vault.** `wrangler.jsonc` lists `ADMIN_TOKEN` as required, and wrangler refuses to deploy a worker that lacks a required secret. Before the first deploy of this config onto a vault set up with `ADMIN_TOKEN_HASH`, set `ADMIN_TOKEN` once (`pnpm exec wrangler secret put ADMIN_TOKEN --config wrangler.jsonc`, or the worker's Settings, Variables and Secrets in the Cloudflare dashboard). That password is then the admin and console login, and the old admin token stops working.

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
6. Run the quarantine migration (below). Until it has run, rebuild, reindex, reconcile, and the nightly cron refuse to start while quarantine records exist (409 `migration_required`; the cron skips and audits `reconcile_skipped`).
7. Re-mint the reviewer token under a fresh agent id. A token whose stored scopes include a raw `admin` string is no longer an admin token: only the admin token is.
8. Anything that checks the deploy through `GET /v1/health` must send a token to see `git_sha`.
9. The first rebuild re-reads every file and moves any existing non-sensitive file whose text classifies as health, finance, or PII into `sensitive/`, including notes the old classifier flagged in place.
10. After the erase has run on every environment, a later migration can tighten the `notes.status` CHECK to `active|superseded|forgotten`.

## Admin jobs

Rebuild, reindex, reconcile, and the quarantine erase are paged jobs in the writer Durable Object. Each alarm runs one page (at most 100 R2 objects, about 10 seconds, or 16 MB of text) and holds the writer lock for that page only, so ordinary writes land between pages. The cursor and counts live in Durable Object storage, so a job resumes after an eviction or a deploy. A rebuild stamps `notes.index_gen` with a new generation on every row it reads back from R2 and then sweeps rows left on an older one; there is no up-front wipe, and a row a write touched during the job carries the new generation and stays. It also re-reads history, re-resolves the `links` table (wikilinks and backlinks), restores journal markers, idempotency rows, and `created_at`, and rebuilds the FTS index.

| Start | Body | Kind |
| --- | --- | --- |
| `POST /v1/admin/reindex` | `{}` | `reindex` (a rebuild) |
| `POST /v1/admin/rebuild` | `{}` | `rebuild` |
| `POST /v1/admin/reconcile` | `{}` | `reconcile` |
| `POST /v1/admin/jobs` | `{ "kind": "rebuild" \| "reindex" \| "reconcile" }` | as given |
| `POST /v1/admin/migrations/quarantine-erase` | `{ "dry_run"?: true, "confirm_count"?: N }` | `quarantine-erase` (its only route) |

A start answers **202** `{ job_id, kind, status: "queued" }`. Only one job runs at a time: a second start answers **409** `job_running` with the running id in `error.job_id`. `GET /v1/admin/jobs/:id` (admin only; 403 for any other token, 404 for an unknown id) answers `{ job_id, kind, status, phase, dry_run, progress, pages, counts, cursor, errors, error, created_at, started_at, finished_at }`, with `status` one of `queued`, `running`, `done`, `failed`. A page that fails is retried twice, then the job is `failed` with `error` and the phase it reached. Within a page, each object's etag is checked against D1 under the writer lock, so a key a write touched between pages is read again and never overwritten with older text. Each job audits `<name>_started`, then one row with the counts and duration, or the phase and error (`reindex`, `reconcile`, `quarantine_erase`). The nightly cron starts a reconcile job. `pnpm rebuild` starts a rebuild and polls it for up to ten minutes.

## Quarantine migration

The old content filter left quarantined notes behind: the original text in the vault object, a stub row with status `quarantined`, history snapshots, `sys/quarantine/*.json` records, and `inbox/quarantine.md`. `POST /v1/admin/migrations/quarantine-erase` hard-erases all of it once.

- `POST /v1/admin/migrations/quarantine-erase` is its only route. There is no alias (`retire-quarantine` is 404), and `/v1/admin/jobs` does not take it.
- It lists D1 rows with status `quarantined` and every `sys/quarantine/` record, and matches by exact note id or path. For a record whose path has no D1 row, the object at that exact path is erased unless its HMAC under `AUDIT_KEY` shows it changed since. A record that does not parse is counted as an error, never a match, and is deleted.
- For each match it erases the vault object, `sys/history/<id>/`, and the D1 note, chunks, FTS, links, and version rows, and leaves a tombstone with an HMAC hash and reason `quarantine_erased`. Then it erases `inbox/quarantine.md`, alert blocks included. Nothing else is touched: `bots/x/shared/a.md` survives the erase of `shared/a.md`.
- `{ "dry_run": true }` is allowed in every environment. It counts and erases nothing. The job shows counts only: `records`, `quarantined_notes`, `unindexed_matches`, `erased`, `orphans_deleted`, `errors`, `alert_file`, and `total` (`records + quarantined_notes`). `GET /v1/admin/jobs/:id/report` (admin) lists the matched note ids and paths for a human to check.
- On production, the erase runs only with `{ "confirm_count": N }` where N is the dry run's `counts.total`. A wrong count answers **409** `confirm_count_mismatch`, and a missing one **400** `invalid` with reason `confirm_count_required`; both carry `actual_count`, and neither is ever 403. Run the dry run, send the total to a human, then erase with that count. Staging erases without `confirm_count`.
- Until the erase has run, a quarantined row stays exactly as it is: no outside edit or delete, reconcile, replay, or rebuild indexes its file again or makes it active (an outside edit is audited as `quarantined_skip`).
- When it finishes it sets the writer flag `quarantine_erased_at`. A second run erases 0. From then on, rebuild and reconcile delete stray `sys/quarantine/` records and audit `quarantine_orphans_deleted`. The audit rows carry counts and note ids only.

## Idempotency and timeouts

Note PUT, fact upsert, journal append, and forget take an idempotency key, `[A-Za-z0-9_.:-]{1,64}`, kept per agent for 7 days with a hash of the canonical payload (the operation and its fields, without the key).

- **REST** takes the `Idempotency-Key` header or the `idempotency_key` body field. Both at once must be equal; if they differ the write answers **400** `idempotency_key_conflict` and writes nothing.
- **MCP** takes only the `idempotency_key` tool argument and ignores the header, since one `/mcp` request can carry several tool calls.
- The same key with the same payload replays the original reply (status and `data`, including a reroute's 201) under a new `request_id`, and writes nothing. The same key with any other payload answers **422** `idempotency_key_reused` and writes nothing. A key whose write failed may be retried with a corrected payload.
- **Rebuild restores keys (L5).** Notes and facts carry `vault_idempotency`, `vault_idempotency_hash`, `vault_outcome`, `vault_rerouted`, and `vault_created_at` in frontmatter; a journal entry's idempotency marker carries the key and payload hash under a `JOURNAL_MAC_KEY` MAC; a keyed forget leaves its key and hash in the stub. A rebuild from R2 alone restores the rows still inside the 7-day window and each note's `created_at`, so a replay afterwards returns the original reply. A journal append answers `{ entry_id, path, block_ref }` (plus the reroute fields), without the day file's etag, so that reply is restored exactly.

Ordinary writes answer within 25 seconds. A write still running then answers **202** `{ pending: true, operation_id }` and keeps running; it is not repeated. `GET /v1/operations/:id` (the writing agent or the admin token; 7 days) answers `{ operation_id, status: "pending" | "done", http_status, result, error }`. A retry with the same idempotency key while the write is running gets the same `operation_id`.

## Size limits

Both limits answer **413** `payload_too_large` with a `limit` tag in the error: `{ "ok": false, "error": { "code": "payload_too_large", "limit": "request" | "content" | "file", ... }, "request_id": ... }`.

- `limit: "request"`: the whole HTTP request, JSON envelope and MCP framing included, is over 256,000 bytes. It is checked first, on raw bytes, before authentication or any parse. A declared `Content-Length` over the cap is refused unread, and a chunked body is counted as it streams and cancelled when it passes the cap. So when both limits are over, the answer is `request`.
- `limit: "content"`: a note body or fact statement is over 200,000 bytes of UTF-8 after JSON decoding (200,000 is accepted, 200,001 is not). It is checked before the schema.
- `limit: "file"`: a stored file would pass 1,900,000 bytes, which only an append target such as a journal day file can reach.

**Oversize files.** An object over 1,900,000 bytes, from an outside edit or found by a rebuild or reconcile, is not indexed, not deleted, and not served. Its index status is `oversize`: the `oversize_files` table keeps its path and size only, and a row the path had before keeps its history but loses its chunks, links, and etag. Reads by path or id and history answer 413 `limit: "file"` to a caller who could read the path (404 to anyone else), search and list skip it, writes to it answer 413 `file`, and one audit row (`oversize`, path and bytes, no content) records each object version. Jobs never load it, count it in `counts.oversize`, and carry on with their pages. Shrinking the file in Obsidian lets the next event or job index it normally.

The rules are the same on REST and `/mcp`, where the 413 is an HTTP 413, comes before rate-limit parsing, and is not charged to the rate limit. Schema limits stay **400**: fact statement 2,000 characters, journal body 8,000, title 120, query 1,000.

## Time zone

`VAULT_TZ` is an IANA zone name; the code default is `UTC`, and staging uses `America/New_York`. `TZ_DISPLAY` is read as a deprecated alias for one release when `VAULT_TZ` is unset. Journal day files (`journal/YYYY/MM/YYYY-MM-DD.md` and the flat sensitive day files) and heading times follow it, daylight saving included, and headings carry the zone abbreviation, for example `## 12:00 EDT · agent · title`. An unknown zone answers 500 `misconfigured` rather than filing an entry on the wrong day. `GET /v1/whoami` reports `vault_tz`, and so does `GET /v1/health` for a caller with a token.

## Scopes

A folder under `domains/<name>/` is that domain. A `domain` field that disagrees with the path is rejected. Domain classes come from `SENSITIVE_DOMAINS` (default `health,finance`) and `ORDINARY_DOMAINS` (default empty). A domain in neither list is refused on write (400 `unclassified_domain`) and read as sensitive. A deploy that lists a domain in both fails closed (500 `misconfigured`). Reading a note the caller cannot see returns 404.

| Role | Scopes |
| --- | --- |
| finance-rw | `read:shared`, `read:own`, `write:own`, `read:domain/finance`, `write:domain/finance`, `read:sensitive/finance`, `write:sensitive/finance` |
| finance-ro | `read:shared`, `read:own`, `write:own`, `read:domain/finance`, `read:sensitive/finance` |
| chief-of-staff | `read:shared`, `read:inbox`, `read:sensitive:summary/health`, `read:sensitive:summary/finance` |
| reader-x | `read:shared`, `read:own`, `write:own`, `read:domain/x`, `write:domain/x` |
| shared-writer | `read:shared`, `read:own`, `write:own`, `write:shared` |

The same matrix is in `examples/scopes.example.json`. Mint checks scope grammar and refuses a raw `admin` scope, any scope naming `restricted`, and unsafe prefixes. It refuses reserved agent ids: `admin`, `owner`, `operator`, `system`, `sys`, `shared`, `external`, `replay`, `rebuild`, `reconcile`, `indexer`, `migration`, `hiveattic`, `restricted`, and `sensitive`. A token minted for one of them before this check existed returns 401. Only the admin token is admin. `read:domain/*` expands to ordinary domains only and `read:sensitive/*` to sensitive domains only. A `domains/<d>/` folder needs `read:domain/<d>` and, for a sensitive domain, `read:sensitive/<d>`; `sensitive/<d>/` needs `read:sensitive/<d>`. A write that declares a sensitive domain, including into the caller's own folder, needs `write:sensitive/<domain>`. Summary scopes see summary paths only.

`forget` on append-only and server-managed files is admin-only (400 `forget_protected_path`): `journal/**`, `bots/*/journal/**`, `bots/*/journal-sensitive/**`, `sensitive/*/journal/**`, `shared/decisions.md`, `inbox/**`, `profile/summary.md`, `AGENTS.md`, and `README.md`. Appends to a protected day file keep working. Forget resolves the note the way the writer does (id first), checks write access against the note's stored path, domain, and sensitivity, answers 400 when `path` and `id` name different notes, and the writer checks all of it again. A path in an unclassified domain is 400 `unclassified_domain`. Journal and fact tags cannot contain a newline, `·`, or `^` (400), and journal bodies are escaped so a line cannot forge a heading, a `Tags:` line, or a server marker.

A non-admin `audit:read` token sees only rows for paths it can read and never a reroute row, and `?path=` is admin-only.

## Facts and journals

When two agents write the same shared fact with the same `observed_at` and different text, the incoming write wins because the Durable Object serializes it later. The tie is still flagged in `conflicts`. `profile/summary.md` lists active shared facts that are normal and carry no domain tag. It is regenerated when a shared fact is forgotten, purged, erased, deleted outside, or moved, and a purge also drops the summary's earlier snapshots, so no forgotten, purged, moved, or tagged statement shows through it. A forget stub carries no caller text; the reason stays in the tombstone row.

Only active notes are served to non-admin callers: a forgotten, moved, or superseded note is 404 by path, id, and history. The admin token reads the stub. An outside delete, or a reconcile that finds the object missing, forgets the note like the API does, and the last indexed body stays in history for the admin token. A delete event for a key that exists again is ignored. An outside create or copy gets its `vault_id` written into its frontmatter, so a rebuild keeps the same id. A forgotten note's path, a forgotten fact's key, and a day file the admin forgot can be written again; the new write gets a new id and the forgotten row keeps its admin-only history.

Every version is an immutable copy under `sys/history/<id>/`, labelled with the write that produced it, so history shows each version's own text and `POST /v1/admin/restore` restores it. Journal day files keep no copies.

## Live end-to-end suite

The live suite runs against staging only and fails closed. Copy `.e2e.env.example` to a file outside the checkout, export it, and run `pnpm e2e`.

- It reads only `HIVEATTIC_STAGING_*` names for its target and tokens, never falls back to an unprefixed name, and refuses to start if `HIVEATTIC_BASE_URL`, `HIVEATTIC_ADMIN_TOKEN`, `HIVEATTIC_E2E_READ_ONLY`, `HIVEATTIC_E2E_MODE`, or `HIVEATTIC_CF_API` is set. `HIVEATTIC_REVIEWER_TOKEN` is refused too, unless it is the same value as `HIVEATTIC_STAGING_REVIEWER_TOKEN` (the run plan maps one onto the other); it is never read.
- The Cloudflare API token, when set, goes only to `https://api.cloudflare.com`.
- `HIVEATTIC_STAGING_BASE_URL` must be the `hiveattic-staging` workers.dev host over https. It then checks `GET /v1/whoami` for `deploy_env: staging` and `staging_resources: true` before any write.
- T-11 needs an R2 S3 key scoped to the staging bucket. `R2_BUCKET` has no default, and every S3 put, copy, and delete checks that it is a `hiveattic-staging-*` bucket first.
- T-CLEANUP and the final cleanup only run against the accepted staging URL. Production is never contacted.
- The only wrangler command it runs is `pnpm exec wrangler tail hiveattic-staging --config wrangler.staging.example.jsonc` for the log check, when Workers Logs credentials are absent. On Windows it starts pnpm through a shell. `HIVEATTIC_LOG_MODE=api` uses only Workers Logs.
- T-06 is 20 runs of 7 parallel appends with a `journal-order` check, plus one batch to the shared day file from 7 different tokens. It needs a staging write limit of at least 140 per minute. Ask Forge to raise it and to restore 60 afterwards; the harness never changes it. Set `HIVEATTIC_RATE_LIMIT_WRITES_PER_MIN` to the confirmed value.
- Rebuild, reindex, and reconcile calls in T-06, T-11, and T-12 start a job and poll `GET /v1/admin/jobs/:id` with a ten-minute ceiling. T-12 also writes a note while its rebuild runs and checks that it survives.
- The SMOKE case replaces the retired T-02, T-03, and T-04: a fake key, a test card, `password: x`, and fake employer text are accepted and stored as written, and Workers Logs (or tail) and the audit log do not echo the bodies. T-15 checks a health reroute end to end.

The suite writes only namespaced paths and tags, revokes every token it mints, and cleans up its run id on staging even when a case throws. It writes `e2e-results/results.json`, a markdown summary, and `e2e-results/dlq.json`. Every check lists the responses it judged under `responses`: a label, `via` (`rest` or `mcp`), the HTTP `status`, `ok`, `error_code`, and `request_id`. `pnpm e2e --dry-run` exercises setup and cleanup against a local mock only.

### Reviewer token

```sh
HIVEATTIC_BASE_URL=... HIVEATTIC_ADMIN_TOKEN=... pnpm mint-reviewer architect-reviewer
```

The token is printed once and expires after 30 days. Its scopes are `read:shared`, `read:decisions`, `read:domain/*`, and `read:inbox`. It does not include `audit:read` or any summary scope. Finance and health notes, `sensitive/` files, summaries, reads by id, history, and shared notes tagged with those domains return 404 and stay out of search, and `GET /v1/admin/audit` returns 403.

Mint copies the preset scopes onto the token (`tokens.scopes_override`) and, for a new agent, onto the agent row. Later requests use that stored list. A reviewer token minted before the preset dropped `audit:read` and the summary scopes keeps its old scopes. Revoke it and mint a new one under a fresh agent id.

## Console

The worker serves an owner console at `/console` (`/` redirects there). It is part of the same deploy: nothing else to create or configure. Sign in with the admin token. The token is kept in that browser tab's session storage and sent only to this worker; closing the tab signs you out. The page holds no vault data itself and loads no third-party script; it runs under a per-response nonce CSP that allows only its own script, Google Fonts, and calls back to this worker.

It shows the hive of recent memories, notes with their links and version history, facts and the profile summary, journal days, agents with what each can read or edit, and the audit log. From it you can forget a note, restore a version, revoke a token, and confirm or correct a shared fact. Corrections are written as the `owner` agent. A fact write with the admin token settles the fact and never opens a conflict; another agent contradicting it within 24 hours still does.

It reads two admin-only routes besides the ones below: `GET /v1/admin/agents` (agents, token metadata without hashes, writes in the last 24 hours) and `GET /v1/admin/overview` (the 500 most recently updated notes without bodies, links between them, writes per hour for 24 hours, open conflicts).

## API

Bearer tokens use `Authorization: Bearer <token>`. The stored value is `sha256(pepper || token)`. `GET /v1/health` is the only unauthenticated API route, and it shows the build only to a caller with a token. The console page is served without a token; it has no data until you sign in.

| Method | Path | Tool |
| --- | --- | --- |
| GET | `/v1/whoami` | `vault_whoami` |
| GET | `/v1/notes?path=` or `?id=` | `vault_read` |
| GET | `/v1/search?q=` (`query` is an alias; `limit`, `domains`, `types`, `since`, `mode`) | `vault_search` |
| GET | `/v1/list?prefix=&cursor=` | `vault_list` (`cursor` argument) |
| GET | `/v1/history?path=` or `?id=` | `vault_history` |
| POST | `/v1/facts` | `vault_write_fact` |
| POST | `/v1/journal` | `vault_append_journal` |
| PUT | `/v1/notes` | `vault_write_note` |
| POST | `/v1/forget` | `vault_forget` |
| GET | `/v1/operations/:id` | |

`GET /v1/search` is the canonical search; there is no `POST /v1/search` (404). MCP is `POST /mcp` using Streamable HTTP. `mode=hybrid` and `mode=semantic` return the keyword results plus `warning: semantic_deferred`. List pages fill with notes the caller can read and return a `cursor` until the prefix is exhausted.

Admin routes, all requiring the admin token (403 for any other token): bootstrap, token mint and revoke, the job and migration routes above, journal order, restore, purge, cleanup, audit read, and append-only verification. `/v1/admin/policy` and `/v1/admin/quarantine` are gone (404). The server always assigns `request_id`; a caller `x-request-id` is echoed as `client_request_id`.

Errors are 400 `invalid`, `unclassified_domain`, `forget_protected_path`, `idempotency_key_conflict`; 401 `unauthorized`; 403 `forbidden_scope`; 404 `not_found`; 409 `conflict_etag`, `job_running`, `migration_required`, `confirm_count_mismatch`; 413 `payload_too_large`; 422 `idempotency_key_reused`; 429 `rate_limited`; and 500 `misconfigured`. No error depends on what the content says.

## Bindings

| Binding | Resource |
| --- | --- |
| `VAULT` | R2 bucket `hiveattic-vault` |
| `DB` | D1 database `hiveattic-index` |
| `WRITER` | Durable Object class `VaultWriter`, instance name `main` |
| `INDEX_Q` | Queue `hiveattic-index-jobs`, dead letter `hiveattic-index-dlq` |
| `TOKEN_PEPPER`, `ADMIN_TOKEN_HASH` or `ADMIN_TOKEN`, `AUDIT_KEY`, `JOURNAL_MAC_KEY` | Worker secrets |

The queue consumer receives both agent index jobs and R2 event notifications for `vault/` object create, copy, and delete. `copySource` may be a string or `{ bucket, object }`. A copy is treated as ours only when the bucket matches `VAULT_BUCKET`. An event is skipped only when the object etag equals `notes.r2_etag` and the `vault-id` metadata equals `notes.id`. Each write records an intent in the Durable Object so a crash after the R2 put can be replayed.

## License

No license has been chosen. This repository has no `LICENSE` file. Selecting a license is an open decision, and this note is a placeholder for that decision.
