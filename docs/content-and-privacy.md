# Content and privacy

What the server stores, and how it moves sensitive text into protected folders.

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

`PII_ROUTE` sets where PII alone goes. `restricted`, the default, is the routing in the table above. `keep` leaves a note, fact, or journal entry whose only sensitive text is a phone number, street address, or date of birth where it was written, for a vault whose agents need contact details (a household assistant calling the plumber). Health or finance text, both together, a declared sensitive domain, and `sensitivity: "sensitive"` route the same under either value. Any other value fails the Worker's configuration check.

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
