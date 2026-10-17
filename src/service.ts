import { assertClassifiedDomain, assertVaultPath, canRead, canWrite, domainOf, hasScope, noteSensitivity, resolveDomain, REVIEWER_SCOPES, scopeProblem, type Access, type NoteView } from "./access";
import { clearAuthCache } from "./auth";
import { classifyText, frontmatterText, journalRouteFor, routeFor } from "./classify";
import { CONTENT_LIMIT_BYTES, domainConfig, isOrdinaryDomain, isSensitiveDomain, stagingResources, utf8Length, vaultTimeZone } from "./config";
import { AGENTS_MD, README_MD } from "./content";
import { hashToken, randomToken, ulid } from "./crypto";
import { payloadHash } from "./idempotency";
import { fromFailure, VaultError, type ApiResult, type JsonValue } from "./errors";
import { logEvent } from "./log";
import { factPath, inSensitiveFolder, isForgetProtectedPath, journalPath, ownerForPath } from "./paths";
import { listNotes, noteHistory, readNote, searchVault, whoami } from "./query";
import { IDEMPOTENCY_KEY } from "./schemas";
import { etStamp } from "./time";
import type { Actor, Grants, JobKind, JobRequest, VaultWriter, WriterOp } from "./writer-do";

export type Session = {
  access: Access;
  requestId: string;
  client: string;
  country: string | null;
};

export type Reply = { status: number; data: Record<string, unknown> };

const WRITE_TOOLS = new Set(["vault_write_fact", "vault_append_journal", "vault_write_note", "vault_forget"]);

// Agent ids the server uses for itself or for system actors. A token cannot be minted for them.
export const RESERVED_AGENT_IDS = new Set([
  "admin",
  "owner",
  "operator",
  "system",
  "sys",
  "shared",
  "external",
  "replay",
  "rebuild",
  "reconcile",
  "indexer",
  "migration",
  "hiveattic",
  "restricted",
  "sensitive",
]);

const REROUTE_ACTIONS = new Set(["reroute", "journal_reroute", "reroute_move", "reroute_tombstone"]);

const REVIEWER_TTL_DAYS = 30;

export function toolRateKind(name: string | undefined): "read" | "write" {
  return name && WRITE_TOOLS.has(name) ? "write" : "read";
}

// Anyone may ask whether the service is up. The build (version, git_sha) and the time zone are
// shown only to a caller with a valid token, so an anonymous probe learns nothing about the deploy.
export async function health(env: Env, authenticated: boolean): Promise<Record<string, unknown>> {
  if (!authenticated) return { status: "ok", service: "hiveattic" };
  const gitSha = env.GIT_SHA?.trim() || null;
  let zone: string | null = null;
  try {
    zone = vaultTimeZone(env);
  } catch {
    zone = null;
  }
  return { status: "ok", service: "hiveattic", version: gitSha, git_sha: gitSha, vault_tz: zone };
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

// On REST a key may come as the Idempotency-Key header or the idempotency_key field. Both at once
// must agree, or nothing is written. MCP passes no header: only the tool argument counts there.
export function idempotencyKeyFrom(header: string | null | undefined, field: string | null | undefined): string | null {
  const fromHeader = header?.trim() || null;
  if (fromHeader && !IDEMPOTENCY_KEY.test(fromHeader)) throw new VaultError("invalid", "Idempotency-Key is not valid", ["idempotency_key"]);
  if (fromHeader && field && fromHeader !== field) {
    throw new VaultError("idempotency_key_conflict", "The Idempotency-Key header and the idempotency_key field differ", ["idempotency_key"]);
  }
  return fromHeader ?? field ?? null;
}

async function keyedHash(key: string | null, kind: string, payload: Record<string, unknown>): Promise<string | null> {
  return key ? payloadHash(kind, payload) : null;
}

export function assertContentSize(text: string): void {
  if (utf8Length(text) > CONTENT_LIMIT_BYTES) {
    throw new VaultError("payload_too_large", `Content is over ${CONTENT_LIMIT_BYTES} bytes of UTF-8`, ["content"], { limit: "content" });
  }
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
  idempotencyHeader: string | null = null,
): Promise<Reply> {
  assertContentSize(input.statement);
  const idempotencyKey = idempotencyKeyFrom(idempotencyHeader, input.idempotency_key);
  const path = factPath(session.access.agentId, input.scope, input.key);
  const declared = resolveDomain(path, input.domain);
  const reroute = routeFor(classifyText([input.statement, ...input.tags, ...input.links].join("\n")), input.sensitivity === "sensitive", declared);
  assertRerouteWrite(session.access, path, declared, reroute);
  const hash = await keyedHash(idempotencyKey, "fact", {
    key: input.key,
    statement: input.statement,
    scope: input.scope,
    domain: input.domain ?? null,
    observed_at: input.observed_at,
    confidence: input.confidence,
    tags: input.tags,
    links: input.links,
    sensitivity: input.sensitivity ?? null,
  });
  return perform(env, {
    kind: "fact",
    actor: actor(session),
    access: session.access,
    grants: grants(session.access),
    key: input.key,
    statement: input.statement,
    scope: input.scope,
    domain: reroute ? null : declared,
    observedAt: input.observed_at,
    confidence: input.confidence,
    tags: input.tags,
    links: input.links,
    idempotencyKey,
    payloadHash: hash,
    reroute,
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
  idempotencyHeader: string | null = null,
): Promise<Reply> {
  const idempotencyKey = idempotencyKeyFrom(idempotencyHeader, input.idempotency_key);
  const declared = input.domain ?? null;
  assertClassifiedDomain(declared);
  const needed = input.target === "decisions" ? "write:decisions" : input.target === "shared" ? "write:shared" : "write:own";
  if (!hasScope(session.access, needed)) throw new VaultError("forbidden_scope", "Scope does not allow this write");
  const at = input.at ?? new Date().toISOString();
  const journalFile = journalPath(session.access.agentId, input.target, etStamp(at, vaultTimeZone(env)).date);
  // Sensitive text is never refused. It is appended to a sensitive day file of the writer's instead:
  // bots/<writer>/journal-sensitive/ for PII alone, sensitive/<d>/journal/<writer>/ otherwise.
  const reroute = journalRouteFor(classifyText([input.title, input.body, ...input.tags].join("\n")), input.sensitivity === "sensitive", declared);
  assertRerouteWrite(session.access, journalFile, declared, reroute);
  const hash = await keyedHash(idempotencyKey, "journal", {
    target: input.target,
    title: input.title,
    body: input.body,
    at: input.at ?? null,
    tags: input.tags,
    domain: input.domain ?? null,
    sensitivity: input.sensitivity ?? null,
  });
  return perform(env, {
    kind: "journal",
    actor: actor(session),
    target: input.target,
    title: input.title,
    body: input.body,
    at,
    tags: input.tags,
    idempotencyKey,
    payloadHash: hash,
    domain: reroute ? null : declared,
    reroute,
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
    idempotency_key?: string | null;
  },
  headerMatch: string | null,
  idempotencyHeader: string | null = null,
): Promise<Reply> {
  assertContentSize(input.body);
  const idempotencyKey = idempotencyKeyFrom(idempotencyHeader, input.idempotency_key);
  const path = assertVaultPath(input.path);
  const declared = resolveDomain(path, input.domain);
  const extra = input.extra ?? {};
  // The folder decides visibility. Text that classifies as health, finance, or PII at a path that
  // is not already sensitive is stored under sensitive/<d>/<same path>. Frontmatter cannot lower it.
  const reroute = inSensitiveFolder(path)
    ? null
    : routeFor(classifyText(`${input.body}\n${frontmatterText(extra)}`), input.sensitivity === "sensitive", declared);
  let sensitivity: "normal" | "sensitive" = "normal";
  if (reroute) {
    assertRerouteWrite(session.access, path, declared, reroute);
  } else {
    sensitivity = inSensitiveFolder(path) || (declared !== null && !isOrdinaryDomain(declared)) ? "sensitive" : "normal";
    assertCanWrite(session.access, path, sensitivity, declared);
  }
  const ifMatch = headerMatch ?? input.if_match ?? null;
  const hash = await keyedHash(idempotencyKey, "note", {
    path,
    body: input.body,
    extra,
    sensitivity: input.sensitivity ?? null,
    domain: input.domain ?? null,
    type: input.type,
    if_match: ifMatch,
  });
  return perform(env, {
    kind: "note",
    actor: actor(session),
    access: session.access,
    grants: grants(session.access),
    path,
    body: input.body,
    extra,
    ifMatch,
    sensitivity,
    domain: reroute ? null : declared,
    noteType: input.type,
    idempotencyKey,
    payloadHash: hash,
    reroute,
  });
}

export async function forgetNote(
  env: Env,
  session: Session,
  input: { path?: string; id?: string; reason: string; idempotency_key?: string | null },
  idempotencyHeader: string | null = null,
): Promise<Reply> {
  if (!input.path && !input.id) throw new VaultError("invalid", "path or id is required");
  const idempotencyKey = idempotencyKeyFrom(idempotencyHeader, input.idempotency_key);
  const path = input.path ? assertVaultPath(input.path) : undefined;
  // Append-only and server-managed files are the admin's to forget. The caller's own path is checked
  // first; a path found by id is checked only after the write check on that note passes.
  if (path) assertForgettable(session.access, path);
  // A path in a domain the deploy does not classify is refused the way writes refuse it.
  if (path && !session.access.admin) assertClassifiedDomain(domainOf(path));
  // Resolve the target the same way the writer does (id wins), then authorize against that note.
  const note = input.id
    ? await env.DB.prepare("SELECT id, owner, domain, sensitivity, path FROM notes WHERE id = ?")
        .bind(input.id)
        .first<{ id: string; owner: string; domain: string | null; sensitivity: string; path: string }>()
    : await env.DB.prepare("SELECT id, owner, domain, sensitivity, path FROM notes WHERE path = ?")
        .bind(path ?? "")
        .first<{ id: string; owner: string; domain: string | null; sensitivity: string; path: string }>();
  if (note) {
    assertCanWrite(session.access, note.path, noteSensitivity(note), note.domain);
    if (path && note.path !== path) throw new VaultError("invalid", "path and id refer to different notes");
  } else if (path) {
    assertCanWrite(session.access, path, "normal");
  }
  if (note) assertForgettable(session.access, note.path);
  const hash = await keyedHash(idempotencyKey, "forget", { path: path ?? null, id: input.id ?? null, reason: input.reason });
  return perform(env, {
    kind: "forget",
    actor: actor(session),
    access: session.access,
    path: note?.path ?? path,
    id: note?.id ?? input.id,
    reason: input.reason,
    idempotencyKey,
    payloadHash: hash,
  });
}

function assertForgettable(access: Access, path: string): void {
  if (!access.admin && isForgetProtectedPath(path)) {
    throw new VaultError("forget_protected_path", "Only the admin token can forget an append-only or server-managed file", [path]);
  }
}

export async function bootstrap(env: Env, session: Session): Promise<Reply> {
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
    ttl_days?: number;
  },
): Promise<Record<string, unknown>> {
  assertAdmin(session.access);
  const reviewer = input.preset === "reviewer";
  // A reviewer token lives 30 days unless the mint says otherwise. Other tokens live until revoked,
  // or for ttl_days when it is given.
  const ttlDays = input.ttl_days ?? (reviewer ? REVIEWER_TTL_DAYS : null);
  const agentId = input.agent_id ?? (reviewer ? "reviewer" : "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) throw new VaultError("invalid", "agent_id is required");
  if (RESERVED_AGENT_IDS.has(agentId)) throw new VaultError("invalid", "agent_id is reserved", ["agent_id"]);
  const scopes = reviewer ? REVIEWER_SCOPES : input.scopes;
  if (!scopes?.length) throw new VaultError("invalid", "scopes are required");
  const problems = scopes.map((scope) => scopeProblem(scope)).filter((problem): problem is string => problem !== null);
  if (problems.length) throw new VaultError("invalid", "A scope is not valid", [...new Set(problems)]);
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
  const expiresAt = ttlDays ? new Date(Date.parse(now) + ttlDays * 86_400_000).toISOString() : null;
  await env.DB.prepare(
    "INSERT INTO tokens (id, agent_id, token_hash, scopes_override, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(tokenId, agentId, await hashToken(env.TOKEN_PEPPER, token), JSON.stringify(scopes), input.label ?? null, now, expiresAt)
    .run();
  await audit(env, session, "mint_token", null, tokenId, "ok", [], null, 0);
  return { token, token_id: tokenId, agent_id: agentId, scopes, label: input.label ?? null, expires_at: expiresAt };
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

// Rebuild, reindex, reconcile, and the quarantine erase run as paged jobs in the writer. Start
// answers 202 with a job id. The job audits `<name>_started`, then one row with counts or the
// phase and error it stopped at.
export async function startJob(
  env: Env,
  session: Session,
  kind: JobKind,
  options: { dryRun?: boolean; confirmCount?: number | null } = {},
): Promise<Reply> {
  assertAdmin(session.access);
  return startWriterJob(env, { kind, actor: actor(session), dryRun: options.dryRun, confirmCount: options.confirmCount ?? null, source: "api" });
}

export async function startWriterJob(env: Env, request: JobRequest): Promise<Reply> {
  const result = await writerCall(env, (stub) => stub.startJob(request));
  return reply(result);
}

export async function getJob(env: Env, session: Session, id: string, report = false): Promise<Reply> {
  assertAdmin(session.access);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new VaultError("not_found", "Job not found");
  return reply(await writerCall(env, (stub) => (report ? stub.jobReport(id) : stub.getJob(id))));
}

export async function getOperation(env: Env, session: Session, id: string): Promise<Reply> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new VaultError("not_found", "Operation not found");
  return reply(await writerCall(env, (stub) => stub.getOperation(id, session.access.agentId, session.access.admin)));
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
): Promise<Reply> {
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

export async function purgeNote(env: Env, session: Session, input: { path?: string; id?: string }): Promise<Reply> {
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

export async function cleanupRun(env: Env, session: Session, runId: string): Promise<Reply> {
  assertAdmin(session.access);
  if (!cleanupEnabled(env)) {
    if (env.E2E_CLEANUP_ENABLED === "true") await audit(env, session, "cleanup_refused", null, null, "rejected", ["not_staging"], null, 0);
    throw new VaultError("not_found", "Route not found");
  }
  return perform(env, { kind: "cleanup", actor: actor(session), runId });
}

type AuditRow = { path: string | null; action: string } & Record<string, unknown>;

// The admin token reads every row. An `audit:read` token sees only rows for paths it can read,
// never a reroute row, and cannot filter by path.
export async function listAudit(env: Env, session: Session, limit: number, requestId?: string, path?: string): Promise<Record<string, unknown>> {
  const admin = session.access.admin;
  if (!admin && !session.access.scopes.includes("audit:read")) {
    throw new VaultError("forbidden_scope", "Scope does not allow audit reads");
  }
  if (!admin && path) throw new VaultError("forbidden_scope", "Only the admin token can filter the audit log by path");
  const cap = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);
  const columns = `seq, ts, request_id, agent_id, token_id, client, action, path, note_id, outcome, reason_codes, content_hash, bytes, ip_country, detail`;
  let rows: AuditRow[];
  if (requestId) {
    if (requestId.length > 80) throw new VaultError("invalid", "request_id is too long");
    rows = (await env.DB.prepare(`SELECT ${columns} FROM audit_log WHERE request_id = ? ORDER BY seq DESC LIMIT ?`).bind(requestId, cap).all<AuditRow>()).results ?? [];
  } else if (path) {
    if (path.length > 200) throw new VaultError("invalid", "path is too long");
    rows = (await env.DB.prepare(`SELECT ${columns} FROM audit_log WHERE path = ? ORDER BY seq DESC LIMIT ?`).bind(path, cap).all<AuditRow>()).results ?? [];
  } else {
    rows = (await env.DB.prepare(`SELECT ${columns} FROM audit_log ORDER BY seq DESC LIMIT ?`).bind(cap).all<AuditRow>()).results ?? [];
  }
  if (admin) return { entries: rows };
  const paths = [...new Set(rows.flatMap((row) => (row.path ? [row.path] : [])))];
  const views = new Map<string, NoteView>();
  if (paths.length) {
    const found = await env.DB.prepare("SELECT path, owner, domain, sensitivity, frontmatter FROM notes WHERE path IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(paths))
      .all<{ path: string; owner: string; domain: string | null; sensitivity: string; frontmatter: string }>();
    for (const row of found.results ?? []) views.set(row.path, { path: row.path, owner: row.owner, domain: row.domain, sensitivity: row.sensitivity });
  }
  const visible = rows.filter((row) => {
    if (REROUTE_ACTIONS.has(row.action)) return false;
    if (!row.path) return true;
    const view = views.get(row.path) ?? { path: row.path, owner: ownerForPath(row.path), domain: domainOf(row.path), sensitivity: inSensitiveFolder(row.path) ? "sensitive" : "normal" };
    return canRead(session.access, view);
  });
  return { entries: visible };
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

// A rerouted write needs the right to write the path the caller named. A sensitive domain the
// caller declared also needs write:sensitive/<d>. Text the server classified does not.
function assertRerouteWrite(access: Access, path: string, declared: string | null, reroute: string | null): void {
  if (!reroute) {
    assertCanWrite(access, path, declared !== null && !isOrdinaryDomain(declared) ? "sensitive" : "normal", declared);
    return;
  }
  if (declared && isSensitiveDomain(declared) && !hasScope(access, `write:sensitive/${declared}`)) {
    throw new VaultError("forbidden_scope", "Scope does not allow this write");
  }
  assertCanWrite(access, path, "normal", declared && isOrdinaryDomain(declared) ? declared : null);
}

function assertCanWrite(access: Access, path: string, sensitivity: "normal" | "sensitive", domain: string | null = null): void {
  if (!canWrite(access, path, sensitivity, domain)) throw new VaultError("forbidden_scope", "Scope does not allow this write");
}

function assertAdmin(access: Access): void {
  if (!access.admin) throw new VaultError("forbidden_scope", "Admin scope required");
}

function grants(access: Access): Grants {
  return { admin: access.admin, sensitive: [...domainConfig().sensitive].filter((domain) => hasScope(access, `write:sensitive/${domain}`)) };
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

// The writer's RPC surface, typed plainly. Generated RPC stub types wrap every return value.
export type WriterStub = Pick<VaultWriter, "perform" | "startJob" | "getJob" | "jobReport" | "getOperation" | "replayPending">;

export function writer(env: Env): WriterStub {
  return env.WRITER.get(env.WRITER.idFromName("main")) as unknown as WriterStub;
}

async function writerCall(env: Env, call: (stub: WriterStub) => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await call(writer(env));
  } catch (err) {
    logEvent({ event: "writer_rpc_failed", name: err instanceof Error ? err.name : "error" });
    throw new VaultError("invalid", "Write failed");
  }
}

function reply(result: ApiResult): Reply {
  if (!result.ok) throw fromFailure(result.error);
  return { status: result.status ?? 200, data: result.data as Record<string, JsonValue> };
}

async function perform(env: Env, op: WriterOp): Promise<Reply> {
  return reply(await writerCall(env, (stub) => stub.perform(op, ulid())));
}

function aborted(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /append-only|ABORT/i.test(text);
}
