# API

The REST and MCP API, its limits, and its error codes.

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
| | | `vault_guide` |

`vault_guide` is MCP only. It tells the agent how the vault stores facts, journal days, and notes, and gives its own folder. The MCP `initialize` reply has the same text as server instructions, so a client can show it to the agent without a call.

`GET /v1/search` is the canonical search; there is no `POST /v1/search` (404). MCP is `POST /mcp` using Streamable HTTP. `mode=hybrid` and `mode=semantic` return the keyword results plus `warning: semantic_deferred`. List pages fill with notes the caller can read and return a `cursor` until the prefix is exhausted. A list `prefix` is the literal start of a path, and case counts: `_` and `%` are ordinary characters, and the prefix can have any length.

Admin routes, all requiring the admin token (403 for any other token): bootstrap, token mint and revoke, the [job and migration routes](admin-jobs.md), journal order, restore, purge, cleanup, audit read, and append-only verification. `/v1/admin/policy` and `/v1/admin/quarantine` are gone (404). The server always assigns `request_id`; a caller `x-request-id` is echoed as `client_request_id`.

Errors are 400 `invalid`, `unclassified_domain`, `forget_protected_path`, `idempotency_key_conflict`; 401 `unauthorized`; 403 `forbidden_scope`; 404 `not_found`; 409 `conflict_etag`, `job_running`, `migration_required`, `confirm_count_mismatch`; 413 `payload_too_large`; 422 `idempotency_key_reused`; 429 `rate_limited`; and 500 `misconfigured`. No error depends on what the content says.

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
