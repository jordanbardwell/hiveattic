# Admin jobs

Rebuild, reindex, reconcile, and the quarantine migration.

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
