import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { authenticate, countryOf } from "./auth";
import { ulid } from "./crypto";
import { piiRoute } from "./config";
import { errorBody, VaultError } from "./errors";
import {
  appendJournal,
  currentAgent,
  forgetNote,
  history,
  list,
  readById,
  readPath,
  search,
  writeFact,
  writeNote,
  type Session,
} from "./service";
import { factSchema, forgetSchema, journalSchema, noteSchema, parseInput } from "./schemas";

// `request` carries the body the HTTP layer already read and counted. `original` is the incoming
// request, kept for its auth header and edge metadata.
export function mcpHandler(request: Request, env: Env, ctx: ExecutionContext, original: Request = request): Promise<Response> {
  const handler = createMcpHandler(() => buildServer(env, original, ctx), { route: "/mcp" });
  return handler(request, env, ctx);
}

// How the vault stores things, for agents to find on their own. It comes from the code, so a vault
// keeps it current after a deploy even when its stored AGENTS.md is older.
export function vaultGuide(folder: string): string {
  return [
    "Hive Attic is a shared memory vault. Everything in it is a markdown note in a folder. Facts and journal days are notes of a special kind.",
    `- Facts: ${folder}facts/<key>.md. Each fact is one short statement. Write facts with vault_write_fact.`,
    `- Journal: ${folder}journal/<year>/<month>/<date>.md. There is one file for each day. You can only add entries. Write entries with vault_append_journal.`,
    `- Other notes: any other path in your folder, for example ${folder}recipes/apple-pie.md. Use a note for longer text, such as a recipe, a list, or a plan. Write notes with vault_write_note. A note path ends in .md and has no spaces. To replace a note, read it first and send its etag as if_match.`,
    "- Shared notes are in shared/. Write there only if your token allows it.",
    piiRoute() === "keep"
      ? "- Health and finance text moves a note to sensitive/. In this vault, phone numbers, street addresses, and dates of birth stay where you write them."
      : "- Health and finance text moves a note to sensitive/. Phone numbers, street addresses, and dates of birth move a note or fact to sensitive/restricted/, which only the admin reads.",
    "Before you write, read AGENTS.md with vault_read. It has the rules for all agents. Call vault_guide to see this text with your own folder.",
  ].join("\n");
}

function buildServer(env: Env, request: Request, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: "hiveattic", version: "0.1.0" }, { instructions: vaultGuide("bots/<your agent id>/") });
  // One /mcp request can carry several tool calls, so the Idempotency-Key header is ignored here.
  // Only the idempotency_key tool argument counts.
  const session = async (): Promise<Session> => {
    const access = await authenticate(request, env, ctx);
    return { access, requestId: ulid(), client: "mcp", country: countryOf(request) };
  };
  const tool = (name: string, description: string, schema: z.ZodType<Record<string, unknown>> | z.ZodObject, run: (session: Session, args: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
    server.registerTool(name, { description, inputSchema: schema as z.ZodObject }, async (args) => {
      let requestId = "";
      try {
        const current = await session();
        requestId = current.requestId;
        const data = await run(current, (args ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data, request_id: requestId }) }] };
      } catch (err) {
        const vault = err instanceof VaultError ? err : new VaultError("invalid", "Request failed");
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: errorBody(vault), request_id: requestId }) }],
        };
      }
    });
  };
  server.registerTool("vault_whoami", { description: "Return the caller and the AGENTS.md hash.", inputSchema: z.object({}) }, async () => {
    try {
      const data = await currentAgent(env, await session());
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }) }] };
    } catch (err) {
      const vault = err instanceof VaultError ? err : new VaultError("invalid", "Request failed");
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: errorBody(vault) }) }] };
    }
  });
  tool("vault_guide", "Explain how the vault stores facts, journal days, and notes, with your own folder. Call this first if you are new to the vault.", z.object({}), async (current) => {
    const folder = `bots/${current.access.agentId}/`;
    return { agent_id: current.access.agentId, own_folder: folder, guide: vaultGuide(folder), rules: "AGENTS.md" };
  });
  tool("vault_read", "Read one vault note by path or id.", z.object({ path: z.string().optional(), id: z.string().optional() }), async (current, args) => {
    if (typeof args.id === "string" && args.id) return readById(env, current, args.id);
    return readPath(env, current, String(args.path ?? ""));
  });
  tool(
    "vault_search",
    "Keyword search, the same as GET /v1/search. Hybrid mode is keyword-only until a later milestone.",
    z.object({
      q: z.string().optional(),
      query: z.string().optional(),
      mode: z.string().optional(),
      limit: z.number().optional(),
      domains: z.array(z.string()).optional(),
      types: z.array(z.string()).optional(),
      since: z.string().optional(),
    }),
    async (current, args) =>
      search(env, current, String(args.q ?? args.query ?? ""), typeof args.mode === "string" ? args.mode : "keyword", {
        limit: typeof args.limit === "number" ? args.limit : undefined,
        domains: Array.isArray(args.domains) ? args.domains.map(String) : undefined,
        types: Array.isArray(args.types) ? args.types.map(String) : undefined,
        since: typeof args.since === "string" ? args.since : undefined,
      }),
  );
  tool("vault_list", "List notes under a path prefix. Pass the returned cursor to get the next page.", z.object({ prefix: z.string().optional(), cursor: z.string().optional() }), async (current, args) =>
    list(env, current, typeof args.prefix === "string" ? args.prefix : "", typeof args.cursor === "string" ? args.cursor : ""),
  );
  tool("vault_history", "List retained versions of a note.", z.object({ path: z.string().optional(), id: z.string().optional() }), async (current, args) =>
    history(env, current, typeof args.path === "string" ? args.path : undefined, typeof args.id === "string" ? args.id : undefined),
  );
  tool("vault_write_fact", "Write a durable fact. The newest observed_at stays active. Send an idempotency_key so a retry writes once.", factSchema, async (current, args) =>
    (await writeFact(env, current, parseInput(factSchema, args))).data,
  );
  tool("vault_append_journal", "Append one journal or decision entry. Send an idempotency_key so a retry writes once.", journalSchema, async (current, args) =>
    (await appendJournal(env, current, parseInput(journalSchema, args))).data,
  );
  tool("vault_write_note", "Create or replace a markdown note, such as a recipe, a list, or a longer write-up. body is the note text only. Do not include the frontmatter block that vault_read returns: the vault writes its own. Put your own frontmatter keys, such as title or tags, in extra. Use a fact for one short statement. path is vault-relative, ends in .md, and uses only letters, digits, '-', '_', '.' and '/' (no spaces). Write in your own folder bots/<your agent id>/, for example bots/<your agent id>/recipes/apple-pie.md, or in shared/ if you have write:shared. To replace an existing note, read it first and send its etag as if_match. Send an idempotency_key so a retry writes once.", noteSchema, async (current, args) =>
    (await writeNote(env, current, parseInput(noteSchema, args), null)).data,
  );
  tool("vault_forget", "Soft-delete a note. History is kept for the admin. Send an idempotency_key so a retry writes once.", forgetSchema, async (current, args) => (await forgetNote(env, current, parseInput(forgetSchema, args))).data);
  return server;
}
