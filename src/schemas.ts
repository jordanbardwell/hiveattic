import { z } from "zod";
import { VaultError } from "./errors";

const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const idempotency = z.string().regex(IDEMPOTENCY_KEY);
// A tag is written on the entry's `Tags:` line. A newline, `·`, or `^` could forge a heading or block ref.
const tag = z.string().regex(/^[^\r\n·^]{1,40}$/);

export const factSchema = z.object({
  key: slug,
  statement: z.string().min(1).max(2000),
  scope: z.enum(["own", "shared"]).default("own"),
  domain: slug.nullable().optional(),
  observed_at: instant,
  confidence: z.number().min(0).max(1).default(0.7),
  tags: z.array(tag).max(20).default([]),
  links: z.array(z.string().min(1).max(120)).max(20).default([]),
  idempotency_key: idempotency.nullable().optional(),
  sensitivity: z.enum(["normal", "sensitive"]).optional(),
});

export const journalSchema = z.object({
  target: z.enum(["own", "shared", "decisions"]).default("own"),
  title: z.string().min(1).max(120).refine((value) => !/[\r\n·^]/.test(value)),
  body: z.string().min(1).max(8000),
  at: instant.optional(),
  domain: slug.nullable().optional(),
  tags: z.array(tag).max(20).default([]),
  idempotency_key: idempotency.nullable().optional(),
  sensitivity: z.enum(["normal", "sensitive"]).optional(),
});

// The body has no character cap here. Its UTF-8 size is checked against the content limit,
// which answers 413 instead of a schema 400.
export const noteSchema = z.object({
  path: z.string().min(1).max(200),
  body: z.string(),
  extra: z.record(z.string(), z.unknown()).optional(),
  sensitivity: z.enum(["normal", "sensitive"]).optional(),
  domain: slug.nullable().optional(),
  type: z.enum(["note", "role", "profile"]).default("note"),
  if_match: z.string().min(1).max(200).nullable().optional(),
  idempotency_key: idempotency.nullable().optional(),
});

export const forgetSchema = z.object({
  path: z.string().min(1).max(200).optional(),
  id: z.string().min(1).max(80).optional(),
  reason: z.string().min(1).max(200),
  idempotency_key: idempotency.nullable().optional(),
});

export const tokenSchema = z.object({
  agent_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  display_name: z.string().min(1).max(80).optional(),
  kind: z.enum(["agent", "external", "human"]).optional(),
  scopes: z.array(z.string().min(1).max(80)).max(40).optional(),
  preset: z.enum(["reviewer"]).optional(),
  label: z.string().min(1).max(80).optional(),
  ttl_days: z.number().int().min(1).max(365).optional(),
});

export const revokeSchema = z.object({
  token_id: z.string().min(1).max(80).optional(),
  label: z.string().min(1).max(80).optional(),
});

export const tokenScopesSchema = z.object({
  token_id: z.string().min(1).max(80),
  scopes: z.array(z.string().min(1).max(80)).min(1).max(40),
});

export const restoreSchema = z.object({
  path: z.string().min(1).max(200).optional(),
  id: z.string().min(1).max(80).optional(),
  version_ts: z.string().min(1).max(80),
});

export const purgeSchema = z.object({
  path: z.string().min(1).max(200).optional(),
  id: z.string().min(1).max(80).optional(),
});

export const cleanupSchema = z.object({
  run_id: z.string().regex(/^e2e[0-9a-f]{10}$/),
});

// The quarantine erase is not a kind here: its only route is POST /v1/admin/migrations/quarantine-erase.
export const jobSchema = z.strictObject({
  kind: z.enum(["rebuild", "reindex", "reconcile"]),
});

export const quarantineEraseSchema = z.strictObject({
  dry_run: z.boolean().optional(),
  confirm_count: z.number().int().min(0).optional(),
});

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => (issue.path.length ? issue.path.join(".") : issue.code));
    throw new VaultError("invalid", "Request body failed validation", reasons);
  }
  return parsed.data;
}
