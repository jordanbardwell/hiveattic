# HiveAttic

HiveAttic is a shared memory vault for AI agents. Agents keep notes, facts, and journals in it. The vault runs in your own Cloudflare account, and you own the data.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jordanbardwell/hiveattic)

## What it does

- Agents read and write Markdown notes, facts, and journal entries.
- Agents connect through a REST API or through MCP.
- Each agent has its own token. Scopes control what each agent can read and write.
- The vault keeps each earlier version of a note and records each change in an audit log.
- The vault moves health, finance, and other personal text into protected folders.
- A web console shows the vault and lets you manage it.

## Deploy

1. Click **Deploy to Cloudflare** above. Sign in to Cloudflare and GitHub.
2. Enter an admin password in `ADMIN_TOKEN`. Use 16 characters or more.
3. Keep the password in a safe place.
4. If the form shows other settings, do not change their default values.
5. Wait for the deploy to finish.
6. Open `https://<worker>.<subdomain>.workers.dev/console`. Sign in with your `ADMIN_TOKEN`.

The deploy makes the three other secret keys. At your first sign-in, the console adds the vault documents.

Your copy gets the updates from this repository one time each day. For updates, a deploy by hand, or an older vault, see [docs/deploy.md](docs/deploy.md).

## Connect an agent

1. Make a token for the agent. Use one of these two methods:
   - In the console, open **Agents** and click **New agent**. Enter a name.
   - Send this request:

     ```sh
     curl -X POST "https://<worker>.<subdomain>.workers.dev/v1/admin/tokens" \
       -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
       -d '{"agent_id": "my-agent", "scopes": ["read:all", "read:own", "write:own", "write:shared"]}'
     ```

2. Copy the token from the reply. The vault shows it one time only.

   With these scopes, the agent reads all notes of all agents. It writes only to its own folder and to the shared folders. Only the admin token reads `sensitive/restricted/` and the private journal of each agent.
3. Give the agent the MCP address `https://<worker>.<subdomain>.workers.dev/mcp` and the token as a bearer token.
4. Tell the agent to read `AGENTS.md` in the vault first. It has the rules for each agent.

For the list of scopes, see [docs/scopes.md](docs/scopes.md). For the REST routes, see [docs/api.md](docs/api.md).

## Warning: the vault does not filter content

The vault stores all text that it receives. It does not block secrets. Do not let agents write passwords, API keys, tokens, card numbers, account numbers, or government IDs. Do not let agents write work content from an employer. The vault indexes all text for search and keeps it in history. Only an admin purge removes it. For more, see [docs/content-and-privacy.md](docs/content-and-privacy.md).

## Documentation

All technical documents are in [docs/](docs/README.md).

## License

This repository uses the MIT License. See [LICENSE](LICENSE).
