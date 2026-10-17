import { DurableObject } from "cloudflare:workers";
import { classifySensitive, inspectWrite, type PolicyTerm } from "./filters";
import { hash8, hmacSha256Hex, sha256Hex, ulid } from "./crypto";
import { failure, VaultError, type ApiResult, type JsonValue } from "./errors";
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
  textForFilter,
  type Frontmatter,
  type JournalEntry,
} from "./markdown";
import { domainOf } from "./access";
import { stagingResources } from "./query";
import { isAppendOnlyPath, isFactPath, isGeneratedNote, journalPath, ownerForPath, r2KeyFor, vaultPathFromKey } from "./paths";
import { etStamp, versionStamp, within24h } from "./time";

export type Actor = {
  agentId: string;
  tokenId: string;
  client: string;
  requestId: string;
  ipCountry: string | null;
};

export type WriterOp =
  | {
      kind: "fact";
      actor: Actor;
      key: string;
      statement: string;
      scope: "own" | "shared";
      domain: string | null;
      observedAt: string;
      confidence: number;
      tags: string[];
      links: string[];
      idempotencyKey: string | null;
      sensitivity: "normal" | "sensitive";
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
      domain: string | null;
      sensitivity: "normal" | "sensitive";
    }
  | {
      kind: "note";
      actor: Actor;
      path: string;
      body: string;
      extra: Frontmatter;
      ifMatch: string | null;
      sensitivity: "normal" | "sensitive";
      domain: string | null;
      noteType: string;
    }
  | { kind: "forget"; actor: Actor; path?: string; id?: string; reason: string }
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
  | { kind: "rebuild" }
  | { kind: "reconcile" }
  | { kind: "replay" }
  | { kind: "cleanup"; actor: Actor; runId: string };

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

export class VaultWriter extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS write_intents (
          op_id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          prev_etag TEXT,
          new_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
      );
      await this.replayIntents();
      const alarm = await ctx.storage.getAlarm();
      if (alarm === null) await ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  async alarm(): Promise<void> {
    const run = this.tail.then(() => this.replayIntents(), () => this.replayIntents());
    this.tail = run.then(() => undefined, () => undefined);
    await run;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async replayPending(): Promise<{ replayed: number; dropped: number }> {
    const run = this.tail.then(() => this.replayIntents(), () => this.replayIntents());
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async perform(op: WriterOp): Promise<ApiResult> {
    const run = this.tail.then(() => this.dispatch(op), () => this.dispatch(op));
    this.tail = run.then(() => undefined, () => undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(failure(new VaultError("invalid", "Write timed out"))), 25_000);
      run.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(failure(new VaultError("invalid", "Write failed")));
        },
      );
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
        return this.purge(op.id, op.path, op.actor, true);
      case "bootstrap":
        return this.bootstrap(op);
      case "external":
        return this.external(op);
      case "rebuild":
        return this.rebuild();
      case "reconcile":
        return this.reconcile();
      case "replay":
        return this.replayIntents().then((data) => ({ ok: true as const, data }));
      case "cleanup":
        return this.cleanup(op);
      default:
        return failure(new VaultError("invalid", "Unknown write"));
    }
  }

  private async fact(op: Extract<WriterOp, { kind: "fact" }>): Promise<ApiResult> {
    const replay = await this.replay(op.actor.agentId, op.idempotencyKey);
    if (replay) return { ok: true, data: replay };
    const owner = op.scope === "shared" ? "shared" : op.actor.agentId;
    const path = op.scope === "shared" ? `profile/facts/${op.key}.md` : `bots/${op.actor.agentId}/facts/${op.key}.md`;
    const existing = await this.noteByOwnerKey(owner, op.key);
    const statementHash = await sha256Hex(normalizeStatement(op.statement));
    if (existing && existing.statement_hash === statementHash && existing.status === "active") {
      await this.env.DB.prepare("UPDATE notes SET last_confirmed_at = ? WHERE id = ?").bind(new Date().toISOString(), existing.id).run();
      const data = { id: existing.id, path: existing.path, outcome: "deduped", etag: existing.r2_etag };
      await this.remember(op.actor.agentId, op.idempotencyKey, data);
      return { ok: true, data };
    }
    // Tie-break is (observed_at, server written_at). Equal observed_at lets the incoming write win:
    // the Durable Object serializes writes, so this call is the later server write.
    const incomingNewer = !existing?.observed_at || Date.parse(op.observedAt) >= Date.parse(existing.observed_at);
    const crossBot = Boolean(existing && existing.last_writer !== op.actor.agentId);
    const conflict = Boolean(existing && crossBot && within24h(existing.observed_at, op.observedAt) && existing.statement_hash !== statementHash);
    const id = existing?.id ?? ulid();
    const markdown = this.factMarkdown({
      id,
      path,
      owner,
      key: op.key,
      statement: op.statement,
      domain: op.domain,
      sensitivity: op.sensitivity,
      observedAt: op.observedAt,
      confidence: op.confidence,
      tags: op.tags,
      links: op.links,
      source: op.actor.agentId,
      idempotencyKey: op.idempotencyKey,
      status: "active",
      supersedes: null,
    });
    if (existing && !incomingNewer) {
      const loserTs = await this.snapshotBytes(existing, markdown, op.actor.agentId, "superseded");
      if (conflict) await this.flagConflict(op.key, existing.id, loserTs, op.actor, op.observedAt, existing.observed_at);
      const data = {
        id: existing.id,
        path: existing.path,
        outcome: conflict ? "conflict_flagged" : "superseded_older",
        etag: existing.r2_etag,
      };
      await this.remember(op.actor.agentId, op.idempotencyKey, data);
      await this.audit(op.actor, "write_fact", existing.path, existing.id, "ok", [], await sha256Hex(markdown), markdown.length);
      return { ok: true, data };
    }
    const supersedes = existing?.version_ts ?? null;
    const markdownWithLink = existing
      ? this.factMarkdown({
          id,
          path,
          owner,
          key: op.key,
          statement: op.statement,
          domain: op.domain,
          sensitivity: op.sensitivity,
          observedAt: op.observedAt,
          confidence: op.confidence,
          tags: op.tags,
          links: op.links,
          source: op.actor.agentId,
          idempotencyKey: op.idempotencyKey,
          status: "active",
          supersedes,
        })
      : markdown;
    const saved = await this.saveMarkdown({
      id,
      path,
      markdown: markdownWithLink,
      type: "fact",
      owner,
      domain: op.domain,
      sensitivity: op.sensitivity,
      factKey: op.key,
      title: op.key,
      statementHash,
      observedAt: op.observedAt,
      actor: op.actor,
      ifMatch: existing?.r2_etag ?? null,
      create: !existing,
      reason: existing ? "updated" : "created",
      action: "write_fact",
      idempotencyKey: op.idempotencyKey,
      journal: null,
    });
    if (!saved.ok) return saved;
    if (conflict && existing) await this.flagConflict(op.key, id, existing.version_ts ?? existing.id, op.actor, op.observedAt, existing.observed_at);
    if (op.scope === "shared") await this.refreshSummary(op.actor);
    const data = {
      id,
      path,
      outcome: conflict ? "conflict_flagged" : existing ? "updated" : "created",
      etag: saved.data.etag,
    };
    await this.remember(op.actor.agentId, op.idempotencyKey, data);
    return { ok: true, data };
  }

  private factMarkdown(input: {
    id: string;
    path: string;
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
    idempotencyKey: string | null;
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
        vault_idempotency: input.idempotencyKey,
        supersedes: input.supersedes,
      },
      body,
    );
  }

  private async journal(op: Extract<WriterOp, { kind: "journal" }>): Promise<ApiResult> {
    const replay = await this.replay(op.actor.agentId, op.idempotencyKey);
    if (replay) return { ok: true, data: replay };
    const stamp = etStamp(op.at, this.env.TZ_DISPLAY || "UTC");
    const text = `${op.title}\n${op.body}`;
    const sensitive = op.sensitivity === "sensitive" || classifySensitive(text, op.domain);
    if (sensitive && op.target !== "own") {
      throw new VaultError("invalid", "A sensitive journal entry stays in your own journal. Shared day files stay normal.");
    }
    const path = journalPath(op.actor.agentId, op.target, stamp.date, sensitive && op.target === "own");
    const entryId = ulid();
    const body = guardJournalBody(op.body).trim();
    const mac = await journalMac(this.env, entryId, op.actor.agentId, op.title, body);
    let attempt = 0;
    while (attempt < 3) {
      attempt += 1;
      const current = await this.noteByPath(path);
      if (current && current.status !== "active") {
        throw new VaultError("conflict_etag", `Cannot append to a ${current.status} note`, [current.status]);
      }
      const previous = current?.body ?? "";
      const entry = [
        `## ${stamp.heading} · ${op.actor.agentId} · ${op.title} ^${entryId}`,
        body,
        op.tags.length ? `Tags: ${op.tags.join(", ")}` : "",
        `<!-- hiveattic:e=${entryId}:${op.actor.agentId}:${mac} -->`,
        op.idempotencyKey ? `<!-- hiveattic:idempotency=${op.idempotencyKey} -->` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const markdown = current
        ? `${previous.endsWith("\n") ? previous : `${previous}\n`}\n${entry}\n`
        : buildMarkdown(
            {
              vault_id: ulid(),
              type: op.target === "decisions" ? "decision" : "journal",
              owner: op.target === "own" ? op.actor.agentId : "shared",
              status: "active",
              source: op.actor.agentId,
              updated_at: stamp.iso,
              sensitivity: sensitive ? "sensitive" : "normal",
              domain: op.domain,
            },
            `${op.target === "decisions" ? "# Decisions\n\n" : `# ${stamp.date}\n\n`}${entry}\n`,
          );
      if (current && !markdown.startsWith(previous)) throw new VaultError("invalid", "Journal append would rewrite earlier entries");
      const id = current?.id ?? stringField(parseMarkdown(markdown).frontmatter.vault_id) ?? ulid();
      const saved = await this.saveMarkdown({
        id,
        path,
        markdown,
        type: op.target === "decisions" ? "decision" : "journal",
        owner: op.target === "own" ? op.actor.agentId : "shared",
        domain: op.domain,
        sensitivity: sensitive ? "sensitive" : "normal",
        factKey: null,
        title: current?.title ?? (op.target === "decisions" ? "Decisions" : stamp.date),
        statementHash: null,
        observedAt: stamp.iso,
        actor: op.actor,
        ifMatch: current?.r2_etag ?? null,
        create: !current,
        reason: current ? "appended" : "created",
        action: "append_journal",
        idempotencyKey: null,
        journal: { id: entryId, title: op.title, at: stamp.iso, idempotencyKey: op.idempotencyKey },
        allowRetry: true,
      });
      if (saved.ok) {
        const data = { entry_id: entryId, path, block_ref: `^${entryId}`, etag: saved.data.etag };
        await this.remember(op.actor.agentId, op.idempotencyKey, data);
        return { ok: true, data };
      }
      if (saved.error.code !== "conflict_etag" || attempt === 3) return saved;
    }
    return failure(new VaultError("conflict_etag", "Journal changed while appending"));
  }

  private async note(op: Extract<WriterOp, { kind: "note" }>): Promise<ApiResult> {
    if (isAppendOnlyPath(op.path) || isFactPath(op.path) || op.path === "profile/summary.md") {
      throw new VaultError("invalid", "That path is append-only or server-managed");
    }
    const existing = await this.noteByPath(op.path);
    if (existing && existing.status !== "active") {
      throw new VaultError("conflict_etag", `Cannot write to a ${existing.status} note`, [existing.status]);
    }
    if (existing && normalizeEtag(op.ifMatch) !== normalizeEtag(existing.r2_etag)) {
      throw new VaultError("conflict_etag", existing ? "if_match does not match the current etag" : "if_match does not match");
    }
    const id = existing?.id ?? ulid();
    const now = new Date().toISOString();
    const markdown = buildMarkdown(
      {
        ...stripReserved(op.extra),
        vault_id: id,
        type: op.noteType,
        owner: ownerForPath(op.path),
        domain: op.domain,
        sensitivity: op.sensitivity,
        status: "active",
        source: op.actor.agentId,
        updated_at: now,
        tags: stringList(op.extra.tags),
        aliases: stringList(op.extra.aliases),
      },
      op.body,
    );
    const saved = await this.saveMarkdown({
      id,
      path: op.path,
      markdown,
      type: op.noteType,
      owner: ownerForPath(op.path),
      domain: op.domain,
      sensitivity: op.sensitivity,
      factKey: null,
      title: stringField(op.extra.title) ?? titleFromBody(op.body, op.path),
      statementHash: null,
      observedAt: stringField(op.extra.observed_at) ?? now,
      actor: op.actor,
      ifMatch: existing?.r2_etag ?? null,
      create: !existing,
      reason: existing ? "updated" : "created",
      action: "write_note",
      idempotencyKey: null,
      journal: null,
    });
    if (!saved.ok) return saved;
    return { ok: true, data: { id, path: op.path, etag: saved.data.etag, outcome: existing ? "updated" : "created" } };
  }

  private async forget(op: Extract<WriterOp, { kind: "forget" }>): Promise<ApiResult> {
    const note = await this.resolveNote(op.id, op.path);
    if (!note) throw new VaultError("not_found", "Note not found");
    if (note.status === "forgotten") {
      return { ok: true, data: { id: note.id, path: note.path, status: "forgotten" } };
    }
    const chunkIds = await this.chunkIds(note.id);
    const now = new Date().toISOString();
    const day = etStamp(now).date;
    const stub = buildMarkdown(
      { vault_id: note.id, type: note.type, owner: note.owner, status: "forgotten", sensitivity: note.sensitivity },
      `Forgotten on ${day}: ${op.reason}`,
    );
    await this.snapshotBytes(note, note.body, op.actor.agentId, "forgotten");
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
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE notes SET body = ?, frontmatter = ?, content_hash = ?, status = 'forgotten', r2_etag = ?, updated_at = ?, version_ts = ?, last_writer = ?
         WHERE id = ?`,
      ).bind(stub, JSON.stringify(parseMarkdown(stub).frontmatter), hash, etag.etag, now, etag.versionTs, op.actor.agentId, note.id),
      this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ?").bind(note.id),
      this.env.DB.prepare(
        `INSERT INTO tombstones (note_id, at, by_agent, reason, content_hash) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET at = excluded.at, reason = excluded.reason, content_hash = excluded.content_hash`,
      ).bind(note.id, now, op.actor.agentId, op.reason, note.content_hash),
      this.env.DB.prepare(
        `INSERT INTO note_versions (note_id, version_ts, r2_key, content_hash, writer, reason) VALUES (?, ?, ?, ?, ?, 'forgotten')`,
      ).bind(note.id, etag.versionTs, r2KeyFor(this.prefix(), note.path), hash, op.actor.agentId),
      ...chunkIds.map((chunkId) =>
        this.env.DB.prepare(
          `INSERT INTO vector_delete_queue (chunk_id, note_id, requested_at) VALUES (?, ?, ?)
           ON CONFLICT(chunk_id) DO UPDATE SET requested_at = excluded.requested_at`,
        ).bind(chunkId, note.id, now),
      ),
    ]);
    this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", intentId);
    await this.audit(op.actor, "forget", note.path, note.id, "ok", [], hash, stub.length);
    await this.enqueue({ kind: "forget", note_id: note.id, chunk_ids: chunkIds });
    return { ok: true, data: { id: note.id, path: note.path, status: "forgotten" } };
  }

  private async restore(op: Extract<WriterOp, { kind: "restore" }>): Promise<ApiResult> {
    const note = await this.resolveNote(op.id, op.path);
    if (!note) throw new VaultError("not_found", "Note not found");
    const version = await this.env.DB.prepare(
      "SELECT r2_key, content_hash, version_ts FROM note_versions WHERE note_id = ? AND version_ts = ?",
    )
      .bind(note.id, op.versionTs)
      .first<{ r2_key: string; content_hash: string; version_ts: string }>();
    if (!version) throw new VaultError("not_found", "Version not found");
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
      idempotencyKey: null,
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
      await this.indexBytes({
        path: file.path,
        markdown: file.markdown,
        etag: null,
        actor: op.actor,
        action: "bootstrap",
        write: true,
        reason: "created",
      });
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
    if (deleting) return this.externalDelete(path, actor, detail);
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
      return { ok: true, data: { skipped: true, reason: "unchanged" } };
    }
    const markdown = await object.text();
    const hit = await this.contentHit(path, markdown);
    if (hit) {
      await this.quarantine(path, markdown, hit.reasons, actor, true, actionName, detail, objectEtag);
      return { ok: true, data: { quarantined: true, path, reasons: hit.reasons } };
    }
    return this.indexBytes({
      path,
      markdown,
      etag: objectEtag,
      actor,
      action: actionName,
      write: false,
      reason: "external-edit",
      detail,
    });
  }

  private async externalDelete(path: string, actor: Actor, detail: string): Promise<ApiResult> {
    const note = await this.noteByPath(path);
    if (!note) return { ok: true, data: { skipped: true, reason: "unknown_delete" } };
    if (note.status === "forgotten") return { ok: true, data: { id: note.id, path, status: "forgotten" } };
    const chunkIds = await this.chunkIds(note.id);
    const now = new Date().toISOString();
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE notes SET status = 'forgotten', updated_at = ?, last_writer = ? WHERE id = ?").bind(now, actor.agentId, note.id),
      this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ?").bind(note.id),
      this.env.DB.prepare(
        `INSERT INTO tombstones (note_id, at, by_agent, reason, content_hash) VALUES (?, ?, ?, 'external_delete', ?)
         ON CONFLICT(note_id) DO UPDATE SET at = excluded.at, reason = excluded.reason`,
      ).bind(note.id, now, actor.agentId, note.content_hash),
      ...chunkIds.map((chunkId) =>
        this.env.DB.prepare(
          `INSERT INTO vector_delete_queue (chunk_id, note_id, requested_at) VALUES (?, ?, ?)
           ON CONFLICT(chunk_id) DO UPDATE SET requested_at = excluded.requested_at`,
        ).bind(chunkId, note.id, now),
      ),
    ]);
    await this.audit(actor, "external_delete", path, note.id, "ok", [], note.content_hash, 0, detail);
    return { ok: true, data: { id: note.id, path, status: "forgotten" } };
  }

  private async rebuild(): Promise<ApiResult> {
    await this.prepareStage();
    let imported = 0;
    let cursor: string | undefined;
    const actor: Actor = { agentId: "rebuild", tokenId: "rebuild", client: "indexer", requestId: ulid(), ipCountry: null };
    const tombstones: { id: string; hash: string }[] = [];
    do {
      const page = await this.env.VAULT.list({ prefix: this.prefix(), cursor, limit: 100 });
      for (const object of page.objects) {
        if (!object.key.endsWith(".md")) continue;
        const path = vaultPathFromKey(this.prefix(), object.key);
        if (!path) continue;
        const file = await this.env.VAULT.get(object.key);
        if (!file) continue;
        const text = await file.text();
        const tombstone = await this.stageVaultFile(path, text, normalizeEtag(file.etag), actor, file.customMetadata?.["vault-id"] ?? null);
        if (tombstone) tombstones.push(tombstone);
        imported += 1;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const now = new Date().toISOString();
    const swap = [
      this.env.DB.prepare("DELETE FROM links"),
      this.env.DB.prepare("DELETE FROM journal_entries"),
      this.env.DB.prepare("DELETE FROM note_versions"),
      this.env.DB.prepare("DELETE FROM chunks"),
      this.env.DB.prepare("DELETE FROM idempotency"),
      this.env.DB.prepare("DELETE FROM notes"),
      this.env.DB.prepare("INSERT INTO notes SELECT * FROM notes_stage"),
      this.env.DB.prepare("INSERT INTO chunks SELECT * FROM chunks_stage"),
      this.env.DB.prepare(
        `INSERT INTO journal_entries (id, note_id, agent_id, at, title, block_ref, idempotency_key)
         SELECT id, note_id, agent_id, at, title, block_ref, idempotency_key FROM journal_stage`,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency (agent_id, key, response, at)
         SELECT agent_id, idempotency_key,
           json_object('entry_id', id, 'block_ref', block_ref, 'path', path),
           at
         FROM journal_stage WHERE idempotency_key IS NOT NULL`,
      ),
      ...tombstones.map((row) =>
        this.env.DB.prepare(
          `INSERT INTO tombstones (note_id, at, by_agent, reason, content_hash) VALUES (?, ?, 'rebuild', 'forgotten', ?)
           ON CONFLICT(note_id) DO NOTHING`,
        ).bind(row.id, now, row.hash),
      ),
    ];
    await this.env.DB.batch(swap);
    await this.env.DB.batch([
      this.env.DB.prepare("DROP TABLE journal_stage"),
      this.env.DB.prepare("DROP TABLE chunks_stage"),
      this.env.DB.prepare("DROP TABLE notes_stage"),
    ]);
    await this.env.DB.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')").run();
    let versions = 0;
    let historyCursor: string | undefined;
    do {
      const page = await this.env.VAULT.list({ prefix: "sys/history/", cursor: historyCursor, limit: 200 });
      for (const object of page.objects) {
        const parsed = /^sys\/history\/([^/]+)\/([^-]+)-([0-9a-f]{8})\.md$/.exec(object.key);
        if (!parsed) continue;
        const note = await this.env.DB.prepare("SELECT id FROM notes WHERE id = ?").bind(parsed[1]).first<{ id: string }>();
        if (!note) continue;
        const file = await this.env.VAULT.get(object.key);
        if (!file) continue;
        const text = await file.text();
        const hash = await sha256Hex(text);
        await this.env.DB.prepare(
          `INSERT OR IGNORE INTO note_versions (note_id, version_ts, r2_key, content_hash, writer, reason)
           VALUES (?, ?, ?, ?, 'rebuild', 'history')`,
        )
          .bind(parsed[1], parsed[2], object.key, hash)
          .run();
        versions += 1;
      }
      historyCursor = page.truncated ? page.cursor : undefined;
    } while (historyCursor);
    const count = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>();
    return { ok: true, data: { imported, versions, notes: count?.n ?? 0 } };
  }

  private async prepareStage(): Promise<void> {
    await this.env.DB.prepare("DROP TABLE IF EXISTS journal_stage").run();
    await this.env.DB.prepare("DROP TABLE IF EXISTS chunks_stage").run();
    await this.env.DB.prepare("DROP TABLE IF EXISTS notes_stage").run();
    await this.env.DB.prepare("CREATE TABLE notes_stage AS SELECT * FROM notes WHERE 0").run();
    await this.env.DB.prepare("CREATE TABLE chunks_stage AS SELECT * FROM chunks WHERE 0").run();
    await this.env.DB.prepare(
      `CREATE TABLE journal_stage (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        at TEXT NOT NULL,
        title TEXT NOT NULL,
        block_ref TEXT NOT NULL,
        idempotency_key TEXT,
        path TEXT NOT NULL
      )`,
    ).run();
  }

  private async stageVaultFile(
    path: string,
    markdown: string,
    etag: string | null,
    actor: Actor,
    metaId: string | null = null,
  ): Promise<{ id: string; hash: string } | null> {
    const hit = await this.contentHit(path, markdown);
    const id = await this.existingNoteId(path, markdown, metaId);
    let stored = markdown;
    let forced: string | null = null;
    if (hit) {
      stored = buildMarkdown(
        { vault_id: id, type: inferType(path), status: "quarantined", sensitivity: "sensitive", owner: ownerForPath(path) },
        "This note was quarantined by the content filter.",
      );
      forced = "quarantined";
      const redacted = await this.auditHash(markdown);
      await this.env.VAULT.put(
        `sys/quarantine/${redacted ?? ulid()}.json`,
        JSON.stringify({
          path,
          at: new Date().toISOString(),
          reason_codes: hit.reasons,
          content_hash: redacted,
          agent_id: actor.agentId,
          run_id: runMarker(path),
        }),
        { httpMetadata: { contentType: "application/json" } },
      );
    }
    const again = parseMarkdown(stored);
    const fmStatus = stringField(again.frontmatter.status);
    const status = forced ?? (fmStatus === "forgotten" || fmStatus === "quarantined" ? fmStatus : "active");
    const type = stringField(again.frontmatter.type) ?? inferType(path);
    const owner = stringField(again.frontmatter.owner) ?? ownerForPath(path);
    const domain = domainOf(path) ?? stringField(again.frontmatter.domain) ?? null;
    const sensitivity = stringField(again.frontmatter.sensitivity) === "sensitive" || classifySensitive(stored, domain) ? "sensitive" : "normal";
    const title = stringField(again.frontmatter.key) ?? stringField(again.frontmatter.title) ?? titleFromBody(again.body, path);
    const now = new Date().toISOString();
    const hash = await sha256Hex(stored);
    const statementHash = type === "fact" ? await sha256Hex(statementOnly(again.body)) : null;
    await this.env.DB.prepare(
      `INSERT INTO notes_stage (
        id, path, type, owner, domain, sensitivity, fact_key, title, body, frontmatter, content_hash, statement_hash,
        r2_etag, r2_key, status, observed_at, created_at, updated_at, version_ts, last_writer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        path,
        type,
        owner,
        domain,
        sensitivity,
        type === "fact" ? (stringField(again.frontmatter.key) ?? null) : null,
        title,
        stored,
        JSON.stringify(again.frontmatter),
        hash,
        statementHash,
        etag,
        r2KeyFor(this.prefix(), path),
        status,
        stringField(again.frontmatter.observed_at) ?? null,
        now,
        stringField(again.frontmatter.updated_at) ?? now,
        versionStamp(),
        stringField(again.frontmatter.source) ?? actor.agentId,
      )
      .run();
    if (status === "active") {
      for (const chunk of chunkMarkdown(path, title, again.body)) {
        await this.env.DB.prepare(
          "INSERT INTO chunks_stage (id, note_id, n, text, title, path, token_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(`${id}:${chunk.n}`, id, chunk.n, chunk.text, title, path, chunk.tokenCount)
          .run();
      }
    }
    if (type === "journal" || type === "decision") await this.stageJournal(id, path, stored, owner, now);
    if (status === "forgotten") return { id, hash };
    return null;
  }

  private async stageJournal(noteId: string, path: string, markdown: string, owner: string, at: string): Promise<void> {
    for (const entry of journalEntries(markdown)) {
      const agent = entry.agent || owner;
      if (!(await journalMacMatches(this.env, { ...entry, agent }))) continue;
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO journal_stage (id, note_id, agent_id, at, title, block_ref, idempotency_key, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(entry.id, noteId, agent, at, entry.title, `^${entry.id}`, entry.idempotency, path)
        .run();
    }
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
        await this.purge(row.id, row.path, op.actor, false);
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
        idempotencyKey: null,
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
    await this.env.DB.prepare("DELETE FROM policy_terms WHERE term LIKE ? ESCAPE '\\'").bind(like).run();
    const runVersions = await this.env.DB.prepare("SELECT r2_key FROM note_versions WHERE writer LIKE ? ESCAPE '\\'")
      .bind(like)
      .all<{ r2_key: string }>();
    const versionKeys = (runVersions.results ?? []).map((row) => row.r2_key).filter((key) => key.startsWith("sys/"));
    if (versionKeys.length) await this.env.VAULT.delete(versionKeys);
    await this.env.DB.prepare("DELETE FROM note_versions WHERE writer LIKE ? ESCAPE '\\'").bind(like).run();
    await this.deleteRunObjects(op.runId);
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
      JSON.stringify({ run_id: op.runId, purged, rewritten, ...remaining }),
    );
    return { ok: true, data: { purged, rewritten, remaining_notes: remaining.notes, remaining_objects: remaining.objects } };
  }

  private async saveMarkdown(input: {
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
    idempotencyKey: string | null;
    journal: { id: string; title: string; at: string; idempotencyKey: string | null } | null;
    allowRetry?: boolean;
    skipPut?: boolean;
    storedEtag?: string | null;
    detail?: string | null;
  }): Promise<ApiResult<{ etag: string }>> {
    const existing = input.create ? null : await this.noteByPath(input.path);
    const appending = input.reason === "appended" || input.reason === "quarantine-alert" || input.reason === "conflict";
    if (existing && !appending && input.reason !== "cleanup" && input.reason !== "rebuild" && input.reason !== "replay") {
      await this.snapshotBytes(existing, existing.body, input.actor.agentId, input.reason);
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
    const put = input.skipPut
      ? { etag: input.storedEtag ?? "", versionTs: versionStamp() }
      : await this.putVault(input.path, input.markdown, input.id, input.create ? null : input.ifMatch);
    if (!put || (input.skipPut && !input.storedEtag)) {
      if (!input.skipPut) this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", intentId);
      if (input.allowRetry) return failure(new VaultError("conflict_etag", "Concurrent write changed the object"));
      throw new VaultError("conflict_etag", "etag precondition failed");
    }
    const now = new Date().toISOString();
    const parsed = parseMarkdown(input.markdown);
    const fmStatus = stringField(parsed.frontmatter.status);
    const status = fmStatus === "forgotten" || fmStatus === "quarantined" ? fmStatus : "active";
    const frontmatter = JSON.stringify(parsed.frontmatter);
    const chunks = appending && existing ? [] : chunkMarkdown(input.path, input.title, parsed.body);
    const appendedChunks = appending && existing ? chunkMarkdown(input.path, input.title, input.markdown.startsWith(existing.body) ? input.markdown.slice(existing.body.length) : parsed.body) : [];
    const linkSource = appending && existing && input.markdown.startsWith(existing.body) ? input.markdown.slice(existing.body.length) : parsed.body;
    const links = await this.resolvedLinks(input.id, linkTargets(linkSource));
    const versionTs = versionStamp();
    const r2Key = r2KeyFor(this.prefix(), input.path);
    const statements = [];
    if (input.create) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO notes (
            id, path, type, owner, domain, sensitivity, fact_key, title, body, frontmatter, content_hash, statement_hash,
            r2_etag, r2_key, status, observed_at, created_at, updated_at, version_ts, last_writer, last_confirmed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          now,
          now,
          versionTs,
          input.actor.agentId,
          now,
        ),
      );
    } else {
      statements.push(
        this.env.DB.prepare(
          `UPDATE notes SET type = ?, owner = ?, domain = ?, sensitivity = ?, fact_key = ?, title = ?, body = ?, frontmatter = ?,
           content_hash = ?, statement_hash = ?, r2_etag = ?, status = ?, observed_at = ?, updated_at = ?, version_ts = ?, last_writer = ?
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
          input.id,
        ),
      );
      if (!appending) {
        statements.push(this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(input.id));
        statements.push(this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ?").bind(input.id));
      }
    }
    if (!appending) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO note_versions (note_id, version_ts, r2_key, content_hash, writer, reason) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(input.id, versionTs, r2Key, hash, input.actor.agentId, input.reason),
      );
    }
    if (status === "active") {
      let nextChunk = 0;
      if (appending && existing) {
        const prior = await this.env.DB.prepare("SELECT COALESCE(MAX(n), -1) AS n FROM chunks WHERE note_id = ?").bind(input.id).first<{ n: number }>();
        nextChunk = (prior?.n ?? -1) + 1;
      }
      const written = appending && existing ? appendedChunks : chunks;
      for (const chunk of written) {
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
        hash,
        input.markdown.length,
        input.actor.ipCountry,
        input.detail ?? null,
      ),
    );
    if (input.idempotencyKey) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO idempotency (agent_id, key, response, at) VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id, key) DO UPDATE SET response = excluded.response, at = excluded.at`,
        ).bind(input.actor.agentId, input.idempotencyKey, JSON.stringify({ pending: true }), now),
      );
    }
    try {
      await this.env.DB.batch(statements);
      if (!input.skipPut) this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", intentId);
    } catch (err) {
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
    await this.backfillLinks(input.id, input.path, input.factKey, stringList(parsed.frontmatter.aliases));
    await this.enqueue({ kind: "agent-index", note_id: input.id, path: input.path });
    await this.env.DB.prepare("UPDATE notes SET index_enqueued_at = ? WHERE id = ?").bind(new Date().toISOString(), input.id).run();
    return { ok: true, data: { etag: put.etag } };
  }

  private async indexBytes(input: {
    path: string;
    markdown: string;
    etag: string | null;
    actor: Actor;
    action: string;
    write: boolean;
    reason: string;
    detail?: string | null;
  }): Promise<ApiResult> {
    const parsed = parseMarkdown(input.markdown);
    let markdown = input.markdown;
    const existing = await this.noteByPath(input.path);
    let id = existing?.id ?? stringField(parsed.frontmatter.vault_id) ?? ulid();
    if (!existing) {
      const clash = await this.env.DB.prepare("SELECT path FROM notes WHERE id = ?").bind(id).first<{ path: string }>();
      if (clash && clash.path !== input.path) {
        id = ulid();
        markdown = buildMarkdown({ ...parsed.frontmatter, vault_id: id }, parsed.body);
        if (!input.write) {
          const put = await this.putVault(input.path, markdown, id, input.etag);
          if (put) input = { ...input, etag: put.etag };
        }
      }
    }
    if (input.write) {
      const current = parseMarkdown(markdown);
      if (!stringField(current.frontmatter.vault_id)) {
        markdown = buildMarkdown(
          {
            ...current.frontmatter,
            vault_id: id,
            type: stringField(current.frontmatter.type) ?? inferType(input.path),
            owner: stringField(current.frontmatter.owner) ?? ownerForPath(input.path),
            status: stringField(current.frontmatter.status) ?? "active",
          },
          current.body,
        );
      }
      const put = await this.putVault(input.path, markdown, id, null);
      if (!put) throw new VaultError("conflict_etag", "Bootstrap object already exists");
      input = { ...input, etag: put.etag };
    } else if (!stringField(parsed.frontmatter.vault_id) && input.action === "external_edit") {
      const fm: Frontmatter = {
        ...parsed.frontmatter,
        vault_id: id,
        type: stringField(parsed.frontmatter.type) ?? inferType(input.path),
        owner: stringField(parsed.frontmatter.owner) ?? ownerForPath(input.path),
        status: stringField(parsed.frontmatter.status) ?? "active",
        sensitivity: stringField(parsed.frontmatter.sensitivity) ?? (classifySensitive(markdown, domainOf(input.path)) ? "sensitive" : "normal"),
        source: stringField(parsed.frontmatter.source) ?? "external",
        updated_at: stringField(parsed.frontmatter.updated_at) ?? new Date().toISOString(),
      };
      markdown = buildMarkdown(fm, parsed.body);
      const put = await this.putVault(input.path, markdown, id, input.etag);
      if (put) input = { ...input, etag: put.etag };
    }
    const again = parseMarkdown(markdown);
    const type = stringField(again.frontmatter.type) ?? inferType(input.path);
    const owner = stringField(again.frontmatter.owner) ?? ownerForPath(input.path);
    const domain = domainOf(input.path) ?? stringField(again.frontmatter.domain) ?? null;
    const sensitivity = (stringField(again.frontmatter.sensitivity) === "sensitive" || classifySensitive(markdown, domain) ? "sensitive" : "normal") as
      | "normal"
      | "sensitive";
    const title = stringField(again.frontmatter.key) ?? stringField(again.frontmatter.title) ?? titleFromBody(again.body, input.path);
    const existingRow = await this.noteByPath(input.path);
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
      ifMatch: existingRow?.r2_etag ?? input.etag,
      create: !existingRow,
      reason: input.reason,
      action: input.action,
      idempotencyKey: null,
      journal: null,
      skipPut: true,
      storedEtag: input.etag,
      detail: input.detail ?? null,
    });
    if (saved.ok && (type === "journal" || type === "decision")) await restoreJournalMarkers(this.env, id, input.path, markdown, owner);
    return saved;
  }

  private async quarantine(
    path: string,
    markdown: string,
    reasons: string[],
    actor: Actor,
    alert = true,
    action = "quarantine",
    detail: string | null = null,
    etag: string | null = null,
  ): Promise<void> {
    const hash = await this.auditHash(markdown);
    const existing = await this.noteByPath(path);
    const normalized = normalizeEtag(etag);
    if (existing?.status === "quarantined" && normalized && normalized === normalizeEtag(existing.r2_etag)) return;
    if (existing?.status === "active") {
      await this.snapshotBytes(existing, existing.body, actor.agentId, "quarantine");
      await this.env.DB.prepare("DELETE FROM note_versions WHERE note_id = ? AND r2_key NOT LIKE 'sys/history/%'").bind(existing.id).run();
    }
    const id = existing?.id ?? ulid();
    const stub = buildMarkdown(
      { vault_id: id, type: inferType(path), status: "quarantined", sensitivity: "sensitive", owner: ownerForPath(path) },
      "This note was quarantined by the content filter.",
    );
    const now = new Date().toISOString();
    const stubHash = await sha256Hex(stub);
    const recordKey = `sys/quarantine/${hash ?? ulid()}.json`;
    await this.env.VAULT.put(
      recordKey,
      JSON.stringify({
        path,
        at: now,
        reason_codes: reasons,
        content_hash: hash,
        agent_id: actor.agentId,
        run_id: runMarker(path) ?? runMarker(actor.agentId),
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    const prior = existing;
    if (!prior) {
      await this.env.DB.prepare(
        `INSERT INTO notes (
          id, path, type, owner, domain, sensitivity, title, body, frontmatter,           content_hash, r2_etag, r2_key, status,
          created_at, updated_at, version_ts, last_writer
        ) VALUES (?, ?, ?, ?, ?, 'sensitive', ?, ?, ?, ?, ?, ?, 'quarantined', ?, ?, ?, ?)`,
      )
        .bind(
          id,
          path,
          inferType(path),
          ownerForPath(path),
          domainOf(path),
          path,
          stub,
          JSON.stringify(parseMarkdown(stub).frontmatter),
          stubHash,
          normalized,
          r2KeyFor(this.prefix(), path),
          now,
          now,
          versionStamp(),
          actor.agentId,
        )
        .run();
    } else {
      await this.env.DB.prepare(
        `UPDATE notes SET body = ?, frontmatter = ?, content_hash = ?, r2_etag = ?, status = 'quarantined', sensitivity = 'sensitive', updated_at = ?, last_writer = ? WHERE id = ?`,
      )
        .bind(stub, JSON.stringify(parseMarkdown(stub).frontmatter), stubHash, normalized, now, actor.agentId, id)
        .run();
      await this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(id).run();
    }
    await this.audit(actor, action, path, id, "rejected", reasons, hash, markdown.length, detail);
    if (!alert) return;
    const inbox = await this.noteByPath("inbox/quarantine.md");
    if (hash && inbox?.body.includes(hash)) return;
    const ref = runMarker(path) ?? runMarker(actor.agentId);
    const block = `## ${now} · quarantine\nA vault file was excluded from search (${reasons.join(", ")}). Hash ${hash ?? "none"}.${ref ? ` Ref ${ref}.` : ""}\n`;
    const base =
      inbox?.body ??
      buildMarkdown({ vault_id: ulid(), type: "note", owner: "shared", status: "active", sensitivity: "normal", vault_summary: false }, "# Quarantine\n");
    const markdownInbox = `${base.endsWith("\n") ? base : `${base}\n`}\n${block}`;
    await this.saveMarkdown({
      id: inbox?.id ?? stringField(parseMarkdown(base).frontmatter.vault_id) ?? ulid(),
      path: "inbox/quarantine.md",
      markdown: markdownInbox,
      type: "note",
      owner: "shared",
      domain: null,
      sensitivity: "normal",
      factKey: null,
      title: "Quarantine",
      statementHash: null,
      observedAt: now,
      actor,
      ifMatch: inbox?.r2_etag ?? null,
      create: !inbox,
      reason: "quarantine-alert",
      action: "quarantine_alert",
      idempotencyKey: null,
      journal: null,
    });
  }

  private async refreshSummary(actor: Actor): Promise<void> {
    const rows = await this.env.DB.prepare(
      `SELECT fact_key, body FROM notes WHERE owner = 'shared' AND type = 'fact' AND status = 'active' AND sensitivity = 'normal' ORDER BY fact_key`,
    ).all<{ fact_key: string; body: string }>();
    const lines = ["# Profile", ""];
    for (const row of rows.results ?? []) {
      const statement = parseMarkdown(row.body).body.trim();
      lines.push(`## ${row.fact_key}`, "", statement, "");
    }
    const existing = await this.noteByPath("profile/summary.md");
    const id = existing?.id ?? ulid();
    const markdown = buildMarkdown(
      {
        vault_id: id,
        type: "profile",
        owner: "shared",
        status: "active",
        sensitivity: "normal",
        source: "hiveattic",
        updated_at: new Date().toISOString(),
        vault_summary: true,
      },
      lines.join("\n"),
    );
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
      idempotencyKey: null,
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
      idempotencyKey: null,
      journal: null,
    });
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

  private async purge(id: string | undefined, path: string | undefined, actor: Actor, audit: boolean): Promise<ApiResult> {
    const note = await this.resolveNote(id, path);
    if (!note) return { ok: true, data: { purged: false } };
    const chunkIds = await this.chunkIds(note.id);
    const now = new Date().toISOString();
    const keys = [note.r2_key];
    let cursor: string | undefined;
    do {
      const history = await this.env.VAULT.list({ prefix: `sys/history/${note.id}/`, cursor, limit: 200 });
      keys.push(...history.objects.map((object) => object.key));
      cursor = history.truncated ? history.cursor : undefined;
    } while (cursor);
    if (keys.length) await this.env.VAULT.delete(keys);
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM links WHERE src_note_id = ? OR dst_note_id = ?").bind(note.id, note.id),
      this.env.DB.prepare("DELETE FROM journal_entries WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM note_versions WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare("DELETE FROM chunks WHERE note_id = ?").bind(note.id),
      this.env.DB.prepare(
        `INSERT INTO tombstones (note_id, at, by_agent, reason, purged_at, content_hash) VALUES (?, ?, ?, 'purge', ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET purged_at = excluded.purged_at, content_hash = excluded.content_hash`,
      ).bind(note.id, now, actor.agentId, now, note.content_hash),
      ...chunkIds.map((chunkId) =>
        this.env.DB.prepare(
          `INSERT INTO vector_delete_queue (chunk_id, note_id, requested_at) VALUES (?, ?, ?)
           ON CONFLICT(chunk_id) DO UPDATE SET requested_at = excluded.requested_at`,
        ).bind(chunkId, note.id, now),
      ),
      this.env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(note.id),
    ]);
    if (audit) await this.audit(actor, "purge", note.path, note.id, "ok", [], note.content_hash, 0);
    return { ok: true, data: { purged: true, id: note.id, path: note.path } };
  }

  private async enqueue(body: Record<string, unknown>): Promise<void> {
    try {
      await this.env.INDEX_Q.send(body);
    } catch (err) {
      logEvent({ event: "queue_send_failed", name: err instanceof Error ? err.name : "error" });
    }
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

  private async auditHash(text: string): Promise<string | null> {
    if (!this.env.AUDIT_KEY) return null;
    return hmacSha256Hex(this.env.AUDIT_KEY, text);
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
        await this.indexBytes({
          path: row.path,
          markdown,
          etag: normalizeEtag(object.etag),
          actor,
          action: "replay",
          write: false,
          reason: "replay",
        });
        this.ctx.storage.sql.exec("DELETE FROM write_intents WHERE op_id = ?", row.op_id);
        replayed += 1;
      } catch (err) {
        logEvent({ event: "intent_replay_failed", name: err instanceof Error ? err.name : "error" });
      }
    }
    return { replayed, dropped };
  }

  private async reconcile(): Promise<ApiResult> {
    let updated = 0;
    let cursor: string | undefined;
    const actor: Actor = { agentId: "reconcile", tokenId: "reconcile", client: "reconcile", requestId: ulid(), ipCountry: null };
    do {
      const page = await this.env.VAULT.list({ prefix: this.prefix(), cursor, limit: 100 });
      for (const object of page.objects) {
        if (!object.key.endsWith(".md")) continue;
        const path = vaultPathFromKey(this.prefix(), object.key);
        if (!path) continue;
        const note = await this.noteByPath(path);
        const etag = normalizeEtag(object.etag);
        if (note && etag && etag === normalizeEtag(note.r2_etag)) continue;
        const file = await this.env.VAULT.get(object.key);
        if (!file) continue;
        const markdown = await file.text();
        const hit = await this.contentHit(path, markdown);
        if (hit) await this.quarantine(path, markdown, hit.reasons, actor, false, "reconcile", null, normalizeEtag(file.etag));
        else {
          await this.indexBytes({
            path,
            markdown,
            etag: normalizeEtag(file.etag),
            actor,
            action: "reconcile",
            write: false,
            reason: "reconcile",
          });
        }
        updated += 1;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const forgotten = await this.reconcileMissing(actor);
    return { ok: true, data: { updated, forgotten } };
  }

  private async reconcileMissing(actor: Actor): Promise<number> {
    const cap = 200;
    const cursor = (await this.ctx.storage.get<string>("reconcile_d1_path")) ?? "";
    const rows = await this.env.DB.prepare(
      "SELECT path, r2_key FROM notes WHERE status = 'active' AND path > ? ORDER BY path LIMIT ?",
    )
      .bind(cursor, cap)
      .all<{ path: string; r2_key: string }>();
    const list = rows.results ?? [];
    let forgotten = 0;
    for (const row of list) {
      const head = await this.env.VAULT.head(row.r2_key);
      if (head) continue;
      await this.externalDelete(row.path, actor, JSON.stringify({ reason: "missing_object" }));
      forgotten += 1;
    }
    if (list.length < cap) await this.ctx.storage.delete("reconcile_d1_path");
    else await this.ctx.storage.put("reconcile_d1_path", list[list.length - 1]!.path);
    return forgotten;
  }

  private cleanupAllowed(): boolean {
    return this.env.E2E_CLEANUP_ENABLED === "true" && stagingResources(this.env);
  }

  private async contentHit(path: string, markdown: string) {
    if (isGeneratedNote(path)) return null;
    return inspectWrite(textForFilter(markdown), await this.policy());
  }

  private async existingNoteId(path: string, markdown: string, metaId: string | null): Promise<string> {
    const fromFile = stringField(parseMarkdown(markdown).frontmatter.vault_id) ?? null;
    const prior = await this.env.DB.prepare("SELECT id FROM notes WHERE path = ?").bind(path).first<{ id: string }>();
    const meta = metaId?.trim() || null;
    const candidates = [fromFile, prior?.id ?? null, meta].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      const clash = await this.env.DB.prepare("SELECT path FROM notes WHERE id = ?").bind(candidate).first<{ path: string }>();
      if (!clash || clash.path === path) return candidate;
    }
    return ulid();
  }

  private async replay(agentId: string, key: string | null): Promise<{ [key: string]: JsonValue } | null> {
    if (!key) return null;
    const row = await this.env.DB.prepare("SELECT response, at FROM idempotency WHERE agent_id = ? AND key = ?")
      .bind(agentId, key)
      .first<{ response: string; at: string }>();
    if (!row) return null;
    if (Date.now() - Date.parse(row.at) > 7 * 24 * 60 * 60 * 1000) return null;
    const parsed = JSON.parse(row.response) as { [key: string]: JsonValue };
    if (parsed.pending) return null;
    return parsed;
  }

  private async remember(agentId: string, key: string | null, data: Record<string, unknown>): Promise<void> {
    if (!key) return;
    await this.env.DB.prepare(
      `INSERT INTO idempotency (agent_id, key, response, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id, key) DO UPDATE SET response = excluded.response, at = excluded.at`,
    )
      .bind(agentId, key, JSON.stringify(data), new Date().toISOString())
      .run();
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

  private async policy(): Promise<PolicyTerm[]> {
    const rows = await this.env.DB.prepare("SELECT term, kind FROM policy_terms").all<PolicyTerm>();
    return rows.results ?? [];
  }

  private async resolvedLinks(srcId: string, targets: string[]): Promise<{ target: string; dst: string | null }[]> {
    const links: { target: string; dst: string | null }[] = [];
    for (const target of targets) {
      links.push({ target, dst: await this.lookupTarget(target, srcId) });
    }
    return links;
  }

  private async lookupTarget(target: string, except: string): Promise<string | null> {
    const file = target.endsWith(".md") ? target : `${target}.md`;
    const row = await this.env.DB.prepare(
      `SELECT id FROM notes WHERE id != ? AND status = 'active' AND (path = ? OR path = ? OR fact_key = ? OR path LIKE ?) LIMIT 1`,
    )
      .bind(except, target, file, target, `%/${file}`)
      .first<{ id: string }>();
    if (row) return row.id;
    const candidates = await this.env.DB.prepare(
      "SELECT id, frontmatter FROM notes WHERE id != ? AND status = 'active' AND instr(lower(frontmatter), lower(?)) > 0 LIMIT 20",
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
    for (const prefix of [this.prefix(), "sys/history/", "sys/quarantine/"]) {
      let cursor: string | undefined;
      do {
        const page = await this.env.VAULT.list({ prefix, cursor, limit: 100 });
        const keys: string[] = [];
        for (const object of page.objects) {
          if (object.key.includes(runId)) {
            keys.push(object.key);
            continue;
          }
          const file = await this.env.VAULT.get(object.key);
          if (file && (await file.text()).includes(runId)) keys.push(object.key);
        }
        if (keys.length) {
          await this.env.VAULT.delete(keys);
          for (const key of keys) await this.env.DB.prepare("DELETE FROM note_versions WHERE r2_key = ?").bind(key).run();
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
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
    for (const prefix of [this.prefix(), "sys/history/", "sys/quarantine/"]) {
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

function normalizeEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  const value = etag.trim().replace(/^W\//, "").replaceAll('"', "");
  return value || null;
}

function normalizeStatement(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function stripReserved(extra: Frontmatter): Frontmatter {
  const out: Frontmatter = {};
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith("vault_") || key === "status" || key === "owner" || key === "type" || key === "sensitivity" || key === "summary" || key === "domain") continue;
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

async function journalMacMatches(env: Env, entry: JournalEntry): Promise<boolean> {
  if (!entry.mac) return false;
  const expected = await journalMac(env, entry.id, entry.agent, entry.title, entry.body);
  return expected === entry.mac;
}

export async function restoreJournalMarkers(env: Env, noteId: string, path: string, markdown: string, agentHint: string): Promise<void> {
  for (const entry of journalEntries(markdown)) {
    const agent = entry.agent || agentHint;
    if (!(await journalMacMatches(env, { ...entry, agent }))) continue;
    const at = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO journal_entries (id, note_id, agent_id, at, title, block_ref, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(entry.id, noteId, agent, at, entry.title, `^${entry.id}`, entry.idempotency)
      .run();
    if (entry.idempotency) {
      await env.DB.prepare(`INSERT OR IGNORE INTO idempotency (agent_id, key, response, at) VALUES (?, ?, ?, ?)`).bind(
        agent,
        entry.idempotency,
        JSON.stringify({ entry_id: entry.id, block_ref: `^${entry.id}`, path }),
        at,
      ).run();
    }
  }
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

function runMarker(value: string | null | undefined): string | null {
  if (!value) return null;
  return /e2e[0-9a-f]{10}/.exec(value)?.[0] ?? null;
}

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
