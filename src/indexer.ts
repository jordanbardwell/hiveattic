import type { ApiResult } from "./errors";
import { logEvent } from "./log";
import type { WriterOp } from "./writer-do";

type IndexMessage = {
  kind?: string;
  note_id?: string;
  path?: string;
  chunk_ids?: string[];
  action?: string;
  eventTime?: string;
  copySource?: { bucket?: string; object?: string } | string;
  object?: { key?: string; eTag?: string; size?: number };
};

export async function handleQueue(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleMessage(message.body, env);
      message.ack();
    } catch (err) {
      logEvent({ event: "index_retry", name: err instanceof Error ? err.name : "error" });
      message.retry();
    }
  }
}

async function handleMessage(body: unknown, env: Env): Promise<void> {
  const message = normalize(body);
  if (!message) return;
  if (message.kind === "agent-index" && message.note_id) {
    await env.DB.prepare("UPDATE notes SET indexed_at = ? WHERE id = ?").bind(new Date().toISOString(), message.note_id).run();
    return;
  }
  if (message.kind === "forget") return;
  if (message.action && message.object?.key) {
    const namespace = env.WRITER as unknown as { get(id: DurableObjectId): { perform(op: WriterOp): Promise<ApiResult> } };
    const stub = namespace.get(env.WRITER.idFromName("main"));
    const op: WriterOp = {
      kind: "external",
      key: message.object.key,
      action: message.action,
      eventTime: message.eventTime ?? null,
      eTag: message.object.eTag ?? null,
      copySource: normalizeCopySource(message.copySource),
    };
    const result = await stub.perform(op);
    if (!result.ok) throw new Error(result.error.code);
  }
}

function normalizeCopySource(value: IndexMessage["copySource"]): { bucket?: string; object?: string } | string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return {
      bucket: typeof value.bucket === "string" ? value.bucket : undefined,
      object: typeof value.object === "string" ? value.object : undefined,
    };
  }
  return null;
}

function normalize(body: unknown): IndexMessage | null {
  if (!body) return null;
  if (typeof body === "string") {
    try {
      return normalize(JSON.parse(body) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof body !== "object") return null;
  return body as IndexMessage;
}
