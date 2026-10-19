import { DurableObject } from "cloudflare:workers";
import { canWrite, domainOf, noteSensitivity, type Access } from "./access";
import { frontmatterRoute } from "./classify";
import { configure, FILE_LIMIT_BYTES, isOrdinaryDomain, isProductionDeploy, requireSecrets, RESTRICTED, stagingResources, utf8Length, vaultTimeZone, writeTimeoutMs } from "./config";
import { hash8, hmacSha256Hex, sha256Hex, ulid } from "./crypto";
import { ulidTime } from "./idempotency";
import { asVaultError, ERROR_STATUS, failure, VaultError, type ApiResult, type JsonValue } from "./errors";
import { logEvent } from "./log";
import {
  buildMarkdown,
  chunkMarkdown,
  guardJournalBody,
  journalEntries,
  linkTargets,
  parseMarkdown,
  stringField,
  stringList,
  type Frontmatter,
  type JournalEntry,
} from "./markdown";
import {
  factPath,
  inSensitiveFolder,
  isAppendOnlyPath,
  isFactPath,
  isGeneratedFile,
  isServerDocument,
  journalPath,
  ownerForPath,
  PII_ROUTE,
  piiJournalOwner,
  r2KeyFor,
  reroutedPath,
  sensitiveJournalPath,
  sensitiveSegment,
  vaultPathFromKey,
} from "./paths";
import { emptyRows, jsonInsert, jsonSelect, jsonSlices, slices, type StagedRows } from "./stage";
import { etStamp, versionStamp, within24h } from "./time";

export type Actor = {
  agentId: string;
  tokenId: string;
  client: string;
  requestId: string;
  ipCountry: string | null;
};

// What the caller may write in sensitive folders. The service fills it from the token's scopes.
export type Grants = { admin: boolean; sensitive: string[] };

export type WriterOp =
  | {
      kind: "fact";
      actor: Actor;
      access: Access;
      grants: Grants;
      key: string;
      statement: string;
      scope: "own" | "shared";
      domain: string | null;
      observedAt: string;
      confidence: number;
      tags: string[];
      links: string[];
      idempotencyKey: string | null;
      payloadHash: string | null;
      reroute: string | null;
    }
  | {
      kind: "journal";
      actor: Actor;
      target: "own" | "shared" | "decisions";
      title: string;
      body: string;
      at: string;
      tags: string[];
      idempotencyKey: string | null;
      payloadHash: string | null;
      domain: string | null;
      reroute: string | null;
    }
  | {
      kind: "note";
      actor: Actor;
      access: Access;
      grants: Grants;
      path: string;
      body: string;
      extra: Frontmatter;
      ifMatch: string | null;
      sensitivity: "normal" | "sensitive";
      domain: string | null;
      noteType: string;
      idempotencyKey: string | null;
      payloadHash: string | null;
      reroute: string | null;
    }
  | { kind: "forget"; actor: Actor; access: Access; path?: string; id?: string; reason: string; idempotencyKey: string | null; payloadHash: string | null }
  | { kind: "restore"; actor: Actor; path?: string; id?: string; versionTs: string }
  | { kind: "purge"; actor: Actor; path?: string; id?: string }
  | { kind: "bootstrap"; actor: Actor; files: { path: string; markdown: string }[] }
  | {
      kind: "external";
      key: string;
      action: string;
      eventTime?: string | null;
      eTag?: string | null;
      copySource?: { bucket?: string; object?: string } | string | null;
    }
  | { kind: "replay" }
  | { kind: "cleanup"; actor: Actor; runId: string };

export type JobKind = "rebuild" | "reindex" | "reconcile" | "quarantine-erase";
export type JobRequest = { kind: JobKind; actor: Actor; dryRun?: boolean; confirmCount?: number | null; source?: "api" | "cron" };

type NoteRow = {
  id: string;
  path: string;
  type: string;
  owner: string;
  domain: string | null;
  sensitivity: string;
  fact_key: string | null;
  title: string | null;
  body: string;
  frontmatter: string;
  content_hash: string;
  statement_hash: string | null;
  r2_etag: string | null;
  r2_key: string;
  status: string;
  observed_at: string | null;
  created_at: string;
  updated_at: string;
  version_ts: string | null;
  last_writer: string;
};

type JobStatus = "queued" | "running" | "done" | "failed";

type Job = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  phase: string;
  cursor: string | null;
  gen: number;
  dry_run: boolean;
  started_ms: number;
  counts: Record<string, number>;
  errors: string[];
  error: string | null;
  pages: number;
  attempts: number;
  actor: Actor;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  report: { note_ids: string[]; paths: string[] };
};

type SaveInput = {
  id: string;
  path: string;
  markdown: string;
  type: string;
  owner: string;
  domain: string | null;
  sensitivity: "normal" | "sensitive";
  factKey: string | null;
  title: string;
  statementHash: string | null;
  observedAt: string | null;
  actor: Actor;
  ifMatch: string | null;
  create: boolean;
  reason: string;
  action: string;
  journal: { id: string; title: string; at: string; idempotencyKey: string | null } | null;
  remember?: { key: string; hash: string | null; status: number; data: (etag: string) => { [key: string]: JsonValue } } | null;
  allowRetry?: boolean;
  skipPut?: boolean;
  storedEtag?: string | null;
  detail?: string | null;
  createdAt?: string | null;
};

// Ordinary writes answer within WRITE_TIMEOUT_MS (25 s). A write still running then answers 202
// with its operation id, keeps running, and stores its result for GET /v1/operations/:id.
const OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const R2_READ_CONCURRENCY = 8;
// One job page handles at most this many R2 objects, about this much wall time, and about this
// many bytes of file text. The writer lock is held for one page, then released.
const PAGE_OBJECTS = 100;
const PAGE_BUDGET_MS = 10_000;
const PAGE_BYTES = 16_000_000;
const HISTORY_READS_PER_PAGE = 100;
const LINK_ROWS_PER_PAGE = 500;
const MAX_JOB_ATTEMPTS = 3;
const NOTE_COLUMNS = [
  "id", "path", "type", "owner", "domain", "sensitivity", "fact_key", "title", "body", "frontmatter", "content_hash", "statement_hash",
  "r2_etag", "r2_key", "status", "observed_at", "created_at", "updated_at", "version_ts", "last_writer", "index_gen",
];
const NOTE_UPDATE_COLUMNS = NOTE_COLUMNS.filter((column) => column !== "id" && column !== "created_at");
const CHUNK_COLUMNS = ["id", "note_id", "n", "text", "title", "path", "token_count"];
const JOURNAL_COLUMNS = ["id", "note_id", "agent_id", "at", "title", "block_ref", "idempotency_key"];
const VERSION_COLUMNS = ["note_id", "version_ts", "r2_key", "content_hash", "writer", "reason"];
const API_OPS = new Set(["fact", "journal", "note", "forget", "restore", "purge", "bootstrap", "cleanup"]);

export class VaultWriter extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private inflight = new Map<string, Promise<ApiResult>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS write_intents (
          op_id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          prev_etag TEXT,
          new_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS operations (
          op_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          idem_key TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          created_at INTEGER NOT NULL,
          finished_at INTEGER,
          payload_hash TEXT
        )`,
      );
      const opColumns = sql.exec<{ name: string }>("PRAGMA table_info(operations)").toArray().map((column) => column.name);
      if (!opColumns.includes("payload_hash")) sql.exec("ALTER TABLE operations ADD COLUMN payload_hash TEXT");
      sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS operations_idem ON operations(agent_id, idem_key) WHERE idem_key IS NOT NULL");
      sql.exec(
        `CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      );
      sql.exec("CREATE TABLE IF NOT EXISTS writer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      // An operation that was running when the object went away has no promise to wait on. A retry
      // with its idempotency key runs it again, and the write's own replay check prevents a duplicate.
      configure(env);
      await this.replayIntents();
      const alarm = await ctx.storage.getAlarm();
      if (this.activeJob()) await ctx.storage.setAlarm(Date.now());
      else if (alarm === null) await ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  // RPC: ordinary writes and admin actions. API writes get an operation id and the caller-facing timeout.
  async perform(op: WriterOp, operationId?: string): Promise<ApiResult> {
    try {
      configure(this.env);
      requireSecrets(this.env);
    } catch (err) {
      return failure(asVaultError(err));
    }
    if (!API_OPS.has(op.kind)) return this.serialize(() => this.dispatch(op));
    const actor = (op as { actor: Actor }).actor;
    const key = idempotencyKeyOf(op);
    const hash = payloadHashOf(op);
    if (key) {
      const row = this.ctx.storage.sql
        .exec<{ op_id: string; status: string; result: string | null; payload_hash: string | null }>(
          "SELECT op_id, status, result, payload_hash FROM operations WHERE agent_id = ? AND idem_key = ? AND created_at > ?",
          actor.agentId,
          key,
          Date.now() - OPERATION_TTL_MS,
        )
        .toArray()[0];
      if (row) {
        const stored = row.status === "done" && row.result ? (JSON.parse(row.result) as ApiResult) : null;
        // A key that wrote something, or is still writing, belongs to its payload. A failed attempt
        // wrote nothing, so its key may be retried with a corrected payload.
        const bound = row.status === "pending" || Boolean(stored?.ok);
        if (bound && row.payload_hash && hash && row.payload_hash !== hash) return failure(keyReused());
        if (stored?.ok) return stored;
        const running = this.inflight.get(row.op_id);
        if (row.status === "pending" && running) return this.withTimeout(row.op_id, running);
        return this.launch(row.op_id, op, actor.agentId, key, hash);
      }
    }
    return this.launch(operationId ?? ulid(), op, actor.agentId, key, hash);
  }

  // RPC: a result stored for a write that answered 202. Only the writing agent or the admin token can read it.
  async getOperation(id: string, agentId: string, admin: boolean): Promise<ApiResult> {
    const row = this.ctx.storage.sql
      .exec<{ op_id: string; agent_id: string; status: string; result: string | null; kind: string }>(
        "SELECT op_id, agent_id, status, result, kind FROM operations WHERE op_id = ? AND created_at > ?",
        id,
        Date.now() - OPERATION_TTL_MS,
      )
      .toArray()[0];
    if (!row || (!admin && row.agent_id !== agentId)) return failure(new VaultError("not_found", "Operation not found"));
    if (row.status !== "done" || !row.result) return { ok: true, data: { operation_id: row.op_id, kind: row.kind, status: "pending" } };
    const stored = JSON.parse(row.result) as ApiResult;
    if (stored.ok) {
      return { ok: true, data: { operation_id: row.op_id, kind: row.kind, status: "done", http_status: stored.status ?? 200, result: stored.data, error: null } };
    }
    return {
      ok: true,
      data: { operation_id: row.op_id, kind: row.kind, status: "done", http_status: ERROR_STATUS[stored.error.code] ?? 400, result: null, error: stored.error as JsonValue },
    };
  }

  async replayPending(): Promise<{ replayed: number; dropped: number }> {
    return this.serialize(() => this.replayIntents());
  }

  // RPC: start a paged job. One job runs at a time. The alarm drives it one page per lock hold.
  async startJob(request: JobRequest): Promise<ApiResult> {
    configure(this.env);
    const refuse = async (error: VaultError): Promise<ApiResult> => {
      if (request.source === "cron") {
        await this.audit(request.actor, `${jobAuditName(request.kind)}_skipped`, null, null, "skipped", [error.code], null, 0, JSON.stringify({ source: "cron", ...error.extra }));
      }
      return failure(error);
    };
    const running = this.activeJob();
    if (running) return refuse(jobRunning(running.id));
    const kind = request.kind;
    // Until the quarantine migration has run, nothing that rebuilds rows from R2 may start while
    // quarantine records exist, so a quarantined note can never come back as active.
    if ((kind === "rebuild" || kind === "reindex" || kind === "reconcile") && !this.erasedAt() && (await this.quarantineRecordsExist())) {
      return refuse(new VaultError("migration_required", "Quarantine records exist. Run POST /v1/admin/migrations/quarantine-erase first.", ["quarantine_erase"]));
    }
    const dryRun = kind === "quarantine-erase" ? request.dryRun === true : false;
    // A dry run is allowed anywhere. On production the erase itself runs only when confirm_count is
    // the count a dry run reports (counts.total), so a person has seen it first. Both refusals carry
    // the actual count.
    if (kind === "quarantine-erase" && !dryRun && isProductionDeploy(this.env)) {
      const count = await this.quarantineCount();
      if (request.confirmCount === null || request.confirmCount === undefined) {
        return failure(
          new VaultError("invalid", "confirm_count is required on production. Run a dry run and confirm its counts.total.", ["confirm_count_required"], { actual_count: count }),
        );
      }
      if (request.confirmCount !== count) {
        return failure(
          new VaultError("confirm_count_mismatch", "confirm_count does not match the current quarantine count. Run a dry run and confirm its counts.total.", [], {
            actual_count: count,
          }),
        );
      }
    }
    const again = this.activeJob();
    if (again) return failure(jobRunning(again.id));
    const now = new Date();
    const job: Job = {
      id: ulid(),
      kind,
      status: "queued",
      phase: "start",
      cursor: null,
      gen: 0,
      dry_run: dryRun,
      started_ms: Date.now(),
      counts: {},
      errors: [],
      error: null,
      pages: 0,
      attempts: 0,
      actor: request.actor,
      created_at: now.toISOString(),
      started_at: null,
      finished_at: null,
      report: { note_ids: [], paths: [] },
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs (id, kind, status, body, created_at) VALUES (?, ?, ?, ?, ?)",
      job.id,
      job.kind,
      job.status,
      JSON.stringify(job),
      now.getTime(),
    );
    await this.audit(job.actor, `${jobAuditName(kind)}_started`, null, null, "ok", [], null, 0, JSON.stringify({ job_id: job.id, kind, dry_run: dryRun, source: request.source ?? "api" }));
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true, status: 202, data: { job_id: job.id, kind, status: "queued" } };
  }

  async getJob(id: string): Promise<ApiResult> {
    const job = this.loadJob(id);
    if (!job) return failure(new VaultError("not_found", "Job not found"));
    return { ok: true, data: jobView(job) };
  }

  // The admin-only report of a job: the note ids and paths it matched. GET /v1/admin/jobs/:id omits them.
  async jobReport(id: string): Promise<ApiResult> {
    const job = this.loadJob(id);
    if (!job) return failure(new VaultError("not_found", "Job not found"));
    return { ok: true, data: { job_id: job.id, kind: job.kind, status: job.status, note_ids: job.report.note_ids, paths: job.report.paths } };
  }

  async alarm(): Promise<void> {
    configure(this.env);
    await this.serialize(() => this.replayIntents());
    this.ctx.storage.sql.exec("DELETE FROM operations WHERE created_at < ?", Date.now() - OPERATION_TTL_MS);
    const job = this.activeJob();
    if (job) await this.serialize(() => this.jobStep(job.id));
    const next = this.activeJob();
    await this.ctx.storage.setAlarm(next ? Date.now() + next.attempts * 1000 : Date.now() + 60_000);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private launch(opId: string, op: WriterOp, agentId: string, key: string | null, hash: string | null): Promise<ApiResult> {
    if (key) this.ctx.storage.sql.exec("DELETE FROM operations WHERE agent_id = ? AND idem_key = ? AND op_id != ?", agentId, key, opId);
    this.ctx.storage.sql.exec(
      `INSERT INTO operations (op_id, agent_id, idem_key, kind, status, result, created_at, finished_at, payload_hash) VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)
       ON CONFLICT(op_id) DO UPDATE SET status = 'pending', result = NULL, finished_at = NULL, payload_hash = excluded.payload_hash`,
      opId,
      agentId,
      key,
      op.kind,
      Date.now(),
      hash,
    );
    const run = this.serialize(() => this.dispatch(op));
    this.inflight.set(opId, run);
    void run.then((result) => {
      this.inflight.delete(opId);
      this.ctx.storage.sql.exec("UPDATE operations SET status = 'done', result = ?, finished_at = ? WHERE op_id = ?", JSON.stringify(result), Date.now(), opId);
    });
    return this.withTimeout(opId, run);
  }

  private withTimeout(opId: string, run: Promise<ApiResult>): Promise<ApiResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: true, status: 202, data: { pending: true, operation_id: opId } }), writeTimeoutMs(this.env));
      void run.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private async dispatch(op: WriterOp): Promise<ApiResult> {
    try {
      return await this.run(op);
    } catch (err) {
      if (err instanceof VaultError) return failure(err);
      logEvent({ event: "writer_failed", name: err instanceof Error ? err.name : "error" });
      return { ok: false, error: { code: "invalid", message: "Write failed", reasons: [] } };
    }
  }

  private async run(op: WriterOp): Promise<ApiResult> {
    switch (op.kind) {
      case "fact":
        return this.fact(op);
      case "journal":
        return this.journal(op);
      case "note":
        return this.note(op);
      case "forget":
        return this.forget(op);
      case "restore":
        return this.restore(op);
      case "purge":
        return this.purge(op.id, op.path, op.actor, true, "purge");
      case "bootstrap":
        return this.bootstrap(op);
      case "external":
        return this.external(op);
      case "replay":
        return this.replayIntents().then((data) => ({ ok: true as const, data }));
      case "cleanup":
        return this.cleanup(op);
      default:
        return failure(new VaultError("invalid", "Unknown write"));
    }
  }

  private async fact(op: Extract<WriterOp, { kind: "fact" }>): Promise<ApiResult> {
    const idem: Idem = { key: op.idempotencyKey, hash: op.payloadHash };
    const replay = await this.replay(op.actor.agentId, idem);
    if (replay) return replay;
    const owner = op.scope === "shared" ? "shared" : op.actor.agentId;
    const basePath = factPath(op.actor.agentId, op.scope, op.key);
    const active = await this.noteByOwnerKey(owner, op.key);
    const activeSegment = active ? sensitiveSegment(active.path) : null;
    let route = op.reroute;
    if (activeSegment) {
      // A fact that already lives in a sensitive folder stays there, and updating it needs write access to that folder.
      if (!grantsAllow(op.grants, activeSegment)) throw new VaultError("forbidden_scope", "Scope does not allow this write");
      route = activeSegment;
    }
    const path = active && (activeSegment || !route) ? active.path : route ? reroutedPath(route, basePath) : basePath;
    // A neutral active fact that receives sensitive text moves: the shared path is tombstoned and the
    // fact continues under a new id in the sensitive folder.
    const moving = Boolean(route && active && !activeSegment);
    await this.assertNotOversize(path);
    let existing = moving ? await this.noteByPath(path) : active;
    // A forgotten fact's key and path can be used again: the new fact gets a new id (F24). The
    // forgotten row is released only right before the new fact is saved, once every check passed.
    let releasable: NoteRow | null = null;
    if (moving && existing?.status === "forgotten") {
      releasable = existing;
      existing = null;
    }
    if (!active) {
      const atPath = await this.noteByPath(path);
      if (atPath?.status === "forgotten") releasable = atPath;
      else if (atPath) throw new VaultError("conflict_etag", `Cannot write to a ${atPath.status} note`, [atPath.status]);
    }
    if (moving && existing && existing.status !== "active" && existing.status !== "superseded") {
      throw new VaultError("conflict_etag", `Cannot write to a ${existing.status} note`, [existing.status]);
    }
    // An update keeps the stored domain and sensitivity: it cannot drop a tag or lower them, and the
    // caller must be allowed to write the fact as it is stored.
    const kept = active && !moving && !route ? keepClass(op.access, active, op.domain) : null;
    const domain = route ? (route === RESTRICTED ? null : route) : (kept?.domain ?? op.domain);
    const sensitivity = route || kept?.sensitivity === "sensitive" ? "sensitive" : "normal";
    const rerouted = rerouteFields(route);
    const status = route ? 201 : 200;
    const statementHash = await sha256Hex(normalizeStatement(op.statement));
    if (active && !moving && active.statement_hash === statementHash) {
      await this.env.DB.prepare("UPDATE notes SET last_confirmed_at = ? WHERE id = ?").bind(new Date().toISOString(), active.id).run();
      const data = { id: active.id, path: active.path, outcome: "deduped", etag: active.r2_etag, ...rerouted };
      await this.remember(op.actor.agentId, idem, data, status);
      return withStatus(data, status);
    }
    // Tie-break is (observed_at, server written_at). Equal observed_at lets the incoming write win:
    // the Durable Object serializes writes, so this call is the later server write.
    const incomingNewer = !active?.observed_at || Date.parse(op.observedAt) >= Date.parse(active.observed_at);
    const crossBot = Boolean(active && active.last_writer !== op.actor.agentId);
    // The owner's own write (the admin token, e.g. a correction from the console) settles the fact.
    // It is not a second opinion, so it never opens a conflict.
    const conflict = Boolean(!op.access.admin && active && crossBot && within24h(active.observed_at, op.observedAt) && active.statement_hash !== statementHash);
    const now = new Date().toISOString();
    const facts = {
      key: op.key,
      owner,
      statement: op.statement,
      domain,
      sensitivity,
      observedAt: op.observedAt,
      confidence: op.confidence,
      tags: op.tags,
      links: op.links,
      source: op.actor.agentId,
      idem,
      rerouted: Boolean(route),
    };
    if (moving && !incomingNewer) {
      // The newer neutral fact stays active. The older sensitive observation is kept in the sensitive
      // folder as superseded, never in the neutral fact's history.
      const id = existing?.id ?? ulid();
      const createdAt = existing ? createdAtOf(existing) : now;
      const markdown = this.factMarkdown({ ...facts, id, status: "superseded", supersedes: null, outcome: "superseded_older", createdAt });
      if (releasable) await this.releaseForgotten(releasable);
      const saved = await this.saveMarkdown({
        ...factSave(id, path, markdown, facts, statementHash, op.actor),
        ifMatch: existing?.r2_etag ?? null,
        create: !existing,
        reason: existing ? "updated" : "created",
        action: "reroute",
        detail: rerouteDetail(basePath, route!),
        createdAt,
        remember: rememberFor(idem, 201, (etag) => ({ id, path, outcome: "superseded_older", etag, ...rerouted })),
      });
      if (!saved.ok) return saved;
      return withStatus({ id, path, outcome: "superseded_older", etag: saved.data.etag, ...rerouted }, 201);
    }
    if (active && !moving && !incomingNewer) {
      const loserOutcome = conflict ? "conflict_flagged" : "superseded_older";
      const loser = this.factMarkdown({ ...facts, id: active.id, status: "active", supersedes: null, outcome: loserOutcome, createdAt: createdAtOf(active) });
      const loserTs = await this.snapshotBytes(active, loser, op.actor.agentId, "superseded");
      if (conflict) await this.flagConflict(op.key, active.id, loserTs, op.actor, op.observedAt, active.observed_at);
      const data = { id: active.id, path: active.path, outcome: loserOutcome, etag: active.r2_etag, ...rerouted };
      await this.remember(op.actor.agentId, idem, data, status);
      await this.audit(op.actor, "write_fact", active.path, active.id, "ok", [], await this.auditHash(loser), utf8Length(loser));
      return withStatus(data, status);
    }
    const id = existing?.id ?? ulid();
    const outcome = conflict ? "conflict_flagged" : moving ? "moved" : existing ? "updated" : "created";
    const createdAt = existing ? createdAtOf(existing) : now;
    const markdown = this.factMarkdown({ ...facts, id, status: "active", supersedes: existing?.version_ts ?? null, outcome, createdAt });
    // A moving fact is saved without its key, the old fact is retired, and then the new one takes
    // the key, so the unique (owner, fact_key) index never sees two active rows.
    if (releasable) await this.releaseForgotten(releasable);
    const saved = await this.saveMarkdown({
      ...factSave(id, path, markdown, facts, statementHash, op.actor),
      factKey: moving ? null : op.key,
      ifMatch: existing?.r2_etag ?? null,
      create: !existing,
      reason: existing ? "updated" : "created",
      action: route ? "reroute" : "write_fact",
      detail: route ? rerouteDetail(basePath, route) : null,
      createdAt,
      remember: rememberFor(idem, status, (etag) => ({ id, path, outcome, etag, ...rerouted })),
    });
    if (!saved.ok) return saved;
    if (moving && active) {
      await this.retireMoved(active, path, op.actor, true);
      await this.env.DB.prepare("UPDATE notes SET fact_key = ? WHERE id = ?").bind(op.key, id).run();
    }
    if (conflict && active) await this.flagConflict(op.key, id, active.version_ts ?? active.id, op.actor, op.observedAt, active.observed_at);
    if (op.scope === "shared" || moving) await this.refreshSummary(op.actor);
    return withStatus({ id, path, outcome, etag: saved.data.etag, ...rerouted }, status);
  }

  private factMarkdown(input: {
    id: string;
    owner: string;
    key: string;
    statement: string;
    domain: string | null;
    sensitivity: string;
    observedAt: string;
    confidence: number;
    tags: string[];
    links: string[];
    source: string;
    idem: Idem;
    rerouted: boolean;
    outcome: string;
    createdAt: string;
    status: string;
    supersedes: string | null;
  }): string {
    const now = new Date().toISOString();
    const linkLine = input.links.map((link) => `[[${link}]]`).join(" ");
    const body = linkLine ? `${input.statement}\n\n${linkLine}` : input.statement;
    return buildMarkdown(
      {
        vault_id: input.id,
        type: "fact",
        key: input.key,
        owner: input.owner,
        domain: input.domain,
        sensitivity: input.sensitivity,
        observed_at: input.observedAt,
        updated_at: now,
        source: input.source,
        confidence: input.confidence,
        status: input.status,
        tags: input.tags,
        supersedes: input.supersedes,
        vault_created_at: input.createdAt,
        ...idempotencyFields(input.idem, input.outcome, input.rerouted),
      },
      body,
    );
  }

  private async journal(op: Extract<WriterOp, { kind: "journal" }>): Promise<ApiResult> {
    const idem: Idem = { key: op.idempotencyKey, hash: op.payloadHash };
    const replay = await this.replay(op.actor.agentId, idem);
    if (replay) return replay;
    const stamp = etStamp(op.at, vaultTimeZone(this.env));
    const route = op.reroute;
    // A rerouted entry goes to a sensitive day file of the writer's: PII alone to its own
    // bots/<writer>/journal-sensitive/, one domain to sensitive/<d>/journal/<writer>/, anything else
    // to sensitive/restricted/journal/<writer>/. The requested day file gets no entry and no placeholder.
    const requested = journalPath(op.actor.agentId, op.target, stamp.date);
    const path = route ? sensitiveJournalPath(route, op.actor.agentId, stamp.date) : requested;
    await this.assertNotOversize(path);
    const decisions = !route && op.target === "decisions";
    const type = decisions ? "decision" : "journal";
    const owner = route || op.target === "own" ? op.actor.agentId : "shared";
    // A day file holds many entries, so it never takes an entry's ordinary domain: a tag on one
    // entry must not change who can read the file. Only a rerouted file carries its sensitive domain.
    const domain = route && route !== RESTRICTED && route !== PII_ROUTE ? route : null;
    const sensitivity = route ? "sensitive" : "normal";
    const status = route ? 201 : 200;
    const entryId = ulid();
    const body = guardJournalBody(op.body).trim();
    const mac = await journalMac(this.env, entryId, op.actor.agentId, op.title, body);
    const idemMarker = idem.key ? await journalIdempotencyMarker(this.env, entryId, op.actor.agentId, idem.key, idem.hash) : "";
    let attempt = 0;
    while (attempt < 3) {
      attempt += 1;
      let current = await this.noteByPath(path);
      // A day file the admin forgot starts over as a new file under a new id.
      let releasable: NoteRow | null = null;
      if (current?.status === "forgotten") {
        releasable = current;
        current = null;
      }
      if (current && current.status !== "active") {
        throw new VaultError("conflict_etag", `Cannot append to a ${current.status} note`, [current.status]);
      }
      const previous = current?.body ?? "";
      const entry = [
        `## ${stamp.heading} · ${op.actor.agentId} · ${op.title} ^${entryId}`,
        body,
        op.tags.length ? `Tags: ${op.tags.join(", ")}` : "",
        `<!-- hiveattic:e=${entryId}:${op.actor.agentId}:${mac} -->`,
        idemMarker,
      ]
        .filter(Boolean)
        .join("\n");
      const markdown = current
        ? `${previous.endsWith("\n") ? previous : `${previous}\n`}\n${entry}\n`
        : buildMarkdown(
            {
              vault_id: ulid(),
              type,
              owner,
              status: "active",
              source: op.actor.agentId,
              created_at: stamp.iso,
              updated_at: stamp.iso,
              sensitivity,
              domain,
            },
            `${decisions ? "# Decisions\n\n" : `# ${stamp.date}\n\n`}${entry}\n`,
          );
      if (current && !markdown.startsWith(previous)) throw new VaultError("invalid", "Journal append would rewrite earlier entries");
      const id = current?.id ?? stringField(parseMarkdown(markdown).frontmatter.vault_id) ?? ulid();
      if (releasable) await this.releaseForgotten(releasable);
      const saved = await this.saveMarkdown({
        id,
        path,
        markdown,
        type,
        owner,
        domain,
        sensitivity,
        factKey: null,
        title: current?.title ?? (decisions ? "Decisions" : stamp.date),
        statementHash: null,
        observedAt: stamp.iso,
        actor: op.actor,
        ifMatch: current?.r2_etag ?? null,
        create: !current,
        reason: current ? "appended" : "created",
        action: route ? "journal_reroute" : "append_journal",
        detail: route ? rerouteDetail(requested, route) : null,
        journal: { id: entryId, title: op.title, at: stamp.iso, idempotencyKey: op.idempotencyKey },
        // The reply names the entry, not the day file's etag, so a rebuild can restore it exactly.
        remember: rememberFor(idem, status, () => journalReply(entryId, path, route)),
        allowRetry: true,
      });
      if (saved.ok) return withStatus(journalReply(entryId, path, route), status);
      if (saved.error.code !== "conflict_etag" || attempt === 3) return saved;
      // The object changed outside the API. D1 cannot catch up by itself inside this call, so the
      // file is read from R2 and indexed before the next attempt.
      await this.refreshFromR2(path, op.actor);
    }
    return failure(new VaultError("conflict_etag", "Journal changed while appending"));
  }

  private async note(op: Extract<WriterOp, { kind: "note" }>): Promise<ApiResult> {
    if (isAppendOnlyPath(op.path) || isFactPath(op.path) || op.path === "profile/summary.md") {
      throw new VaultError("invalid", "That path is append-only or server-managed");
    }
    const idem: Idem = { key: op.idempotencyKey, hash: op.payloadHash };
    const replay = await this.replay(op.actor.agentId, idem);
    if (replay) return replay;
    const route = op.reroute;
    const path = route ? reroutedPath(route, op.path) : op.path;
    await this.assertNotOversize(path);
    // A forgotten note's path can be written again under a new id (F24). A forgotten note at the
    // requested path of a rerouted write is not moved: it is already gone.
    let original = route ? await this.noteByPath(op.path) : null;
    if (original?.status === "forgotten") original = null;
    let existing = await this.noteByPath(path);
    let releasable: NoteRow | null = null;
    if (existing?.status === "forgotten") {
      releasable = existing;
      existing = null;
    }
    if (original && original.status !== "active") {
      throw new VaultError("conflict_etag", `Cannot write to a ${original.status} note`, [original.status]);
    }
    if (existing && existing.status !== "active") {
      throw new VaultError("conflict_etag", `Cannot write to a ${existing.status} note`, [existing.status]);
    }
    const moving = Boolean(route && original);
    if (moving) {
      // An update that adds sensitive text moves the note. The caller's if_match is for the note it named.
      if (normalizeEtag(op.ifMatch) !== normalizeEtag(original!.r2_etag)) throw new VaultError("conflict_etag", "if_match does not match the current etag");
      if (existing) throw new VaultError("conflict_etag", "if_match does not match the current etag");
    } else if (existing) {
      // Updating a note that was rerouted needs write access to its sensitive folder.
      if (route && !grantsAllow(op.grants, route)) throw new VaultError("forbidden_scope", "Scope does not allow this write");
      if (normalizeEtag(op.ifMatch) !== normalizeEtag(existing.r2_etag)) throw new VaultError("conflict_etag", "if_match does not match the current etag");
    }
    const id = existing?.id ?? ulid();
    const now = new Date().toISOString();
    // An update keeps the stored domain and sensitivity: it cannot drop a tag or lower them, and the
    // caller must be allowed to write the note as it is stored.
    const kept = existing && !route ? keepClass(op.access, existing, op.domain) : null;
    const domain = route ? (route === RESTRICTED ? null : route) : (kept?.domain ?? op.domain);
    const sensitivity = route || kept?.sensitivity === "sensitive" ? "sensitive" : op.sensitivity;
    const createdAt = existing ? createdAtOf(existing) : now;
    const outcome = moving ? "moved" : existing ? "updated" : "created";
    if (releasable) await this.releaseForgotten(releasable);
    const markdown = buildMarkdown(
      {
        ...stripReserved(op.extra),
        vault_id: id,
        type: op.noteType,
        owner: ownerForPath(path),
        domain,
        sensitivity,
        status: "active",
        source: op.actor.agentId,
        created_at: createdAt,
        updated_at: now,
        tags: stringList(op.extra.tags),
        aliases: stringList(op.extra.aliases),
        vault_created_at: createdAt,
        ...idempotencyFields(idem, outcome, Boolean(route)),
      },
      op.body,
    );
    const rerouted = rerouteFields(route);
    const status = route ? 201 : 200;
    const saved = await this.saveMarkdown({
      id,
      path,
      markdown,
      type: op.noteType,
      owner: ownerForPath(path),
      domain,
      sensitivity,
      factKey: null,
      title: stringField(op.extra.title) ?? titleFromBody(op.body, path),
      statementHash: null,
      observedAt: stringField(op.extra.observed_at) ?? now,
      actor: op.actor,
      ifMatch: existing?.r2_etag ?? null,
      create: !existing,
      reason: existing ? "updated" : "created",
      action: route ? "reroute" : "write_note",
      detail: route ? rerouteDetail(op.path, route) : null,
      journal: null,
      createdAt,
      remember: rememberFor(idem, status, (etag) => ({ id, path, etag, outcome, ...rerouted })),
    });
    if (!saved.ok) return saved;
    if (moving) await this.retireMoved(original!, path, op.actor, true);
    return withStatus({ id, path, etag: saved.data.etag, outcome, ...rerouted }, status);
  }

  private async forget(op: Extract<WriterOp, { kind: "forget" }>): Promise<ApiResult> {
    const idem: Idem = { key: op.idempotencyKey, hash: op.payloadHash };
    const replay = await this.replay(op.actor.agentId, idem);
    if (replay) return replay;
    const note = await this.resolveNote(op.id, op.path);
    if (!note) throw new VaultError("not_found", "Note not found");
    // Authorize against the resolved note, never the caller-supplied path.
    if (!canWrite(op.access, note.path, noteSensitivity(note), note.domain)) {
      throw new VaultError("forbidden_scope", "Scope does not allow this write");
    }
    if (op.path && note.path !== op.path) throw new VaultError("invalid", "path and id refer to different notes");
    // A quarantined note is the quarantine erase's to remove, with its history.
    if (note.status === "quarantined") throw new VaultError("conflict_etag", "Cannot forget a quarantined note", ["quarantined"]);
    if (note.status === "forgotten") {
      const data = { id: note.id, path: note.path, status: "forgotten" };
      await this.remember(op.actor.agentId, idem, data, 200);
      return { ok: true, data };
    }
    const chunkIds = await this.chunkIds(note.id);
    const now = new Date().toISOString();
    // The stub carries no caller text. The reason stays in the tombstone row, which only the admin
    // reads. A keyed forget leaves its key and payload hash in the stub, so a rebuild restores it.
    const stub = forgottenStub(note, etStamp(now, vaultTimeZone(this.env)).date, idem.key ? { by: op.actor.agentId, at: now, idem } : null);
    await this.snapshotIfUnversioned(note, op.actor.agentId);
    const hash = await sha256Hex(stub);
    const intentId = ulid();
    this.ctx.storage.sql.exec(
      "INSERT INTO write_intents (op_id, path, prev_etag, new_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      intentId,
      note.path,
      note.r2_etag,
      hash,
      now,
    );
    const etag = await this.putVault(note.path, stub, note.id, note.r2_etag);
    if (!etag) {
      this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", intentId);
      throw new VaultError("conflict_etag", "Note changed while forgetting");
    }
    const data = { id: note.id, path: note.path, status: "forgotten" };
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE notes SET body = ?, frontmatter = ?, content_hash = ?, status = 'forgotten', r2_etag = ?, updated_at = ?, version_ts = ?, last_writer = ?, index_gen = ?
         WHERE id = ?`,
      ).bind(stub, JSON.stringify(parseMarkdown(stub).frontmatter), hash, etag.etag, now, etag.versionTs, op.actor.agentId, this.gen(), note.id),
      this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ?").bind(note.id),
      this.env.DB.prepare(
        `INSERT INTO tombstones (note_id, at, by_agent, reason, content_hash, path) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET at = excluded.at, reason = excluded.reason, content_hash = excluded.content_hash`,
      ).bind(note.id, now, op.actor.agentId, op.reason, (await this.auditHash(note.body)) ?? note.content_hash, note.path),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO note_versions (note_id, version_ts, r2_key, content_hash, writer, reason) VALUES (?, ?, ?, ?, ?, 'forgotten')`,
      ).bind(note.id, etag.versionTs, await this.historyCopy(note.id, etag.versionTs, hash, stub), hash, op.actor.agentId),
      ...this.vectorDeletes(chunkIds, note.id, now),
      ...this.rememberStatements(op.actor.agentId, idem, data, 200),
    ]);
    this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", intentId);
    await this.audit(op.actor, "forget", note.path, note.id, "ok", [], await this.auditHash(stub), utf8Length(stub));
    await this.enqueue({ kind: "forget", note_id: note.id, chunk_ids: chunkIds });
    await this.refreshSummaryAfter(note, op.actor);
    return { ok: true, data };
  }

  private async restore(op: Extract<WriterOp, { kind: "restore" }>): Promise<ApiResult> {
    const note = await this.resolveNote(op.id, op.path);
    if (!note) throw new VaultError("not_found", "Note not found");
    if (note.status === "quarantined") throw new VaultError("conflict_etag", "Cannot restore a quarantined note", ["quarantined"]);
    const version = await this.env.DB.prepare(
      "SELECT r2_key, content_hash, version_ts FROM note_versions WHERE note_id = ? AND version_ts = ?",
    )
      .bind(note.id, op.versionTs)
      .first<{ r2_key: string; content_hash: string; version_ts: string }>();
    if (!version) throw new VaultError("not_found", "Version not found");
    // A version row from before F15 can point at the live object, which holds the current text, not
    // that version's. Restoring it would change nothing, so it is refused.
    if (!version.r2_key.startsWith("sys/history/")) throw new VaultError("invalid", "That version has no stored copy to restore", ["not_a_snapshot"]);
    const object = await this.env.VAULT.get(version.r2_key);
    if (!object) throw new VaultError("not_found", "Version object not found");
    const markdown = await object.text();
    const saved = await this.saveMarkdown({
      id: note.id,
      path: note.path,
      markdown,
      type: note.type,
      owner: note.owner,
      domain: note.domain,
      sensitivity: note.sensitivity === "sensitive" ? "sensitive" : "normal",
      factKey: note.fact_key,
      title: note.title ?? note.path,
      statementHash: note.statement_hash,
      observedAt: note.observed_at,
      actor: op.actor,
      ifMatch: note.r2_etag,
      create: false,
      reason: "restore",
      action: "restore",
      journal: null,
    });
    if (!saved.ok) return saved;
    return { ok: true, data: { id: note.id, path: note.path, etag: saved.data.etag, restored_version: op.versionTs } };
  }

  private async bootstrap(op: Extract<WriterOp, { kind: "bootstrap" }>): Promise<ApiResult> {
    const created: string[] = [];
    for (const file of op.files) {
      const key = r2KeyFor(this.prefix(), file.path);
      const existing = await this.env.VAULT.head(key);
      if (existing) continue;
      const id = ulid();
      const current = parseMarkdown(file.markdown);
      const markdown = buildMarkdown(
        { ...current.frontmatter, vault_id: id, type: inferType(file.path), owner: ownerForPath(file.path), status: "active", vault_created_at: new Date().toISOString() },
        current.body,
      );
      const put = await this.putVault(file.path, markdown, id, null);
      if (!put) throw new VaultError("conflict_etag", "Bootstrap object already exists");
      await this.indexBytes({ path: file.path, markdown, etag: put.etag, actor: op.actor, action: "bootstrap", reason: "created", metaId: id });
      created.push(file.path);
    }
    return { ok: true, data: { created } };
  }

  private async external(op: Extract<WriterOp, { kind: "external" }>): Promise<ApiResult> {
    const prefix = this.prefix();
    const path = vaultPathFromKey(prefix, op.key);
    if (!path || !path.endsWith(".md")) return { ok: true, data: { skipped: true, reason: "outside_vault" } };
    const actor: Actor = { agentId: "external", tokenId: "external", client: "r2-event", requestId: ulid(), ipCountry: null };
    const detail = JSON.stringify({ eventTime: op.eventTime ?? null, eTag: op.eTag ?? null, copySource: op.copySource ?? null, action: op.action });
    const deleting = op.action === "DeleteObject" || op.action === "LifecycleDeletion";
    const copying = op.action === "CopyObject" || Boolean(op.copySource);
    const actionName = deleting ? "external_delete" : copying ? "external_copy" : "external_put";
    if (deleting) {
      // A delete event can arrive after the key was written again. Only a key that is gone now is forgotten.
      if (await this.env.VAULT.head(op.key)) return { ok: true, data: { skipped: true, reason: "recreated" } };
      await this.clearOversize(path);
      return this.externalDelete(path, actor, detail);
    }
    if (op.copySource) {
      const source = copySourceVaultPath(op.copySource, prefix, this.env.VAULT_BUCKET || "");
      if (source && source !== path) {
        const sourceObject = await this.env.VAULT.head(r2KeyFor(prefix, source));
        if (!sourceObject) await this.externalDelete(source, actor, detail);
      }
    }
    const object = await this.env.VAULT.get(op.key);
    if (!object) return { ok: true, data: { skipped: true, reason: "missing_object" } };
    const note = await this.noteByPath(path);
    const objectEtag = normalizeEtag(object.etag);
    const metaId = object.customMetadata?.["vault-id"] ?? "";
    if (note && objectEtag && objectEtag === normalizeEtag(note.r2_etag) && metaId === note.id) {
      await object.body?.cancel();
      return { ok: true, data: { skipped: true, reason: "unchanged" } };
    }
    if (object.size > FILE_LIMIT_BYTES) {
      await object.body?.cancel();
      if (note?.status === "quarantined") return { ok: true, data: { skipped: true, reason: "quarantined" } };
      await this.markOversize(path, object.size, objectEtag, actor, detail);
      return { ok: true, data: { skipped: true, reason: "oversize" } };
    }
    const markdown = await object.text();
    return this.indexBytes({ path, markdown, etag: objectEtag, actor, action: actionName, reason: "external-edit", detail, metaId: metaId || null });
  }

  // An outside delete forgets the note like the API does: the D1 body becomes a stub, so no reader
  // gets the old text back. The last indexed body is kept in history for the admin token.
  private async externalDelete(path: string, actor: Actor, detail: string): Promise<ApiResult> {
    const note = await this.noteByPath(path);
    if (!note) return { ok: true, data: { skipped: true, reason: "unknown_delete" } };
    if (note.status === "forgotten") return { ok: true, data: { id: note.id, path, status: "forgotten" } };
    // A quarantined row is left for the quarantine erase, which removes its history and records too.
    if (note.status === "quarantined") return { ok: true, data: { skipped: true, reason: "quarantined" } };
    const chunkIds = await this.chunkIds(note.id);
    const now = new Date().toISOString();
    await this.snapshotIfUnversioned(note, actor.agentId);
    const stub = forgottenStub(note, etStamp(now, vaultTimeZone(this.env)).date);
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE notes SET status = 'forgotten', body = ?, frontmatter = ?, content_hash = ?, r2_etag = NULL, updated_at = ?, last_writer = ?, index_gen = ? WHERE id = ?`,
      ).bind(stub, JSON.stringify(parseMarkdown(stub).frontmatter), await sha256Hex(stub), now, actor.agentId, this.gen(), note.id),
      this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM note_versions WHERE note_id = ? AND r2_key = ?").bind(note.id, note.r2_key),
      this.env.DB.prepare(
        `INSERT INTO tombstones (note_id, at, by_agent, reason, content_hash, path) VALUES (?, ?, ?, 'external_delete', ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET at = excluded.at, reason = excluded.reason`,
      ).bind(note.id, now, actor.agentId, (await this.auditHash(note.body)) ?? note.content_hash, path),
      ...this.vectorDeletes(chunkIds, note.id, now),
    ]);
    await this.audit(actor, "external_delete", path, note.id, "ok", [], await this.auditHash(note.body), 0, detail);
    await this.refreshSummaryAfter(note, actor);
    return { ok: true, data: { id: note.id, path, status: "forgotten" } };
  }

  // A stored file at a non-sensitive path whose text classifies as sensitive moves to the
  // sensitive folder before anything indexes it at the requested path: the new object is
  // written, the old object is deleted, and the old path gets a tombstone that only the admin
  // can follow.
  private async moveStoredFile(input: {
    path: string;
    markdown: string;
    etag: string | null;
    route: string;
    actor: Actor;
    action: string;
    detail?: string | null;
  }): Promise<ApiResult> {
    const target = reroutedPath(input.route, input.path);
    const source = await this.noteByPath(input.path);
    const atTarget = await this.noteByPath(target);
    const parsed = parseMarkdown(input.markdown);
    const fm = parsed.frontmatter;
    const fileId = stringField(fm.vault_id) ?? null;
    let id = atTarget?.id ?? null;
    if (!id && !source && fileId) {
      const clash = await this.env.DB.prepare("SELECT path FROM notes WHERE id = ?").bind(fileId).first<{ path: string }>();
      if (!clash) id = fileId;
    }
    id ??= ulid();
    const domain = input.route === RESTRICTED ? null : input.route;
    const type = stringField(fm.type) ?? inferType(input.path);
    const owner = ownerForPath(target);
    const markdown = buildMarkdown({ ...fm, vault_id: id, type, owner, status: "active", sensitivity: "sensitive", domain }, parsed.body);
    let ifMatch = atTarget?.r2_etag ?? null;
    if (!atTarget) {
      const orphan = await this.env.VAULT.head(r2KeyFor(this.prefix(), target));
      if (orphan) ifMatch = normalizeEtag(orphan.etag);
    }
    const again = parseMarkdown(markdown);
    const saved = await this.saveMarkdown({
      id,
      path: target,
      markdown,
      type,
      owner,
      domain,
      sensitivity: "sensitive",
      factKey: type === "fact" ? (stringField(fm.key) ?? null) : null,
      title: stringField(fm.key) ?? stringField(fm.title) ?? titleFromBody(again.body, target),
      statementHash: type === "fact" ? await sha256Hex(statementOnly(again.body)) : null,
      observedAt: stringField(fm.observed_at) ?? null,
      actor: input.actor,
      ifMatch,
      create: !atTarget,
      reason: atTarget ? "updated" : "created",
      action: "reroute_move",
      journal: null,
      detail: JSON.stringify({ requested_path: input.path, sensitive_domain: input.route, source_action: input.action }),
    });
    if (!saved.ok) return saved;
    if (type === "journal" || type === "decision") await restoreJournalMarkers(this.env, id, target, markdown, owner);
    if (source && source.status !== "forgotten") {
      await this.retireMoved(source, target, input.actor, false);
    } else if (!source) {
      await this.env.DB.prepare(
        `INSERT INTO tombstones (note_id, at, by_agent, reason, content_hash, moved_to, path) VALUES (?, ?, ?, 'removed', ?, ?, ?)`,
      )
        .bind(ulid(), new Date().toISOString(), input.actor.agentId, (await this.auditHash(input.markdown)) ?? (await sha256Hex(input.markdown)), target, input.path)
        .run();
    }
    const key = r2KeyFor(this.prefix(), input.path);
    const head = await this.env.VAULT.head(key);
    if (head && (!input.etag || normalizeEtag(head.etag) === normalizeEtag(input.etag))) await this.env.VAULT.delete(key);
    return { ok: true, data: { moved: true, path: target, requested_path: input.path, sensitive_domain: input.route } };
  }

  // Tombstones the path a note moved away from. Its history keeps only the earlier versions: the
  // last indexed body is snapshotted, and version rows that point at the live object are dropped,
  // because that object is now a stub or gone. Readers other than the admin get 404 at the old
  // path, and nothing they can read names the new one.
  private async retireMoved(note: NoteRow, target: string, actor: Actor, keepStub: boolean): Promise<void> {
    const now = new Date().toISOString();
    const chunkIds = await this.chunkIds(note.id);
    if (note.status === "active") await this.snapshotIfUnversioned(note, actor.agentId);
    const stub = forgottenStub(note, etStamp(now, vaultTimeZone(this.env)).date);
    let etag: string | null = null;
    if (keepStub) {
      const put = await this.putVault(note.path, stub, note.id, note.r2_etag);
      etag = put?.etag ?? null;
    }
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE notes SET body = ?, frontmatter = ?, content_hash = ?, status = 'forgotten', fact_key = NULL, r2_etag = ?, updated_at = ?, last_writer = ?, index_gen = ?
         WHERE id = ?`,
      ).bind(stub, JSON.stringify(parseMarkdown(stub).frontmatter), await sha256Hex(stub), etag, now, actor.agentId, this.gen(), note.id),
      this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM note_versions WHERE note_id = ? AND r2_key = ?").bind(note.id, note.r2_key),
      this.env.DB.prepare(
        `INSERT INTO tombstones (note_id, at, by_agent, reason, content_hash, moved_to, path) VALUES (?, ?, ?, 'removed', ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET at = excluded.at, reason = excluded.reason, moved_to = excluded.moved_to, path = excluded.path`,
      ).bind(note.id, now, actor.agentId, (await this.auditHash(note.body)) ?? note.content_hash, target, note.path),
      ...this.vectorDeletes(chunkIds, note.id, now),
    ]);
    await this.audit(actor, "reroute_tombstone", note.path, note.id, "ok", [], await this.auditHash(stub), utf8Length(stub));
    await this.enqueue({ kind: "forget", note_id: note.id, chunk_ids: chunkIds });
    await this.refreshSummaryAfter(note, actor);
  }

  private async cleanup(op: Extract<WriterOp, { kind: "cleanup" }>): Promise<ApiResult> {
    if (!this.cleanupAllowed()) throw new VaultError("not_found", "Route not found");
    if (!/^e2e[0-9a-f]{10}$/.test(op.runId)) throw new VaultError("invalid", "run_id is not a safe namespace");
    const like = `%${op.runId}%`;
    const rows = await this.env.DB.prepare(
      `SELECT id, path, body, owner, type, title, sensitivity, domain, r2_etag FROM notes
       WHERE path LIKE ? ESCAPE '\\' OR owner LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
          OR ifnull(last_writer, '') LIKE ? ESCAPE '\\'
          OR id IN (SELECT note_id FROM journal_entries WHERE agent_id LIKE ? ESCAPE '\\')`,
    )
      .bind(like, like, like, like, like)
      .all<CleanupNote>();
    let purged = 0;
    let rewritten = 0;
    for (const row of rows.results ?? []) {
      const owned = row.path.includes(op.runId) || row.owner.includes(op.runId);
      const stripped = owned ? null : stripRunContent(row.body, op.runId);
      if (owned || stripped?.empty) {
        await this.purge(row.id, row.path, op.actor, false, "purge");
        purged += 1;
        continue;
      }
      if (!stripped?.changed) continue;
      const sensitivity = row.sensitivity === "sensitive" ? "sensitive" : "normal";
      const saved = await this.saveMarkdown({
        id: row.id,
        path: row.path,
        markdown: stripped.markdown,
        type: row.type,
        owner: row.owner,
        domain: row.domain,
        sensitivity,
        factKey: null,
        title: row.title ?? titleFromBody(stripped.markdown, row.path),
        statementHash: null,
        observedAt: null,
        actor: op.actor,
        ifMatch: row.r2_etag,
        create: false,
        reason: "cleanup",
        action: "cleanup_rewrite",
        journal: null,
      });
      if (!saved.ok) return saved;
      rewritten += 1;
      await this.env.DB.prepare("DELETE FROM journal_entries WHERE note_id = ? AND (agent_id LIKE ? ESCAPE '\\' OR instr(?, id) = 0)")
        .bind(row.id, like, stripped.markdown)
        .run();
    }
    await this.env.DB.prepare("DELETE FROM journal_entries WHERE agent_id LIKE ? ESCAPE '\\'").bind(like).run();
    await this.env.DB.prepare("DELETE FROM idempotency WHERE agent_id LIKE ? ESCAPE '\\'").bind(like).run();
    await this.env.DB.prepare("DELETE FROM links WHERE target LIKE ? ESCAPE '\\'").bind(like).run();
    await this.env.DB.prepare("DELETE FROM conflicts WHERE fact_key LIKE ? ESCAPE '\\'").bind(like).run();
    await this.env.DB.prepare("DELETE FROM tombstones WHERE path LIKE ? ESCAPE '\\' OR moved_to LIKE ? ESCAPE '\\'").bind(like, like).run();
    this.ctx.storage.sql.exec("DELETE FROM operations WHERE agent_id LIKE ? ESCAPE '\\'", like);
    const runVersions = await this.env.DB.prepare("SELECT r2_key FROM note_versions WHERE writer LIKE ? ESCAPE '\\'")
      .bind(like)
      .all<{ r2_key: string }>();
    const versionKeys = (runVersions.results ?? []).map((row) => row.r2_key).filter((key) => key.startsWith("sys/"));
    if (versionKeys.length) await this.env.VAULT.delete(versionKeys);
    await this.env.DB.prepare("DELETE FROM note_versions WHERE writer LIKE ? ESCAPE '\\'").bind(like).run();
    await this.deleteRunObjects(op.runId);
    const tokenRows = await this.env.DB.prepare("SELECT id FROM tokens WHERE label LIKE ? ESCAPE '\\' OR agent_id LIKE ? ESCAPE '\\'")
      .bind(like, like)
      .all<{ id: string }>();
    const deletedTokenIds = (tokenRows.results ?? []).map((row) => row.id);
    await this.env.DB.prepare("DELETE FROM tokens WHERE label LIKE ? ESCAPE '\\' OR agent_id LIKE ? ESCAPE '\\'").bind(like, like).run();
    await this.env.DB.prepare("DELETE FROM agents WHERE id LIKE ? ESCAPE '\\'").bind(like).run();
    const remaining = await this.runLeftovers(op.runId);
    await this.audit(
      op.actor,
      "cleanup",
      null,
      null,
      "ok",
      [],
      null,
      purged,
      JSON.stringify({
        run_id: op.runId,
        purged,
        rewritten,
        ...remaining,
        deleted_token_ids: deletedTokenIds,
        deleted_tokens: deletedTokenIds.length,
      }),
    );
    return { ok: true, data: { purged, rewritten, remaining_notes: remaining.notes, remaining_objects: remaining.objects } };
  }

  private async saveMarkdown(input: SaveInput): Promise<ApiResult<{ etag: string }>> {
    if (utf8Length(input.markdown) > FILE_LIMIT_BYTES) throw fileTooLarge();
    const existing = input.create ? null : await this.noteByPath(input.path);
    const appending = input.reason === "appended" || input.reason === "conflict";
    const generated = isGeneratedFile(input.path);
    if (existing && !appending && !generated && input.reason !== "cleanup" && input.reason !== "rebuild" && input.reason !== "replay") {
      await this.snapshotIfUnversioned(existing, input.actor.agentId);
    }
    const hash = await sha256Hex(input.markdown);
    const intentId = ulid();
    if (!input.skipPut) {
      this.ctx.storage.sql.exec(
        "INSERT INTO write_intents (op_id, path, prev_etag, new_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        intentId,
        input.path,
        input.ifMatch,
        hash,
        new Date().toISOString(),
      );
    }
    const put = input.skipPut ? { etag: input.storedEtag ?? "", versionTs: versionStamp() } : await this.putVault(input.path, input.markdown, input.id, input.ifMatch);
    if (!put || (input.skipPut && !input.storedEtag)) {
      if (!input.skipPut) this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", intentId);
      if (input.allowRetry) return failure(new VaultError("conflict_etag", "Concurrent write changed the object"));
      throw new VaultError("conflict_etag", "etag precondition failed");
    }
    const now = new Date().toISOString();
    const parsed = parseMarkdown(input.markdown);
    const status = noteStatus(parsed.frontmatter);
    const frontmatter = JSON.stringify(parsed.frontmatter);
    const appendedText = appending && existing && input.markdown.startsWith(existing.body) ? input.markdown.slice(existing.body.length) : null;
    const chunks = appending && existing ? chunkMarkdown(input.path, input.title, appendedText ?? parsed.body) : chunkMarkdown(input.path, input.title, parsed.body);
    const links = generated ? [] : await this.resolvedLinks(input.id, input.path, linkTargets(appendedText ?? parsed.body));
    const versionTs = versionStamp();
    const r2Key = r2KeyFor(this.prefix(), input.path);
    const gen = this.gen();
    const statements: D1PreparedStatement[] = [];
    if (input.create) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO notes (
            id, path, type, owner, domain, sensitivity, fact_key, title, body, frontmatter, content_hash, statement_hash,
            r2_etag, r2_key, status, observed_at, created_at, updated_at, version_ts, last_writer, last_confirmed_at, index_gen
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          input.id,
          input.path,
          input.type,
          input.owner,
          input.domain,
          input.sensitivity,
          input.factKey,
          input.title,
          input.markdown,
          frontmatter,
          hash,
          input.statementHash,
          put.etag,
          r2Key,
          status,
          input.observedAt,
          input.createdAt ?? stringField(parsed.frontmatter.vault_created_at) ?? stringField(parsed.frontmatter.created_at) ?? now,
          now,
          versionTs,
          input.actor.agentId,
          now,
          gen,
        ),
      );
    } else {
      statements.push(
        this.env.DB.prepare(
          `UPDATE notes SET type = ?, owner = ?, domain = ?, sensitivity = ?, fact_key = ?, title = ?, body = ?, frontmatter = ?,
           content_hash = ?, statement_hash = ?, r2_etag = ?, status = ?, observed_at = ?, updated_at = ?, version_ts = ?, last_writer = ?, index_gen = ?
           WHERE id = ?`,
        ).bind(
          input.type,
          input.owner,
          input.domain,
          input.sensitivity,
          input.factKey,
          input.title,
          input.markdown,
          frontmatter,
          hash,
          input.statementHash,
          put.etag,
          status,
          input.observedAt,
          now,
          versionTs,
          input.actor.agentId,
          gen,
          input.id,
        ),
      );
      if (!appending) {
        statements.push(this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(input.id));
        statements.push(this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ?").bind(input.id));
      }
    }
    // F15: every version is an immutable copy under sys/history/<id>/, labelled with the write that
    // produced it, so history shows each version's own text and restoring one restores it.
    // A journal day file is append-only and never restored, so it keeps no copies. The generated
    // summary keeps none either: it is made again from the facts, which keep their own.
    let historyKey: string | null = null;
    if (!appending && !input.journal && !generated) {
      historyKey = await this.historyCopy(input.id, versionTs, hash, input.markdown);
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO note_versions (note_id, version_ts, r2_key, content_hash, writer, reason) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(input.id, versionTs, historyKey, hash, input.actor.agentId, input.reason),
      );
    }
    if (status === "active") {
      let nextChunk = 0;
      if (appending && existing) {
        const prior = await this.env.DB.prepare("SELECT COALESCE(MAX(n), -1) AS n FROM chunks WHERE note_id = ?").bind(input.id).first<{ n: number }>();
        nextChunk = (prior?.n ?? -1) + 1;
      }
      for (const chunk of chunks) {
        const n = appending && existing ? nextChunk++ : chunk.n;
        statements.push(
          this.env.DB.prepare(
            "INSERT INTO chunks (id, note_id, n, text, title, path, token_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).bind(`${input.id}:${n}`, input.id, n, chunk.text, input.title, input.path, chunk.tokenCount),
        );
      }
    }
    for (const link of links) {
      statements.push(
        this.env.DB.prepare("INSERT OR IGNORE INTO links (src_note_id, target, dst_note_id) VALUES (?, ?, ?)").bind(input.id, link.target, link.dst),
      );
    }
    if (input.journal) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO journal_entries (id, note_id, agent_id, at, title, block_ref, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          input.journal.id,
          input.id,
          input.actor.agentId,
          input.journal.at,
          input.journal.title,
          `^${input.journal.id}`,
          input.journal.idempotencyKey,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_log (ts, request_id, agent_id, token_id, client, action, path, note_id, outcome, reason_codes, content_hash, bytes, ip_country, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?, ?, ?)`,
      ).bind(
        now,
        input.actor.requestId,
        input.actor.agentId,
        input.actor.tokenId,
        input.actor.client,
        input.action,
        input.path,
        input.id,
        await this.auditHash(input.markdown),
        utf8Length(input.markdown),
        input.actor.ipCountry,
        input.detail ?? null,
      ),
    );
    statements.push(this.env.DB.prepare("DELETE FROM oversize_files WHERE path = ?").bind(input.path));
    if (input.remember) {
      const { key, hash } = input.remember;
      statements.push(...this.rememberStatements(input.actor.agentId, { key, hash }, input.remember.data(put.etag), input.remember.status));
    }
    try {
      await this.env.DB.batch(statements);
      if (!input.skipPut) this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", intentId);
    } catch (err) {
      if (historyKey) await this.env.VAULT.delete(historyKey).catch(() => undefined);
      if (!input.skipPut) {
        let reverted = false;
        try {
          if (existing) {
            const back = await this.putVault(input.path, existing.body, existing.id, put.etag);
            reverted = Boolean(back);
          } else {
            await this.env.VAULT.delete(r2Key);
            reverted = true;
          }
        } catch {
          reverted = false;
        }
        if (reverted) this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", intentId);
      }
      throw err;
    }
    if (!input.path.startsWith("sensitive/")) await this.backfillLinks(input.id, input.path, input.factKey, stringList(parsed.frontmatter.aliases));
    await this.enqueue({ kind: "agent-index", note_id: input.id, path: input.path });
    await this.env.DB.prepare("UPDATE notes SET index_enqueued_at = ? WHERE id = ?").bind(new Date().toISOString(), input.id).run();
    return { ok: true, data: { etag: put.etag } };
  }

  // Indexes a stored file: an outside edit, a reconcile, a replayed intent, or bootstrap. Sensitive
  // text at a non-sensitive path is moved before it is indexed there.
  private async indexBytes(input: {
    path: string;
    markdown: string;
    etag: string | null;
    actor: Actor;
    action: string;
    reason: string;
    detail?: string | null;
    metaId?: string | null;
  }): Promise<ApiResult> {
    const parsed = parseMarkdown(input.markdown);
    const existing = await this.noteByPath(input.path);
    const status = noteStatus(parsed.frontmatter);
    const outside = input.action === "external_put" || input.action === "external_copy";
    // A quarantined row stays as it is until the quarantine erase removes it: no outside edit,
    // reconcile, replay, or rebuild indexes the file again or turns the row active.
    if (existing?.status === "quarantined") {
      if (outside) await this.audit(input.actor, "quarantined_skip", input.path, existing.id, "skipped", ["quarantined"], null, 0, input.detail ?? null);
      return { ok: true, data: { skipped: true, reason: "quarantined" } };
    }
    if (status === "active" && !inSensitiveFolder(input.path) && !isServerDocument(input.path)) {
      const route = frontmatterRoute(parsed.frontmatter, input.markdown);
      if (route) {
        return this.moveStoredFile({ path: input.path, markdown: input.markdown, etag: input.etag, route, actor: input.actor, action: input.action, detail: input.detail });
      }
    }
    let markdown = input.markdown;
    let etag = input.etag;
    const fileId = stringField(parsed.frontmatter.vault_id);
    let id = existing?.id ?? fileId ?? input.metaId ?? ulid();
    let writeBack = false;
    if (!existing) {
      const clash = await this.env.DB.prepare("SELECT path FROM notes WHERE id = ?").bind(id).first<{ path: string }>();
      if (clash && clash.path !== input.path) {
        id = ulid();
        writeBack = true;
      }
    }
    // A file created or copied outside the API gets its vault_id written into its frontmatter, so
    // a later rebuild keeps the same id.
    if ((outside || input.action === "reconcile") && (writeBack || fileId !== id)) {
      markdown = buildMarkdown({ ...parsed.frontmatter, vault_id: id }, parsed.body);
      const put = await this.putVault(input.path, markdown, id, etag);
      if (put) etag = put.etag;
      else markdown = input.markdown;
    }
    const again = parseMarkdown(markdown);
    const type = stringField(again.frontmatter.type) ?? inferType(input.path);
    const owner = stringField(again.frontmatter.owner) ?? ownerForPath(input.path);
    const domain = domainOf(input.path) ?? stringField(again.frontmatter.domain) ?? null;
    const sensitivity = storedSensitivity(again.frontmatter, input.path, domain);
    const title = stringField(again.frontmatter.key) ?? stringField(again.frontmatter.title) ?? titleFromBody(again.body, input.path);
    const saved = await this.saveMarkdown({
      id,
      path: input.path,
      markdown,
      type,
      owner,
      domain,
      sensitivity,
      factKey: type === "fact" ? stringField(again.frontmatter.key) ?? null : null,
      title,
      statementHash: type === "fact" ? await sha256Hex(statementOnly(again.body)) : null,
      observedAt: stringField(again.frontmatter.observed_at) ?? null,
      actor: input.actor,
      ifMatch: existing?.r2_etag ?? etag,
      create: !existing,
      reason: input.reason,
      action: input.action,
      journal: null,
      skipPut: true,
      storedEtag: etag,
      detail: input.detail ?? null,
    });
    if (saved.ok && (type === "journal" || type === "decision")) await restoreJournalMarkers(this.env, id, input.path, markdown, owner);
    return saved;
  }

  // A note that left the index (forgotten, moved, deleted outside) may have been a fact the
  // summary quoted. The summary is regenerated so the statement is gone from it.
  private async refreshSummaryAfter(note: { type: string; owner: string; path: string }, actor: Actor): Promise<void> {
    if (feedsSummary(note)) await this.refreshSummary(actor);
  }

  // profile/summary.md lists active shared facts that are normal and carry no domain tag, so a
  // read:shared caller sees nothing a scope would hide: no forgotten, purged, moved, sensitive, or
  // domain-tagged fact.
  private async refreshSummary(actor: Actor): Promise<void> {
    const rows = await this.env.DB.prepare(
      `SELECT fact_key, body FROM notes WHERE owner = 'shared' AND type = 'fact' AND status = 'active' AND sensitivity = 'normal'
         AND domain IS NULL AND path LIKE 'profile/facts/%' ORDER BY fact_key`,
    ).all<{ fact_key: string; body: string }>();
    const lines = ["# Profile", ""];
    for (const row of rows.results ?? []) {
      const statement = parseMarkdown(row.body).body.trim();
      lines.push(`## ${row.fact_key}`, "", statement, "");
    }
    const existing = await this.noteByPath("profile/summary.md");
    const id = existing?.id ?? ulid();
    const build = (updatedAt: string) =>
      buildMarkdown(
        {
          vault_id: id,
          type: "profile",
          owner: "shared",
          status: "active",
          sensitivity: "normal",
          source: "hiveattic",
          updated_at: updatedAt,
          vault_summary: true,
        },
        lines.join("\n"),
      );
    // A change that leaves the list as it was, such as a fact with a domain tag, writes nothing.
    // The stored file must match byte for byte apart from updated_at, so an outside edit is still replaced.
    const stamped = existing?.status === "active" && existing.r2_etag ? stringField(parseFrontmatter(existing.frontmatter).updated_at) : undefined;
    if (stamped && build(stamped) === existing!.body) return;
    const markdown = build(new Date().toISOString());
    await this.saveMarkdown({
      id,
      path: "profile/summary.md",
      markdown,
      type: "profile",
      owner: "shared",
      domain: null,
      sensitivity: "normal",
      factKey: null,
      title: "Profile",
      statementHash: null,
      observedAt: null,
      actor,
      ifMatch: existing?.r2_etag ?? null,
      create: !existing,
      reason: "summary",
      action: "summary",
      journal: null,
    });
  }

  private async flagConflict(key: string, winnerId: string, loserId: string, actor: Actor, observedAt: string, previous: string | null): Promise<void> {
    const id = ulid();
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      "INSERT INTO conflicts (id, fact_key, winner_id, loser_id, at, resolution) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, key, winnerId, loserId, now, "newest_observed_at")
      .run();
    const existing = await this.noteByPath("inbox/conflicts.md");
    const block = `## ${now} · ${actor.agentId} · ${key}\nObserved ${observedAt}. Previous observed ${previous ?? "unknown"}. Newest observed fact stays active.\n`;
    const base =
      existing?.body ??
      buildMarkdown({ vault_id: ulid(), type: "note", owner: "shared", status: "active", sensitivity: "normal" }, "# Conflicts\n");
    const markdown = `${base.endsWith("\n") ? base : `${base}\n`}\n${block}`;
    await this.saveMarkdown({
      id: existing?.id ?? stringField(parseMarkdown(base).frontmatter.vault_id) ?? ulid(),
      path: "inbox/conflicts.md",
      markdown,
      type: "note",
      owner: "shared",
      domain: null,
      sensitivity: "normal",
      factKey: null,
      title: "Conflicts",
      statementHash: null,
      observedAt: now,
      actor,
      ifMatch: existing?.r2_etag ?? null,
      create: !existing,
      reason: "conflict",
      action: "conflict",
      journal: null,
    });
  }

  // Writes one immutable version copy and returns its key. The key carries the version stamp and
  // the first 8 hex of the content hash, which is how a rebuild restores the version row.
  private async historyCopy(id: string, versionTs: string, hash: string, bytes: string): Promise<string> {
    const key = `sys/history/${id}/${versionTs}-${hash8(hash)}.md`;
    await this.env.VAULT.put(key, bytes, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { "vault-writer": "do", "vault-id": id },
    });
    return key;
  }

  // Notes written before F15, or indexed from an outside edit by an older build, may have no
  // immutable copy of their current text. One is made before that text is replaced.
  private async snapshotIfUnversioned(note: { id: string; body: string; content_hash: string }, writer: string): Promise<void> {
    const held = await this.env.DB.prepare("SELECT 1 AS hit FROM note_versions WHERE note_id = ? AND content_hash = ? AND r2_key LIKE 'sys/history/%' LIMIT 1")
      .bind(note.id, note.content_hash)
      .first<{ hit: number }>();
    if (!held) await this.snapshotBytes(note, note.body, writer, "earlier");
  }

  private async snapshotBytes(note: { id: string }, bytes: string, writer: string, reason: string): Promise<string> {
    const stamp = versionStamp();
    const hash = await sha256Hex(bytes);
    const key = `sys/history/${note.id}/${stamp}-${hash8(hash)}.md`;
    await this.env.VAULT.put(key, bytes, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { "vault-writer": "do", "vault-id": note.id },
    });
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO note_versions (note_id, version_ts, r2_key, content_hash, writer, reason) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(note.id, stamp, key, hash, writer, reason)
      .run();
    return stamp;
  }

  private async putVault(path: string, markdown: string, id: string, ifMatch: string | null): Promise<{ etag: string; versionTs: string } | null> {
    const onlyIf = ifMatch ? { etagMatches: ifMatch } : { etagDoesNotMatch: "*" };
    const object = await this.env.VAULT.put(r2KeyFor(this.prefix(), path), markdown, {
      onlyIf,
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { "vault-writer": "do", "vault-id": id },
    });
    if (!object) return null;
    return { etag: normalizeEtag(object.etag) ?? object.etag, versionTs: versionStamp() };
  }

  // An object over the file limit is not indexed, not deleted, and not served. D1 keeps its path and
  // size in oversize_files. A row the path already had keeps its history, but loses its chunks and
  // links and its etag, so search and list skip it and no API write can match it. The audit row is
  // written once per object version. Shrinking the file lets the next event or job index it again.
  private async markOversize(path: string, size: number, etag: string | null, actor: Actor, detail: string | null = null): Promise<void> {
    const prior = await this.env.DB.prepare("SELECT r2_etag FROM oversize_files WHERE path = ?").bind(path).first<{ r2_etag: string | null }>();
    const note = await this.noteByPath(path);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO oversize_files (path, size, r2_etag, note_id, found_at, index_gen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, r2_etag = excluded.r2_etag, note_id = excluded.note_id, index_gen = excluded.index_gen`,
      ).bind(path, size, etag, note?.id ?? null, now, this.gen()),
    ];
    if (note) {
      const chunkIds = await this.chunkIds(note.id);
      statements.push(
        this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(note.id),
        this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ?").bind(note.id),
        this.env.DB.prepare("UPDATE notes SET r2_etag = NULL, index_gen = ? WHERE id = ?").bind(this.gen(), note.id),
        ...this.vectorDeletes(chunkIds, note.id, now),
      );
    }
    await this.env.DB.batch(statements);
    if (!prior || normalizeEtag(prior.r2_etag) !== normalizeEtag(etag)) {
      await this.audit(actor, "oversize", path, note?.id ?? null, "skipped", ["file"], null, size, detail);
    }
  }

  // Frees a forgotten note's path for a new note. The forgotten row keeps its id, tombstone, and
  // admin-only history under a parked path that no request can name, and its stub object makes way
  // for the new note. An object someone put there since is left alone, so the create answers 409.
  private async releaseForgotten(row: NoteRow): Promise<void> {
    const key = r2KeyFor(this.prefix(), row.path);
    const head = await this.env.VAULT.head(key);
    if (head) {
      // Only the stub this row wrote is removed. Anything else at the key was put there outside the
      // API since, and the write is refused until that object has been indexed.
      if (!row.r2_etag || normalizeEtag(head.etag) !== normalizeEtag(row.r2_etag)) {
        throw new VaultError("conflict_etag", "The file was changed outside the API. Read it again before writing.");
      }
      await this.env.VAULT.delete(key);
    }
    const parked = `.forgotten/${row.id}.md`;
    await this.env.DB.prepare("UPDATE notes SET path = ?, r2_key = ?, fact_key = NULL WHERE id = ? AND status = 'forgotten'")
      .bind(parked, r2KeyFor(this.prefix(), parked), row.id)
      .run();
  }

  // Indexes what R2 holds at a path now, so the next attempt of a write works from the stored file.
  private async refreshFromR2(path: string, actor: Actor): Promise<void> {
    const object = await this.env.VAULT.get(r2KeyFor(this.prefix(), path));
    if (!object) return;
    if (object.size > FILE_LIMIT_BYTES) {
      await object.body?.cancel();
      await this.markOversize(path, object.size, normalizeEtag(object.etag), actor);
      throw fileTooLarge();
    }
    const indexer: Actor = { ...actor, agentId: "reconcile", tokenId: "reconcile", client: "reconcile" };
    await this.indexBytes({ path, markdown: await object.text(), etag: normalizeEtag(object.etag), actor: indexer, action: "reconcile", reason: "reconcile" });
  }

  private async clearOversize(path: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM oversize_files WHERE path = ?").bind(path).run();
  }

  private async assertNotOversize(path: string): Promise<void> {
    const row = await this.env.DB.prepare("SELECT 1 AS hit FROM oversize_files WHERE path = ?").bind(path).first<{ hit: number }>();
    if (row) throw fileTooLarge();
  }

  // Hard-erases one note: the vault object, sys/history/<id>/, and every D1 row for it, leaving a
  // tombstone with an HMAC hash and the reason. Matching is by exact id and r2 key only.
  private async purge(id: string | undefined, path: string | undefined, actor: Actor, audit: boolean, reason: string): Promise<ApiResult> {
    const note = await this.resolveNote(id, path);
    if (!note) return { ok: true, data: { purged: false } };
    await this.eraseRow(note, actor, reason);
    if (audit) await this.audit(actor, "purge", note.path, note.id, "ok", [], null, 0);
    return { ok: true, data: { purged: true, id: note.id, path: note.path } };
  }

  private async eraseRow(note: NoteRow, actor: Actor, reason: string): Promise<void> {
    const chunkIds = await this.chunkIds(note.id);
    const now = new Date().toISOString();
    const live = await this.env.VAULT.get(note.r2_key);
    const liveText = live ? await live.text() : null;
    const hash = (await this.auditHash(liveText ?? note.body)) ?? note.content_hash;
    const keys = [note.r2_key, ...(await this.historyKeys(note.id))];
    await this.env.VAULT.delete(keys);
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ? OR dst_note_id = ?").bind(note.id, note.id),
      this.env.DB.prepare("DELETE FROM journal_entries WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM note_versions WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare(
        `INSERT INTO tombstones (note_id, at, by_agent, reason, purged_at, content_hash, path) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET reason = excluded.reason, purged_at = excluded.purged_at, content_hash = excluded.content_hash`,
      ).bind(note.id, now, actor.agentId, reason, now, hash, note.path),
      ...this.vectorDeletes(chunkIds, note.id, now),
      this.env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(note.id),
    ]);
    if (feedsSummary(note)) {
      // The summary is regenerated without the erased statement. Its earlier versions quoted it, and
      // the summary is derived, so their snapshots go too.
      await this.refreshSummary(actor);
      const summary = await this.noteByPath("profile/summary.md");
      if (summary) {
        const keys = await this.historyKeys(summary.id);
        if (keys.length) await this.env.VAULT.delete(keys);
        await this.env.DB.prepare("DELETE FROM note_versions WHERE note_id = ? AND r2_key LIKE 'sys/history/%'").bind(summary.id).run();
      }
    }
  }

  private async historyKeys(id: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const history = await this.env.VAULT.list({ prefix: `sys/history/${id}/`, cursor, limit: 500 });
      keys.push(...history.objects.map((object) => object.key));
      cursor = history.truncated ? history.cursor : undefined;
    } while (cursor);
    return keys;
  }

  private vectorDeletes(chunkIds: string[], noteId: string, now: string): D1PreparedStatement[] {
    return chunkIds.map((chunkId) =>
      this.env.DB.prepare(
        `INSERT INTO vector_delete_queue (chunk_id, note_id, requested_at) VALUES (?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET requested_at = excluded.requested_at`,
      ).bind(chunkId, noteId, now),
    );
  }

  private async enqueue(body: Record<string, unknown>): Promise<void> {
    try {
      await this.env.INDEX_Q.send(body);
    } catch (err) {
      logEvent({ event: "queue_send_failed", name: err instanceof Error ? err.name : "error" });
    }
  }

  // Audit hashes are HMAC-SHA256 under AUDIT_KEY, so a hash in the log cannot be checked against a
  // guessed text. AUDIT_KEY is required; were it missing, the hash would be left out rather than
  // stored as a plain digest.
  private async auditHash(text: string): Promise<string | null> {
    if (!this.env.AUDIT_KEY) return null;
    return hmacSha256Hex(this.env.AUDIT_KEY, text);
  }

  private async audit(
    actor: Actor,
    action: string,
    path: string | null,
    noteId: string | null,
    outcome: string,
    reasons: string[],
    contentHash: string | null,
    bytes: number,
    detail: string | null = null,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO audit_log (ts, request_id, agent_id, token_id, client, action, path, note_id, outcome, reason_codes, content_hash, bytes, ip_country, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        new Date().toISOString(),
        actor.requestId,
        actor.agentId,
        actor.tokenId,
        actor.client,
        action,
        path,
        noteId,
        outcome,
        reasons.length ? JSON.stringify(reasons) : null,
        contentHash,
        bytes,
        actor.ipCountry,
        detail,
      )
      .run();
  }

  private async replayIntents(): Promise<{ replayed: number; dropped: number }> {
    const rows = this.ctx.storage.sql
      .exec<{ op_id: string; path: string; new_hash: string }>("SELECT op_id, path, new_hash FROM write_intents")
      .toArray();
    let replayed = 0;
    let dropped = 0;
    for (const row of rows) {
      const object = await this.env.VAULT.get(r2KeyFor(this.prefix(), row.path));
      if (!object) {
        this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", row.op_id);
        dropped += 1;
        continue;
      }
      const markdown = await object.text();
      if ((await sha256Hex(markdown)) !== row.new_hash) {
        this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", row.op_id);
        dropped += 1;
        continue;
      }
      const actor: Actor = { agentId: "replay", tokenId: "replay", client: "replay", requestId: ulid(), ipCountry: null };
      try {
        await this.indexBytes({ path: row.path, markdown, etag: normalizeEtag(object.etag), actor, action: "replay", reason: "replay" });
        this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", row.op_id);
        replayed += 1;
      } catch (err) {
        logEvent({ event: "intent_replay_failed", name: err instanceof Error ? err.name : "error" });
      }
    }
    return { replayed, dropped };
  }

  // ---- Jobs ---------------------------------------------------------------------------------

  private activeJob(): Job | null {
    const row = this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 1")
      .toArray()[0];
    return row ? (JSON.parse(row.body) as Job) : null;
  }

  private loadJob(id: string): Job | null {
    const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM jobs WHERE id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.body) as Job) : null;
  }

  private saveJob(job: Job): void {
    this.ctx.storage.sql.exec("UPDATE jobs SET status = ?, body = ? WHERE id = ?", job.status, JSON.stringify(job), job.id);
  }

  private state(key: string): string | null {
    return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM writer_state WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setState(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT INTO writer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // Every write stamps notes.index_gen with the current generation. A rebuild bumps it, restamps
  // every row it reads back from R2, and sweeps the rows still on an older generation.
  private gen(): number {
    return Number(this.state("index_gen") ?? "0") || 0;
  }

  // Set once a quarantine erase (not a dry run) has finished.
  private erasedAt(): string | null {
    return this.state("quarantine_erased_at");
  }

  private async quarantineRecordsExist(): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT 1 AS hit FROM notes WHERE status = 'quarantined' LIMIT 1").first<{ hit: number }>();
    if (row) return true;
    const records = await this.env.VAULT.list({ prefix: "sys/quarantine/", limit: 1 });
    return records.objects.length > 0;
  }

  // The count a production erase must confirm: quarantined D1 rows plus sys/quarantine/ records.
  private async quarantineCount(): Promise<number> {
    const rows = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE status = 'quarantined'").first<{ n: number }>();
    let records = 0;
    let cursor: string | undefined;
    do {
      const page = await this.env.VAULT.list({ prefix: "sys/quarantine/", cursor, limit: 1000 });
      records += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return (rows?.n ?? 0) + records;
  }

  private async jobStep(id: string): Promise<void> {
    const job = this.loadJob(id);
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    if (job.status === "queued") {
      job.status = "running";
      job.started_at = new Date().toISOString();
      job.started_ms = Date.now();
    }
    const deadline = Date.now() + PAGE_BUDGET_MS;
    try {
      const done =
        job.kind === "reconcile" ? await this.reconcileStep(job, deadline) : job.kind === "quarantine-erase" ? await this.eraseStep(job, deadline) : await this.rebuildStep(job, deadline);
      job.pages += 1;
      job.attempts = 0;
      job.error = null;
      if (done) await this.finishJob(job);
      this.saveJob(job);
    } catch (err) {
      job.attempts += 1;
      job.error = errorText(err);
      logEvent({ event: "job_page_failed", kind: job.kind, phase: job.phase, attempts: job.attempts });
      if (job.attempts >= MAX_JOB_ATTEMPTS) {
        job.status = "failed";
        job.finished_at = new Date().toISOString();
        const detail = { job_id: job.id, phase: job.phase, ...job.counts, duration_ms: Date.now() - job.started_ms, error: job.error };
        await this.audit(job.actor, jobAuditName(job.kind), null, null, "failed", [err instanceof VaultError ? err.code : "error"], null, 0, JSON.stringify(detail)).catch(
          () => undefined,
        );
      }
      this.saveJob(job);
    }
  }

  private async finishJob(job: Job): Promise<void> {
    job.status = "done";
    job.phase = "done";
    job.finished_at = new Date().toISOString();
    job.counts.duration_ms = Date.now() - job.started_ms;
    if (job.kind === "quarantine-erase" && !job.dry_run && !this.erasedAt()) this.setState("quarantine_erased_at", job.finished_at);
    const detail: Record<string, unknown> = { job_id: job.id, ...job.counts };
    if (job.kind === "quarantine-erase") {
      detail.dry_run = job.dry_run;
      detail.note_ids = job.report.note_ids.slice(0, 200);
    }
    await this.audit(job.actor, jobAuditName(job.kind), null, null, "ok", [], null, 0, JSON.stringify(detail));
  }

  private count(job: Job, name: string, by = 1): void {
    job.counts[name] = (job.counts[name] ?? 0) + by;
  }

  // Rebuild: files, then history, then a sweep of rows no file accounts for, then links, then the
  // FTS index, then orphaned quarantine records once the migration has run.
  private async rebuildStep(job: Job, deadline: number): Promise<boolean> {
    if (job.phase === "start") {
      job.gen = this.gen() + 1;
      this.setState("index_gen", String(job.gen));
      for (const name of ["files", "notes", "versions", "tombstones", "history_reads", "moved", "swept", "links", "skipped", "oversize"]) job.counts[name] = 0;
      job.phase = "files";
      job.cursor = null;
    }
    switch (job.phase) {
      case "files":
        if (await this.rebuildFiles(job, deadline)) this.nextPhase(job, "history");
        return false;
      case "history":
        if (await this.rebuildHistory(job, deadline)) this.nextPhase(job, "sweep");
        return false;
      case "sweep":
        if (await this.rebuildSweep(job)) this.nextPhase(job, "links");
        return false;
      case "links":
        if (await this.rebuildLinks(job)) this.nextPhase(job, "fts");
        return false;
      case "fts":
        await this.env.DB.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')").run();
        this.nextPhase(job, "quarantine");
        return false;
      case "quarantine":
        if (!(await this.deleteQuarantineOrphans(job))) return false;
        job.counts.notes = (await this.env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>())?.n ?? 0;
        job.counts.imported = job.counts.files ?? 0;
        return true;
      default:
        return true;
    }
  }

  private nextPhase(job: Job, phase: string): void {
    job.phase = phase;
    job.cursor = null;
  }

  private async rebuildFiles(job: Job, deadline: number): Promise<boolean> {
    const prefix = this.prefix();
    const gen = job.gen;
    const page = await this.env.VAULT.list({ prefix, startAfter: job.cursor ?? undefined, limit: PAGE_OBJECTS });
    const entries = page.objects.map((object) => ({ object, path: object.key.endsWith(".md") ? vaultPathFromKey(prefix, object.key) : null }));
    const live = await this.rowsByPath(entries.flatMap((entry) => (entry.path ? [entry.path] : [])));
    // Pick how far into the page this step goes: every object, unless the file text passes the byte cap.
    let take = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (entry.path && entry.object.size <= FILE_LIMIT_BYTES && !isCurrent(live.get(entry.path), entry.object.etag, gen)) bytes += entry.object.size;
      if (take > 0 && bytes > PAGE_BYTES) break;
      take += 1;
    }
    const chosen = entries.slice(0, take);
    const loads = chosen.filter((entry) => entry.path && entry.object.size <= FILE_LIMIT_BYTES && !isCurrent(live.get(entry.path), entry.object.etag, gen));
    const texts = new Map<string, { text: string; etag: string | null; metaId: string | null; uploaded: string | null }>();
    let loadedUpTo = chosen.length;
    for (const group of slices(loads, R2_READ_CONCURRENCY)) {
      if (Date.now() > deadline && texts.size > 0) {
        loadedUpTo = chosen.indexOf(group[0]!);
        break;
      }
      const files = await Promise.all(
        group.map(async (entry) => {
          const file = await this.env.VAULT.get(entry.object.key);
          return file
            ? { key: entry.object.key, text: await file.text(), etag: normalizeEtag(file.etag), metaId: file.customMetadata?.["vault-id"] ?? null, uploaded: file.uploaded.toISOString() }
            : null;
        }),
      );
      for (const file of files) if (file) texts.set(file.key, file);
    }
    const processed = chosen.slice(0, loadedUpTo);
    // An object over the file limit is never loaded. It is recorded as oversize and the page goes on.
    const actor: Actor = { agentId: "rebuild", tokenId: "rebuild", client: "indexer", requestId: job.actor.requestId, ipCountry: null };
    for (const entry of processed) {
      if (!entry.path || entry.object.size <= FILE_LIMIT_BYTES || live.get(entry.path)?.status === "quarantined") continue;
      await this.markOversize(entry.path, entry.object.size, normalizeEtag(entry.object.etag), actor, JSON.stringify({ job_id: job.id }));
      this.count(job, "oversize");
    }
    const loaded = processed.flatMap((entry) => {
      const file = texts.get(entry.object.key);
      return entry.path && file ? [{ path: entry.path, ...file }] : [];
    });
    const parsedFiles = loaded.map((file) => ({ ...file, parsed: parseMarkdown(file.text) }));
    const candidates = new Set<string>();
    for (const file of parsedFiles) {
      const fromFile = stringField(file.parsed.frontmatter.vault_id);
      if (fromFile) candidates.add(fromFile);
      if (file.metaId) candidates.add(file.metaId);
    }
    const byId = await this.rowsById([...candidates]);
    const factSlots = parsedFiles.flatMap((file) => {
      const fm = file.parsed.frontmatter;
      const key = stringField(fm.key);
      const type = stringField(fm.type) ?? inferType(file.path);
      return type === "fact" && key ? [`${stringField(fm.owner) ?? ownerForPath(file.path)}\u0000${key}`] : [];
    });
    const claims = await this.factClaims(factSlots);
    const rows = emptyRows();
    const assigned = new Map<string, string>();
    const claimed = new Map<string, string>();
    const keepAlive: string[] = [];
    const moves: { path: string; text: string; etag: string | null; route: string }[] = [];
    const now = new Date().toISOString();
    let pending = 0;
    for (const entry of processed) if (entry.path && isCurrent(live.get(entry.path), entry.object.etag, gen)) this.count(job, "files");
    for (const file of parsedFiles) {
      const row = live.get(file.path);
      // Rebuild does not start while quarantine records exist. Should a quarantined row be here
      // anyway, it is kept as it is, never re-read from its file.
      if (row?.status === "quarantined") {
        keepAlive.push(row.id);
        this.count(job, "skipped");
        continue;
      }
      if (utf8Length(file.text) > FILE_LIMIT_BYTES) {
        await this.markOversize(file.path, utf8Length(file.text), file.etag, actor, JSON.stringify({ job_id: job.id }));
        this.count(job, "oversize");
        continue;
      }
      const fm = file.parsed.frontmatter;
      const status = noteStatus(fm);
      if (status === "active" && !inSensitiveFolder(file.path) && !isServerDocument(file.path)) {
        const route = frontmatterRoute(fm, file.text);
        if (route) {
          moves.push({ path: file.path, text: file.text, etag: file.etag, route });
          continue;
        }
      }
      const id = pickNoteId(file.path, [stringField(fm.vault_id) ?? null, row?.id ?? null, file.metaId?.trim() || null], byId, assigned);
      assigned.set(id, file.path);
      if (row && row.id !== id) rows.replaced.push(row.id);
      const type = stringField(fm.type) ?? inferType(file.path);
      const owner = stringField(fm.owner) ?? ownerForPath(file.path);
      const domain = domainOf(file.path) ?? stringField(fm.domain) ?? null;
      const title = stringField(fm.key) ?? stringField(fm.title) ?? titleFromBody(file.parsed.body, file.path);
      // Two active files for one fact key would break the unique index. The first path in listing order keeps the key.
      let factKey = type === "fact" ? (stringField(fm.key) ?? null) : null;
      if (factKey && status === "active") {
        const slot = `${owner}\u0000${factKey}`;
        const holder = claims.get(slot);
        if (claimed.has(slot)) factKey = null;
        else if (holder && holder.id !== id && holder.index_gen === gen) factKey = null;
        else {
          if (holder && holder.id !== id) rows.unkeyed.push(holder.id);
          claimed.set(slot, id);
        }
      }
      const hash = await sha256Hex(file.text);
      const createdAt = row?.created_at ?? stringField(fm.vault_created_at) ?? stringField(fm.created_at) ?? stringField(fm.updated_at) ?? file.uploaded ?? now;
      rows.notes.push([
        id,
        file.path,
        type,
        owner,
        domain,
        storedSensitivity(fm, file.path, domain),
        factKey,
        title,
        file.text,
        JSON.stringify(fm),
        hash,
        type === "fact" ? await sha256Hex(statementOnly(file.parsed.body)) : null,
        file.etag,
        r2KeyFor(prefix, file.path),
        status,
        stringField(fm.observed_at) ?? null,
        createdAt,
        stringField(fm.updated_at) ?? now,
        versionStamp(),
        stringField(fm.source) ?? "rebuild",
        gen,
      ]);
      if (status === "active") {
        for (const chunk of chunkMarkdown(file.path, title, file.parsed.body)) rows.chunks.push([`${id}:${chunk.n}`, id, chunk.n, chunk.text, title, file.path, chunk.tokenCount]);
        if (!isGeneratedFile(file.path)) for (const target of linkTargets(file.parsed.body)) rows.links.push([id, target]);
      }
      // L5: idempotency rows inside the 7-day window come back from the files themselves: the MAC'd
      // markers of journal entries, and the frontmatter of notes, facts, and keyed forget stubs.
      if (type === "journal" || type === "decision") {
        for (const entry of journalEntries(file.text)) {
          const agent = entry.agent || owner;
          if (!(await journalMacMatches(this.env, { ...entry, agent }))) continue;
          rows.journal.push([entry.id, id, agent, journalAt(entry.id, now), entry.title, `^${entry.id}`, entry.idempotency]);
          const restored = await journalIdempotencyRow(this.env, entry, agent, file.path);
          if (restored) rows.idempotency.push([restored.agent, restored.key, restored.response, restored.at, restored.hash]);
        }
      } else {
        const restored = frontmatterIdempotencyRow(fm, { id, path: file.path, etag: file.etag, type, status });
        if (restored) rows.idempotency.push([restored.agent, restored.key, restored.response, restored.at, restored.hash]);
      }
      if (status === "forgotten") {
        rows.tombstones.push([id, hash]);
        this.count(job, "tombstones");
      }
      this.count(job, "files");
      // A file's text lands in its note row and again in its chunks.
      pending += utf8Length(file.text) * 2;
      if (pending > 1_500_000) {
        await this.flushRows(rows, now);
        Object.assign(rows, emptyRows());
        pending = 0;
      }
    }
    await this.flushRows(rows, now);
    if (keepAlive.length) await this.env.DB.prepare("UPDATE notes SET index_gen = ? WHERE id IN (SELECT value FROM json_each(?))").bind(gen, JSON.stringify(keepAlive)).run();
    // A path read back at its normal size is no longer oversize.
    const indexed = rows.notes.map((row) => String(row[1]));
    if (indexed.length) await this.env.DB.prepare("DELETE FROM oversize_files WHERE path IN (SELECT value FROM json_each(?))").bind(JSON.stringify(indexed)).run();
    for (const move of moves) {
      await this.moveStoredFile({ path: move.path, markdown: move.text, etag: move.etag, route: move.route, actor, action: "rebuild" });
      this.count(job, "moved");
      this.count(job, "files");
    }
    const last = processed.at(-1);
    if (last) job.cursor = last.object.key;
    return processed.length === entries.length && !page.truncated;
  }

  private async flushRows(rows: StagedRows, now: string): Promise<void> {
    const db = this.env.DB;
    const statements: D1PreparedStatement[] = [];
    const ids = (list: string[]) => JSON.stringify(list);
    if (rows.replaced.length) {
      const replaced = ids(rows.replaced);
      statements.push(
        db.prepare(
          `INSERT INTO vector_delete_queue (chunk_id, note_id, requested_at) SELECT id, note_id, ? FROM chunks WHERE note_id IN (SELECT value FROM json_each(?)) AND 1
           ON CONFLICT(chunk_id) DO UPDATE SET requested_at = excluded.requested_at`,
        ).bind(now, replaced),
        db.prepare("DELETE FROM links WHERE src_note_id IN (SELECT value FROM json_each(?))").bind(replaced),
        db.prepare("DELETE FROM journal_entries WHERE note_id IN (SELECT value FROM json_each(?))").bind(replaced),
        db.prepare("DELETE FROM note_versions WHERE note_id IN (SELECT value FROM json_each(?))").bind(replaced),
        db.prepare("DELETE FROM chunks WHERE note_id IN (SELECT value FROM json_each(?))").bind(replaced),
        db.prepare("DELETE FROM notes WHERE id IN (SELECT value FROM json_each(?))").bind(replaced),
      );
    }
    if (rows.unkeyed.length) statements.push(db.prepare("UPDATE notes SET fact_key = NULL WHERE id IN (SELECT value FROM json_each(?))").bind(ids(rows.unkeyed)));
    const staged = rows.notes.map((row) => String(row[0]));
    for (const json of jsonSlices(rows.notes)) {
      statements.push(
        db.prepare(
          `${jsonInsert("INSERT INTO notes", NOTE_COLUMNS)} WHERE 1
           ON CONFLICT(id) DO UPDATE SET ${NOTE_UPDATE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`,
        ).bind(json),
      );
    }
    if (staged.length) {
      const stagedIds = ids(staged);
      statements.push(db.prepare("DELETE FROM chunks WHERE note_id IN (SELECT value FROM json_each(?))").bind(stagedIds));
      statements.push(db.prepare("DELETE FROM links WHERE src_note_id IN (SELECT value FROM json_each(?))").bind(stagedIds));
      const entryIds = JSON.stringify(rows.journal.map((row) => row[0]));
      statements.push(
        db.prepare(
          `DELETE FROM journal_entries WHERE (note_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?)))
             OR (id IN (SELECT value FROM json_each(?)) AND note_id NOT IN (SELECT value FROM json_each(?)))`,
        ).bind(stagedIds, entryIds, entryIds, stagedIds),
      );
    }
    for (const json of jsonSlices(rows.chunks)) statements.push(db.prepare(jsonInsert("INSERT INTO chunks", CHUNK_COLUMNS)).bind(json));
    for (const json of jsonSlices(rows.links)) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO links (src_note_id, target, dst_note_id) SELECT ${jsonSelect(["src", "target"])}, NULL FROM json_each(?)`).bind(json));
    }
    for (const json of jsonSlices(rows.journal)) statements.push(db.prepare(jsonInsert("INSERT OR IGNORE INTO journal_entries", JOURNAL_COLUMNS)).bind(json));
    for (const json of jsonSlices(rows.idempotency)) statements.push(db.prepare(jsonInsert("INSERT OR IGNORE INTO idempotency", ["agent_id", "key", "response", "at", "payload_hash"])).bind(json));
    for (const json of jsonSlices(rows.tombstones)) {
      statements.push(
        db.prepare(
          `INSERT INTO tombstones (note_id, at, by_agent, reason, content_hash)
           SELECT json_extract(value, '$[0]'), ?, 'rebuild', 'forgotten', json_extract(value, '$[1]') FROM json_each(?) WHERE 1
           ON CONFLICT(note_id) DO NOTHING`,
        ).bind(now, json),
      );
    }
    if (statements.length) await db.batch(statements);
  }

  private async rowsByPath(
    paths: string[],
  ): Promise<Map<string, { id: string; path: string; r2_etag: string | null; index_gen: number | null; created_at: string; status: string }>> {
    if (!paths.length) return new Map();
    const rows = await this.env.DB.prepare("SELECT id, path, r2_etag, index_gen, created_at, status FROM notes WHERE path IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(paths))
      .all<{ id: string; path: string; r2_etag: string | null; index_gen: number | null; created_at: string; status: string }>();
    return new Map((rows.results ?? []).map((row) => [row.path, row]));
  }

  private async rowsById(ids: string[]): Promise<Map<string, { id: string; path: string }>> {
    if (!ids.length) return new Map();
    const rows = await this.env.DB.prepare("SELECT id, path FROM notes WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<{ id: string; path: string }>();
    return new Map((rows.results ?? []).map((row) => [row.id, row]));
  }

  private async factClaims(slots: string[]): Promise<Map<string, { id: string; index_gen: number | null }>> {
    if (!slots.length) return new Map();
    const rows = await this.env.DB.prepare(
      `SELECT id, owner, fact_key, index_gen FROM notes WHERE status = 'active' AND fact_key IS NOT NULL
         AND owner || char(0) || fact_key IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(slots))
      .all<{ id: string; owner: string; fact_key: string; index_gen: number | null }>();
    return new Map((rows.results ?? []).map((row) => [`${row.owner}\u0000${row.fact_key}`, row]));
  }

  // History objects are write-once and their key carries the first 8 hex of the content hash. A
  // version row D1 already holds is kept. Anything else is read from R2 once.
  private async rebuildHistory(job: Job, deadline: number): Promise<boolean> {
    const page = await this.env.VAULT.list({ prefix: "sys/history/", startAfter: job.cursor ?? undefined, limit: 1000 });
    const parsed = page.objects
      .map((object) => ({ key: object.key, match: /^sys\/history\/([^/]+)\/([^-]+)-([0-9a-f]{8})\.md$/.exec(object.key) }))
      .filter((item): item is { key: string; match: RegExpExecArray } => Boolean(item.match));
    const noteIds = [...new Set(parsed.map((item) => item.match[1]!))];
    const known = new Set<string>();
    if (noteIds.length) {
      const rows = await this.env.DB.prepare("SELECT id FROM notes WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(noteIds)).all<{ id: string }>();
      for (const row of rows.results ?? []) known.add(row.id);
    }
    const wanted = parsed.filter((item) => known.has(item.match[1]!));
    const have = new Set<string>();
    if (wanted.length) {
      const rows = await this.env.DB.prepare("SELECT r2_key FROM note_versions WHERE r2_key IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(wanted.map((item) => item.key)))
        .all<{ r2_key: string }>();
      for (const row of rows.results ?? []) have.add(row.r2_key);
    }
    const versions: JsonValue[][] = [];
    let reads = 0;
    let lastKey: string | null = null;
    let stopped = false;
    const missing = wanted.filter((item) => !have.has(item.key));
    const reading = new Set(missing.slice(0, HISTORY_READS_PER_PAGE).map((item) => item.key));
    for (const group of slices(missing.filter((item) => reading.has(item.key)), R2_READ_CONCURRENCY)) {
      if (Date.now() > deadline && reads > 0) {
        stopped = true;
        break;
      }
      const resolved = await Promise.all(
        group.map(async ({ key, match }) => {
          const file = await this.env.VAULT.get(key);
          return file ? [match[1]!, match[2]!, key, await sha256Hex(await file.text()), "rebuild", "history"] : null;
        }),
      );
      reads += group.length;
      for (const row of resolved) if (row) versions.push(row);
      lastKey = group.at(-1)!.key;
    }
    job.counts.history_reads = (job.counts.history_reads ?? 0) + reads;
    // The page ends at the first missing row that was not read, so the next page starts there.
    const cutoff = stopped || missing.length > reading.size ? (lastKey ?? null) : null;
    const counted = cutoff === null ? wanted : wanted.filter((item) => item.key <= cutoff);
    this.count(job, "versions", counted.length);
    for (const json of jsonSlices(versions)) await this.env.DB.prepare(jsonInsert("INSERT OR IGNORE INTO note_versions", VERSION_COLUMNS)).bind(json).run();
    if (cutoff !== null) {
      job.cursor = cutoff;
      return false;
    }
    job.cursor = page.objects.at(-1)?.key ?? job.cursor;
    return !page.truncated;
  }

  private async rebuildSweep(job: Job): Promise<boolean> {
    // A forgotten row parked by a reused path has no object of its own. It keeps its history.
    await this.env.DB.prepare("UPDATE notes SET index_gen = ? WHERE path LIKE '.forgotten/%' AND (index_gen IS NULL OR index_gen < ?)").bind(job.gen, job.gen).run();
    const rows = await this.env.DB.prepare("SELECT id FROM notes WHERE index_gen IS NULL OR index_gen < ? LIMIT 100").bind(job.gen).all<{ id: string }>();
    const stale = (rows.results ?? []).map((row) => row.id);
    if (stale.length < 100) await this.env.DB.prepare("DELETE FROM oversize_files WHERE index_gen IS NULL OR index_gen < ?").bind(job.gen).run();
    if (!stale.length) return true;
    const json = JSON.stringify(stale);
    const now = new Date().toISOString();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO vector_delete_queue (chunk_id, note_id, requested_at) SELECT id, note_id, ? FROM chunks WHERE note_id IN (SELECT value FROM json_each(?)) AND 1
         ON CONFLICT(chunk_id) DO UPDATE SET requested_at = excluded.requested_at`,
      ).bind(now, json),
      this.env.DB.prepare("DELETE FROM links WHERE src_note_id IN (SELECT value FROM json_each(?))").bind(json),
      this.env.DB.prepare("DELETE FROM journal_entries WHERE note_id IN (SELECT value FROM json_each(?))").bind(json),
      this.env.DB.prepare("DELETE FROM note_versions WHERE note_id IN (SELECT value FROM json_each(?))").bind(json),
      this.env.DB.prepare("DELETE FROM chunks WHERE note_id IN (SELECT value FROM json_each(?))").bind(json),
      this.env.DB.prepare("DELETE FROM notes WHERE id IN (SELECT value FROM json_each(?))").bind(json),
    ]);
    this.count(job, "swept", stale.length);
    return stale.length < 100;
  }

  // Re-resolves every wikilink target to a note id, so backlinks match the rebuilt notes. A link
  // from outside sensitive/ never resolves into it.
  private async rebuildLinks(job: Job): Promise<boolean> {
    const after = Number(job.cursor ?? "0");
    const rows = await this.env.DB.prepare("SELECT rowid AS r FROM links WHERE rowid > ? ORDER BY rowid LIMIT ?").bind(after, LINK_ROWS_PER_PAGE).all<{ r: number }>();
    const list = (rows.results ?? []).map((row) => row.r);
    if (!list.length) return true;
    const first = list[0]!;
    const last = list.at(-1)!;
    const file = "(CASE WHEN links.target LIKE '%.md' THEN links.target ELSE links.target || '.md' END)";
    const fence = "(n.path NOT LIKE 'sensitive/%' OR (SELECT s.path FROM notes s WHERE s.id = links.src_note_id) LIKE 'sensitive/%')";
    await this.env.DB.prepare(
      `UPDATE links SET dst_note_id = COALESCE(
         (SELECT n.id FROM notes n WHERE n.id != links.src_note_id AND n.status = 'active' AND ${fence}
            AND (n.path = links.target OR n.path = ${file} OR n.fact_key = links.target OR n.path LIKE '%/' || ${file}) LIMIT 1),
         (SELECT n.id FROM notes n, json_each(CASE WHEN json_valid(n.frontmatter) THEN n.frontmatter ELSE '{}' END, '$.aliases') a
            WHERE n.id != links.src_note_id AND n.status = 'active' AND ${fence} AND lower(a.value) = lower(links.target) LIMIT 1))
       WHERE rowid BETWEEN ? AND ?`,
    )
      .bind(first, last)
      .run();
    this.count(job, "links", list.length);
    job.cursor = String(last);
    return list.length < LINK_ROWS_PER_PAGE;
  }

  // Once the quarantine migration has run, any sys/quarantine/ record left over is deleted. Before it
  // has run, nothing here touches quarantine data.
  private async deleteQuarantineOrphans(job: Job): Promise<boolean> {
    if (!this.erasedAt()) return true;
    const page = await this.env.VAULT.list({ prefix: "sys/quarantine/", limit: 100 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) {
      await this.env.VAULT.delete(keys);
      this.count(job, "orphans_deleted", keys.length);
    }
    if (page.truncated) return false;
    if (job.counts.orphans_deleted) {
      await this.audit(job.actor, "quarantine_orphans_deleted", null, null, "ok", [], null, 0, JSON.stringify({ job_id: job.id, deleted: job.counts.orphans_deleted }));
    }
    return true;
  }

  // Reconcile: index files whose etag differs from D1, then forget rows whose object is missing.
  private async reconcileStep(job: Job, deadline: number): Promise<boolean> {
    if (job.phase === "start") {
      for (const name of ["scanned", "updated", "moved", "forgotten", "oversize"]) job.counts[name] = 0;
      this.nextPhase(job, "files");
    }
    const actor: Actor = { agentId: "reconcile", tokenId: "reconcile", client: "reconcile", requestId: job.actor.requestId, ipCountry: null };
    if (job.phase === "files") {
      const prefix = this.prefix();
      const page = await this.env.VAULT.list({ prefix, startAfter: job.cursor ?? undefined, limit: PAGE_OBJECTS });
      const live = await this.rowsByPath(page.objects.flatMap((object) => {
        const path = object.key.endsWith(".md") ? vaultPathFromKey(prefix, object.key) : null;
        return path ? [path] : [];
      }));
      let stopped = false;
      for (const object of page.objects) {
        if (Date.now() > deadline) {
          stopped = true;
          break;
        }
        await this.reconcileObject(job, object, live, actor);
        job.cursor = object.key;
      }
      if (!stopped && !page.truncated) this.nextPhase(job, "missing");
      return false;
    }
    if (job.phase === "missing") {
      const rows = await this.env.DB.prepare("SELECT path, r2_key FROM notes WHERE status = 'active' AND path > ? ORDER BY path LIMIT ?")
        .bind(job.cursor ?? "", PAGE_OBJECTS)
        .all<{ path: string; r2_key: string }>();
      const list = rows.results ?? [];
      for (const group of slices(list, R2_READ_CONCURRENCY)) {
        const heads = await Promise.all(group.map((row) => this.env.VAULT.head(row.r2_key)));
        for (const [index, head] of heads.entries()) {
          if (head) continue;
          await this.externalDelete(group[index]!.path, actor, JSON.stringify({ reason: "missing_object" }));
          this.count(job, "forgotten");
        }
      }
      if (list.length) job.cursor = list.at(-1)!.path;
      if (list.length < PAGE_OBJECTS) {
        // Oversize records whose object is gone go too.
        const records = await this.env.DB.prepare("SELECT path FROM oversize_files").all<{ path: string }>();
        for (const record of records.results ?? []) {
          if (!(await this.env.VAULT.head(r2KeyFor(this.prefix(), record.path)))) await this.clearOversize(record.path);
        }
        this.nextPhase(job, "quarantine");
      }
      return false;
    }
    if (job.phase === "quarantine") return this.deleteQuarantineOrphans(job);
    return true;
  }

  private async reconcileObject(job: Job, object: R2Object, live: Map<string, { r2_etag: string | null }>, actor: Actor): Promise<void> {
    const path = object.key.endsWith(".md") ? vaultPathFromKey(this.prefix(), object.key) : null;
    if (!path) return;
    this.count(job, "scanned");
    const row = live.get(path);
    if (row && normalizeEtag(row.r2_etag) && normalizeEtag(row.r2_etag) === normalizeEtag(object.etag)) return;
    if (object.size > FILE_LIMIT_BYTES) {
      if ((row as { status?: string } | undefined)?.status === "quarantined") return;
      await this.markOversize(path, object.size, normalizeEtag(object.etag), actor, JSON.stringify({ job_id: job.id }));
      this.count(job, "oversize");
      return;
    }
    const file = await this.env.VAULT.get(object.key);
    if (!file) return;
    const result = await this.indexBytes({ path, markdown: await file.text(), etag: normalizeEtag(file.etag), actor, action: "reconcile", reason: "reconcile" });
    if (result.ok && result.data.moved) this.count(job, "moved");
    else if (result.ok && !result.data.skipped) this.count(job, "updated");
  }

  // The quarantine erase. Lists D1 rows with status 'quarantined' and sys/quarantine/ records,
  // matches by exact note id or path, and hard-erases what matched. A dry run only counts.
  private async eraseStep(job: Job, deadline: number): Promise<boolean> {
    const actor: Actor = { agentId: "migration", tokenId: job.actor.tokenId, client: "migration", requestId: job.actor.requestId, ipCountry: null };
    if (job.phase === "start") {
      for (const name of ["records", "quarantined_notes", "unindexed_matches", "erased", "orphans_deleted", "errors", "alert_file", "total"]) job.counts[name] = 0;
      this.nextPhase(job, "notes");
    }
    if (job.phase === "notes") {
      const rows = await this.env.DB.prepare("SELECT * FROM notes WHERE status = 'quarantined' AND path > ? ORDER BY path LIMIT 25").bind(job.cursor ?? "").all<NoteRow>();
      const list = rows.results ?? [];
      for (const row of list) {
        this.count(job, "quarantined_notes");
        this.reportNote(job, row.id, row.path);
        if (!job.dry_run) {
          await this.eraseRow(row, actor, "quarantine_erased");
          this.count(job, "erased");
        }
        job.cursor = row.path;
        if (Date.now() > deadline) return false;
      }
      if (list.length < 25) this.nextPhase(job, "records");
      return false;
    }
    if (job.phase === "records") {
      const page = await this.env.VAULT.list({ prefix: "sys/quarantine/", startAfter: job.cursor ?? undefined, limit: PAGE_OBJECTS });
      for (const object of page.objects) {
        if (Date.now() > deadline) return false;
        this.count(job, "records");
        await this.eraseRecord(job, object.key, actor);
        job.cursor = object.key;
      }
      if (!page.truncated) this.nextPhase(job, "alert");
      return false;
    }
    if (job.phase === "alert") {
      const row = await this.noteByPath("inbox/quarantine.md");
      const key = r2KeyFor(this.prefix(), "inbox/quarantine.md");
      if (row) {
        job.counts.alert_file = 1;
        if (!job.dry_run) await this.eraseRow(row, actor, "quarantine_erased");
      } else if (await this.env.VAULT.head(key)) {
        job.counts.alert_file = 1;
        if (!job.dry_run) await this.env.VAULT.delete(key);
      }
      job.counts.total = (job.counts.records ?? 0) + (job.counts.quarantined_notes ?? 0);
      return true;
    }
    return true;
  }

  private async eraseRecord(job: Job, key: string, actor: Actor): Promise<void> {
    const object = await this.env.VAULT.get(key);
    let record: { path?: unknown; content_hash?: unknown } | null = null;
    try {
      const parsed = object ? (JSON.parse(await object.text()) as unknown) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed as { path?: unknown; content_hash?: unknown };
    } catch {
      record = null;
    }
    const path = typeof record?.path === "string" ? record.path : null;
    if (!record || !path || !/^[A-Za-z0-9][A-Za-z0-9_./-]*\.md$/.test(path) || path.includes("..")) {
      // A record that does not parse is an error, never a match.
      this.count(job, "errors");
      if (job.errors.length < 100) job.errors.push(`unparsed_record:${key}`);
      if (!job.dry_run) await this.env.VAULT.delete(key);
      return;
    }
    const erasedHere = job.report.paths.includes(path);
    const row = erasedHere ? null : await this.noteByPath(path);
    let matched = erasedHere || row?.status === "quarantined";
    if (!erasedHere && !row) {
      // No D1 row: the object at that exact path is the quarantined file, unless its HMAC shows it changed since.
      const file = await this.env.VAULT.get(r2KeyFor(this.prefix(), path));
      if (file) {
        const text = await file.text();
        const recorded = typeof record.content_hash === "string" ? record.content_hash : null;
        const current = await this.auditHash(text);
        if (!recorded || !current || recorded === current) {
          matched = true;
          this.count(job, "unindexed_matches");
          const id = stringField(parseMarkdown(text).frontmatter.vault_id) ?? file.customMetadata?.["vault-id"] ?? null;
          this.reportNote(job, id ?? "", path);
          if (!job.dry_run) {
            const keys = [r2KeyFor(this.prefix(), path), ...(id ? await this.historyKeys(id) : [])];
            await this.env.VAULT.delete(keys);
            await this.env.DB.prepare(
              `INSERT INTO tombstones (note_id, at, by_agent, reason, purged_at, content_hash, path) VALUES (?, ?, ?, 'quarantine_erased', ?, ?, ?)
               ON CONFLICT(note_id) DO UPDATE SET reason = excluded.reason, purged_at = excluded.purged_at`,
            )
              .bind(id || ulid(), new Date().toISOString(), actor.agentId, new Date().toISOString(), current ?? (await sha256Hex(text)), path)
              .run();
            this.count(job, "erased");
          }
        }
      }
    }
    if (!matched) this.count(job, "orphans_deleted");
    if (!job.dry_run) await this.env.VAULT.delete(key);
  }

  private reportNote(job: Job, id: string, path: string): void {
    if (job.report.paths.length >= 1000) return;
    if (id) job.report.note_ids.push(id);
    job.report.paths.push(path);
  }

  // ---- Lookups ------------------------------------------------------------------------------

  private cleanupAllowed(): boolean {
    return this.env.E2E_CLEANUP_ENABLED === "true" && stagingResources(this.env);
  }

  // A stored reply for (agent, key) inside the 7-day window. The same payload replays it; any
  // other payload is refused with 422. A row with no hash predates payload binding and replays.
  private async replay(agentId: string, idem: Idem): Promise<ApiResult | null> {
    if (!idem.key) return null;
    const row = await this.env.DB.prepare("SELECT response, at, payload_hash FROM idempotency WHERE agent_id = ? AND key = ?")
      .bind(agentId, idem.key)
      .first<{ response: string; at: string; payload_hash: string | null }>();
    if (!row) return null;
    if (Date.now() - Date.parse(row.at) > OPERATION_TTL_MS) return null;
    if (row.payload_hash && idem.hash && row.payload_hash !== idem.hash) throw keyReused();
    const parsed = JSON.parse(row.response) as { v?: number; status?: number; data?: { [key: string]: JsonValue }; pending?: boolean };
    if (parsed.pending) return null;
    if (parsed.v === 2 && parsed.data) return withStatus(parsed.data, parsed.status ?? 200);
    return { ok: true, data: parsed as { [key: string]: JsonValue } };
  }

  private rememberStatements(agentId: string, idem: Idem, data: { [key: string]: JsonValue }, status: number): D1PreparedStatement[] {
    if (!idem.key) return [];
    return [
      this.env.DB.prepare(
        `INSERT INTO idempotency (agent_id, key, response, at, payload_hash) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET response = excluded.response, at = excluded.at, payload_hash = excluded.payload_hash`,
      ).bind(agentId, idem.key, stored(status, data), new Date().toISOString(), idem.hash),
    ];
  }

  private async remember(agentId: string, idem: Idem, data: { [key: string]: JsonValue }, status: number): Promise<void> {
    const statements = this.rememberStatements(agentId, idem, data, status);
    if (statements.length) await this.env.DB.batch(statements);
  }

  private async noteByPath(path: string): Promise<NoteRow | null> {
    return this.env.DB.prepare("SELECT * FROM notes WHERE path = ?").bind(path).first<NoteRow>();
  }

  private async noteByOwnerKey(owner: string, key: string): Promise<NoteRow | null> {
    return this.env.DB.prepare("SELECT * FROM notes WHERE owner = ? AND fact_key = ? AND status = 'active'")
      .bind(owner, key)
      .first<NoteRow>();
  }

  private async resolveNote(id?: string, path?: string): Promise<NoteRow | null> {
    if (id) return this.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
    if (path) return this.noteByPath(path);
    return null;
  }

  private async chunkIds(noteId: string): Promise<string[]> {
    const rows = await this.env.DB.prepare("SELECT id FROM chunks WHERE note_id = ?").bind(noteId).all<{ id: string }>();
    return (rows.results ?? []).map((row) => row.id);
  }

  private async resolvedLinks(srcId: string, srcPath: string, targets: string[]): Promise<{ target: string; dst: string | null }[]> {
    const links: { target: string; dst: string | null }[] = [];
    for (const target of targets) {
      links.push({ target, dst: await this.lookupTarget(target, srcId, srcPath.startsWith("sensitive/")) });
    }
    return links;
  }

  private async lookupTarget(target: string, except: string, fromSensitive: boolean): Promise<string | null> {
    const file = target.endsWith(".md") ? target : `${target}.md`;
    const fence = fromSensitive ? "" : "AND path NOT LIKE 'sensitive/%'";
    const row = await this.env.DB.prepare(
      `SELECT id FROM notes WHERE id != ? AND status = 'active' ${fence} AND (path = ? OR path = ? OR fact_key = ? OR path LIKE ?) LIMIT 1`,
    )
      .bind(except, target, file, target, `%/${file}`)
      .first<{ id: string }>();
    if (row) return row.id;
    const candidates = await this.env.DB.prepare(
      `SELECT id, frontmatter FROM notes WHERE id != ? AND status = 'active' ${fence} AND instr(lower(frontmatter), lower(?)) > 0 LIMIT 20`,
    )
      .bind(except, `"${target.toLowerCase()}"`)
      .all<{ id: string; frontmatter: string }>();
    for (const candidate of candidates.results ?? []) {
      try {
        const fm = JSON.parse(candidate.frontmatter) as Frontmatter;
        if (stringList(fm.aliases).some((alias) => alias.toLowerCase() === target.toLowerCase())) return candidate.id;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async backfillLinks(id: string, path: string, factKey: string | null, aliases: string[]): Promise<void> {
    const names = [path, path.replace(/\.md$/, ""), factKey, ...aliases].filter((name): name is string => Boolean(name));
    for (const name of names) {
      await this.env.DB.prepare("UPDATE links SET dst_note_id = ? WHERE dst_note_id IS NULL AND target = ?").bind(id, name).run();
    }
  }

  private async deleteRunObjects(runId: string): Promise<void> {
    for (const prefix of [this.prefix(), "sys/history/"]) {
      const keys = await this.scanObjects(prefix, async (key, read) => key.includes(runId) || (await read()).includes(runId));
      if (!keys.length) continue;
      await this.env.VAULT.delete(keys);
      for (const key of keys) await this.env.DB.prepare("DELETE FROM note_versions WHERE r2_key = ?").bind(key).run();
    }
  }

  private async scanObjects(prefix: string, include: (key: string, read: () => Promise<string>) => Promise<boolean>): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.env.VAULT.list({ prefix, cursor, limit: 100 });
      for (const object of page.objects) {
        let loaded: string | undefined;
        const read = async () => {
          if (loaded !== undefined) return loaded;
          const file = await this.env.VAULT.get(object.key);
          loaded = file ? await file.text() : "";
          return loaded;
        };
        if (await include(object.key, read)) keys.push(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  private async runLeftovers(runId: string): Promise<{ notes: number; objects: number }> {
    const like = `%${runId}%`;
    const notes = await this.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM notes WHERE path LIKE ? ESCAPE '\\' OR owner LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
         + (SELECT COUNT(*) FROM journal_entries WHERE agent_id LIKE ? ESCAPE '\\')
         + (SELECT COUNT(*) FROM note_versions WHERE writer LIKE ? ESCAPE '\\' OR r2_key LIKE ? ESCAPE '\\')
         AS n`,
    )
      .bind(like, like, like, like, like, like)
      .first<{ n: number }>();
    let objects = 0;
    for (const prefix of [this.prefix(), "sys/history/"]) {
      let cursor: string | undefined;
      do {
        const page = await this.env.VAULT.list({ prefix, cursor, limit: 100 });
        for (const object of page.objects) {
          if (object.key.includes(runId)) {
            objects += 1;
            continue;
          }
          const file = await this.env.VAULT.get(object.key);
          if (file && (await file.text()).includes(runId)) objects += 1;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    return { notes: notes?.n ?? 0, objects };
  }

  private prefix(): string {
    return this.env.VAULT_PREFIX || "vault/";
  }
}

function idempotencyKeyOf(op: WriterOp): string | null {
  if (op.kind === "fact" || op.kind === "journal" || op.kind === "note" || op.kind === "forget") return op.idempotencyKey;
  return null;
}

function payloadHashOf(op: WriterOp): string | null {
  if (op.kind === "fact" || op.kind === "journal" || op.kind === "note" || op.kind === "forget") return op.payloadHash ?? null;
  return null;
}

type Idem = { key: string | null; hash: string | null };

function keyReused(): VaultError {
  return new VaultError("idempotency_key_reused", "This idempotency key was already used with a different payload", ["idempotency_key"]);
}

// Frontmatter that lets a rebuild restore a keyed write's reply: the key, the payload hash, the
// outcome, and whether it was rerouted. Nothing is written for a write without a key.
function idempotencyFields(idem: Idem, outcome: string, rerouted: boolean): Frontmatter {
  if (!idem.key) return {};
  return { vault_idempotency: idem.key, vault_idempotency_hash: idem.hash, vault_outcome: outcome, vault_rerouted: rerouted ? true : null };
}

function journalReply(entryId: string, path: string, route: string | null): { [key: string]: JsonValue } {
  return { entry_id: entryId, path, block_ref: `^${entryId}`, ...rerouteFields(route) };
}

// An update keeps what the stored note already is. The caller must be allowed to write the note as
// it is stored, may not change its domain, and cannot lower it to normal.
function keepClass(access: Access, existing: NoteRow, next: string | null): { domain: string | null; sensitivity: "normal" | "sensitive" } {
  const sensitivity = noteSensitivity(existing);
  if (!canWrite(access, existing.path, sensitivity, existing.domain)) throw new VaultError("forbidden_scope", "Scope does not allow this write");
  if (existing.domain && next && next !== existing.domain) throw new VaultError("invalid", "A write cannot change a note's domain", ["domain"]);
  return { domain: existing.domain ?? next, sensitivity };
}

// The created_at a stored note keeps across updates and rebuilds.
function createdAtOf(note: { frontmatter: string; created_at: string }): string {
  const fm = parseFrontmatter(note.frontmatter);
  return stringField(fm.vault_created_at) ?? stringField(fm.created_at) ?? note.created_at;
}

// Facts that can appear in profile/summary.md, or did before they changed.
function feedsSummary(note: { type: string; owner: string; path: string }): boolean {
  return note.type === "fact" && note.owner === "shared";
}

function fileTooLarge(): VaultError {
  return new VaultError("payload_too_large", "The stored file is over the file size limit", ["file"], { limit: "file" });
}

function jobRunning(id: string): VaultError {
  return new VaultError("job_running", "A job is already running", [id], { job_id: id });
}

function jobAuditName(kind: JobKind): string {
  if (kind === "reconcile") return "reconcile";
  if (kind === "quarantine-erase") return "quarantine_erase";
  return "reindex";
}

function jobView(job: Job): { [key: string]: JsonValue } {
  return {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    dry_run: job.dry_run,
    progress: { phase: job.phase, pages: job.pages, cursor: job.cursor },
    pages: job.pages,
    counts: job.counts,
    cursor: job.cursor,
    errors: job.errors,
    error: job.error,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

function grantsAllow(grants: Grants, segment: string): boolean {
  if (grants.admin) return true;
  if (segment === RESTRICTED) return false;
  return grants.sensitive.includes(segment);
}

function rerouteFields(route: string | null): { [key: string]: JsonValue } {
  return route ? { rerouted: true, sensitive_domain: route } : {};
}

function withStatus(data: { [key: string]: JsonValue }, status: number): ApiResult {
  return status === 200 ? { ok: true, data } : { ok: true, data, status };
}

function stored(status: number, data: { [key: string]: JsonValue }): string {
  return JSON.stringify({ v: 2, status, data });
}

function rememberFor(idem: Idem, status: number, data: (etag: string) => { [key: string]: JsonValue }): SaveInput["remember"] {
  return idem.key ? { key: idem.key, hash: idem.hash, status, data } : null;
}

function rerouteDetail(requested: string, domain: string): string {
  return JSON.stringify({ requested_path: requested, sensitive_domain: domain });
}

function factSave(
  id: string,
  path: string,
  markdown: string,
  facts: { key: string; owner: string; domain: string | null; sensitivity: string; observedAt: string },
  statementHash: string,
  actor: Actor,
): Omit<SaveInput, "ifMatch" | "create" | "reason" | "action"> {
  return {
    id,
    path,
    markdown,
    type: "fact",
    owner: facts.owner,
    domain: facts.domain,
    sensitivity: facts.sensitivity === "sensitive" ? "sensitive" : "normal",
    factKey: facts.key,
    title: facts.key,
    statementHash,
    observedAt: facts.observedAt,
    actor,
    journal: null,
  };
}

// The body a forgotten or moved note keeps. A keyed forget also records who forgot it, when, and
// its key and payload hash, which is the tombstone a rebuild restores the forget's reply from.
function forgottenStub(
  note: { id: string; type: string; owner: string; sensitivity: string; created_at?: string; frontmatter?: string },
  day: string,
  keyed: { by: string; at: string; idem: Idem } | null = null,
): string {
  const createdAt = note.created_at && note.frontmatter !== undefined ? createdAtOf({ created_at: note.created_at, frontmatter: note.frontmatter }) : null;
  const fm: Frontmatter = { vault_id: note.id, type: note.type, owner: note.owner, status: "forgotten", sensitivity: note.sensitivity, vault_created_at: createdAt };
  if (keyed?.idem.key) Object.assign(fm, { source: keyed.by, updated_at: keyed.at, vault_idempotency: keyed.idem.key, vault_idempotency_hash: keyed.idem.hash });
  return buildMarkdown(fm, `Forgotten on ${day}.`);
}

function isCurrent(row: { index_gen: number | null; r2_etag: string | null } | undefined, etag: string, gen: number): boolean {
  return Boolean(row && row.index_gen === gen && normalizeEtag(row.r2_etag) && normalizeEtag(row.r2_etag) === normalizeEtag(etag));
}

// Keeps the id in the file, then the id D1 had for the path, then the R2 metadata id, unless another
// path already owns it in D1 or earlier in this page. A copied file gets a fresh id.
function pickNoteId(path: string, candidates: (string | null)[], byId: Map<string, { path: string }>, assigned: Map<string, string>): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const livePath = byId.get(candidate)?.path;
    const stagedPath = assigned.get(candidate);
    if ((!livePath || livePath === path) && (!stagedPath || stagedPath === path)) return candidate;
  }
  return ulid();
}

function parseFrontmatter(json: string): Frontmatter {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Frontmatter) : {};
  } catch {
    return {};
  }
}

function normalizeEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  const value = etag.trim().replace(/^W\//, "").replaceAll('"', "");
  return value || null;
}

// Status comes from the file, except quarantine: only a D1 row can be quarantined, and the code
// that indexes a file never touches such a row (indexBytes skips it, and rebuild and reconcile
// refuse to start while one exists). A file that says `quarantined` is indexed by what it holds.
function noteStatus(frontmatter: Frontmatter): "active" | "forgotten" | "superseded" {
  const status = stringField(frontmatter.status);
  if (status === "forgotten" || status === "superseded") return status;
  return "active";
}

function storedSensitivity(frontmatter: Frontmatter, path: string, domain: string | null): "normal" | "sensitive" {
  if (inSensitiveFolder(path)) return "sensitive";
  if (stringField(frontmatter.sensitivity) === "sensitive") return "sensitive";
  return domain !== null && !isOrdinaryDomain(domain) ? "sensitive" : "normal";
}

function normalizeStatement(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function stripReserved(extra: Frontmatter): Frontmatter {
  const out: Frontmatter = {};
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith("vault_") || ["status", "owner", "type", "sensitivity", "summary", "domain", "created_at", "updated_at", "source"].includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function titleFromBody(body: string, path: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading?.[1]) return heading[1].trim().slice(0, 120);
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

function inferType(path: string): string {
  if (path.startsWith("profile/facts/")) return "fact";
  if (path.includes("/facts/")) return "fact";
  if (path.endsWith("/role.md")) return "role";
  if (path.includes("/journal-sensitive/") || path.includes("/journal/") || path.startsWith("journal/")) return "journal";
  if (path === "shared/decisions.md") return "decision";
  if (path === "profile/summary.md") return "profile";
  return "note";
}

function statementOnly(body: string): string {
  const paragraph = body.trim().split(/\n\s*\n/)[0] ?? "";
  return normalizeStatement(paragraph);
}

function copySourceVaultPath(
  copySource: { bucket?: string; object?: string } | string,
  prefix: string,
  bucketName: string,
): string | null {
  const bucket = typeof copySource === "string" ? null : copySource.bucket ?? null;
  const object = typeof copySource === "string" ? copySource : copySource.object ?? null;
  if (!object) return null;
  if (bucket && bucketName && bucket !== bucketName) return null;
  if (bucket) return vaultPathFromKey(prefix, object);
  const marker = `/${prefix}`;
  const at = object.lastIndexOf(marker);
  if (at >= 0) return vaultPathFromKey(prefix, object.slice(at + 1));
  if (object.startsWith(prefix)) return vaultPathFromKey(prefix, object);
  return null;
}

async function journalMac(env: Env, id: string, agent: string, title: string, body: string): Promise<string> {
  if (!env.JOURNAL_MAC_KEY) return "";
  const material = await sha256Hex(`${title}\n${body}`);
  return (await hmacSha256Hex(env.JOURNAL_MAC_KEY, `${id}:${agent}:${material}`)).slice(0, 16);
}

// The marker that carries a journal entry's idempotency key and payload hash. Its MAC binds both to
// the entry id and the writer, so a rebuild restores only what the server wrote.
async function journalIdempotencyMarker(env: Env, entryId: string, agent: string, key: string, hash: string | null): Promise<string> {
  const h = hash ?? "-";
  const mac = await idempotencyMac(env, entryId, agent, key, h);
  return `<!-- hiveattic:idempotency=${key} h=${h} mac=${mac} -->`;
}

async function idempotencyMac(env: Env, entryId: string, agent: string, key: string, hash: string): Promise<string> {
  if (!env.JOURNAL_MAC_KEY) return "";
  return (await hmacSha256Hex(env.JOURNAL_MAC_KEY, `idempotency:${entryId}:${agent}:${key}:${hash}`)).slice(0, 16);
}

// The idempotency row a rebuild restores for one MAC-checked journal entry, inside the 7-day window.
// An old marker with no hash restores the key without one, which replays for any payload.
async function journalIdempotencyRow(
  env: Env,
  entry: JournalEntry,
  agent: string,
  path: string,
): Promise<{ agent: string; key: string; hash: string | null; at: string; response: string } | null> {
  if (!entry.idempotency) return null;
  const time = ulidTime(entry.id);
  if (time === null || Date.now() - time > OPERATION_TTL_MS) return null;
  let hash: string | null = null;
  if (entry.idempotencyMac !== null) {
    const h = entry.idempotencyHash ?? "-";
    if ((await idempotencyMac(env, entry.id, agent, entry.idempotency, h)) !== entry.idempotencyMac) return null;
    hash = h === "-" ? null : h;
  }
  const route = journalRouteOf(path);
  return { agent, key: entry.idempotency, hash, at: new Date(time).toISOString(), response: stored(route ? 201 : 200, journalReply(entry.id, path, route)) };
}

// The route a stored journal path was written by: the writer's own PII day file, a sensitive folder, or none.
function journalRouteOf(path: string): string | null {
  if (piiJournalOwner(path)) return PII_ROUTE;
  return sensitiveSegment(path);
}

// The idempotency row a rebuild restores from a note's or fact's frontmatter, or from a keyed
// forget's stub, inside the 7-day window.
function frontmatterIdempotencyRow(
  fm: Frontmatter,
  file: { id: string; path: string; etag: string | null; type: string; status: string },
): { agent: string; key: string; hash: string | null; at: string; response: string } | null {
  const key = stringField(fm.vault_idempotency);
  const agent = stringField(fm.source);
  const at = stringField(fm.updated_at);
  if (!key || !agent || !at || Number.isNaN(Date.parse(at)) || Date.now() - Date.parse(at) > OPERATION_TTL_MS) return null;
  const hash = stringField(fm.vault_idempotency_hash) ?? null;
  if (file.status === "forgotten") return { agent, key, hash, at, response: stored(200, { id: file.id, path: file.path, status: "forgotten" }) };
  const outcome = stringField(fm.vault_outcome) ?? "restored";
  const reroute = fm.vault_rerouted === true ? sensitiveSegment(file.path) : null;
  const rerouted = rerouteFields(reroute);
  const data =
    file.type === "fact"
      ? { id: file.id, path: file.path, outcome, etag: file.etag, ...rerouted }
      : { id: file.id, path: file.path, etag: file.etag, outcome, ...rerouted };
  return { agent, key, hash, at, response: stored(reroute ? 201 : 200, data) };
}

async function journalMacMatches(env: Env, entry: JournalEntry): Promise<boolean> {
  if (!entry.mac) return false;
  const expected = await journalMac(env, entry.id, entry.agent, entry.title, entry.body);
  return expected === entry.mac;
}

export async function restoreJournalMarkers(env: Env, noteId: string, path: string, markdown: string, agentHint: string): Promise<void> {
  const now = new Date().toISOString();
  for (const entry of journalEntries(markdown)) {
    const agent = entry.agent || agentHint;
    if (!(await journalMacMatches(env, { ...entry, agent }))) continue;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO journal_entries (id, note_id, agent_id, at, title, block_ref, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(entry.id, noteId, agent, journalAt(entry.id, now), entry.title, `^${entry.id}`, entry.idempotency)
      .run();
    const restored = await journalIdempotencyRow(env, entry, agent, path);
    if (restored) {
      await env.DB.prepare(`INSERT OR IGNORE INTO idempotency (agent_id, key, response, at, payload_hash) VALUES (?, ?, ?, ?, ?)`)
        .bind(restored.agent, restored.key, restored.response, restored.at, restored.hash)
        .run();
    }
  }
}

// When a journal entry was written: the time in its ULID, or the fallback.
function journalAt(entryId: string, fallback: string): string {
  const time = ulidTime(entryId);
  return time === null ? fallback : new Date(time).toISOString();
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return "error";
}

type CleanupNote = {
  id: string;
  path: string;
  body: string;
  owner: string;
  type: string;
  title: string | null;
  sensitivity: string;
  domain: string | null;
  r2_etag: string | null;
};

function stripRunContent(markdown: string, runId: string): { markdown: string; empty: boolean; changed: boolean } {
  const parsed = parseMarkdown(markdown);
  const pieces = parsed.body.split(/\n(?=## )/);
  const kept = pieces.filter((piece) => !piece.includes(runId));
  const changed = kept.length !== pieces.length;
  if (!changed) return { markdown, empty: false, changed: false };
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const hasSection = kept.some((piece) => piece.trimStart().startsWith("## "));
  const leftover = body.replace(/^#[^\n]*$/gm, "").trim();
  const empty = !hasSection && leftover.length === 0;
  const next = Object.keys(parsed.frontmatter).length > 0 ? buildMarkdown(parsed.frontmatter, body) : body ? `${body}\n` : "";
  return { markdown: next, empty, changed: true };
}

