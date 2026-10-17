import { isSensitiveDomain, RESTRICTED } from "./config";
import { parseMarkdown, type Frontmatter } from "./markdown";
import { PII_ROUTE } from "./paths";

// Content classification. It never rejects anything: a hit only decides that a write lands in a
// sensitive folder instead of the path the caller named. The word lists are deliberately narrow
// (personal health and personal finance), so engineering prose such as "tech debt", "error
// budget", or "diagnose the bug" stays where it was written. Card, account, and routing numbers
// are not signals: bots are told not to store them, and the server does not look for them.

export type Classification = { health: boolean; finance: boolean; pii: boolean };

// A term matches only as a whole word. Lookarounds instead of \b, so a term that ends in
// punctuation, such as 401(k), still matches.
function bounded(term: string): string {
  return `(?<![A-Za-z0-9])(?:${term})(?![A-Za-z0-9])`;
}

const HEALTH = new RegExp(
  [
    "diagnosis",
    "diagnosed with",
    "prescription",
    "prescribed",
    "medications?",
    "medicine",
    "dosage",
    "doctor'?s?",
    "physician",
    "therapist",
    "therapy",
    "psychiatri(?:st|c)",
    "hospital(?:ized|ised)?",
    "surgery",
    "surgeon",
    "vaccin(?:e|es|ation|ated)",
    "flu shot",
    "booster shot",
    "blood pressure",
    "blood (?:test|work)",
    "lab results",
    "allerg(?:y|ies|ic)",
    "illness",
    "disease",
    "mental health",
    "health insurance",
    "medical",
    "insulin",
    "diabet(?:es|ic)",
    "cancer",
    "chemotherapy",
    "pregnan(?:t|cy)",
    "dentist",
    "dental",
    "mri",
    "x-ray",
    "urgent care",
    "emergency room",
    "migraines?",
    "asthma",
    "cholesterol",
    "covid",
  ]
    .map(bounded)
    .join("|"),
  "i",
);

const FINANCE = new RegExp(
  [
    "salary",
    "salaries",
    "paycheck",
    "payslip",
    "pay stub",
    "net worth",
    "(?:bank|account) balance",
    "checking account",
    "savings account",
    "retirement account",
    "brokerage",
    "investment (?:account|portfolio)",
    "stock portfolio",
    "credit score",
    "credit card (?:debt|bill|statement)",
    "bank statement",
    "student loans?",
    "mortgage",
    "loans?",
    "(?<!(?:error|time|performance|latency|token|memory|compute|cpu|frame|power|page|size)\\s)budget(?:s|ing)?",
    "tax return",
    "taxes",
    "irs",
    "401\\(k\\)",
    "401k",
    "roth ira",
    "(?:annual|monthly|household) income",
    "income tax",
    "dividends?",
    "overdraft",
    "refinanc(?:e|ed|ing)",
    "bankrupt(?:cy)?",
    "wire transfer",
  ]
    .map(bounded)
    .join("|"),
  "i",
);

const PHONE = /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/;
const ADDRESS = /\b\d{1,5}\s+[A-Za-z0-9.]+\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln)\b/i;
const BIRTH = /\b(?:dob|date of birth|born on)\b/i;

export function normalizeText(input: string): string {
  return input.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u2060\u180E]/g, "");
}

export function classifyText(input: string): Classification {
  const text = normalizeText(input);
  return {
    health: HEALTH.test(text),
    finance: FINANCE.test(text),
    pii: PHONE.test(text) || ADDRESS.test(text) || BIRTH.test(text),
  };
}

// Picks the sensitive folder for a write that is not already in one, or null to keep it in
// place. A sensitive domain the caller declared wins. One content domain picks that domain.
// Health plus finance, PII alone, or a bare sensitive flag go to `restricted`, which only the
// admin token can read. A classifier domain that the deploy does not list as sensitive also
// goes to `restricted`, so a config change cannot make it readable.
export function routeFor(classification: Classification, flagged: boolean, declared: string | null): string | null {
  if (declared && isSensitiveDomain(declared)) return declared;
  const domains: string[] = [];
  if (classification.health) domains.push("health");
  if (classification.finance) domains.push("finance");
  if (domains.length > 1) return RESTRICTED;
  if (domains.length === 1) return isSensitiveDomain(domains[0]) ? domains[0]! : RESTRICTED;
  if (classification.pii || flagged) return RESTRICTED;
  return null;
}

// Journal entries route the same way with one difference: PII alone goes to the writer's own
// bots/<writer>/journal-sensitive/ day file, even for a shared or decisions target, instead of
// restricted. A bare sensitive flag, or health and finance together, still go to restricted.
export function journalRouteFor(classification: Classification, flagged: boolean, declared: string | null): string | null {
  const route = routeFor(classification, flagged, declared);
  const piiOnly = classification.pii && !flagged && !classification.health && !classification.finance && !(declared && isSensitiveDomain(declared));
  return route === RESTRICTED && piiOnly ? PII_ROUTE : route;
}

// Frontmatter keys the server writes. Their values are ids, agent names, and timestamps, and
// are left out of classification so an agent id cannot reroute every file it touches.
const SERVER_KEYS = new Set([
  "vault_id",
  "vault_idempotency",
  "vault_summary",
  "type",
  "owner",
  "status",
  "source",
  "updated_at",
  "created_at",
  "domain",
  "sensitivity",
  "key",
  "observed_at",
  "confidence",
  "supersedes",
]);

export function frontmatterText(frontmatter: Frontmatter): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (SERVER_KEYS.has(key) || key.startsWith("vault_")) continue;
    parts.push(typeof value === "string" ? value : JSON.stringify(value) ?? "");
  }
  return parts.join("\n");
}

// The text a stored file is classified on: the body plus caller frontmatter. Journal heading
// lines keep only their title, and server markers are dropped, so a rebuild classifies a day
// file on the same words the API classified entry by entry.
export function classificationText(markdown: string): string {
  const { frontmatter, body } = parseMarkdown(markdown);
  const lines = body
    .split("\n")
    .filter((line) => !/<!-- hiveattic:/i.test(line))
    .map((line) => {
      const heading = /^## .+ · [^·\n]+ · (.+?) \^[0-9A-HJKMNP-TV-Z]{26}\s*$/.exec(line);
      return heading ? heading[1]! : line;
    });
  return `${frontmatterText(frontmatter)}\n${lines.join("\n")}`;
}

// The frontmatter fields that mark a stored file sensitive. `sensitivity: normal` and an ordinary
// domain never lower what the text classifies as.
export function frontmatterRoute(frontmatter: Frontmatter, markdown: string): string | null {
  const declared = typeof frontmatter.domain === "string" ? frontmatter.domain.trim() : null;
  const flagged = typeof frontmatter.sensitivity === "string" && frontmatter.sensitivity.trim() === "sensitive";
  return routeFor(classifyText(classificationText(markdown)), flagged, declared);
}
