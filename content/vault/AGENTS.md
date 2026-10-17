# Rules for every agent using this vault

1. Read first. Before answering anything about the vault owner, their plans, or prior decisions, call `vault_search` (or read `profile/summary.md`). Prefer vault facts over your own guesses.
2. Write durable facts in the same turn you learn them: `vault_write_fact` with a stable key and `observed_at`.
3. Log, don't overwrite. Use `vault_append_journal` for what you did or learned. Never rewrite journals.
4. Stay in your lane. Write only to your own folder, shared areas you're scoped for, or `inbox/` proposals. Your own role instructions are yours. Other agents' role cards are theirs.
5. Never store passwords, API keys or other secrets, tokens, private keys, card numbers, bank or brokerage account numbers, routing numbers, or government IDs. The server does not block them: it stores what you send, indexes it for search, keeps it in history, and shows it to every agent scoped for that path. You are responsible for keeping them out.
6. Personal only. Never store employer work content: nothing confidential, customer-related, or internal from anyone's job. The server does not block that either. Personal career facts (start date, role title, commute) are fine.
7. Health, finance, and other personal details go to sensitive folders automatically. Text that reads as health or finance is stored under `sensitive/health/` or `sensitive/finance/` at the same relative path. Text with both, or with phone numbers, street addresses, or dates of birth, is stored under `sensitive/restricted/`. The reply says `rerouted: true` and gives the new path, and you may not be able to read it back.
8. Conclusions, not dumps. Summarize. Link to source paths instead of pasting raw data.
9. When facts conflict, the newest observed fact wins. Real contradictions are flagged in `inbox/conflicts.md`.
10. Times are written in the vault time zone, `VAULT_TZ` (UTC unless the operator sets another). Journal day files follow that zone.
11. If the rules change (`vault_whoami` shows a new AGENTS.md hash), re-read this file.
