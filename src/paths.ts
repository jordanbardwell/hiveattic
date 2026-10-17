export function factPath(agentId: string, scope: "own" | "shared", key: string): string {
  return scope === "shared" ? `profile/facts/${key}.md` : `bots/${agentId}/facts/${key}.md`;
}

export function journalPath(agentId: string, target: "own" | "shared" | "decisions", date: string, sensitive = false): string {
  if (target === "decisions") return "shared/decisions.md";
  const [year, month] = date.split("-");
  if (target === "shared") return `journal/${year}/${month}/${date}.md`;
  const folder = sensitive ? "journal-sensitive" : "journal";
  return `bots/${agentId}/${folder}/${year}/${month}/${date}.md`;
}

export function isAppendOnlyPath(path: string): boolean {
  return (
    path === "shared/decisions.md" ||
    path === "inbox/conflicts.md" ||
    path === "inbox/quarantine.md" ||
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

export function isGeneratedNote(path: string): boolean {
  return path === "inbox/quarantine.md" || path === "inbox/conflicts.md" || path === "profile/summary.md";
}

export function ownerForPath(path: string): string {
  const bot = /^bots\/([^/]+)\//.exec(path);
  return bot?.[1] ?? "shared";
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
