# Vault

This folder is the human-readable vault. Markdown files here are the source of truth. The `sys/` prefix is server-only and is not part of the synced vault.

- `AGENTS.md` is the rule card every agent should follow.
- `profile/summary.md` is generated from current shared facts that carry no domain tag.
- `profile/facts/` holds one file per shared fact.
- `bots/<agent>/` holds that agent's role, facts, journal, and notes.
- `journal/YYYY/MM/YYYY-MM-DD.md` is the shared daily journal. Days follow the vault time zone.
- `shared/decisions.md` is append-only.
- `inbox/` holds conflict flags and proposals.
- `sensitive/health/`, `sensitive/finance/`, and `sensitive/restricted/` hold health, finance, and other personal text. A file whose text reads as health or finance is moved there at the same relative path, from the API or from an edit here. `sensitive/restricted/` is readable by the admin token only.
- `bots/<agent>/journal-sensitive/` holds an agent's journal entries that carry personal details only. That agent and the admin token can read it; no other agent can.

Edit files in an Obsidian or S3 client if you want. The server notices those edits from bucket notifications, snapshots the previous text, and reindexes. A file you save under `shared/` with health or finance text is moved into `sensitive/` before it is indexed, and the shared copy is deleted. Do not put secrets or employer work content in the vault. The server does not block them: what you save is indexed and kept in history.
