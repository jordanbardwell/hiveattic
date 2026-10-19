# Architecture

HiveAttic is a shared memory vault for agents. Markdown in R2 is the source of truth. D1 is a rebuildable keyword index. A single Durable Object serializes writes and runs the long admin jobs. Each write waits for the write before it, so a write makes few D1 round trips. A journal append makes one batch of reads and one batch of writes.

This is the Milestone 1 vault: REST and MCP, bearer tokens and scopes, an append-only audit log, and a queue consumer for R2 object notifications. Semantic search, OAuth, and the cost load test are later milestones.

## Layout

- `src/` Worker, Durable Object, REST, and MCP
- `migrations/` D1 schema. Add a new file for each change; never edit an applied migration
- `content/vault/` generic `AGENTS.md` and `README.md` seeded into the bucket
- `test/` acceptance tests named by spec id
- `e2e/run.ts` live suite against staging
- `scripts/` deploy, token hash, pilot provisioning, reviewer mint, and rebuild

## Bindings

| Binding | Resource |
| --- | --- |
| `VAULT` | R2 bucket `hiveattic-vault` |
| `DB` | D1 database `hiveattic-index` |
| `WRITER` | Durable Object class `VaultWriter`, instance name `main` |
| `INDEX_Q` | Queue `hiveattic-index-jobs`, dead letter `hiveattic-index-dlq` |
| `TOKEN_PEPPER`, `ADMIN_TOKEN_HASH` or `ADMIN_TOKEN`, `AUDIT_KEY`, `JOURNAL_MAC_KEY` | Worker secrets |

The queue consumer receives both agent index jobs and R2 event notifications for `vault/` object create, copy, and delete. `copySource` may be a string or `{ bucket, object }`. A copy is treated as ours only when the bucket matches `VAULT_BUCKET`. An event is skipped only when the object etag equals `notes.r2_etag` and the `vault-id` metadata equals `notes.id`. Each write records an intent in the Durable Object so a crash after the R2 put can be replayed.

## Facts and journals

When two agents write the same shared fact with the same `observed_at` and different text, the incoming write wins because the Durable Object serializes it later. The tie is still flagged in `conflicts`. `profile/summary.md` lists active shared facts that are normal and carry no domain tag. It is regenerated when a shared fact is written, forgotten, purged, erased, deleted outside, or moved. A change that leaves the list the same does not write it again. The summary stores no links and keeps no history copies, because the facts keep both. A purge also drops the copies that earlier builds kept, so no forgotten, purged, moved, or tagged statement shows through it. A forget stub carries no caller text; the reason stays in the tombstone row.

Only active notes are served to non-admin callers: a forgotten, moved, or superseded note is 404 by path, id, and history. The admin token reads the stub. An outside delete, or a reconcile that finds the object missing, forgets the note like the API does, and the last indexed body stays in history for the admin token. A delete event for a key that exists again is ignored. An outside create or copy gets its `vault_id` written into its frontmatter, so a rebuild keeps the same id. A forgotten note's path, a forgotten fact's key, and a day file the admin forgot can be written again; the new write gets a new id and the forgotten row keeps its admin-only history.

A `[[link]]` resolves to the note that its target names: the path, the path without `.md`, a part of the path after a slash, a fact key, or an alias. Case does not count. A path wins over a fact key, and a fact key wins over an alias. A link never resolves to the note that holds it, and a link from outside `sensitive/` never resolves into it. The `note_names` table keeps these names for each note, so a write finds the targets of all its links in one query. Each write keeps the table right, and the nightly reconcile repairs it.

Every version is an immutable copy under `sys/history/<id>/`, labelled with the write that produced it, so history shows each version's own text and `POST /v1/admin/restore` restores it. Journal day files keep no copies.

## Time zone

`VAULT_TZ` is an IANA zone name; the code default is `UTC`, and staging uses `America/New_York`. `TZ_DISPLAY` is read as a deprecated alias for one release when `VAULT_TZ` is unset. Journal day files (`journal/YYYY/MM/YYYY-MM-DD.md` and the flat sensitive day files) and heading times follow it, daylight saving included, and headings carry the zone abbreviation, for example `## 12:00 EDT · agent · title`. An unknown zone answers 500 `misconfigured` rather than filing an entry on the wrong day. `GET /v1/whoami` reports `vault_tz`, and so does `GET /v1/health` for a caller with a token.
