import { scan, shannonEntropy } from "@sanity-labs/secret-scan";

/**
 * Pattern-based secret detection.
 *
 * `@sanity-labs/secret-scan` ports ~1,100 TruffleHog detectors. Rules for
 * prefix-anchored formats (ghp_, sk-ant-, AKIA, PEM blocks, ...) are precise, but
 * many "keyword + generic token" rules fire constantly on source code and diffs
 * (e.g. `100644` as a GitHub App key, `merge` as a DockerHub token). We trust the
 * anchored rules outright and require everything else to look like a real secret.
 */

export interface PatternMatch {
  rule: string;
  start: number;
  end: number;
  confidence: "high" | "medium";
}

const TRUSTED_RULES = new Set([
  "anthropic",
  "openai",
  "aws-access_keys",
  "github-v2",
  "gitlab-v2",
  "stripe",
  "slack",
  "slackwebhook",
  "groq",
  "replicate",
  "sendgrid",
  "jwt",
  "npmtokenv2",
  "linearapi",
  "supabasetoken",
  "postman",
  "privatekey",
  "database-connection-string",
  "huggingface",
  "gcpapplicationdefaultcredentials",
  "googleapikey",
  "digitaloceanv2",
  "doppler",
  "pypi",
  "xai",
  "openrouter",
  "sentrytoken",
]);

const HEX_HASH = /^(sha\d*[-:])?[0-9a-f]{7,128}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGRITY = /^sha(256|384|512)-[A-Za-z0-9+/=]+$/;

/** Heuristic "does this look like a random credential rather than code/prose". */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 20) return false;
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (HEX_HASH.test(value) || UUID.test(value) || INTEGRITY.test(value)) return false;
  if (value.includes("/") || value.includes("\\")) return false; // paths, model ids, escaped text
  if (/\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(value)) return false; // file names
  // Identifiers, filenames and model ids are mostly readable words; random tokens are not.
  // Count lowercase runs only: random base62 is mostly letters, but rarely 4+ lowercase in a row.
  const wordChars = (value.match(/[a-z]{4,}/g) ?? []).reduce((n, w) => n + w.length, 0);
  if (wordChars / value.length >= 0.4) return false;
  // Short strings cannot reach high entropy, so scale the bar with length (max 4 bits/char).
  return shannonEntropy(value) >= Math.min(4, Math.log2(value.length) - 0.5);
}

const PLACEHOLDER_VALUE =
  /^(\$|%|<|\{\{|\$\{|process\.env|os\.environ|env\.|secrets\.|\*{3,}|x{4,}|\.{3}|…|\[REDACTED|your[_-]|example|changeme|placeholder|dummy|test|null|none|undefined|true|false|string|number|redacted|<redacted>)/i;

/** Values assigned to secret-looking keys that are clearly not literal secrets. */
export function isPlaceholderValue(value: string): boolean {
  if (PLACEHOLDER_VALUE.test(value)) return true;
  if (/^(pass(word|wd)?|secret|pwd|token|key|user(name)?|foo|bar|baz|admin|root|guest)$/i.test(value)) return true;
  if (/[()]/.test(value)) return true; // function calls
  if (/^[{[]/.test(value)) return true; // object/array literals
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) return true; // member access like config.apiKey
  if (/^[A-Z_][A-Z0-9_]*$/.test(value)) return true; // constant/env var names
  if (/^[/~.]/.test(value)) return true; // paths
  if (/^https?:\/\/[^@\s]*$/.test(value)) return true; // URLs without credentials
  return false;
}

/** Literal secret values worth redacting when assigned to a sensitive key. */
export function isLiteralSecretValue(value: string): boolean {
  if (value.length < 8 || isPlaceholderValue(value)) return false;
  if (/^\d+$/.test(value)) return false;
  return (/\d/.test(value) && /[A-Za-z]/.test(value)) || looksLikeSecret(value);
}

export const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|pwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|credential|session[_-]?token|^token$|[_-]token$)/i;

const ASSIGNMENT =
  /\b((?:[A-Za-z_][\w.-]*?)?(?:pass(?:word|wd|phrase)?|pwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|token|credential)[\w-]*)["']?\s*(?:[:=]|=>)\s*(["'`]?)([^\s"'`,;]{8,})\2/gi;
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]+)@/gi;
const AUTH_HEADER = /\b(?:authorization|x-api-key|api-key|x-auth-token)["']?\s*[:=]\s*["']?(?:bearer|basic|token)?\s*([A-Za-z0-9._~+/=-]{16,})/gi;
const AGE_SECRET_KEY = /AGE-SECRET-KEY-1[0-9A-Z]{58}/g;
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Documentation/sample credentials (AWS's `AKIAIOSFODNN7EXAMPLE`, `ghp_1234567890abcdef...`)
 * are public; flagging them would mark every session that read a README as "needs review".
 */
export function isObviouslyFake(value: string): boolean {
  if (/EXAMPLE/.test(value)) return true;
  return /0123456789|1234567890|abcdefghij|ABCDEFGHIJ|(.)\1{7,}/.test(value);
}

/** All secret-pattern matches in `text`, overlaps resolved (longest wins). */
export function findSecretPatterns(text: string, allow: ReadonlySet<string> = new Set()): PatternMatch[] {
  return text.length > CHUNK + OVERLAP ? findChunked(text, allow) : findInWindow(text, allow);
}

function findInWindow(text: string, allow: ReadonlySet<string>): PatternMatch[] {
  const found: PatternMatch[] = [];
  for (const s of scan(text)) {
    const trusted = TRUSTED_RULES.has(s.rule) || TRUSTED_RULES.has(s.rule.replace(/-\d+$/, ""));
    if (!trusted) {
      if (!looksLikeSecret(s.text) || s.text.includes(".")) continue;
      if (/[_-][0-9a-f]{8,}$/.test(s.text)) continue; // build artifacts like libfoo-1df712e7440f2fd2
      // A generic rule matching a fragment of a longer token (base64 blob, identifier) is noise.
      if (TOKEN_CHAR.test(text[s.start - 1] ?? "") || TOKEN_CHAR.test(text[s.end] ?? "")) continue;
    }
    found.push({ rule: s.rule, start: s.start, end: s.end, confidence: trusted ? "high" : "medium" });
  }
  for (const m of text.matchAll(AGE_SECRET_KEY)) found.push({ rule: "age-secret-key", start: m.index, end: m.index + m[0].length, confidence: "high" });
  for (const m of text.matchAll(PEM_BLOCK)) found.push({ rule: "private-key-block", start: m.index, end: m.index + m[0].length, confidence: "high" });
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[3] ?? "";
    if (!isLiteralSecretValue(value)) continue;
    const start = m.index + m[0].lastIndexOf(value);
    found.push({ rule: "secret-assignment", start, end: start + value.length, confidence: "medium" });
  }
  for (const m of text.matchAll(URL_CREDENTIALS)) {
    const value = m[1] ?? "";
    if (isPlaceholderValue(value) || value.length < 3) continue;
    const start = m.index + m[0].lastIndexOf(`:${value}@`) + 1;
    found.push({ rule: "url-credentials", start, end: start + value.length, confidence: "high" });
  }
  for (const m of text.matchAll(AUTH_HEADER)) {
    const value = m[1] ?? "";
    if (isPlaceholderValue(value) || !looksLikeSecret(value)) continue;
    const start = m.index + m[0].lastIndexOf(value);
    found.push({ rule: "auth-header", start, end: start + value.length, confidence: "high" });
  }
  return resolveOverlaps(
    found.filter((f) => {
      const value = text.slice(f.start, f.end);
      // Private keys legitimately contain long runs (e.g. "AAAAAAAA" in OpenSSH keys).
      const fake = !/private-?key/.test(f.rule) && isObviouslyFake(value);
      return !allow.has(value) && !fake && !insidePlaceholder(text, f.start);
    }),
  );
}

const TOKEN_CHAR = /[A-Za-z0-9+/=_-]/;
// The scanner is superlinear on very large inputs; scan long strings in overlapping windows.
// The overlap exceeds any single secret we detect (PEM keys are a few KB).
const CHUNK = 32_768;
const OVERLAP = 8_192;

function findChunked(text: string, allow: ReadonlySet<string>): PatternMatch[] {
  const all: PatternMatch[] = [];
  for (let offset = 0; offset < text.length; offset += CHUNK) {
    const window = text.slice(offset, offset + CHUNK + OVERLAP);
    for (const m of findInWindow(window, allow)) all.push({ ...m, start: m.start + offset, end: m.end + offset });
    if (offset + CHUNK + OVERLAP >= text.length) break;
  }
  const unique = new Map(all.map((m) => [`${m.start}:${m.end}`, m]));
  return resolveOverlaps([...unique.values()]);
}

function insidePlaceholder(text: string, index: number): boolean {
  const open = text.lastIndexOf("[REDACTED", index);
  return open !== -1 && text.indexOf("]", open) >= index;
}

function resolveOverlaps(matches: PatternMatch[]): PatternMatch[] {
  const sorted = [...matches].sort((a, b) => b.end - b.start - (a.end - a.start));
  const kept: PatternMatch[] = [];
  for (const m of sorted) {
    if (kept.every((k) => m.end <= k.start || m.start >= k.end)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}
