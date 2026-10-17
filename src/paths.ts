import { isSensitiveDomain, RESTRICTED } from "./config";

export function factPath(agentId: string, scope: "own" | "shared", key: string): string {
  return scope === "shared" ? `profile/facts/${key}.md` : `bots/${agentId}/facts/${key}.md`;
}

export function journalPath(agentId: string, target: "own" | "shared" | "decisions", date: string): string {
  if (target === "decisions") return "shared/decisions.md";
  const [year, month] = date.split("-");
  if (target === "shared") return `journal/${year}/${month}/${date}.md`;
  return `bots/${agentId}/journal/${year}/${month}/${date}.md`;
}

// A rerouted journal entry goes to the writer's day file in the sensitive folder, whatever the
// requested target was.
export function sensitiveJournalPath(domain: string, agentId: string, date: string): string {
  return `sensitive/${domain}/journal/${agentId}/${date}.md`;
}

export function reroutedPath(domain: string, path: string): string {
  return `sensitive/${domain}/${path}`;
}

export function isRestrictedPath(path: string): boolean {
  return path.startsWith(`sensitive/${RESTRICTED}/`);
}

// The domain segment of a path under sensitive/, or null for any other path.
export function sensitiveSegment(path: string): string | null {
  const match = /^sensitive\/([^/]+)\//.exec(path);
  return match?.[1] ?? null;
}

// The path a sensitive/<d>/ file was rerouted from.
export function innerPath(path: string): string | null {
  const match = /^sensitive\/[^/]+\/(.+)$/.exec(path);
  return match?.[1] ?? null;
}

// Sensitive folders: domains/<sensitive d>/, sensitive/<d>/ (restricted included), and the legacy
// own PII journal bots/<a>/journal-sensitive/. A write already inside one is never rerouted.
export function inSensitiveFolder(path: string): boolean {
  if (path.startsWith("sensitive/")) return true;
  const domain = /^domains\/([^/]+)\//.exec(path)?.[1];
  if (domain && isSensitiveDomain(domain)) return true;
  return /^bots\/[^/]+\/journal-sensitive\//.test(path);
}

// Files the server writes for every reader. They are never classified or moved.
export function isServerDocument(path: string): boolean {
  return path === "AGENTS.md" || path === "README.md" || path === "profile/summary.md" || path === "inbox/conflicts.md";
}

export function isAppendOnlyPath(path: string): boolean {
  return (
    path === "shared/decisions.md" ||
    path === "inbox/conflicts.md" ||
    path.startsWith("journal/") ||
    path.includes("/journal/") ||
    path.includes("/journal-sensitive/")
  );
}

export function isFactPath(path: string): boolean {
  return /(^|\/)facts\/[^/]+\.md$/.test(path);
}

export function isServerManagedPath(path: string): boolean {
  return path === "profile/summary.md" || isFactPath(path);
}

// Only the admin token may forget these: append-only journals and decisions, server-written
// files, and the vault rule card. Appends to a protected day file keep working.
export function isForgetProtectedPath(path: string): boolean {
  return (
    path.startsWith("journal/") ||
    /^bots\/[^/]+\/journal(?:-sensitive)?\//.test(path) ||
    /^sensitive\/[^/]+\/journal\//.test(path) ||
    path === "shared/decisions.md" ||
    path.startsWith("inbox/") ||
    path === "profile/summary.md" ||
    path === "AGENTS.md" ||
    path === "README.md" ||
    path.startsWith("sys/")
  );
}

export function ownerForPath(path: string): string {
  const bot = /^(?:sensitive\/[^/]+\/)?bots\/([^/]+)\//.exec(path);
  if (bot?.[1]) return bot[1];
  const journal = /^sensitive\/[^/]+\/journal\/([^/]+)\//.exec(path);
  return journal?.[1] ?? "shared";
}

export function r2KeyFor(prefix: string, path: string): string {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${normalized}${path}`;
}

export function vaultPathFromKey(prefix: string, key: string): string | null {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  if (!key.startsWith(normalized)) return null;
  return key.slice(normalized.length);
}
