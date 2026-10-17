import { VaultError } from "./errors";

export type PolicyTerm = { term: string; kind: string };

export type FilterHit = {
  code: "rejected_secret" | "rejected_financial" | "rejected_government_id" | "rejected_employer";
  reasons: string[];
};

const SECRET_RULES: { reason: string; pattern: RegExp }[] = [
  { reason: "secret_pem", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { reason: "secret_openai", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{16,}\b/ },
  { reason: "secret_aws", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: "secret_aws_secret", pattern: /aws[\w\s:=-]{0,40}[A-Za-z0-9/+]{40}/i },
  { reason: "secret_github", pattern: /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{16,}\b/ },
  { reason: "secret_slack", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/ },
  { reason: "secret_google", pattern: /\bAIza[0-9A-Za-z_\-]{20,}\b/ },
  { reason: "secret_jwt", pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/ },
  { reason: "secret_password", pattern: /password\s*[:=]\s*\S+/i },
  { reason: "secret_bearer", pattern: /bearer\s+[A-Za-z0-9._~+\-/]{20,}/i },
];

export function normalizeText(input: string): string {
  return input.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u2060\u180E]/g, "");
}

export function scanSecrets(input: string): string[] {
  const text = normalizeText(input);
  const reasons: string[] = [];
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(text)) reasons.push(rule.reason);
  }
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{24,}/g)) {
    const token = match[0];
    if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(token)) continue;
    const index = match.index ?? 0;
    if (isAgentIdentifier(text, index, token)) continue;
    const span = pathSpan(text, index, token.length);
    const path = span ?? (token.includes("/") ? token : null);
    if (path && !/[+=]/.test(path)) {
      const scored = scorePath(path);
      if (scored === "safe") continue;
      if (scored === "segment") {
        reasons.push("secret_entropy");
        continue;
      }
    }
    if (shannon(token) > 4) reasons.push("secret_entropy");
  }
  return unique(reasons);
}

export function scanFinancial(input: string): string[] {
  const text = normalizeText(input);
  const reasons: string[] = [];
  if (findCard(text)) reasons.push("financial_card");
  if (findRouting(text)) reasons.push("financial_routing");
  if (findAccount(text)) reasons.push("financial_account");
  if (findIban(text)) reasons.push("financial_iban");
  if (findSsn(text)) reasons.push("pii_ssn");
  if (findGovId(text)) reasons.push("pii_gov_id");
  return unique(reasons);
}

export function scanEmployer(input: string, terms: PolicyTerm[]): string[] {
  const text = normalizeText(input);
  const reasons: string[] = [];
  const denies = terms.filter((term) => term.kind === "employer" || term.kind === "deny");
  if (denies.some((term) => termMatches(text, term.term))) reasons.push("employer_denylist");
  const allowed = terms.some((term) => term.kind === "allow" && termMatches(text, term.term));
  if (!allowed) {
    const subjects = terms.filter((term) => term.kind === "context_subject");
    const qualifiers = terms.filter((term) => term.kind === "context_qualifier");
    if (subjects.some((term) => termMatches(text, term.term)) && qualifiers.some((term) => termMatches(text, term.term))) {
      reasons.push("employer_context");
    }
  }
  return unique(reasons);
}

export function classifySensitive(input: string, domain: string | null): boolean {
  if (domain === "health" || domain === "finance") return true;
  const text = normalizeText(input);
  if (/\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/.test(text)) return true;
  if (/\b\d{1,5}\s+[A-Za-z0-9.]+\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln)\b/i.test(text)) return true;
  if (/\b(?:dob|date of birth|born on)\b/i.test(text)) return true;
  return false;
}

export function inspectWrite(input: string, terms: PolicyTerm[]): FilterHit | null {
  const secrets = scanSecrets(input);
  if (secrets.length) return { code: "rejected_secret", reasons: secrets };
  const financial = scanFinancial(input);
  if (financial.length) {
    const government = financial.filter((reason) => reason === "pii_ssn" || reason === "pii_gov_id");
    const money = financial.filter((reason) => reason !== "pii_ssn" && reason !== "pii_gov_id");
    if (money.length) return { code: "rejected_financial", reasons: money };
    return { code: "rejected_government_id", reasons: government };
  }
  const employer = scanEmployer(input, terms);
  if (employer.length) return { code: "rejected_employer", reasons: employer };
  return null;
}

export function rejectIfNeeded(input: string, terms: PolicyTerm[]): void {
  const hit = inspectWrite(input, terms);
  if (!hit) return;
  const message =
    hit.code === "rejected_secret"
      ? "Write rejected by the secret filter"
      : hit.code === "rejected_employer"
        ? "Write rejected by the employer filter"
        : hit.code === "rejected_government_id"
          ? "Write rejected by the government-id filter"
          : "Write rejected by the financial filter";
  throw new VaultError(hit.code, message, hit.reasons);
}

function findCard(text: string): boolean {
  for (const match of text.matchAll(/(?<!\d)(\d{13,19})(?!\d)/g)) {
    if (cardNumber(match[1]!)) return true;
  }
  const grouped = /(?<!\d)(\d{4})([ .\-])(\d{4})\2(\d{4})\2(\d{4})(?:\2(?:19|20)\d{2})?(?!\d)/g;
  for (const match of text.matchAll(grouped)) {
    if (cardNumber(`${match[1]}${match[3]}${match[4]}${match[5]}`)) return true;
  }
  const amex = /(?<!\d)(\d{4})([ .\-])(\d{6})\2(\d{5})(?!\d)/g;
  for (const match of text.matchAll(amex)) {
    if (cardNumber(`${match[1]}${match[3]}${match[4]}`)) return true;
  }
  return false;
}

function cardNumber(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits) || !cardPrefix(digits)) return false;
  return luhn(digits);
}

function cardPrefix(digits: string): boolean {
  if (/^3[47]/.test(digits)) return digits.length === 15;
  if (digits.startsWith("4")) return digits.length === 13 || digits.length === 16 || digits.length === 19;
  if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) return digits.length === 16;
  if (digits.startsWith("6")) return digits.length === 16;
  return false;
}

function findRouting(text: string): boolean {
  const keyword = /\b(?:routing|aba)\b/gi;
  for (const match of text.matchAll(keyword)) {
    const start = Math.max(0, (match.index ?? 0) - 40);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 40);
    const window = text.slice(start, end);
    const runs = window.match(/\d{9}/g) ?? [];
    if (runs.some((run) => aba(run))) return true;
  }
  return false;
}

function findAccount(text: string): boolean {
  const keyword = /\b(?:accounts?|acct|a\/c|acc(?:t|ount)?(?:\s*(?:no\.?|#))?|brokerage|iban)\b/gi;
  for (const match of text.matchAll(keyword)) {
    const start = Math.max(0, (match.index ?? 0) - 40);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 48);
    const window = text.slice(start, end);
    const explicit = /(?:#|\bno\.?\b)/i.test(window);
    const labeled = /^(?:accounts?|acct|a\/c|acc(?:t|ount)?(?:\s*(?:no\.?|#))?)$/i.test(match[0]);
    const runs = window.match(/\d[\d .\-]{2,30}\d/g) ?? [];
    for (const run of runs) {
      if (!labeled && currencyAdjacent(window, run)) continue;
      const digits = accountDigits(run);
      if (!digits) continue;
      if (/\d{4}-\d{2}-\d{2}/.test(run) && digits.length <= 8) continue;
      const min = explicit ? 6 : 8;
      if (digits.length >= min && digits.length <= 17) return true;
    }
  }
  return false;
}

function findIban(text: string): boolean {
  const runs = text.toUpperCase().match(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g) ?? [];
  return runs.some((run) => iban(run));
}

function findSsn(text: string): boolean {
  const dashed = text.match(/\b(\d{3})-(\d{2})-(\d{4})\b/g) ?? [];
  if (dashed.some((value) => ssn(value.replaceAll("-", "")))) return true;
  if (!/\b(?:ssn|social security)\b/i.test(text)) return false;
  const spaced = text.match(/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g) ?? [];
  if (spaced.some((value) => ssn(value.replace(/\D/g, "")))) return true;
  const bare = text.match(/\b\d{9}\b/g) ?? [];
  return bare.some((value) => ssn(value));
}

function findGovId(text: string): boolean {
  return /\b(?:passport|driver'?s license|drivers license)\b.{0,40}?\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,12}\b/i.test(text);
}

export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function aba(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const n = [...digits].map((ch) => ch.charCodeAt(0) - 48);
  const sum = 3 * (n[0]! + n[3]! + n[6]!) + 7 * (n[1]! + n[4]! + n[7]!) + (n[2]! + n[5]! + n[8]!);
  return sum !== 0 && sum % 10 === 0;
}

function ssn(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const area = Number(digits.slice(0, 3));
  const group = Number(digits.slice(3, 5));
  const serial = Number(digits.slice(5));
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

function iban(value: string): boolean {
  const rearranged = `${value.slice(4)}${value.slice(0, 4)}`;
  let expanded = "";
  for (const ch of rearranged) expanded += ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
  let remainder = 0;
  for (const ch of expanded) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}

function termMatches(text: string, term: string): boolean {
  const needle = term.toLowerCase();
  if (!needle) return false;
  if (/[^a-z0-9\s]/i.test(needle) || needle.includes(" ")) return text.toLowerCase().includes(needle);
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i").test(text);
}

function accountDigits(run: string): string | null {
  const compact = run.replace(/\s/g, "");
  if (/^\d+(?:\.\d+){2,}$/.test(compact)) return compact.replaceAll(".", "");
  if (run.includes(".")) return null;
  return run.replace(/\D/g, "");
}

function currencyAdjacent(window: string, run: string): boolean {
  const currency = String.raw`(?:\$|\b(?:dollars?|usd|eur|gbp|cents?)\b)`;
  let from = 0;
  while (from < window.length) {
    const at = window.indexOf(run, from);
    if (at < 0) return false;
    const before = window.slice(Math.max(0, at - 16), at);
    const after = window.slice(at + run.length, at + run.length + 16);
    if (new RegExp(`${currency}\\s*$`, "i").test(before)) return true;
    if (new RegExp(`^\\s*[([/]*${currency}`, "i").test(after)) return true;
    from = at + Math.max(1, run.length);
  }
  return false;
}

function pathSpan(text: string, index: number, length: number): string | null {
  const segment = /[A-Za-z0-9_.-]/;
  let start = index;
  while (start > 0 && segment.test(text[start - 1] ?? "")) start -= 1;
  while (start > 0 && text[start - 1] === "/") {
    let seg = start - 1;
    while (seg > 0 && segment.test(text[seg - 1] ?? "")) seg -= 1;
    if (seg === start - 1) break;
    start = seg;
  }
  let end = index + length;
  while (end < text.length && segment.test(text[end] ?? "")) end += 1;
  while (end < text.length && text[end] === "/") {
    let seg = end + 1;
    while (seg < text.length && segment.test(text[seg] ?? "")) seg += 1;
    if (seg === end + 1) break;
    end = seg;
  }
  const span = text.slice(start, end);
  return span.includes("/") ? span : null;
}

function isAgentIdentifier(text: string, index: number, token: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]{23,63}$/.test(token)) return false;
  const before = text.slice(Math.max(0, index - 80), index);
  const after = text.slice(index + token.length, index + token.length + 4);
  if (/(?:^|\n)(?:owner|source):\s*$/.test(before)) return true;
  return /·\s*$/.test(before) && /^\s*·/.test(after);
}

function scorePath(path: string): "safe" | "segment" | "whole" {
  if (path.length > 300) return "whole";
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return "whole";
  let suspicious = false;
  for (const part of parts) {
    const base = part.replace(/\.[A-Za-z0-9]{1,8}$/, "");
    for (const label of base.split(".").filter((label) => label.length > 0)) {
      if (isSafePathLabel(label)) continue;
      if (label.length >= 24 && shannon(label) > 4) suspicious = true;
      else if (!isShortBenign(label)) return "whole";
    }
  }
  return suspicious ? "segment" : "safe";
}

function isSafePathLabel(label: string): boolean {
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(label)) return true;
  if (isWordLike(label)) return true;
  return isShortBenign(label);
}

function isShortBenign(label: string): boolean {
  if (label.length >= 24) return false;
  if (/^\d+$/.test(label)) return true;
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(label)) return true;
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(label) && shannon(label) <= 4;
}

function isWordLike(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value)) {
    const words = value.split(/(?=[A-Z])/);
    return words.length >= 2 && words.every((word) => /^[A-Za-z][a-z]{1,19}\d{0,4}$/.test(word));
  }
  if (/^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+$/.test(value)) {
    return value.split("-").every((part) => part.length >= 2 && part.length <= 18 && part.replace(/\d/g, "").length >= Math.ceil(part.length * 0.6));
  }
  return false;
}

function shannon(value: string): number {
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
