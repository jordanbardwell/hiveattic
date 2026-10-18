import { pruneRateCounters } from "./auth";
import { handleFetch } from "./http";
import { handleQueue } from "./indexer";
import { logEvent } from "./log";
import { mcpHandler } from "./mcp";
import type { WriterOp } from "./writer-do";
import type { ApiResult } from "./errors";
export { VaultWriter } from "./writer-do";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx, mcpHandler);
  },
  queue(batch: MessageBatch, env: Env): Promise<void> {
    return handleQueue(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcileAndPrune(env));
  },
};

async function reconcileAndPrune(env: Env): Promise<void> {
  const namespace = env.WRITER as unknown as { get(id: DurableObjectId): { perform(op: WriterOp): Promise<ApiResult> } };
  const stub = namespace.get(env.WRITER.idFromName("main"));
  // Each step runs even when the other fails, and a failure is logged instead of dropped.
  try {
    const result = await stub.perform({ kind: "reconcile" });
    if (!result.ok) logEvent({ event: "reconcile_failed", code: result.error.code });
  } catch (err) {
    logEvent({ event: "reconcile_failed", name: err instanceof Error ? err.name : "error" });
  }
  try {
    await pruneRateCounters(env);
  } catch (err) {
    logEvent({ event: "prune_failed", name: err instanceof Error ? err.name : "error" });
  }
}
