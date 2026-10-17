import { sha256Hex } from "./crypto";

// An idempotency key is bound to the operation and its fields, without the key itself. The same
// key with the same payload replays the stored response; with any other payload it is refused.
export async function payloadHash(kind: string, payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(`${kind}\n${canonicalJson(payload)}`);
}

// JSON with object keys sorted at every level and undefined fields dropped, so the hash does not
// depend on the order a client wrote its fields in.
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// The millisecond timestamp in the first ten characters of a ULID, or null for anything else.
export function ulidTime(id: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
}
