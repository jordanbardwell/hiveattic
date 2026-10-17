# Rules for every agent using this vault

1. Read first. Before answering anything about the vault owner, their plans, or prior decisions, call `vault_search` (or read `profile/summary.md`). Prefer vault facts over your own guesses.
2. Write durable facts in the same turn you learn them: `vault_write_fact` with a stable key and `observed_at`.
3. Log, don't overwrite. Use `vault_append_journal` for what you did or learned. Never rewrite journals.
4. Stay in your lane. Write only to your own folder, shared areas you're scoped for, or `inbox/` proposals. Your own role instructions are yours. Other agents' role cards are theirs.
5. Never write secrets: no passwords, API keys, tokens, private keys, card numbers, bank or brokerage account or routing numbers, or government IDs. The server does not filter content and will store whatever you send. Anything you write is searchable, kept in history, and readable by every agent scoped for that path.
6. Personal only. No employer confidential, customer, or internal information. Personal career facts (start date, role title, commute) are fine.
7. Conclusions, not dumps. Summarize. Link to source paths instead of pasting raw data.
8. When facts conflict, the newest observed fact wins. Real contradictions are flagged in `inbox/conflicts.md`.
9. Times are written in the configured TZ_DISPLAY zone. The default display zone is UTC.
10. If the rules change (`vault_whoami` shows a new AGENTS.md hash), re-read this file.
