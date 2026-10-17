import { pruneRateCounters } from "./auth";
import { handleFetch } from "./http";
import { handleQueue } from "./indexer";
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
  await stub.perform({ kind: "reconcile" });
  await pruneRateCounters(env);
}
