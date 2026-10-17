import { VaultError } from "./errors";

// Size limits, in bytes. The request cap covers the whole HTTP body, JSON envelope and MCP
// framing included, and is checked before anything parses it. The content cap applies to a note
// body or fact statement after JSON decoding. The file cap keeps one stored file under the D1
// row limit, which only an append target such as a journal day file can approach.
export const REQUEST_LIMIT_BYTES = 256_000;
export const CONTENT_LIMIT_BYTES = 200_000;
export const FILE_LIMIT_BYTES = 1_900_000;

export const RESTRICTED = "restricted";

export type DomainConfig = { sensitive: Set<string>; ordinary: Set<string> };

const DEFAULT_SENSITIVE = "health,finance";
let loaded: { key: string; config: DomainConfig } | null = null;

// Domain classes come from SENSITIVE_DOMAINS (default health,finance) and ORDINARY_DOMAINS
// (default empty). A name in neither set is unclassified: writes fail and reads treat it as
// sensitive. Every entry point calls this before it touches access rules.
export function configure(env: Env): DomainConfig {
  const sensitiveRaw = env.SENSITIVE_DOMAINS?.trim() || DEFAULT_SENSITIVE;
  const ordinaryRaw = env.ORDINARY_DOMAINS?.trim() ?? "";
  const key = `${sensitiveRaw}|${ordinaryRaw}`;
  if (loaded?.key === key) return loaded.config;
  const sensitive = domainList(sensitiveRaw, "SENSITIVE_DOMAINS");
  const ordinary = domainList(ordinaryRaw, "ORDINARY_DOMAINS");
  for (const name of sensitive) {
    if (ordinary.has(name)) throw new VaultError("misconfigured", "A domain is listed as both sensitive and ordinary", [name]);
  }
  loaded = { key, config: { sensitive, ordinary } };
  return loaded.config;
}

export function domainConfig(): DomainConfig {
  if (!loaded) return configure({} as Env);
  return loaded.config;
}

export function isSensitiveDomain(name: string | null | undefined): boolean {
  return Boolean(name) && domainConfig().sensitive.has(name!);
}

export function isOrdinaryDomain(name: string | null | undefined): boolean {
  return Boolean(name) && domainConfig().ordinary.has(name!);
}

export function isClassifiedDomain(name: string): boolean {
  return isSensitiveDomain(name) || isOrdinaryDomain(name);
}

function domainList(raw: string, label: string): Set<string> {
  const names = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || name === RESTRICTED || name === "pii") {
      throw new VaultError("misconfigured", `${label} has a name that cannot be a domain`, [name]);
    }
  }
  return new Set(names);
}

// Day files and journal headings follow VAULT_TZ, an IANA name. TZ_DISPLAY is read as a
// deprecated alias for one release. An unknown zone fails the write instead of filing it on the
// wrong day.
export function vaultTimeZone(env: Env): string {
  const zone = (env.VAULT_TZ?.trim() || env.TZ_DISPLAY?.trim() || "UTC").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
  } catch {
    throw new VaultError("misconfigured", "VAULT_TZ is not a valid IANA time zone");
  }
  return zone;
}

// Staging needs the staging flag and staging resource names. Everything else counts as
// production, including a deploy that sets ENVIRONMENT=production on top of staging names.
export function stagingResources(env: Env): boolean {
  const bucket = env.VAULT_BUCKET ?? "";
  const db = env.DB_NAME ?? "";
  const worker = env.WORKER_NAME ?? "";
  // Names from wrangler.staging.example.jsonc put `-staging` in the middle
  // (`hiveattic-staging-vault`) or at the end (`hiveattic-vault-staging`).
  return env.DEPLOY_ENV === "staging" && bucket.includes("-staging") && db.includes("-staging") && worker.includes("staging");
}

export function isProductionDeploy(env: Env): boolean {
  if (env.ENVIRONMENT?.trim() === "production") return true;
  return !stagingResources(env);
}

export function writeTimeoutMs(env: Env): number {
  const raw = Number(env.WRITE_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
