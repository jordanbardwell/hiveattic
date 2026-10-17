import { assertClassifiedDomain, canWrite, hasScope, NON_SENSITIVE_DOMAINS, resolveDomain, REVIEWER_SCOPES, SENSITIVE_DOMAINS, type Access } from "./access";
import { clearAuthCache } from "./auth";
import { AGENTS_MD, README_MD } from "./content";
import { hashToken, randomToken, ulid } from "./crypto";
import { VaultError, type ApiResult, type ErrorCode, type JsonValue } from "./errors";
import { logEvent } from "./log";
import { assertVaultPath } from "./access";
import { factPath, journalPath } from "./paths";
import { listNotes, noteHistory, readNote, searchVault, stagingResources, whoami } from "./query";
import { etStamp } from "./time";
import type { Actor, WriterOp } from "./writer-do";

export type Session = {
  access: Access;
  requestId: string;
  client: string;
  country: string | null;
};

const WRITE_TOOLS = new Set(["vault_write_fact", "vault_append_journal", "vault_write_note", "vault_forget"]);

export function toolRateKind(name: string | undefined): "read" | "write" {
  return name && WRITE_TOOLS.has(name) ? "write" : "read";
}

export async function health(env: Env): Promise<Record<string, unknown>> {
  const gitSha = env.GIT_SHA?.trim() || null;
  return { status: "ok", service: "hiveattic", version: gitSha, git_sha: gitSha };
}

export async function currentAgent(env: Env, session: Session): Promise<Record<string, unknown>> {
  return whoami(env, session.access);
}

export async function readPath(env: Env, session: Session, path: string): Promise<Record<string, unknown>> {
  return readNote(env, session.access, assertVaultPath(path));
}

export async function readById(env: Env, session: Session, id: string): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) throw new VaultError("invalid", "id is not valid");
  return readNote(env, session.access, undefined, id);
}

export type SearchOptions = { limit?: number; domains?: string[]; types?: string[]; since?: string };

export async function search(env: Env, session: Session, query: string, mode: string, options: SearchOptions = {}): Promise<Record<string, unknown>> {
  return searchVault(env, session.access, query, mode, options);
}

export async function list(env: Env, session: Session, prefix: string, cursor = ""): Promise<Record<string, unknown>> {
  const trimmed = prefix.trim().replace(/^\/+/, "");
  if (trimmed.includes("..") || trimmed.includes("\\")) throw new VaultError("invalid", "Prefix is not valid");
  return listNotes(env, session.access, trimmed, cursor);
}

export async function history(env: Env, session: Session, path?: string, id?: string): Promise<Record<string, unknown>> {
  if (!path && !id) throw new VaultError("invalid", "path or id is required");
  return noteHistory(env, session.access, path ? assertVaultPath(path) : undefined, id);
}

export async function writeFact(
  env: Env,
  session: Session,
  input: {
    key: string;
    statement: string;
    scope: "own" | "shared";
    domain?: string | null;
    observed_at: string;
    confidence: number;
    tags: string[];
    links: string[];
    idempotency_key?: string | null;
    sensitivity?: "normal" | "sensitive";
  },
): Promise<Record<string, unknown>> {
  const path = factPath(session.access.agentId, input.scope, input.key);
  const domain = resolveDomain(path, input.domain);
  const sensitivity = sensitivityFor(input.sensitivity, domain);
  assertCanWrite(session.access, path, sensitivity, domain);
  return perform(env, {
    kind: "fact",
    actor: actor(session),
    key: input.key,
    statement: input.statement,
    scope: input.scope,
    domain,
    observedAt: input.observed_at,
    confidence: input.confidence,
    tags: input.tags,
    links: input.links,
    idempotencyKey: input.idempotency_key ?? null,
    sensitivity,
  });
}

export async function appendJournal(
  env: Env,
  session: Session,
  input: {
    target: "own" | "shared" | "decisions";
    title: string;
    body: string;
    at?: string;
    tags: string[];
    idempotency_key?: string | null;
    domain?: string | null;
    sensitivity?: "normal" | "sensitive";
  },
): Promise<Record<string, unknown>> {
  const domain = input.domain ?? null;
  assertClassifiedDomain(domain);
  const sensitivity = sensitivityFor(input.sensitivity, domain);
  if (sensitivity === "sensitive" && input.target !== "own") {
    throw new VaultError("invalid", "A sensitive journal entry stays in your own journal. Shared day files stay normal.");
  }
  const needed = input.target === "decisions" ? "write:decisions" : input.target === "shared" ? "write:shared" : "write:own";
  if (!hasScope(session.access, needed)) throw new VaultError("forbidden_scope", "Scope does not allow this write");
  const journalDate = etStamp(input.at ?? new Date().toISOString(), env.TZ_DISPLAY || "UTC").date;
  const journalFile = journalPath(session.access.agentId, input.target, journalDate, sensitivity === "sensitive" && input.target === "own");
  assertCanWrite(session.access, journalFile, sensitivity, domain);
  return perform(env, {
    kind: "journal",
    actor: actor(session),
    target: input.target,
    title: input.title,
    body: input.body,
    at: input.at ?? new Date().toISOString(),
    tags: input.tags,
    idempotencyKey: input.idempotency_key ?? null,
    domain,
    sensitivity,
  });
}

export async function writeNote(
  env: Env,
  session: Session,
  input: {
    path: string;
    body: string;
    extra?: Record<string, unknown>;
    sensitivity?: "normal" | "sensitive";
    domain?: string | null;
    type: string;
    if_match?: string | null;
  },
  headerMatch: string | null,
): Promise<Record<string, unknown>> {
  const path = assertVaultPath(input.path);
  const domain = resolveDomain(path, input.domain);
  const sensitivity = sensitivityFor(input.sensitivity, domain);
  assertCanWrite(session.access, path, sensitivity, domain);
  return perform(env, {
    kind: "note",
    actor: actor(session),
    path,
    body: input.body,
    extra: input.extra ?? {},
    ifMatch: headerMatch ?? input.if_match ?? null,
    sensitivity,
    domain,
    noteType: input.type,
  });
}

export async function forgetNote(
  env: Env,
  session: Session,
  input: { path?: string; id?: string; reason: string },
): Promise<Record<string, unknown>> {
  if (!input.path && !input.id) throw new VaultError("invalid", "path or id is required");
  const path = input.path ? assertVaultPath(input.path) : undefined;
  const note = path
    ? await env.DB.prepare("SELECT owner, domain, sensitivity, path FROM notes WHERE path = ?")
        .bind(path)
        .first<{ owner: string; domain: string | null; sensitivity: string; path: string }>()
    : await env.DB.prepare("SELECT owner, domain, sensitivity, path FROM notes WHERE id = ?")
        .bind(input.id ?? "")
        .first<{ owner: string; domain: string | null; sensitivity: string; path: string }>();
  if (note) {
    const sensitivity = note.sensitivity === "sensitive" || (note.domain !== null && !NON_SENSITIVE_DOMAINS.has(note.domain)) ? "sensitive" : "normal";
    assertCanWrite(session.access, note.path, sensitivity, note.domain);
  } else if (path) {
    assertCanWrite(session.access, path, "normal");
  }
  return perform(env, { kind: "forget", actor: actor(session), path, id: input.id, reason: input.reason });
}

export async function bootstrap(env: Env, session: Session): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  return perform(env, {
    kind: "bootstrap",
    actor: actor(session),
    files: [
      { path: "AGENTS.md", markdown: AGENTS_MD },
      { path: "README.md", markdown: README_MD },
    ],
  });
}

export async function mintToken(
  env: Env,
  session: Session,
  input: {
    agent_id?: string;
    display_name?: string;
    kind?: "agent" | "external" | "human";
    scopes?: string[];
    preset?: "reviewer";
    label?: string;
  },
): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  const reviewer = input.preset === "reviewer";
  const agentId = input.agent_id ?? (reviewer ? "reviewer" : "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) throw new VaultError("invalid", "agent_id is required");
  const scopes = reviewer ? REVIEWER_SCOPES : input.scopes;
  if (!scopes?.length) throw new VaultError("invalid", "scopes are required");
  const now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId).first<{ id: string }>();
  if (!existing) {
    await env.DB.prepare("INSERT INTO agents (id, display_name, kind, scopes, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      agentId,
      input.display_name ?? agentId,
      input.kind ?? (reviewer ? "human" : "agent"),
      JSON.stringify(scopes),
      now,
    ).run();
  }
  const token = randomToken(agentId);
  const tokenId = ulid();
  await env.DB.prepare(
    "INSERT INTO tokens (id, agent_id, token_hash, scopes_override, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(tokenId, agentId, await hashToken(env.TOKEN_PEPPER, token), JSON.stringify(scopes), input.label ?? null, now)
    .run();
  await audit(env, session, "mint_token", null, tokenId, "ok", [], null, 0);
  return { token, token_id: tokenId, agent_id: agentId, scopes, label: input.label ?? null };
}

export async function revokeToken(env: Env, session: Session, input: { token_id?: string; label?: string }): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  if (!input.token_id && !input.label) throw new VaultError("invalid", "token_id or label is required");
  const now = new Date().toISOString();
  const result = input.token_id
    ? await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, input.token_id).run()
    : await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL").bind(now, input.label ?? "").run();
  clearAuthCache();
  await audit(env, session, "revoke", null, input.token_id ?? null, "ok", [], null, result.meta.changes ?? 0);
  return { revoked: result.meta.changes ?? 0 };
}

// The writer audits reindex_started, then reindex with the outcome, counts, and duration when the rebuild ends.
export async function reindex(env: Env, session: Session): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  return perform(env, { kind: "rebuild", actor: actor(session) });
}

export async function reconcile(env: Env, session: Session): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  await audit(env, session, "reconcile", null, null, "ok", [], null, 0);
  return perform(env, { kind: "reconcile" });
}

export async function journalOrder(env: Env, session: Session, path: string): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  const note = await env.DB.prepare("SELECT id FROM notes WHERE path = ?").bind(assertVaultPath(path)).first<{ id: string }>();
  if (!note) throw new VaultError("not_found", "Note not found");
  const rows = await env.DB.prepare("SELECT block_ref FROM journal_entries WHERE note_id = ? ORDER BY rowid").bind(note.id).all<{ block_ref: string }>();
  return { path, block_refs: (rows.results ?? []).map((row) => row.block_ref) };
}

export async function restoreVersion(
  env: Env,
  session: Session,
  input: { path?: string; id?: string; version_ts: string },
): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  if (!input.path && !input.id) throw new VaultError("invalid", "path or id is required");
  return perform(env, {
    kind: "restore",
    actor: actor(session),
    path: input.path ? assertVaultPath(input.path) : undefined,
    id: input.id,
    versionTs: input.version_ts,
  });
}

export async function purgeNote(env: Env, session: Session, input: { path?: string; id?: string }): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  if (!input.path && !input.id) throw new VaultError("invalid", "path or id is required");
  return perform(env, {
    kind: "purge",
    actor: actor(session),
    path: input.path ? assertVaultPath(input.path) : undefined,
    id: input.id,
  });
}

export function cleanupEnabled(env: Env): boolean {
  return env.E2E_CLEANUP_ENABLED === "true" && stagingResources(env);
}

export async function cleanupRun(env: Env, session: Session, runId: string): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  if (!cleanupEnabled(env)) {
    if (env.E2E_CLEANUP_ENABLED === "true") await audit(env, session, "cleanup_refused", null, null, "rejected", ["not_staging"], null, 0);
    throw new VaultError("not_found", "Route not found");
  }
  return perform(env, { kind: "cleanup", actor: actor(session), runId });
}

export async function listAudit(env: Env, session: Session, limit: number, requestId?: string, path?: string): Promise<Record<string, unknown>> {
  if (!session.access.admin && !session.access.scopes.includes("audit:read")) {
    throw new VaultError("forbidden_scope", "Scope does not allow audit reads");
  }
  const cap = Math.min(Math.max(limit, 1), 200);
  const columns = `seq, ts, request_id, agent_id, token_id, client, action, path, note_id, outcome, reason_codes, content_hash, bytes, ip_country, detail`;
  if (requestId) {
    if (requestId.length > 80) throw new VaultError("invalid", "request_id is too long");
    const rows = await env.DB.prepare(`SELECT ${columns} FROM audit_log WHERE request_id = ? ORDER BY seq DESC LIMIT ?`).bind(requestId, cap).all();
    return { entries: rows.results ?? [] };
  }
  if (path) {
    if (path.length > 200) throw new VaultError("invalid", "path is too long");
    const rows = await env.DB.prepare(`SELECT ${columns} FROM audit_log WHERE path = ? ORDER BY seq DESC LIMIT ?`).bind(path, cap).all();
    return { entries: rows.results ?? [] };
  }
  const rows = await env.DB.prepare(`SELECT ${columns} FROM audit_log ORDER BY seq DESC LIMIT ?`).bind(cap).all();
  return { entries: rows.results ?? [] };
}

export async function verifyAuditAppendOnly(env: Env, session: Session): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  const requestId = ulid();
  await env.DB.prepare(
    `INSERT INTO audit_log (ts, request_id, agent_id, token_id, client, action, path, note_id, outcome, reason_codes, content_hash, bytes, ip_country)
     VALUES (?, ?, ?, ?, 'rest', 'verify_append_only', NULL, NULL, 'ok', NULL, NULL, 0, NULL)`,
  )
    .bind(new Date().toISOString(), requestId, session.access.agentId, session.access.tokenId)
    .run();
  const row = await env.DB.prepare("SELECT seq, outcome FROM audit_log WHERE request_id = ?").bind(requestId).first<{ seq: number; outcome: string }>();
  if (!row) throw new VaultError("invalid", "Audit probe was not written");
  let updateAborted = false;
  try {
    await env.DB.prepare("UPDATE audit_log SET outcome = 'tampered' WHERE seq = ?").bind(row.seq).run();
  } catch (err) {
    updateAborted = aborted(err);
  }
  let deleteAborted = false;
  try {
    await env.DB.prepare("DELETE FROM audit_log WHERE seq = ?").bind(row.seq).run();
  } catch (err) {
    deleteAborted = aborted(err);
  }
  const after = await env.DB.prepare("SELECT outcome FROM audit_log WHERE seq = ?").bind(row.seq).first<{ outcome: string }>();
  if (!updateAborted || !deleteAborted || after?.outcome !== "ok") {
    throw new VaultError("invalid", "Audit trigger did not abort a mutation");
  }
  return { update_aborted: true, delete_aborted: true };
}

// Sensitivity comes from the caller or the domain. The server does not read content to decide it.
function sensitivityFor(requested: "normal" | "sensitive" | undefined, domain: string | null): "normal" | "sensitive" {
  if (requested === "sensitive" || (domain !== null && SENSITIVE_DOMAINS.has(domain))) return "sensitive";
  return "normal";
}

function assertCanWrite(access: Access, path: string, sensitivity: "normal" | "sensitive", domain: string | null = null): void {
  if (!canWrite(access, path, sensitivity, domain)) throw new VaultError("forbidden_scope", "Scope does not allow this write");
}

function assertAdmin(access: Access): void {
  if (!access.admin) throw new VaultError("forbidden_scope", "Admin scope required");
}

async function audit(
  env: Env,
  session: Session,
  action: string,
  path: string | null,
  noteId: string | null,
  outcome: string,
  reasons: string[],
  contentHash: string | null,
  bytes: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (ts, request_id, agent_id, token_id, client, action, path, note_id, outcome, reason_codes, content_hash, bytes, ip_country)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      new Date().toISOString(),
      session.requestId,
      session.access.agentId,
      session.access.tokenId,
      session.client,
      action,
      path,
      noteId,
      outcome,
      reasons.length ? JSON.stringify(reasons) : null,
      contentHash,
      bytes,
      session.country,
    )
    .run();
}

function actor(session: Session): Actor {
  return {
    agentId: session.access.agentId,
    tokenId: session.access.tokenId,
    client: session.client,
    requestId: session.requestId,
    ipCountry: session.country,
  };
}

async function perform(env: Env, op: WriterOp): Promise<{ [key: string]: JsonValue }> {
  const namespace = env.WRITER as unknown as { get(id: DurableObjectId): { perform(op: WriterOp): Promise<ApiResult> } };
  const stub = namespace.get(env.WRITER.idFromName("main"));
  let result: ApiResult;
  try {
    result = await stub.perform(op);
  } catch (err) {
    logEvent({ event: "writer_rpc_failed", name: err instanceof Error ? err.name : "error" });
    throw new VaultError("invalid", "Write failed");
  }
  if (!result.ok) {
    const code = isErrorCode(result.error.code) ? result.error.code : "invalid";
    throw new VaultError(code, result.error.message, result.error.reasons);
  }
  return result.data;
}

function isErrorCode(code: string): code is ErrorCode {
  return [
    "unauthorized",
    "forbidden_scope",
    "conflict_etag",
    "not_found",
    "rate_limited",
    "invalid",
  ].includes(code);
}

function aborted(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /append-only|ABORT/i.test(text);
}
