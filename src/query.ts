import { canRead, domainOf, hasScope, type Access, type NoteView } from "./access";
import { domainConfig, RESTRICTED, stagingResources, vaultTimeZone } from "./config";
import { sha256Hex } from "./crypto";
import { VaultError } from "./errors";
import { AGENTS_MD } from "./content";
import { inSensitiveFolder, ownerForPath, r2KeyFor } from "./paths";
import { searchTags, tagPrefix, taggedIdsBinds, taggedIdsSql } from "./tags";

export { stagingResources };

export type SearchOptions = { limit?: number; domains?: string[]; types?: string[]; since?: string; tags?: string[] };

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
  const tags = searchTags(options.tags);
  // Tags without words list the newest notes that have them.
  if (!query.trim() && tags.length) return taggedNotes(env, access, tags, mode, options);
  const match = ftsQuery(query);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const scope = scopeSql(access);
  const filters = extraFilters(options, tags);
  // The SQL prefilter is broader than canRead, so rows the caller cannot read are dropped after it.
  // Reading goes on, a batch at a time, until the page has `limit` notes or the matches run out.
  const best = new Map<string, { hit: NoteHit; score: number; boosts: string[] }>();
  const batch = Math.min(limit * 2, 100);
  for (let round = 0, offset = 0; round < 5 && best.size < limit; round++, offset += batch) {
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
         LIMIT ? OFFSET ?`,
      )
        .bind(match, ...scope.binds, ...filters.binds, batch, offset)
        .all<NoteHit>();
      rows = selected.results ?? [];
    } catch {
      throw new VaultError("invalid", "Search query is not valid");
    }
    for (const hit of rows) {
      const view = noteView(hit);
      if (!canRead(access, view)) continue;
      const scored = scoreHit(hit, access);
      const prior = best.get(hit.id);
      if (!prior || scored.score > prior.score) best.set(hit.id, { hit, ...scored });
    }
    if (rows.length < batch) break;
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const tagged = await tagsOf(env, ranked.map(({ hit }) => hit.id));
  const results = ranked.map(({ hit, score, boosts }) => ({
    id: hit.id,
    path: hit.path,
    title: hit.title,
    type: hit.type,
    owner: hit.owner,
    domain: hit.domain,
    updated_at: hit.updated_at,
    score: Number(score.toFixed(4)),
    snippet: hit.chunk_text.slice(0, 180),
    tags: tagged.get(hit.id) ?? [],
    why: { kw_rank: hit.rank, vec_rank: null, boosts },
  }));
  return searchReply(results, mode);
}

function searchReply(results: Record<string, unknown>[], mode: string): Record<string, unknown> {
  const data: Record<string, unknown> = { results, index_lag_ms: 0, mode: mode === "hybrid" || mode === "semantic" ? mode : "keyword" };
  if (mode === "hybrid" || mode === "semantic") data.warning = "semantic_deferred";
  return data;
}

// The newest notes with every tag asked for, the same filters, and the same read checks as a search.
// The first tag's rows in note_tags lead the query, so it reads those notes and no others.
async function taggedNotes(env: Env, access: Access, tags: string[], mode: string, options: SearchOptions): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const scope = scopeSql(access);
  const filters = extraFilters(options, tags.slice(1));
  const found: (NoteHit & { snippet: string })[] = [];
  const batch = Math.min(limit * 2, 100);
  for (let round = 0, offset = 0; round < 5 && found.length < limit; round++, offset += batch) {
    const selected = await env.DB.prepare(
      `SELECT n.id, n.path, n.title, n.owner, n.type, n.domain, n.sensitivity, n.updated_at, n.frontmatter,
              COALESCE((SELECT c.text FROM chunks c WHERE c.note_id = n.id ORDER BY c.n LIMIT 1), '') AS snippet
       FROM (${taggedIdsSql()}) m
       CROSS JOIN notes n ON n.id = m.note_id
       WHERE n.status = 'active' AND (${scope.sql}) ${filters.sql}
         AND NOT EXISTS (SELECT 1 FROM oversize_files o WHERE o.path = n.path)
       ORDER BY n.updated_at DESC, n.id
       LIMIT ? OFFSET ?`,
    )
      .bind(...taggedIdsBinds(tags[0]!), ...scope.binds, ...filters.binds, batch, offset)
      .all<NoteHit & { snippet: string }>();
    const rows = selected.results ?? [];
    for (const hit of rows) {
      if (!canRead(access, noteView(hit))) continue;
      found.push(hit);
      if (found.length === limit) break;
    }
    if (rows.length < batch) break;
  }
  const tagged = await tagsOf(env, found.map((hit) => hit.id));
  const results = found.map((hit) => ({
    id: hit.id,
    path: hit.path,
    title: hit.title,
    type: hit.type,
    owner: hit.owner,
    domain: hit.domain,
    updated_at: hit.updated_at,
    score: 0,
    snippet: hit.snippet.slice(0, 180),
    tags: tagged.get(hit.id) ?? [],
    why: { kw_rank: null, vec_rank: null, boosts: [] },
  }));
  return searchReply(results, mode);
}

// The tags of each note in a reply, in one query. Callers pass only notes the caller can read.
async function tagsOf(env: Env, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const rows = await env.DB.prepare("SELECT note_id, tag FROM note_tags WHERE note_id IN (SELECT value FROM json_each(?)) ORDER BY note_id, tag")
    .bind(JSON.stringify(ids))
    .all<{ note_id: string; tag: string }>();
  for (const row of rows.results ?? []) {
    const list = out.get(row.note_id);
    if (list) list.push(row.tag);
    else out.set(row.note_id, [row.tag]);
  }
  return out;
}

const TAG_PAGE = 200;
const TAG_ROWS = 500;
// Reads per call: TAG_ROUNDS once the page has a tag, TAG_ROUNDS_FIRST while it has none, so a tag
// on thousands of notes still gets counted whole.
const TAG_ROUNDS = 8;
const TAG_ROUNDS_FIRST = 24;

// The tags on notes the caller can read, in order, with how many of those notes carry each. A tag
// that only notes the caller cannot read carry is left out, the same as those notes are, and the
// cursor is always a tag the reply lists. Rows come in (tag, note_id) order from the primary key, a
// batch at a time, and each is checked with canRead. A page holds whole tags only: when the reads
// run out in the middle of a tag, the page ends before it. If no tag is whole by then, the first one
// is returned with `partial: true` and a count that is a lower bound, or, when none of the notes
// read so far were readable, the reply has `truncated: true` and no cursor.
export async function listTags(env: Env, access: Access, prefix: string, cursor = ""): Promise<Record<string, unknown>> {
  const from = tagPrefix(prefix);
  const end = from ? prefixEnd(from) : null;
  const scope = scopeSql(access);
  const tags: { tag: string; count: number; partial?: true }[] = [];
  // The cursor is the last tag of the previous page, so this page starts after all of its rows.
  let afterTag = cursor;
  let afterId = cursor ? "\u{10FFFF}" : "";
  let current: string | null = null;
  let count = 0;
  let full = false;
  let exhausted = false;
  const push = () => {
    if (current !== null && count > 0) tags.push({ tag: current, count });
    current = null;
    count = 0;
  };
  rounds: for (let round = 0; round < (tags.length ? TAG_ROUNDS : TAG_ROUNDS_FIRST); round++) {
    const selected = await env.DB.prepare(
      `SELECT t.tag, n.id, n.path, n.owner, n.domain, n.sensitivity, n.frontmatter
       FROM note_tags t CROSS JOIN notes n ON n.id = t.note_id
       WHERE (t.tag, t.note_id) > (?, ?) ${from ? "AND t.tag >= ?" : ""} ${end === null ? "" : "AND t.tag < ?"}
         AND n.status = 'active' AND (${scope.sql})
         AND NOT EXISTS (SELECT 1 FROM oversize_files o WHERE o.path = n.path)
       ORDER BY t.tag, t.note_id
       LIMIT ?`,
    )
      .bind(afterTag, afterId, ...(from ? [from] : []), ...(end === null ? [] : [end]), ...scope.binds, TAG_ROWS)
      .all<{ tag: string; id: string; path: string; owner: string; domain: string | null; sensitivity: string; frontmatter: string }>();
    const rows = selected.results ?? [];
    for (const row of rows) {
      if (row.tag !== current) {
        push();
        if (tags.length === TAG_PAGE) {
          full = true;
          break rounds;
        }
        current = row.tag;
      }
      if (canRead(access, noteView(row))) count += 1;
      afterTag = row.tag;
      afterId = row.id;
    }
    if (rows.length < TAG_ROWS) {
      push();
      exhausted = true;
      break;
    }
  }
  let truncated = false;
  if (!full && !exhausted && current !== null && tags.length === 0) {
    if (count > 0) tags.push({ tag: current, count, partial: true });
    else truncated = true;
  }
  const more = full || (!exhausted && tags.length > 0);
  const reply: Record<string, unknown> = { tags, cursor: more ? tags.at(-1)!.tag : null };
  if (truncated) reply.truncated = true;
  return reply;
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
  // The paths that start with the prefix sort from the prefix up to its end, so the list reads only
  // that folder from the path index.
  const end = prefixEnd(prefix);
  const range = end === null ? "" : "AND path >= ? AND path < ?";
  for (let round = 0; round < 20; round++) {
    const rows = await env.DB.prepare(
      `SELECT id, path, title, type, owner, domain, sensitivity, frontmatter, updated_at, status
       FROM notes n WHERE status = 'active' AND instr(path, ?) = 1 ${range} AND (? = '' OR path > ?) AND (${scope.sql})
         AND NOT EXISTS (SELECT 1 FROM oversize_files o WHERE o.path = n.path)
       ORDER BY path LIMIT ?`,
    )
      .bind(prefix, ...(end === null ? [] : [prefix, end]), after, after, ...scope.binds, page + 1)
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
  const all = versions.results ?? [];
  const latest = all.at(-1)?.version_ts;
  for (const version of all.slice(-50)) {
    const entry: Record<string, unknown> = {
      version_ts: version.version_ts,
      content_hash: version.content_hash,
      writer: version.writer,
      reason: version.reason,
    };
    // A version is read from its immutable copy. An older row that points at the live object only
    // shows a body if it is the latest version, since the live object holds the current text.
    if (includeBody && (version.r2_key.startsWith("sys/history/") || version.version_ts === latest)) {
      const object = await env.VAULT.get(version.r2_key);
      entry.body = object ? await object.text() : null;
    } else if (includeBody) {
      entry.body = null;
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

// The first string after every string that starts with prefix: the prefix with its last character
// one higher. Null when there is none to make, and then the list does without the range.
function prefixEnd(prefix: string): string | null {
  const chars = [...prefix];
  const last = chars.pop()?.codePointAt(0);
  if (last === undefined || (last >= 0xd7ff && last <= 0xdfff) || last >= 0x10ffff) return null;
  return chars.join("") + String.fromCodePoint(last + 1);
}

function extraFilters(options: SearchOptions, tags: string[] = []): { sql: string; binds: string[] } {
  const parts: string[] = [];
  const binds: string[] = [];
  for (const tag of tags) {
    parts.push(`n.id IN (${taggedIdsSql()})`);
    binds.push(...taggedIdsBinds(tag));
  }
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
// bot always reaches its own journal-sensitive/ files. A path that starts with an agent id, a
// domain name, or a prefix is tested with instr(n.path, ?) = 1, not LIKE: D1 refuses a LIKE
// pattern longer than 50 bytes, and these can be longer. Case counts, the same as in canRead.
function scopeSql(access: Access): { sql: string; binds: string[] } {
  if (access.admin) return { sql: "1 = 1", binds: [] };
  const ownPii = `bots/${access.agentId}/journal-sensitive/`;
  const fenced = (inner: { sql: string; binds: string[] }) => ({
    sql: `n.path NOT LIKE ? AND (n.path NOT LIKE 'bots/%/journal-sensitive/%' OR instr(n.path, ?) = 1) AND (${inner.sql})`,
    binds: [RESTRICTED_LIKE, ownPii, ...inner.binds],
  });
  if (hasScope(access, "read:all")) return fenced({ sql: "1 = 1", binds: [] });
  const parts: { sql: string; binds: string[] }[] = [
    { sql: "n.path IN ('AGENTS.md', 'README.md')", binds: [] },
    { sql: "instr(n.path, ?) = 1", binds: [ownPii] },
  ];
  if (hasScope(access, "read:own") || hasScope(access, "write:own")) {
    parts.push({ sql: "instr(n.path, ?) = 1", binds: [`bots/${access.agentId}/`] });
  }
  for (const scope of access.scopes) {
    const summary = /^read:sensitive:summary\/([a-z0-9-]+)$/.exec(scope);
    if (summary) parts.push({ sql: "(instr(n.path, ?) = 1 OR n.path = 'profile/summary.md')", binds: [`domains/${summary[1]}/summaries/`] });
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
    if (domain) visible.push({ sql: "(n.domain = ? OR instr(n.path, ?) = 1)", binds: [domain[1]!, `domains/${domain[1]}/`] });
    if (scope === "read:domain/*") visible.push({ sql: "(n.domain IS NOT NULL OR n.path LIKE 'domains/%')", binds: [] });
    const bot = /^read:bots\/([a-z0-9-]+)$/.exec(scope);
    if (bot) visible.push({ sql: "instr(n.path, ?) = 1", binds: [`bots/${bot[1]}/`] });
    if (scope === "read:bots/*") visible.push({ sql: "n.path LIKE 'bots/%'", binds: [] });
    const prefix = scope.startsWith("read:prefix:") ? scope.slice("read:prefix:".length) : "";
    if (prefix) visible.push({ sql: "instr(n.path, ?) = 1", binds: [prefix] });
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
      parts.push({ sql: "(n.domain = ? OR instr(n.path, ?) = 1 OR instr(n.path, ?) = 1)", binds: [sens[1]!, `domains/${sens[1]}/`, `sensitive/${sens[1]}/`] });
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
  const sensitivePaths = sensitive.map(() => " AND instr(n.path, ?) != 1").join("");
  const ordinaryPaths = ordinary.length ? ` OR ${ordinary.map(() => "instr(n.path, ?) = 1").join(" OR ")}` : "";
  return {
    sql: `(n.sensitivity != 'sensitive' AND ${domainClause}${sensitivePaths} AND n.path NOT LIKE 'sensitive/%' AND (n.path NOT LIKE 'domains/%'${ordinaryPaths}))`,
    binds: [...ordinary, ...sensitive.map((name) => `domains/${name}/`), ...ordinary.map((name) => `domains/${name}/`)],
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
