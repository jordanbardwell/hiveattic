# Development

Local setup, tests, CI, and the live suite against staging.

## Local setup

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Put long random strings in `TOKEN_PEPPER`, `AUDIT_KEY`, and `JOURNAL_MAC_KEY`. Put an admin password of 16 characters or more in `ADMIN_TOKEN`.

Use `pnpm dev` to start the local server. It sends each value in `.dev.vars` to the dev server. When `wrangler.jsonc` lists required secrets, the dev server by itself reads only those names from `.dev.vars`.

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
