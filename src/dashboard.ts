import { vaultTimeZone } from "./config";
import { VaultError } from "./errors";
import type { Session } from "./service";

// Read-only views for the owner console. Both are admin-only: they list every agent, token, and
// note, whatever its folder. No token hash, body, or audit hash leaves this file.

const NOTE_LIMIT = 500;
const LINK_LIMIT = 4000;
const DAY_MS = 86_400_000;

function assertAdmin(session: Session): void {
  if (!session.access.admin) throw new VaultError("forbidden_scope", "Admin scope required");
}

type AgentRow = { id: string; display_name: string; kind: string; scopes: string; created_at: string; disabled_at: string | null };
type TokenRow = {
  id: string;
  agent_id: string;
  label: string | null;
  scopes_override: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};
type ActivityRow = { agent_id: string; writes: number; rejected: number; last_at: string | null };

export async function adminAgents(env: Env, session: Session): Promise<Record<string, unknown>> {
  assertAdmin(session);
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [agents, tokens, activity] = await env.DB.batch([
    env.DB.prepare("SELECT id, display_name, kind, scopes, created_at, disabled_at FROM agents ORDER BY id"),
    env.DB.prepare("SELECT id, agent_id, label, scopes_override, created_at, expires_at, revoked_at, last_used_at FROM tokens ORDER BY created_at"),
    env.DB.prepare(
      `SELECT agent_id, SUM(outcome = 'ok') AS writes, SUM(outcome != 'ok') AS rejected, MAX(ts) AS last_at
       FROM audit_log WHERE ts >= ? AND path IS NOT NULL AND agent_id IS NOT NULL GROUP BY agent_id`,
    ).bind(since),
  ]);
  const byAgent = new Map<string, ActivityRow>();
  for (const row of (activity?.results ?? []) as ActivityRow[]) byAgent.set(row.agent_id, row);
  const tokenRows = (tokens?.results ?? []) as TokenRow[];
  return {
    agents: ((agents?.results ?? []) as AgentRow[]).map((agent) => {
      const own = tokenRows.filter((token) => token.agent_id === agent.id);
      const seen = own.map((token) => token.last_used_at).filter((at): at is string => Boolean(at));
      const recent = byAgent.get(agent.id);
      if (recent?.last_at) seen.push(recent.last_at);
      return {
        id: agent.id,
        display_name: agent.display_name,
        kind: agent.kind,
        scopes: parseList(agent.scopes),
        created_at: agent.created_at,
        disabled_at: agent.disabled_at,
        writes_24h: Number(recent?.writes ?? 0),
        rejected_24h: Number(recent?.rejected ?? 0),
        last_seen_at: seen.sort().at(-1) ?? null,
        tokens: own.map((token) => ({
          id: token.id,
          label: token.label,
          scopes: token.scopes_override ? parseList(token.scopes_override) : null,
          created_at: token.created_at,
          expires_at: token.expires_at,
          revoked_at: token.revoked_at,
          last_used_at: token.last_used_at,
        })),
      };
    }),
  };
}

type NoteRow = {
  id: string;
  path: string;
  title: string | null;
  type: string;
  owner: string;
  domain: string | null;
  sensitivity: string;
  status: string;
  fact_key: string | null;
  observed_at: string | null;
  updated_at: string;
  last_writer: string;
  last_confirmed_at: string | null;
  frontmatter: string;
  body: string;
};

export async function adminOverview(env: Env, session: Session): Promise<Record<string, unknown>> {
  assertAdmin(session);
  const now = Date.now();
  const since = new Date(now - DAY_MS).toISOString();
  const [notes, totals, links, hourly, lastWrite, conflicts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, path, title, type, owner, domain, sensitivity, status, fact_key, observed_at, updated_at, last_writer, last_confirmed_at, frontmatter, body
       FROM notes WHERE status != 'superseded' ORDER BY updated_at DESC LIMIT ?`,
    ).bind(NOTE_LIMIT),
    env.DB.prepare("SELECT status, type, COUNT(*) AS n FROM notes GROUP BY status, type"),
    env.DB.prepare("SELECT src_note_id, dst_note_id FROM links WHERE dst_note_id IS NOT NULL LIMIT ?").bind(LINK_LIMIT),
    env.DB.prepare(
      `SELECT substr(ts, 1, 13) AS hour, SUM(outcome = 'ok') AS ok, SUM(outcome != 'ok') AS rejected
       FROM audit_log WHERE ts >= ? AND path IS NOT NULL GROUP BY hour`,
    ).bind(since),
    env.DB.prepare("SELECT MAX(ts) AS at FROM audit_log WHERE outcome = 'ok' AND path IS NOT NULL"),
    env.DB.prepare("SELECT id, fact_key, winner_id, loser_id, at FROM conflicts WHERE resolved_at IS NULL ORDER BY at DESC LIMIT 20"),
  ]);
  const rows = (notes?.results ?? []) as NoteRow[];
  const ids = new Set(rows.map((row) => row.id));
  const byHour = new Map<string, { ok: number; rejected: number }>();
  for (const row of (hourly?.results ?? []) as { hour: string; ok: number; rejected: number }[]) {
    byHour.set(row.hour, { ok: Number(row.ok ?? 0), rejected: Number(row.rejected ?? 0) });
  }
  // 24 buckets, oldest first, ending with the current hour.
  const hours = [];
  for (let i = 23; i >= 0; i--) {
    const hour = new Date(now - i * 3_600_000).toISOString().slice(0, 13);
    hours.push({ hour: `${hour}:00:00Z`, ...(byHour.get(hour) ?? { ok: 0, rejected: 0 }) });
  }
  let zone: string | null = null;
  try {
    zone = vaultTimeZone(env);
  } catch {
    zone = null;
  }
  return {
    vault: {
      deploy_env: env.DEPLOY_ENV === "staging" ? "staging" : "production",
      git_sha: env.GIT_SHA?.trim() || null,
      vault_tz: zone,
      bucket: env.VAULT_BUCKET || null,
      sensitive_domains: (env.SENSITIVE_DOMAINS ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    },
    totals: ((totals?.results ?? []) as { status: string; type: string; n: number }[]).map((row) => ({ status: row.status, type: row.type, count: Number(row.n) })),
    notes: rows.map((row) => noteSummary(row)),
    notes_truncated: rows.length === NOTE_LIMIT,
    links: ((links?.results ?? []) as { src_note_id: string; dst_note_id: string }[])
      .filter((link) => ids.has(link.src_note_id) && ids.has(link.dst_note_id))
      .map((link) => [link.src_note_id, link.dst_note_id]),
    hourly: hours,
    last_write_at: (lastWrite?.results?.[0] as { at: string | null } | undefined)?.at ?? null,
    conflicts: (conflicts?.results ?? []) as Record<string, unknown>[],
  };
}

function noteSummary(row: NoteRow): Record<string, unknown> {
  const frontmatter = parseObject(row.frontmatter);
  const confidence = typeof frontmatter.confidence === "number" ? frontmatter.confidence : null;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    type: row.type,
    owner: row.owner,
    domain: row.domain,
    sensitivity: row.sensitivity,
    status: row.status,
    fact_key: row.fact_key,
    observed_at: row.observed_at,
    updated_at: row.updated_at,
    last_writer: row.last_writer,
    last_confirmed_at: row.last_confirmed_at,
    confidence,
    snippet: snippet(row.body),
  };
}

// The first line of prose, without the frontmatter, headings, links, or server markers.
export function snippet(markdown: string): string {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--") || /^\[\[[^\]]+\]\]$/.test(line) || /^Tags: /.test(line)) continue;
    const text = line.replace(/^[-*]\s+/, "").replace(/\[\[([^\]]+)\]\]/g, "$1");
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  }
  return "";
}

function parseList(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
