import { canRead, domainOf, hasScope, type Access, type NoteView } from "./access";
import { domainConfig, RESTRICTED, stagingResources, vaultTimeZone } from "./config";
import { sha256Hex } from "./crypto";
import { VaultError } from "./errors";
import { AGENTS_MD } from "./content";
import { inSensitiveFolder, ownerForPath, r2KeyFor } from "./paths";

export { stagingResources };

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

type NoteRecord = {
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
  moved_to: string | null;
};

const RESTRICTED_LIKE = `sensitive/${RESTRICTED}/%`;

export async function searchVault(env: Env, access: Access, query: string, mode: string, options: SearchOptions = {}): Promise<Record<string, unknown>> {
  const match = ftsQuery(query);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const scope = scopeSql(access);
  const filters = extraFilters(options);
  let rows: NoteHit[] = [];
  try {
    const selected = await env.DB.prepare(
      `SELECT n.id, n.path, n.title, n.owner, n.type, n.domain, n.sensitivity, n.updated_at, n.frontmatter,
              c.text AS chunk_text, bm25(chunks_fts) AS rank
       FROM chunks_fts
       JOIN chunks c ON c.rowid = chunks_fts.rowid
       JOIN notes n ON n.id = c.note_id
       WHERE chunks_fts MATCH ? AND n.status = 'active' AND (${scope.sql}) ${filters.sql}
         AND NOT EXISTS (SELECT 1 FROM oversize_files o WHERE o.path = n.path)
       ORDER BY bm25(chunks_fts)
       LIMIT ?`,
    )
      .bind(match, ...scope.binds, ...filters.binds, limit)
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

const NOTE_SELECT = `SELECT id, path, owner, domain, sensitivity, frontmatter, body, status, r2_etag, type, title,
  (SELECT moved_to FROM tombstones t WHERE t.note_id = notes.id) AS moved_to FROM notes`;

// Only active notes are served to non-admin callers. A forgotten, moved, or superseded note reads as
// missing for everyone but the admin token, so the old path gives no stub and no pointer to where
// a moved note went.
function readable(access: Access, note: NoteRecord | null): note is NoteRecord {
  if (!note) return false;
  if (!access.admin && (note.status !== "active" || note.moved_to)) return false;
  return canRead(access, noteView(note));
}

// An oversize file is not served. A caller who could read the path gets 413 limit "file"; anyone
// else gets the same 404 as for a missing note.
async function assertServable(env: Env, access: Access, path: string, note: NoteRecord | null): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 AS hit FROM oversize_files WHERE path = ?").bind(path).first<{ hit: number }>();
  if (!row) return;
  const view: NoteView = note ? noteView(note) : { path, owner: ownerForPath(path), domain: domainOf(path), sensitivity: inSensitiveFolder(path) ? "sensitive" : "normal" };
  if (note ? readable(access, note) : canRead(access, view)) {
    throw new VaultError("payload_too_large", "The stored file is over the file size limit", ["file"], { limit: "file" });
  }
  throw new VaultError("not_found", "Note not found");
}

export async function readNote(env: Env, access: Access, path?: string, id?: string): Promise<Record<string, unknown>> {
  const note = id
    ? await env.DB.prepare(`${NOTE_SELECT} WHERE id = ?`).bind(id).first<NoteRecord>()
    : await env.DB.prepare(`${NOTE_SELECT} WHERE path = ?`).bind(path ?? "").first<NoteRecord>();
  const target = note?.path ?? (id ? null : path);
  if (target) await assertServable(env, access, target, note);
  if (!readable(access, note)) throw new VaultError("not_found", "Note not found");
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

// Pages through visible notes. Rows the SQL prefilter lets through but the caller cannot read do
// not shorten a page: it keeps reading until it has a full page or runs out.
export async function listNotes(env: Env, access: Access, prefix: string, cursor = ""): Promise<Record<string, unknown>> {
  const scope = scopeSql(access);
  const page = 100;
  const notes: { id: string; path: string; title: string | null; type: string; updated_at: string }[] = [];
  let after = cursor;
  let more = false;
  for (let round = 0; round < 20; round++) {
    const rows = await env.DB.prepare(
      `SELECT id, path, title, type, owner, domain, sensitivity, frontmatter, updated_at, status
       FROM notes n WHERE status = 'active' AND path LIKE ? ESCAPE '\\' AND (? = '' OR path > ?) AND (${scope.sql})
         AND NOT EXISTS (SELECT 1 FROM oversize_files o WHERE o.path = n.path)
       ORDER BY path LIMIT ?`,
    )
      .bind(likePrefix(prefix), after, after, ...scope.binds, page + 1)
      .all<{ id: string; path: string; title: string | null; type: string; owner: string; domain: string | null; sensitivity: string; frontmatter: string; updated_at: string; status: string }>();
    const batch = rows.results ?? [];
    for (const note of batch.slice(0, page)) {
      after = note.path;
      if (!canRead(access, noteView(note))) continue;
      notes.push({ id: note.id, path: note.path, title: note.title, type: note.type, updated_at: note.updated_at });
      if (notes.length === page) break;
    }
    if (notes.length === page) {
      more = batch.findIndex((note) => note.path === after) < batch.length - 1;
      break;
    }
    more = batch.length > page;
    if (!more) break;
  }
  return { notes, cursor: more ? after : null };
}

export async function noteHistory(env: Env, access: Access, path?: string, id?: string): Promise<Record<string, unknown>> {
  const note = id
    ? await env.DB.prepare(`${NOTE_SELECT} WHERE id = ?`).bind(id).first<NoteRecord>()
    : await env.DB.prepare(`${NOTE_SELECT} WHERE path = ?`).bind(path ?? "").first<NoteRecord>();
  const target = note?.path ?? (id ? null : path);
  if (target) await assertServable(env, access, target, note);
  if (!readable(access, note)) throw new VaultError("not_found", "Note not found");
  const versions = await env.DB.prepare(
    "SELECT version_ts, r2_key, content_hash, writer, reason FROM note_versions WHERE note_id = ? ORDER BY version_ts",
  )
    .bind(note.id)
    .all<{ version_ts: string; r2_key: string; content_hash: string; writer: string; reason: string | null }>();
  const hiddenBody = note.status === "forgotten";
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
  let zone: string | null = null;
  try {
    zone = vaultTimeZone(env);
  } catch {
    zone = null;
  }
  return {
    agent_id: access.agentId,
    token_id: access.tokenId,
    scopes: access.scopes,
    admin: access.admin,
    agents_md_sha256: await sha256Hex(bytes),
    deploy_env: env.DEPLOY_ENV === "staging" ? "staging" : "production",
    staging_resources: stagingResources(env),
    vault_tz: zone,
  };
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
  if (access.scopes.includes("read:domain/*") || access.scopes.includes("read:sensitive/*")) return { sql: "1 = 1", binds: [] };
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

// A SQL prefilter that is broader than canRead, which still checks every row. No branch reaches
// sensitive/restricted/ or another bot's bots/<a>/journal-sensitive/ for a non-admin token, and a
// bot always reaches its own journal-sensitive/ files.
function scopeSql(access: Access): { sql: string; binds: string[] } {
  if (access.admin) return { sql: "1 = 1", binds: [] };
  const ownPii = `bots/${access.agentId}/journal-sensitive/%`;
  const fenced = (inner: { sql: string; binds: string[] }) => ({
    sql: `n.path NOT LIKE ? AND (n.path NOT LIKE 'bots/%/journal-sensitive/%' OR n.path LIKE ?) AND (${inner.sql})`,
    binds: [RESTRICTED_LIKE, ownPii, ...inner.binds],
  });
  if (hasScope(access, "read:all")) return fenced({ sql: "1 = 1", binds: [] });
  const parts: { sql: string; binds: string[] }[] = [
    { sql: "n.path IN ('AGENTS.md', 'README.md')", binds: [] },
    { sql: "n.path LIKE ?", binds: [ownPii] },
  ];
  if (hasScope(access, "read:own") || hasScope(access, "write:own")) {
    parts.push({ sql: "n.path LIKE ?", binds: [`bots/${access.agentId}/%`] });
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
  const sensitive = [...domainConfig().sensitive];
  for (const scope of access.scopes) {
    const sens = /^read:sensitive\/([a-z0-9-]+)$/.exec(scope);
    if (sens && sens[1] !== "pii" && sens[1] !== "*") {
      parts.push({ sql: "(n.domain = ? OR n.path LIKE ? OR n.path LIKE ?)", binds: [sens[1]!, `domains/${sens[1]}/%`, `sensitive/${sens[1]}/%`] });
    }
    if (scope === "read:sensitive/*" && sensitive.length) {
      parts.push({
        sql: `(n.sensitivity = 'sensitive' OR n.domain IN (${sensitive.map(() => "?").join(", ")}) OR n.path LIKE 'domains/%' OR n.path LIKE 'sensitive/%')`,
        binds: sensitive,
      });
    }
  }
  if (hasScope(access, "read:sensitive/pii")) {
    parts.push({ sql: "(n.sensitivity = 'sensitive' AND n.domain IS NULL AND n.path NOT LIKE 'domains/%' AND n.path NOT LIKE 'sensitive/%')", binds: [] });
  }
  return fenced({ sql: parts.map((part) => part.sql).join(" OR "), binds: parts.flatMap((part) => part.binds) });
}

function ordinaryDomainSql(): { sql: string; binds: string[] } {
  const { ordinary: ordinarySet, sensitive: sensitiveSet } = domainConfig();
  const ordinary = [...ordinarySet];
  const sensitive = [...sensitiveSet];
  const domainClause = ordinary.length ? `(n.domain IS NULL OR n.domain IN (${ordinary.map(() => "?").join(", ")}))` : "n.domain IS NULL";
  const sensitivePaths = sensitive.map(() => " AND n.path NOT LIKE ?").join("");
  const ordinaryPaths = ordinary.length ? ` OR ${ordinary.map(() => "n.path LIKE ?").join(" OR ")}` : "";
  return {
    sql: `(n.sensitivity != 'sensitive' AND ${domainClause}${sensitivePaths} AND n.path NOT LIKE 'sensitive/%' AND (n.path NOT LIKE 'domains/%'${ordinaryPaths}))`,
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
