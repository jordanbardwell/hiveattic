import { canRead, hasScope, NON_SENSITIVE_DOMAINS, SENSITIVE_DOMAINS, type Access, type NoteView } from "./access";
import { sha256Hex } from "./crypto";
import { VaultError } from "./errors";
import { AGENTS_MD } from "./content";
import { r2KeyFor } from "./paths";

export type SearchOptions = { limit?: number; domains?: string[]; types?: string[]; since?: string };

type NoteHit = {
  id: string;
  path: string;
  title: string | null;
  owner: string;
  type: string;
  domain: string | null;
  sensitivity: string;
  updated_at: string;
  frontmatter: string;
  chunk_text: string;
  rank: number;
};

export async function searchVault(env: Env, access: Access, query: string, mode: string, options: SearchOptions = {}): Promise<Record<string, unknown>> {
  const match = ftsQuery(query);
  const limit = clampInt(options.limit, 20, 1, 50);
  const scope = scopeSql(access);
  const filters = extraFilters(options);
  let rows: NoteHit[] = [];
  try {
    // One row per note (its best chunk), so a long note cannot take several result slots. A few extra
    // candidates let the boosts below reorder notes that sit just past the keyword cut.
    const selected = await env.DB.prepare(
      `WITH hits AS (
         SELECT c.note_id, c.text AS chunk_text, bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
       ), best AS (
         SELECT note_id, chunk_text, rank, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY rank) AS rn FROM hits
       )
       SELECT n.id, n.path, n.title, n.owner, n.type, n.domain, n.sensitivity, n.updated_at, n.frontmatter,
              b.chunk_text, b.rank
       FROM best b
       JOIN notes n ON n.id = b.note_id
       WHERE b.rn = 1 AND n.status = 'active' AND (${scope.sql}) ${filters.sql}
       ORDER BY b.rank
       LIMIT ?`,
    )
      .bind(match, ...scope.binds, ...filters.binds, Math.min(limit * 3, 150))
      .all<NoteHit>();
    rows = selected.results ?? [];
  } catch {
    throw new VaultError("invalid", "Search query is not valid");
  }
  const best = new Map<string, { hit: NoteHit; score: number; boosts: string[] }>();
  for (const hit of rows) {
    const view = noteView(hit);
    if (!canRead(access, view)) continue;
    const scored = scoreHit(hit, access);
    const prior = best.get(hit.id);
    if (!prior || scored.score > prior.score) best.set(hit.id, { hit, ...scored });
  }
  const results = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score, boosts }) => ({
      id: hit.id,
      path: hit.path,
      title: hit.title,
      type: hit.type,
      owner: hit.owner,
      domain: hit.domain,
      updated_at: hit.updated_at,
      score: Number(score.toFixed(4)),
      snippet: hit.chunk_text.slice(0, 180),
      why: { kw_rank: hit.rank, vec_rank: null, boosts },
    }));
  const data: Record<string, unknown> = { results, index_lag_ms: 0, mode: mode === "hybrid" || mode === "semantic" ? mode : "keyword" };
  if (mode === "hybrid" || mode === "semantic") data.warning = "semantic_deferred";
  return data;
}

export async function readNote(env: Env, access: Access, path?: string, id?: string): Promise<Record<string, unknown>> {
  const note = id
    ? await env.DB.prepare(
        "SELECT id, path, owner, domain, sensitivity, frontmatter, body, status, r2_etag, type, title FROM notes WHERE id = ?",
      )
        .bind(id)
        .first<{
          id: string;
          path: string;
          owner: string;
          domain: string | null;
          sensitivity: string;
          frontmatter: string;
          body: string;
          status: string;
          r2_etag: string | null;
          type: string;
          title: string | null;
        }>()
    : await env.DB.prepare(
        "SELECT id, path, owner, domain, sensitivity, frontmatter, body, status, r2_etag, type, title FROM notes WHERE path = ?",
      )
        .bind(path ?? "")
        .first<{
      id: string;
      path: string;
      owner: string;
      domain: string | null;
      sensitivity: string;
      frontmatter: string;
      body: string;
      status: string;
      r2_etag: string | null;
      type: string;
      title: string | null;
    }>();
  if (!note || !canRead(access, noteView(note))) throw new VaultError("not_found", "Note not found");
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    type: note.type,
    status: note.status,
    sensitivity: note.sensitivity,
    owner: note.owner,
    etag: note.r2_etag,
    markdown: note.body,
  };
}

export async function listNotes(env: Env, access: Access, prefix: string, cursor = ""): Promise<Record<string, unknown>> {
  const scope = scopeSql(access);
  const page = 100;
  const rows = await env.DB.prepare(
    `SELECT id, path, title, type, owner, domain, sensitivity, frontmatter, updated_at, status
     FROM notes n WHERE status = 'active' AND path LIKE ? ESCAPE '\\' AND (? = '' OR path > ?) AND (${scope.sql})
     ORDER BY path LIMIT ?`,
  )
    .bind(likePrefix(prefix), cursor, cursor, ...scope.binds, page + 1)
    .all<{
      id: string;
      path: string;
      title: string | null;
      type: string;
      owner: string;
      domain: string | null;
      sensitivity: string;
      frontmatter: string;
      updated_at: string;
      status: string;
    }>();
  const visible = (rows.results ?? []).filter((note) => canRead(access, noteView(note)));
  const pageRows = visible.slice(0, page);
  const notes = pageRows.map((note) => ({ id: note.id, path: note.path, title: note.title, type: note.type, updated_at: note.updated_at }));
  const next = visible.length > page ? pageRows[pageRows.length - 1]?.path ?? null : null;
  return { notes, cursor: next };
}

export async function noteHistory(env: Env, access: Access, path?: string, id?: string): Promise<Record<string, unknown>> {
  const note = id
    ? await env.DB.prepare("SELECT id, path, owner, domain, sensitivity, frontmatter, status FROM notes WHERE id = ?").bind(id).first<NoteView & { id: string; status: string }>()
    : await env.DB.prepare("SELECT id, path, owner, domain, sensitivity, frontmatter, status FROM notes WHERE path = ?")
        .bind(path ?? "")
        .first<NoteView & { id: string; status: string }>();
  if (!note || !canRead(access, note)) throw new VaultError("not_found", "Note not found");
  const versions = await env.DB.prepare(
    "SELECT version_ts, r2_key, content_hash, writer, reason FROM note_versions WHERE note_id = ? ORDER BY version_ts",
  )
    .bind(note.id)
    .all<{ version_ts: string; r2_key: string; content_hash: string; writer: string; reason: string | null }>();
  const hiddenBody = note.status === "forgotten" || note.status === "quarantined";
  const includeBody = access.admin || (!hiddenBody && note.owner === access.agentId);
  const listed = [];
  for (const version of (versions.results ?? []).slice(-50)) {
    const entry: Record<string, unknown> = {
      version_ts: version.version_ts,
      content_hash: version.content_hash,
      writer: version.writer,
      reason: version.reason,
    };
    if (includeBody) {
      const object = await env.VAULT.get(version.r2_key);
      entry.body = object ? await object.text() : null;
    }
    listed.push(entry);
  }
  return { id: note.id, path: note.path, status: note.status, versions: listed };
}

export async function whoami(env: Env, access: Access): Promise<Record<string, unknown>> {
  const key = r2KeyFor(env.VAULT_PREFIX || "vault/", "AGENTS.md");
  const object = await env.VAULT.get(key);
  const bytes = object ? await object.text() : AGENTS_MD;
  return {
    agent_id: access.agentId,
    token_id: access.tokenId,
    scopes: access.scopes,
    admin: access.admin,
    agents_md_sha256: await sha256Hex(bytes),
    deploy_env: env.DEPLOY_ENV === "staging" ? "staging" : "production",
    staging_resources: stagingResources(env),
  };
}

export function stagingResources(env: Env): boolean {
  const bucket = env.VAULT_BUCKET ?? "";
  const db = env.DB_NAME ?? "";
  const worker = env.WORKER_NAME ?? "";
  // Names from wrangler.staging.example.jsonc put `-staging` in the middle
  // (`hiveattic-staging-vault`) or at the end (`hiveattic-vault-staging`).
  return env.DEPLOY_ENV === "staging" && bucket.includes("-staging") && db.includes("-staging") && worker.includes("staging");
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

function likePrefix(prefix: string): string {
  return `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function extraFilters(options: SearchOptions): { sql: string; binds: string[] } {
  const parts: string[] = [];
  const binds: string[] = [];
  const domains = (options.domains ?? []).filter((domain) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(domain));
  if (domains.length) {
    parts.push(`n.domain IN (${domains.map(() => "?").join(", ")})`);
    binds.push(...domains);
  }
  const types = (options.types ?? []).filter((type) => /^[a-z0-9-]{1,40}$/.test(type));
  if (types.length) {
    parts.push(`n.type IN (${types.map(() => "?").join(", ")})`);
    binds.push(...types);
  }
  if (options.since && !Number.isNaN(Date.parse(options.since))) {
    parts.push("n.updated_at >= ?");
    binds.push(options.since);
  }
  return { sql: parts.length ? `AND ${parts.join(" AND ")}` : "", binds };
}

function domainTagSql(access: Access): { sql: string; binds: string[] } {
  if (hasScope(access, "read:domain/*") || hasScope(access, "read:sensitive/*")) return { sql: "1 = 1", binds: [] };
  const names = new Set<string>();
  for (const scope of access.scopes) {
    const domain = /^read:domain\/([a-z0-9-]+)$/.exec(scope);
    if (domain) names.add(domain[1]!);
    const sens = /^read:sensitive\/([a-z0-9-]+)$/.exec(scope);
    if (sens && sens[1] !== "pii") names.add(sens[1]!);
  }
  if (names.size === 0) return { sql: "(n.domain IS NULL OR n.path LIKE 'domains/%')", binds: [] };
  return {
    sql: `(n.domain IS NULL OR n.path LIKE 'domains/%' OR n.domain IN (${[...names].map(() => "?").join(", ")}))`,
    binds: [...names],
  };
}

function scopeSql(access: Access): { sql: string; binds: string[] } {
  if (access.admin || hasScope(access, "read:all")) return { sql: "1 = 1", binds: [] };
  const parts: { sql: string; binds: string[] }[] = [{ sql: "n.path IN ('AGENTS.md', 'README.md')", binds: [] }];
  if (hasScope(access, "read:own") || hasScope(access, "write:own")) {
    // Same rule as canRead: sensitive notes in the own folder need a sensitive scope (granted below),
    // except the own journal-sensitive file with no domain.
    const ordinary = ordinaryDomainSql();
    parts.push({
      sql: `(n.path LIKE ? AND (${ordinary.sql} OR (n.path LIKE ? AND n.domain IS NULL)))`,
      binds: [`bots/${access.agentId}/%`, ...ordinary.binds, `bots/${access.agentId}/journal-sensitive/%`],
    });
  }
  for (const scope of access.scopes) {
    const summary = /^read:sensitive:summary\/([a-z0-9-]+)$/.exec(scope);
    if (summary) parts.push({ sql: "(n.path LIKE ? OR n.path = 'profile/summary.md')", binds: [`domains/${summary[1]}/summaries/%`] });
  }
  const visible: { sql: string; binds: string[] }[] = [];
  if (hasScope(access, "read:shared")) {
    visible.push(
      { sql: "n.path LIKE 'shared/%'", binds: [] },
      { sql: "n.path LIKE 'profile/%'", binds: [] },
      { sql: "n.path LIKE 'journal/%'", binds: [] },
      { sql: "n.path LIKE 'inbox/%'", binds: [] },
    );
  }
  if (hasScope(access, "read:inbox")) visible.push({ sql: "n.path LIKE 'inbox/%'", binds: [] });
  if (hasScope(access, "read:decisions")) visible.push({ sql: "n.path = 'shared/decisions.md'", binds: [] });
  for (const scope of access.scopes) {
    const domain = /^read:domain\/([a-z0-9-]+)$/.exec(scope);
    if (domain) visible.push({ sql: "(n.domain = ? OR n.path LIKE ?)", binds: [domain[1]!, `domains/${domain[1]}/%`] });
    if (scope === "read:domain/*") visible.push({ sql: "(n.domain IS NOT NULL OR n.path LIKE 'domains/%')", binds: [] });
    const bot = /^read:bots\/([a-z0-9-]+)$/.exec(scope);
    if (bot) visible.push({ sql: "n.path LIKE ?", binds: [`bots/${bot[1]}/%`] });
    if (scope === "read:bots/*") visible.push({ sql: "n.path LIKE 'bots/%'", binds: [] });
    const prefix = scope.startsWith("read:prefix:") ? scope.slice("read:prefix:".length) : "";
    if (prefix) visible.push({ sql: "n.path LIKE ?", binds: [likePrefix(prefix)] });
  }
  if (visible.length) {
    const tag = domainTagSql(access);
    const visibleDomains = ordinaryDomainSql();
    parts.push({
      sql: `(${visibleDomains.sql} AND (${tag.sql}) AND (${visible.map((item) => item.sql).join(" OR ")}))`,
      binds: [...visibleDomains.binds, ...tag.binds, ...visible.flatMap((item) => item.binds)],
    });
  }
  for (const scope of access.scopes) {
    const sens = /^read:sensitive\/([a-z0-9-]+)$/.exec(scope);
    if (sens && sens[1] !== "pii") parts.push({ sql: "(n.domain = ? OR n.path LIKE ?)", binds: [sens[1]!, `domains/${sens[1]}/%`] });
    if (scope === "read:sensitive/*") {
      const names = [...SENSITIVE_DOMAINS];
      parts.push({
        sql: `(n.sensitivity = 'sensitive' OR n.domain IN (${names.map(() => "?").join(", ")}) OR n.path LIKE 'domains/%')`,
        binds: names,
      });
    }
  }
  if (hasScope(access, "read:sensitive/pii")) {
    parts.push({ sql: "(n.sensitivity = 'sensitive' AND n.domain IS NULL AND n.path NOT LIKE 'domains/%')", binds: [] });
  }
  return { sql: parts.map((part) => part.sql).join(" OR "), binds: parts.flatMap((part) => part.binds) };
}

function ordinaryDomainSql(): { sql: string; binds: string[] } {
  const ordinary = [...NON_SENSITIVE_DOMAINS];
  const sensitive = [...SENSITIVE_DOMAINS];
  const ordinarySlots = ordinary.map(() => "?").join(", ");
  const sensitivePaths = sensitive.map(() => "n.path NOT LIKE ?").join(" AND ");
  const ordinaryPaths = ordinary.map(() => "n.path LIKE ?").join(" OR ");
  return {
    sql: `(n.sensitivity != 'sensitive' AND (n.domain IS NULL OR n.domain IN (${ordinarySlots})) AND ${sensitivePaths} AND (n.path NOT LIKE 'domains/%' OR ${ordinaryPaths}))`,
    binds: [...ordinary, ...sensitive.map((name) => `domains/${name}/%`), ...ordinary.map((name) => `domains/${name}/%`)],
  };
}

function ftsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/^["']+|["']+$/g, ""))
    .filter((term) => term.length > 0 && term.length <= 80);
  if (terms.length === 0 || terms.length > 16) throw new VaultError("invalid", "Search query is not valid");
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function noteView(note: { path: string; owner: string; domain: string | null; sensitivity: string; frontmatter?: string }): NoteView {
  let frontmatter: Record<string, unknown> | undefined;
  if (note.frontmatter) {
    try {
      const parsed = JSON.parse(note.frontmatter) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
    } catch {
      frontmatter = undefined;
    }
  }
  return { path: note.path, owner: note.owner, domain: note.domain, sensitivity: note.sensitivity, frontmatter };
}

function scoreHit(hit: NoteHit, access: Access): { score: number; boosts: string[] } {
  let score = Number.isFinite(hit.rank) ? -hit.rank : 0;
  if (score <= 0) score = 0.01;
  const boosts: string[] = [];
  if (hit.type === "fact" || hit.type === "profile" || hit.path.startsWith("profile/")) {
    score *= 1.3;
    boosts.push("profile_or_fact");
  }
  if (hit.path.endsWith("/role.md") && hit.owner === access.agentId) {
    score *= 1.2;
    boosts.push("own_role");
  }
  if (hit.owner === access.agentId) {
    score *= 1.15;
    boosts.push("own");
  }
  if (hit.type === "journal" || hit.path.startsWith("journal/") || hit.path.includes("/journal/")) {
    const updated = hit.updated_at || new Date().toISOString();
    const ageDays = Number.isNaN(Date.parse(updated)) ? 365 : Math.max(0, (Date.now() - Date.parse(updated)) / 86_400_000);
    score *= Math.pow(0.5, ageDays / 30);
    boosts.push("journal_recency");
  }
  return { score, boosts };
}
