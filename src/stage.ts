import type { JsonValue } from "./errors";

// D1 caps a bound value at 2 MB. Rows go to D1 as JSON arrays split well below that, so a page of
// a rebuild costs a few statements instead of one per chunk.
export const STAGE_JSON_BYTES = 900_000;

export function byteLength(parts: string[]): number {
  let total = 0;
  for (const part of parts) total += new TextEncoder().encode(part).length + 1;
  return total;
}

export function jsonSelect(columns: string[]): string {
  return columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(", ");
}

export function jsonInsert(verb: string, columns: string[]): string {
  return `${verb} (${columns.join(", ")}) SELECT ${jsonSelect(columns)} FROM json_each(?)`;
}

export function jsonSlices(rows: JsonValue[][]): string[] {
  const out: string[] = [];
  let parts: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const part = JSON.stringify(row);
    const size = new TextEncoder().encode(part).length + 1;
    if (parts.length && bytes + size > STAGE_JSON_BYTES) {
      out.push(`[${parts.join(",")}]`);
      parts = [];
      bytes = 0;
    }
    parts.push(part);
    bytes += size;
  }
  if (parts.length) out.push(`[${parts.join(",")}]`);
  return out;
}

export function slices<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export type StagedRows = {
  notes: JsonValue[][];
  chunks: JsonValue[][];
  journal: JsonValue[][];
  links: JsonValue[][];
  idempotency: JsonValue[][];
  tombstones: JsonValue[][];
  // Ids that already hold one of the staged paths under another id, and ids that lose a fact key.
  replaced: string[];
  unkeyed: string[];
};

export function emptyRows(): StagedRows {
  return { notes: [], chunks: [], journal: [], links: [], idempotency: [], tombstones: [], replaced: [], unkeyed: [] };
}

export function stagedBytes(rows: StagedRows): number {
  let total = 0;
  for (const table of ["notes", "chunks", "journal", "links", "idempotency", "tombstones"] as const) {
    for (const row of rows[table]) total += JSON.stringify(row).length + 1;
  }
  return total;
}
