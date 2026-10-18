import { parse, stringify } from "yaml";

export type Frontmatter = Record<string, unknown>;

export function buildMarkdown(frontmatter: Frontmatter, body: string): string {
  const yaml = stringify(compact(frontmatter), { lineWidth: 0 }).trimEnd();
  const content = body.replace(/^\n+/, "").replace(/\s+$/, "");
  return `---\n${yaml}\n---\n${content}\n`;
}

export function parseMarkdown(file: string): { frontmatter: Frontmatter; body: string } {
  const text = file.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + 5);
  try {
    const data = parse(raw, { schema: "core" });
    if (!data || typeof data !== "object" || Array.isArray(data)) return { frontmatter: {}, body };
    return { frontmatter: data as Frontmatter, body };
  } catch {
    return { frontmatter: {}, body: text };
  }
}

export function stringField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

export function linkTargets(body: string): string[] {
  const found = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of body.matchAll(re)) {
    const target = match[1]?.trim();
    if (target) found.add(target);
  }
  return [...found];
}

export function chunkMarkdown(path: string, title: string, body: string): { n: number; text: string; tokenCount: number }[] {
  const sections = body.split(/\n(?=#{1,6} )/).map((section) => section.trim()).filter(Boolean);
  const source = sections.length > 0 ? sections : [body.trim()];
  const pieces: string[] = [];
  const target = 1600;
  const overlap = 240;
  for (const section of source) {
    if (section.length <= target) {
      pieces.push(section);
      continue;
    }
    let index = 0;
    while (index < section.length) {
      pieces.push(section.slice(index, index + target));
      if (index + target >= section.length) break;
      index += target - overlap;
    }
  }
  const usable = pieces.length > 0 ? pieces : [""];
  return usable.slice(0, 200).map((piece, n) => {
    const text = `${title}\n${path}\n${piece}`.trim();
    return { n, text, tokenCount: Math.ceil(text.length / 4) };
  });
}

export type JournalEntry = {
  id: string;
  agent: string;
  title: string;
  body: string;
  idempotency: string | null;
  mac: string | null;
};

export function journalEntries(markdown: string): JournalEntry[] {
  const { body } = parseMarkdown(markdown);
  const blocks = body.split(/\n(?=## )/);
  const entries: JournalEntry[] = [];
  for (const block of blocks) {
    const heading = /^## .+ · ([^·\n]+) · (.+?) \^([0-9A-HJKMNP-TV-Z]{26})/m.exec(block);
    if (!heading) continue;
    const idem = /<!-- hiveattic:idempotency=([A-Za-z0-9_.:-]{1,64}) -->/.exec(block);
    const mac = /<!-- hiveattic:e=([0-9A-HJKMNP-TV-Z]{26}):([^:\s]+):([0-9a-f]{16}) -->/.exec(block);
    entries.push({
      id: heading[3]!,
      agent: heading[1]!.trim(),
      title: heading[2]!.trim(),
      body: journalBlockBody(block),
      idempotency: idem?.[1] ?? null,
      mac: mac && mac[1] === heading[3] ? mac[3]! : null,
    });
  }
  return entries;
}

function journalBlockBody(block: string): string {
  const lines = block.split("\n").slice(1);
  const kept: string[] = [];
  for (const line of lines) {
    if (/hiveattic:/i.test(line)) break;
    if (/^Tags: /.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

// Frontmatter keys the server writes, with the exact value shape it writes. A key is left out of the
// filter only when its value has that shape, so an outside edit cannot hide text under one of these names.
const SERVER_FIELDS = new Map<string, (value: unknown) => boolean>([
  ["vault_id", (value) => typeof value === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)],
  ["vault_idempotency", (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)],
  ["vault_summary", (value) => typeof value === "boolean"],
  ["source", (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)],
  ["supersedes", (value) => typeof value === "string" && /^(?:\d{8}T\d{9}Z[0-9a-f]{4}|[0-9A-HJKMNP-TV-Z]{26})$/.test(value)],
]);

// Only the journal markers the server writes. Any other hiveattic comment is filtered like body text.
const SERVER_MARKER = /<!-- hiveattic:(?:e=[0-9A-HJKMNP-TV-Z]{26}:[a-z0-9][a-z0-9-]{0,63}:(?:[0-9a-f]{16})?|idempotency=[A-Za-z0-9_.:-]{1,64}) -->/g;

// The hash in a quarantine alert line is hex and can hold a digit run that passes the card check.
// Only the hash is dropped, and only on a line with exactly the shape the server writes.
const QUARANTINE_ALERT_HASH = /^(A vault file was excluded from search \([a-z_, ]+\)\. Hash )[0-9a-f]{64}(\.(?: Ref e2e[0-9a-f]{10}\.)?)$/gm;

export function textForFilter(markdown: string): string {
  const parsed = parseMarkdown(markdown);
  const frontmatter: Frontmatter = {};
  for (const [key, value] of Object.entries(parsed.frontmatter)) {
    if (SERVER_FIELDS.get(key)?.(value)) continue;
    frontmatter[key] = value;
  }
  const body = parsed.body.replace(SERVER_MARKER, "").replace(QUARANTINE_ALERT_HASH, "$1$2");
  return buildMarkdown(frontmatter, body);
}

export function guardJournalBody(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !line.toLowerCase().includes("hiveattic:"))
    .map((line) => (/^\s*#/.test(line) ? `\\${line}` : line))
    .join("\n");
}

function compact(frontmatter: Frontmatter): Frontmatter {
  const out: Frontmatter = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}
