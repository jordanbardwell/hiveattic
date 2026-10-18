# Tokens and scopes

How tokens and scopes control what each agent can read and write.

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
