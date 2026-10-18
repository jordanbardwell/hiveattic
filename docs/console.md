# Console

The owner console at `/console`.

## Console

The worker serves an owner console at `/console` (`/` redirects there). It is part of the same deploy: nothing else to create or configure. Sign in with the admin token. The token is kept in that browser tab's session storage and sent only to this worker; closing the tab signs you out. The page holds no vault data itself and loads no third-party script; it runs under a per-response nonce CSP that allows only its own script, Google Fonts, and calls back to this worker.

It shows the hive of recent memories, notes with their links and version history, facts and the profile summary, journal days, agents with what each can read or edit, and the audit log. From it you can make an agent and its token, make a new token for an agent, forget a note, restore a version, revoke a token, and confirm or correct a shared fact. Corrections are written as the `owner` agent. A fact write with the admin token settles the fact and never opens a conflict; another agent contradicting it within 24 hours still does.

**New agent** and **New token** call `POST /v1/admin/tokens` with the scopes `read:all`, `read:own`, `write:own`, and `write:shared`. The console shows the token, the MCP address, and the header one time only.

It reads two admin-only routes besides the ones in [api.md](api.md): `GET /v1/admin/agents` (agents, token metadata without hashes, writes in the last 24 hours) and `GET /v1/admin/overview` (the 500 most recently updated notes without bodies, links between them, writes per hour for 24 hours, open conflicts).
