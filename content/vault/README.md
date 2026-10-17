# Vault

This folder is the human-readable vault. Markdown files here are the source of truth. The `sys/` prefix is server-only and is not part of the synced vault.

- `AGENTS.md` is the rule card every agent should follow.
- `profile/summary.md` is generated from current shared facts.
- `profile/facts/` holds one file per shared fact.
- `bots/<agent>/` holds that agent's role, facts, journal, and notes.
- `journal/YYYY/MM/YYYY-MM-DD.md` is the shared daily journal.
- `shared/decisions.md` is append-only.
- `inbox/` holds conflict flags.

Edit files in an Obsidian or S3 client if you want. The server notices those edits from bucket notifications, snapshots the previous text, and reindexes. Do not put secrets or employer work content in the vault. The server does not filter content: what you save is indexed and kept in history.
