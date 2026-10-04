import { scan, shannonEntropy } from "@sanity-labs/secret-scan";
import { findAwsSecretKeys, findTokenFormats } from "./token-formats.js";

/**
 * Pattern-based secret detection.
 *
 * `@sanity-labs/secret-scan` ports ~1,100 TruffleHog detectors. Rules for
 * prefix-anchored formats (ghp_, sk-ant-, AKIA, PEM blocks, ...) are precise, but
 * many "keyword + generic token" rules fire constantly on source code and diffs
 * (e.g. `100644` as a GitHub App key, `merge` as a DockerHub token). We trust the
 * anchored rules outright and require everything else to look like a real secret.
 *
 * Two things sit beside that scanner: `token-formats.ts` (provider formats recognised by their prefix, plus an AWS
 * secret key found next to its key id) and the strong-context rules below (an auth header, `curl -u`, `password=`),
 * where the position alone says "credential" and the value only has to be plausible, not statistically random.
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

/**
 * Identifiers, filenames and model ids are mostly readable words; random tokens are not. Counts lowercase runs only:
 * random base62 is mostly letters, but rarely 4+ lowercase in a row.
 */
function readable(value: string, threshold = 0.4): boolean {
  const wordChars = (value.match(/[a-z]{4,}/g) ?? []).reduce((n, w) => n + w.length, 0);
  return wordChars / value.length >= threshold;
}

/** `csrfTokenValue`, `GetApiKeyFromStore`: whole-string camelCase / PascalCase words. Random base62 essentially never is. */
const WORDS_IN_CASE = /^(?:[a-z]{2,}(?:[A-Z][a-z]{2,})+|(?:[A-Z][a-z]{2,}){2,})$/;

/** Heuristic "does this look like a random credential rather than code/prose". */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 20) return false;
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (HEX_HASH.test(value) || UUID.test(value) || INTEGRITY.test(value)) return false;
  if (value.includes("/") || value.includes("\\")) return false; // paths, model ids, escaped text
  if (/\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(value)) return false; // file names
  if (readable(value)) return false;
  // Short strings cannot reach high entropy, so scale the bar with length (max 4 bits/char).
  return shannonEntropy(value) >= Math.min(4, Math.log2(value.length) - 0.5);
}

/**
 * The bar for a value in a place that only holds credentials (`Authorization:` header, `curl -u`): not a placeholder,
 * some variety, a digit or long mixed-case text, and not readable words or camelCase. Far below `looksLikeSecret`, whose near-maximal entropy requirement
 * is right for a bare string in prose and wrong for a 21-character password in a header, which it rejects.
 */
export function looksLikeCredential(value: string): boolean {
  if (value.length < 8 || isPlaceholderValue(value) || WORDS_IN_CASE.test(value)) return false;
  // A digit, or both letter cases over enough characters that a word-like string would not do this by chance.
  const digit = /\d/.test(value);
  if (!digit && !(value.length >= 16 && /[a-z]/.test(value) && /[A-Z]/.test(value))) return false;
  // Without a digit the string must not be mostly readable words; with one, only clearly word-built strings are rejected.
  if (readable(value, digit ? 0.6 : 0.4)) return false;
  return shannonEntropy(value) >= 2.75;
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
  /(pass(word|wd|phrase)?|pwd|psw|(^|[_.-])pw($|[_.-])|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|credential|session[_-]?token|^token$|[_-]token$)/i;

const ASSIGNMENT =
  /\b((?:[A-Za-z_][\w.-]*?)?(?:pass(?:word|wd|phrase)?|pwd|psw|[_.-]pw(?![A-Za-z])|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|token|credential)[\w-]*)["']?\s*(?:[:=]|=>)\s*(["'`]?)([^\s"'`,;]{8,})\2/gi;
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]+)@/gi;
// Header and header-like names that carry a credential: `Authorization`, `X-Api-Key`, `X-Amz-Security-Token`,
// `Private-Token` (GitLab). Reached through curl's `-H`/`--header` as well, since the header text is what matches.
const AUTH_HEADER = /\b(?:(?:proxy-)?authorization|x-[a-z0-9-]*(?:api-?key|auth-?token|access-?token|security-?token|secret|token|key)|api-?key|private-token)["']?\s*[:=]\s*["']?(?:bearer|basic|token)?\s*([A-Za-z0-9._~+/=-]{12,})/gi;
// curl's `-u`/`--user` (and `-U`/`--proxy-user`) `user:password`, in the forms a shell accepts:
// - the flag as `--user x`, `--user=x`, `-u x`, attached `-ux`, or inside a cluster `-su x`;
// - the value bare, or quoted when the password holds spaces or shell characters (`"user:pa ss"`, `'user:p&q'`),
//   or `user:"quoted password"`;
// - the command split over lines with `\` continuations.
// Between `curl` and the flag nothing may end the command (`|`, `;`, `&`), so `curl x | sort -u a:b` is not matched. A
// bare `-u user` prompts for the password and has none to match. A bare password stops at the characters that end a
// shell word; a quoted one runs to its closing quote, so none of it is left behind. A quote only opens a quoted value
// after whitespace or `=` (not `-u", (v: string)` in source code, whose quote closes a string), the user part of a
// quoted value has no whitespace, and a password is at most 200 characters.
const CURL_USER =
  /\bcurl\b(?:\\\r?\n|[^\n|;&]){0,1500}?(?<=\s)(?:-[A-Za-z]*[uU]|--(?:proxy-)?user)[ \t=]*(?:(?<=[ \t=])"[^\s":\\]*:((?:[^"\\]|\\.){1,200})"|(?<=[ \t=])'[^\s':]*:([^']{1,200})'|[^\s:"'`;|&<>)]*:(?:"((?:[^"\\]|\\.){1,200})"|'([^']{1,200})'|([^\s"'`;|&<>)]+)))/g;
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
    if (!looksLikeCredential(value)) continue;
    const start = m.index + m[0].lastIndexOf(value);
    found.push({ rule: "auth-header", start, end: start + value.length, confidence: "high" });
  }
  for (const m of text.includes("curl") ? text.matchAll(CURL_USER) : []) {
    const value = m.slice(1).find((g) => g !== undefined) ?? "";
    // Parentheses mark a function call to `isPlaceholderValue`, but a quoted password may hold them; `$(cmd)` and `${VAR}`
    // are still placeholders by their leading `$`, and an interpolation inside the value (`pw${n}`, `pw$(cmd)`) is code.
    if (value.length < 4 || /\$[({]/.test(value) || isPlaceholderValue(value.replace(/[()]/g, ""))) continue;
    const start = m.index + m[0].lastIndexOf(value);
    found.push({ rule: "curl-user-password", start, end: start + value.length, confidence: "high" });
  }
  found.push(...findTokenFormats(text), ...findAwsSecretKeys(text));
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
  // Longest wins; on a tie the higher confidence does, so a span two rules both find is reported (and blocks) as high.
  const sorted = [...matches].sort((a, b) => b.end - b.start - (a.end - a.start) || Number(b.confidence === "high") - Number(a.confidence === "high"));
  const kept: PatternMatch[] = [];
  for (const m of sorted) {
    if (kept.every((k) => m.end <= k.start || m.start >= k.end)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}
