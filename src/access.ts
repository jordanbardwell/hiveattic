import { VaultError } from "./errors";

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

export const REVIEWER_SCOPES = ["read:shared", "read:decisions", "read:domain/*", "read:inbox", "audit:read"];

export const SENSITIVE_DOMAINS = new Set(["health", "finance"]);

export function hasScope(access: Access, scope: string): boolean {
  if (access.admin || access.scopes.includes("admin") || access.scopes.includes(scope)) return true;
  const slash = scope.indexOf("/");
  if (slash > 0 && access.scopes.includes(`${scope.slice(0, slash)}/*`)) return true;
  return false;
}

export function domainOf(path: string): string | null {
  const match = /^domains\/([^/]+)\//.exec(path);
  return match?.[1] ?? null;
}

// A path under domains/<d>/ always owns that domain. A caller-supplied domain that disagrees is invalid.
export function resolveDomain(path: string, supplied: string | null | undefined): string | null {
  const fromPath = domainOf(path);
  if (fromPath) {
    if (supplied && supplied !== fromPath) throw new VaultError("invalid", "domain does not match the path");
    return fromPath;
  }
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
  const domain = effectiveDomain(note);
  return note.sensitivity === "sensitive" || (domain !== null && SENSITIVE_DOMAINS.has(domain));
}

export function canRead(access: Access, note: NoteView): boolean {
  if (access.admin || hasScope(access, "read:all")) return true;
  if (note.path === "AGENTS.md" || note.path === "README.md") return true;
  const ownFolder = note.path.startsWith(`bots/${access.agentId}/`);
  if (ownFolder && (note.owner === access.agentId || ownFolder) && (hasScope(access, "read:own") || hasScope(access, "write:own"))) {
    return true;
  }
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
  const pathDomain = domainOf(path) ?? domain;
  const ownFolder = path.startsWith(`bots/${access.agentId}/`);
  const sensitive = sensitivity === "sensitive" || (pathDomain !== null && SENSITIVE_DOMAINS.has(pathDomain));
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
