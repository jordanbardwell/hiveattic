import { isClassifiedDomain, isOrdinaryDomain, isSensitiveDomain, RESTRICTED } from "./config";
import { VaultError } from "./errors";
import { innerPath, inSensitiveFolder, isRestrictedPath, piiJournalOwner, sensitiveSegment } from "./paths";

export type Access = {
  agentId: string;
  tokenId: string;
  scopes: string[];
  admin: boolean;
};

export type NoteView = {
  path: string;
  owner: string;
  domain: string | null;
  sensitivity: string;
  frontmatter?: Record<string, unknown>;
};

export const REVIEWER_SCOPES = ["read:shared", "read:decisions", "read:domain/*", "read:inbox"];

// Agent ids the server uses for itself or for system actors. A token cannot be minted for them, and a
// token minted for one before mint refused them is not accepted ("shared" owns every note outside bots/).
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

// Admin is the admin token only. A stored scope list never makes a token admin. A wildcard
// expands only within its own class: `read:domain/*` to ordinary domains, `*:sensitive/*` to
// sensitive domains. Neither reaches an unclassified domain or `restricted`.
export function hasScope(access: Access, scope: string): boolean {
  if (access.admin || access.scopes.includes(scope)) return true;
  const slash = scope.indexOf("/");
  if (slash <= 0) return false;
  const family = scope.slice(0, slash);
  const name = scope.slice(slash + 1);
  if (!access.scopes.includes(`${family}/*`)) return false;
  if (family === "read:domain" || family === "write:domain") return isOrdinaryDomain(name);
  if (family === "read:sensitive" || family === "write:sensitive") return isSensitiveDomain(name);
  return true;
}

// The domain a path belongs to: domains/<d>/ or sensitive/<d>/. restricted is not a domain.
export function domainOf(path: string): string | null {
  const match = /^domains\/([^/]+)\//.exec(path);
  if (match?.[1]) return match[1];
  const segment = sensitiveSegment(path);
  return segment && segment !== RESTRICTED ? segment : null;
}

export function assertClassifiedDomain(domain: string | null | undefined): void {
  if (!domain) return;
  if (!isClassifiedDomain(domain)) throw new VaultError("unclassified_domain", "domain is not classified", [domain]);
}

// A path under domains/<d>/ or sensitive/<d>/ owns that domain. A caller-supplied domain that disagrees is invalid.
export function resolveDomain(path: string, supplied: string | null | undefined): string | null {
  if (isRestrictedPath(path)) {
    if (supplied) throw new VaultError("invalid", "domain does not match the path");
    return null;
  }
  const fromPath = domainOf(path);
  if (fromPath) {
    if (supplied && supplied !== fromPath) throw new VaultError("invalid", "domain does not match the path");
    assertClassifiedDomain(fromPath);
    if (sensitiveSegment(path) && !isSensitiveDomain(fromPath)) throw new VaultError("invalid", "sensitive/ holds sensitive domains only");
    return fromPath;
  }
  assertClassifiedDomain(supplied);
  return supplied ?? null;
}

export function effectiveDomain(note: NoteView): string | null {
  return domainOf(note.path) ?? note.domain ?? null;
}

export function isSummary(note: NoteView): boolean {
  if (note.path.includes("/summaries/") || note.path === "profile/summary.md") return true;
  return note.frontmatter?.vault_summary === true;
}

export function isSensitive(note: NoteView): boolean {
  if (note.path.startsWith("sensitive/")) return true;
  const domain = effectiveDomain(note);
  if (note.sensitivity === "sensitive") return true;
  if (domain === null) return false;
  return !isOrdinaryDomain(domain);
}

// How a stored note is classified for access checks. The service and the writer both use this,
// so they agree on what a forget or an update has to be allowed to touch.
export function noteSensitivity(note: { path: string; sensitivity: string; domain: string | null }): "normal" | "sensitive" {
  if (note.sensitivity === "sensitive" || inSensitiveFolder(note.path)) return "sensitive";
  return note.domain !== null && !isOrdinaryDomain(note.domain) ? "sensitive" : "normal";
}

export function canRead(access: Access, note: NoteView): boolean {
  // sensitive/restricted/ is the admin token's alone. No scope, read:all included, reaches it.
  if (isRestrictedPath(note.path)) return access.admin;
  // A bot's own PII journal: its writer always reads it, with or without a read:sensitive scope.
  // Nobody else does, whatever scopes they hold (read:bots/<writer> and read:all included), except
  // the admin token. This runs before every other rule.
  const piiOwner = piiJournalOwner(note.path);
  if (piiOwner) return access.admin || piiOwner === access.agentId;
  if (access.admin || hasScope(access, "read:all")) return true;
  if (note.path === "AGENTS.md" || note.path === "README.md") return true;
  const segment = sensitiveSegment(note.path);
  if (segment) return isSensitiveDomain(segment) && hasScope(access, `read:sensitive/${segment}`);
  const ownFolder = note.path.startsWith(`bots/${access.agentId}/`);
  if (ownFolder && (hasScope(access, "read:own") || hasScope(access, "write:own"))) return true;
  const domain = effectiveDomain(note);
  if (isSensitive(note) && !sensitiveRead(access, note, domain)) return false;
  if (note.domain && !domainOf(note.path)) {
    const tagged =
      hasScope(access, `read:domain/${note.domain}`) ||
      hasScope(access, `read:sensitive/${note.domain}`) ||
      (isSummary(note) && hasScope(access, `read:sensitive:summary/${note.domain}`));
    if (!tagged) return false;
  }
  if (note.owner === access.agentId && (hasScope(access, "read:own") || hasScope(access, "write:own"))) return true;
  const bot = /^bots\/([^/]+)\//.exec(note.path);
  if (bot) {
    if (bot[1] === access.agentId && hasScope(access, "read:own")) return true;
    if (hasScope(access, `read:bots/${bot[1]}`)) return true;
    return false;
  }
  if (domain && hasScope(access, `read:domain/${domain}`)) return true;
  if (note.path.startsWith("inbox/") && (hasScope(access, "read:shared") || hasScope(access, "read:inbox"))) return true;
  if ((note.path.startsWith("shared/") || note.path.startsWith("profile/") || note.path.startsWith("journal/")) && hasScope(access, "read:shared")) {
    return true;
  }
  if (note.path === "shared/decisions.md" && hasScope(access, "read:decisions")) return true;
  if (isSummary(note) && domain && hasScope(access, `read:sensitive:summary/${domain}`)) return true;
  if (note.path === "profile/summary.md" && access.scopes.some((scope) => scope.startsWith("read:sensitive:summary/"))) return true;
  return access.scopes.some((scope) => scope.startsWith("read:prefix:") && note.path.startsWith(scope.slice("read:prefix:".length)));
}

function sensitiveRead(access: Access, note: NoteView, domain: string | null): boolean {
  if (domain && hasScope(access, `read:sensitive/${domain}`)) return true;
  if (!domain && hasScope(access, "read:sensitive/pii")) return true;
  if (isSummary(note) && domain && hasScope(access, `read:sensitive:summary/${domain}`)) return true;
  if (note.path === "profile/summary.md" && access.scopes.some((scope) => scope.startsWith("read:sensitive:summary/"))) return true;
  return false;
}

export function canWrite(access: Access, path: string, sensitivity: "normal" | "sensitive", domain: string | null = null): boolean {
  if (access.admin) return true;
  if (isRestrictedPath(path)) return false;
  const segment = sensitiveSegment(path);
  if (segment) {
    // A rerouted file: the caller needs write:sensitive/<d> and the right to write the path it came from.
    const inner = innerPath(path);
    if (!inner || !isSensitiveDomain(segment) || !hasScope(access, `write:sensitive/${segment}`)) return false;
    return canWrite(access, inner, "normal", null);
  }
  const pathDomain = domainOf(path) ?? domain;
  const ownFolder = path.startsWith(`bots/${access.agentId}/`);
  const sensitive = sensitivity === "sensitive" || (pathDomain !== null && !isOrdinaryDomain(pathDomain));
  const ownPiiJournal = ownFolder && !pathDomain && path.includes("/journal-sensitive/");
  if (sensitive && !ownPiiJournal) {
    if (pathDomain) {
      if (!hasScope(access, `write:sensitive/${pathDomain}`)) return false;
    } else if (!hasScope(access, "write:sensitive/pii")) return false;
  }
  const role = /^bots\/([^/]+)\/role\.md$/.exec(path);
  if (role && role[1] !== access.agentId) return false;
  if (path === "AGENTS.md" || path === "README.md" || path === "profile/summary.md") return false;
  const bot = /^bots\/([^/]+)\//.exec(path);
  if (bot) {
    if (bot[1] === access.agentId && hasScope(access, "write:own")) return true;
    return hasScope(access, `write:bots/${bot[1]}`);
  }
  if (pathDomain && domainOf(path) && hasScope(access, `write:domain/${pathDomain}`)) return true;
  if (path.startsWith("inbox/") && (hasScope(access, "write:inbox") || hasScope(access, "write:shared"))) return true;
  if (path === "shared/decisions.md") return hasScope(access, "write:decisions");
  if ((path.startsWith("shared/") || path.startsWith("profile/") || path.startsWith("journal/")) && hasScope(access, "write:shared")) return true;
  return access.scopes.some((scope) => scope.startsWith("write:prefix:") && path.startsWith(scope.slice("write:prefix:".length)));
}

export function assertVaultPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (
    trimmed.length === 0 ||
    trimmed.length > 200 ||
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("//") ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*\.md$/.test(trimmed) ||
    trimmed.startsWith("sys/")
  ) {
    throw new VaultError("invalid", "Path is not a vault-relative markdown path");
  }
  return trimmed;
}

// Scope grammar for mint. A raw `admin` string is not a scope, and nothing names `restricted`.
const PLAIN_SCOPES = new Set([
  "read:own",
  "write:own",
  "read:shared",
  "write:shared",
  "read:inbox",
  "write:inbox",
  "read:decisions",
  "write:decisions",
  "read:all",
  "audit:read",
]);

export function scopeProblem(scope: string): string | null {
  if (PLAIN_SCOPES.has(scope)) return null;
  const named = /^(read|write):(domain|sensitive|bots)\/(\*|[a-z0-9][a-z0-9-]{0,63})$/.exec(scope);
  if (named) {
    const [, , family, name] = named;
    if (name === RESTRICTED) return "restricted_scope";
    if (family === "sensitive" && name === "pii") return null;
    return null;
  }
  const summary = /^read:sensitive:summary\/([a-z0-9][a-z0-9-]{0,63})$/.exec(scope);
  if (summary) return summary[1] === RESTRICTED ? "restricted_scope" : null;
  const prefix = /^(read|write):prefix:([A-Za-z0-9][A-Za-z0-9_./-]{0,199})$/.exec(scope);
  if (prefix) {
    const target = prefix[2]!;
    if (target.includes("..") || target.includes("//") || target.startsWith("sys/") || target.startsWith("sensitive/")) return "unsafe_prefix";
    return null;
  }
  return "bad_scope";
}
