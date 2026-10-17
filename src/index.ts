import { pruneRateCounters } from "./auth";
import { configure } from "./config";
import { ulid } from "./crypto";
import { handleFetch } from "./http";
import { handleQueue } from "./indexer";
import { mcpHandler } from "./mcp";
import { startWriterJob } from "./service";
import { VaultError } from "./errors";
import { logEvent } from "./log";
export { VaultWriter } from "./writer-do";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx, mcpHandler);
  },
  queue(batch: MessageBatch, env: Env, _ctx?: ExecutionContext): Promise<void> {
    return handleQueue(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(nightly(env));
  },
};

// The nightly cron starts a reconcile job. A job already running, or quarantine records that still
// need the migration, make it skip. The writer audits the skip.
export async function nightly(env: Env): Promise<void> {
  configure(env);
  const actor = { agentId: "reconcile", tokenId: "cron", client: "cron", requestId: ulid(), ipCountry: null };
  try {
    await startWriterJob(env, { kind: "reconcile", actor, source: "cron" });
  } catch (err) {
    const code = err instanceof VaultError ? err.code : "error";
    logEvent({ event: "nightly_reconcile_skipped", reason: code });
  }
  await pruneRateCounters(env);
}
