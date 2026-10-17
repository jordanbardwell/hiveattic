# HiveAttic

HiveAttic is a shared memory vault for agents. Markdown in R2 is the source of truth. D1 is a rebuildable keyword index. A single Durable Object serializes writes.

This repository is the Milestone 1 vault: REST and MCP, bearer tokens, write filters, an append-only audit log, and a queue consumer for R2 object notifications. Semantic search, OAuth, and the cost load test are later milestones.

The `database_id` in `wrangler.jsonc` is a placeholder. No Cloudflare account id, resource id, or secret belongs in git.

## Layout

- `src/` Worker, Durable Object, filters, REST, and MCP
- `migrations/` D1 schema. The employer list is not in git
- `policy/employers.example.txt` fake employer terms. Real terms live in `policy/employers.local.txt`
- `content/vault/` generic `AGENTS.md` and `README.md` seeded into the bucket
- `test/` acceptance tests named by spec id
- `e2e/run.ts` live suite against a deployed URL
- `scripts/` token hash, pilot provisioning, reviewer mint, and rebuild

## Local setup

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Put a long random string in `TOKEN_PEPPER`. Hash the admin token with the same pepper and put the hex digest in `ADMIN_TOKEN_HASH`:

```sh
printf '%s' 'the-admin-token' | TOKEN_PEPPER='the-pepper' pnpm hash-token
```

`pnpm dev` starts Wrangler against local D1 and R2. Apply migrations locally with `pnpm exec wrangler d1 migrations apply hiveattic-index --local` before the first request, then `POST /v1/admin/bootstrap`.

## Tests

```sh
pnpm test
pnpm typecheck
```

`pnpm test` runs T-01 through T-08, the keyword parts of T-11, and the D1 rebuild parts of T-12. The run ends with an explicit line: **T-09 PARTIAL**. Full-text search after forget is covered (the read is a stub, search is empty, history remains, and chunk ids are queued). Vector deletion is deferred to M2. T-10, T-13, and T-14 are skipped because they belong to later milestones.

T-03's real account number is not stored in git. The test reads `HIVEATTIC_ACCOUNT_NUMBER`, or the file named by `HIVEATTIC_ACCOUNT_FIXTURE`, or `test/fixtures/account-number.local.txt`. When that value is missing the account check is skipped and the card, routing, and benign-corpus checks still run.

## Deploy

Create the resources, replace the placeholder `database_id`, then deploy. These commands are the runbook. They are not run by CI.

```sh
pnpm exec wrangler d1 create hiveattic-index
pnpm exec wrangler r2 bucket create hiveattic-vault
pnpm exec wrangler queues create hiveattic-index-jobs
pnpm exec wrangler queues create hiveattic-index-dlq
pnpm exec wrangler r2 bucket notification create hiveattic-vault \
  --event-type object-create \
  --event-type object-delete \
  --prefix vault/ \
  --queue hiveattic-index-jobs
```

Put the new D1 id into `wrangler.jsonc` at `d1_databases[0].database_id`.

```sh
pnpm exec wrangler d1 migrations apply hiveattic-index --remote
printf '%s' "$ADMIN_TOKEN" | TOKEN_PEPPER="$TOKEN_PEPPER" pnpm hash-token
pnpm exec wrangler secret put TOKEN_PEPPER
pnpm exec wrangler secret put ADMIN_TOKEN_HASH
pnpm exec wrangler secret put AUDIT_KEY
pnpm exec wrangler deploy --var GIT_SHA:$(git rev-parse HEAD)
```

`GET /v1/health` returns `version` and `git_sha` from the `GIT_SHA` var. Pass that `--var` on every production deploy so the running build can be checked against a commit. The tracked config leaves `GIT_SHA` empty, and a deploy that omits the flag publishes an empty value.

The Worker URL is the `workers.dev` host printed by deploy, or a custom hostname you attach later. Bootstrap the vault documents and mint the first agent tokens:

```sh
curl -X POST "$HIVEATTIC_BASE_URL/v1/admin/bootstrap" \
  -H "authorization: Bearer $HIVEATTIC_ADMIN_TOKEN"
HIVEATTIC_BASE_URL=... HIVEATTIC_ADMIN_TOKEN=... pnpm provision
```

`pnpm provision` prints each pilot token once. It does not write tokens to disk.

The Durable Object class is created by the `v1` migration during deploy. There is no separate create command.

Set a $10/month budget alert on the Cloudflare account. That alert is account configuration, not a binding in this repo.

Production rate limits are 60 writes per minute and 300 reads per minute per token. `0` disables a limit.

The live T-06 case sends 140 journal writes in one window, so a deployed limit of 60 returns `429` before the case finishes. Raise the plain var for the run, then deploy again to restore `60` from `wrangler.jsonc`:

```sh
pnpm exec wrangler deploy --var RATE_LIMIT_WRITES_PER_MIN:10000
pnpm e2e
pnpm exec wrangler deploy
```

`--var` overrides that one key for the deploy and leaves the other bindings in `wrangler.jsonc` in place. Secrets are left in place. A deploy with no `--var` writes `RATE_LIMIT_WRITES_PER_MIN` back to `60`. If the dashboard holds extra plain vars that are absent from this config, add `--keep-vars` to both deploy commands so those vars stay.

Set `HIVEATTIC_RATE_LIMIT_WRITES_PER_MIN` to the value you deployed (`0` when the limit is disabled). When that value is greater than zero and below 140, the suite fails T-06 before sending the burst and prints the same commands. A `429` during the burst fails the case the same way.

Copy `wrangler.example.jsonc` when you create an environment. Leave the tracked `wrangler.jsonc` `database_id` as the placeholder `00000000-0000-0000-0000-000000000001`. Production stays on `workers.dev` for now: `workers_dev` is true and `wrangler.jsonc` has no routes. Attaching `hiveattic.com` is a later step. When that hostname is ready, set `workers_dev` to false and add `{ "pattern": "hiveattic.com", "custom_domain": true }` under `routes`. Staging is a separate worker, `hiveattic-staging`, with its own D1, R2 bucket, and queue. Start from `wrangler.staging.example.jsonc`. Cleanup runs only when `E2E_CLEANUP_ENABLED` is `true`, `DEPLOY_ENV` is `staging`, `VAULT_BUCKET` and `DB_NAME` contain `-staging`, and `WORKER_NAME` contains `staging`. The production config leaves the flag empty and `DEPLOY_ENV` empty, and `POST /v1/admin/cleanup` then returns 404. Turning the flag on by itself is not enough. Mint a staging-only admin token for the architect.

The write suite targets `HIVEATTIC_STAGING_BASE_URL` only. It reads `deploy_env` and `staging_resources` from `GET /v1/whoami` and exits before any write when the target is not staging. `HIVEATTIC_E2E_READ_ONLY=1` runs a reviewer smoke against `HIVEATTIC_BASE_URL` and sends no writes. Policy terms added by a run are unique to that run, and the suite deletes only terms it added.

`AUDIT_KEY` is a required secret. Rejected-write audit hashes are HMAC-SHA256 of the submitted text under that key. `JOURNAL_MAC_KEY` signs journal entries. Rotating it makes existing entries fail verification on the next rebuild, so keep the old key until those files are rewritten. Rotating `TOKEN_PEPPER` invalidates every token, including the admin token, and does not invalidate journal markers. Revocation itself takes effect within 10 seconds: the auth cache is cleared on revoke and entries expire after that interval. Journal appends do not copy the whole day file into `sys/history/`. A full snapshot is kept for rewrites, quarantine, and outside edits.

Set `TZ_DISPLAY` to the zone journal headings should use. The default in this repo is `UTC`.

## Scopes

A folder under `domains/<name>/` is that domain. A `domain` field that disagrees with the path is rejected. Sensitive domains are `health` and `finance`. Reading a note the caller cannot see returns 404.

| Role | Scopes |
| --- | --- |
| finance-rw | `read:shared`, `read:own`, `write:own`, `read:domain/finance`, `write:domain/finance`, `read:sensitive/finance`, `write:sensitive/finance` |
| finance-ro | `read:shared`, `read:own`, `write:own`, `read:domain/finance`, `read:sensitive/finance` |
| chief-of-staff | `read:shared`, `read:inbox`, `read:sensitive:summary/health`, `read:sensitive:summary/finance` |
| reader-x | `read:shared`, `read:own`, `write:own`, `read:domain/x`, `write:domain/x` |
| shared-writer | `read:shared`, `read:own`, `write:own`, `write:shared` |

The same matrix is in `examples/scopes.example.json`. A write into `health` or `finance`, including a note in the caller's own `bots/<self>/` folder, needs `write:sensitive/<domain>`. Finance read-only cannot write finance anywhere. A sensitive note with no domain needs `write:sensitive/pii`, except the owner's own `journal-sensitive` file, which `write:own` can append. Summary scopes see summary paths only. `read:domain/*` does not grant `read:sensitive/finance`.

## Employer list

The database ships with no employer terms. Copy `policy/employers.example.txt` to `policy/employers.local.txt`, replace the fake Contoso Example Corp lines with the real terms, and load them:

```sh
HIVEATTIC_BASE_URL=... HIVEATTIC_ADMIN_TOKEN=... pnpm policy:apply
```

`policy/employers.local.txt` is gitignored. Real terms do not belong in git. A write is rejected when it matches an employer term, or when it matches both a subject and a qualifier. The match is the whole write, not one sentence. See `policy/README.md`. An allow term is the escape hatch for a write that would otherwise match, such as a personal purchase. Tests insert only fake names.

When two agents write the same shared fact with the same `observed_at` and different text, the incoming write wins because the Durable Object serializes it later. The tie is still flagged in `conflicts`, and the loser reference is that version's timestamp. Journal files are `journal/YYYY/MM/YYYY-MM-DD.md`. A sensitive entry stays in the writer's own `journal-sensitive` file.

## Live end-to-end suite

Copy `.e2e.env.example` to a file that stays outside git, export the variables, and run:

```sh
pnpm e2e
```

The suite writes only namespaced paths and tags, and only to staging. It revokes every token it mints. Cleanup runs on staging after the cases, including when a case throws. It deletes notes the run owns and rewrites shared journals, decisions, and quarantine alerts by run id, including history objects and quarantine records, and the suite checks that D1 and R2 have nothing left from that run. It prints a summary and writes `e2e-results/results.json`, a markdown summary, and `e2e-results/dlq.json` even if the run aborts. Staging labels that file `hiveattic-staging-index-dlq`. A read-only prod smoke labels it `hiveattic-index-dlq` and records the backlog depth from that queue. `HIVEATTIC_DLQ_NAME` overrides either name. `HIVEATTIC_CF_API` overrides the Cloudflare API origin used for that read. `pnpm e2e --dry-run` exercises setup, `wrangler tail` startup, and that cleanup against a local mock; `pnpm test` runs that check before the suite. DLQ depth comes from the GraphQL dataset `queueBacklogAdaptiveGroups` (`avg.messages`), or from `GET /accounts/{account_id}/queues/{queue_id}/metrics` `backlog_count` when that dataset has no sample. A missing or unreadable backlog fails the check. It is not the queue's producer count. Status values are `passed`, `failed`, `skipped`, and `partial`. T-09 is `partial`: the live checks cover the forgotten stub, empty keyword search, and retained history, and the vector-deletion half is deferred to M2. T-10, T-13, and T-14 are reported as skipped. The account-number check inside T-03 is skipped when the fixture is absent. Without the staging URL and staging admin token the process exits before sending writes.

T-06 is 20 runs of 7 parallel appends to the namespaced agent's own journal, then a comparison of heading order with `GET /v1/admin/journal-order`, a stale `if_match` that must return 409 `conflict_etag`, and a rebuild that must leave all 140 entries in the day file. See the rate-limit commands above before running it.

T-02 and T-03 check that the filtered fragment is absent from the response body and from the audit row for that `request_id`. The routing audit `content_hash` must differ from the unsalted SHA-256 of the rejected text. Audit reads are automatic: `GET /v1/admin/audit?request_id=`. The same checks cover the card, the routing number, and, when the fixture is present, the account number. Assertion text names the leak and leaves the fixture value out of the results file. Confirm deployed traces and logs omit rejected values. Trace sampling is `head_sampling_rate` 0.1.

T-02 and T-03 also check logs. When `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set, the suite POSTs `/accounts/{account_id}/workers/observability/telemetry/query` with dataset `cloudflare-workers`, view `events`, and filter `$metadata.service` equal to `HIVEATTIC_WORKER_NAME` (default `hiveattic-staging`). The token needs Workers Observability access. If those credentials are missing, the query returns no events, or `HIVEATTIC_LOG_MODE=tail`, the suite spawns `pnpm exec wrangler tail <worker> --format json` for the check and passes or fails on that output. The log check is not skipped. `HIVEATTIC_LOG_MODE=api` uses only the API.

T-11 needs an R2 S3 API token that can write the bucket, plus the event notification from the deploy section. The suite treats a missing credential set as a skipped T-11, and a credentialed edit that is not keyword-searchable within 10 seconds as a failure.

### Reviewer token

Mint a read-only token for someone who should run the read checks and nothing else:

```sh
HIVEATTIC_BASE_URL=... HIVEATTIC_ADMIN_TOKEN=... pnpm mint-reviewer architect-reviewer
```

The token is printed once. Its scopes are `read:shared`, `read:decisions`, `read:domain/*`, and `read:inbox`. It does not include `audit:read`, `read:sensitive:summary/finance`, or `read:sensitive:summary/health`. Summary reads belong to the chief-of-staff role. `GET /v1/admin/audit` returns 403. Finance and health notes, including summaries, raw notes, reads by id, history, and shared notes tagged with those domains, return 404 and stay out of search. Put the token in `HIVEATTIC_REVIEWER_TOKEN`. The suite uses it for the read checks and does not revoke a token you supplied. A run with only that token, and no admin token, executes the read checks and skips the write cases.

Mint copies the preset scopes onto the token (`tokens.scopes_override`) and, for a new agent, onto the agent row. Later requests use that stored list. A reviewer token minted before this change can still read finance and health summaries and the audit log. Revoke it and mint a new one.

Domains are classified in `src/access.ts`. `health` and `finance` are sensitive. `deals` and `x` are not. A domain that is in neither set is rejected on write and treated as sensitive on read.

Rebuild the D1 index from R2 at any time:

```sh
HIVEATTIC_BASE_URL=... HIVEATTIC_ADMIN_TOKEN=... pnpm rebuild
```

## API

Bearer tokens use `Authorization: Bearer <token>`. The stored value is `sha256(pepper || token)`. `GET /v1/health` is the only unauthenticated route.

| Method | Path | Tool |
| --- | --- | --- |
| GET | `/v1/whoami` | `vault_whoami` |
| GET | `/v1/notes?path=` or `?id=` | `vault_read` |
| GET | `/v1/search?q=` (`query` is an alias) | `vault_search` |
| GET | `/v1/list?prefix=` | `vault_list` |
| GET | `/v1/history?path=` | `vault_history` |
| POST | `/v1/facts` | `vault_write_fact` |
| POST | `/v1/journal` | `vault_append_journal` |
| PUT | `/v1/notes` | `vault_write_note` |
| POST | `/v1/forget` | `vault_forget` |

MCP is `POST /mcp` using Streamable HTTP. `mode=hybrid` and `mode=semantic` return the keyword results plus `warning: semantic_deferred`.

Admin routes, all requiring the admin token: bootstrap, token mint and revoke, policy edit, reindex, reconcile, journal order, restore, purge, audit read, append-only verification, and quarantine list. `POST /v1/admin/cleanup` returns 404 unless the staging flag and the staging resource names are both set. A refusal while the flag is on is audited. `GET /v1/admin/audit` accepts `limit`, `request_id`, and `path`. The server always assigns `request_id`. A caller `x-request-id` is echoed as `client_request_id`. Writes to a forgotten or quarantined note return 409. Rebuild and reconcile ignore server journal markers when they run the content filter, and they snapshot the previous bytes before a quarantine.

Writes that fail the secret filter return 422 `rejected_secret`. Card, routing, account, and IBAN failures return `rejected_financial`. SSN, passport, and license failures return `rejected_government_id`. Employer failures return `rejected_employer`. The response lists reason codes and does not echo the value. A human edit that contains a secret stays in R2, is removed from search, and is recorded under `sys/quarantine/` without the secret text. An outside delete tombstones the D1 row and does not write the object back.

## Bindings

| Binding | Resource |
| --- | --- |
| `VAULT` | R2 bucket `hiveattic-vault` |
| `DB` | D1 database `hiveattic-index` |
| `WRITER` | Durable Object class `VaultWriter`, instance name `main` |
| `INDEX_Q` | Queue `hiveattic-index-jobs`, dead letter `hiveattic-index-dlq` |
| `TOKEN_PEPPER`, `ADMIN_TOKEN_HASH`, `AUDIT_KEY`, `JOURNAL_MAC_KEY` | Worker secrets |
| `VAULT_PREFIX`, `TZ_DISPLAY`, `RATE_LIMIT_*`, `E2E_CLEANUP_ENABLED`, `DEPLOY_ENV`, `VAULT_BUCKET`, `DB_NAME`, `WORKER_NAME` | Plain vars |

The queue consumer receives both agent index jobs and R2 event notifications for `vault/` object create, copy, and delete. `copySource` may be a string or `{ bucket, object }`. A copy is treated as ours only when the bucket matches `VAULT_BUCKET`. An event is skipped only when the object etag equals `notes.r2_etag` and the `vault-id` metadata equals `notes.id`. Quarantine stores that etag so a later reconcile does not write another version. A nightly cron reconciles R2 into D1 and, in batches of 200, forgets active rows whose object is missing. Each write, including forget, records an intent in the Durable Object so a crash after the R2 put can be replayed. The caller-facing timeout does not release the writer while the operation is still running.

## License

No license has been chosen. This repository has no `LICENSE` file. Selecting a license is an open decision, and this note is a placeholder for that decision.
