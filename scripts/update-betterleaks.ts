/**
 * Converts Betterleaks' vendored rule file (`vendor/betterleaks/betterleaks.toml`, pinned by `upstream.json`) into
 * `src/redact/betterleaks-rules.json`, a rule table JavaScript can use.
 *
 *   npm run update:betterleaks                 # rewrite the JSON and print what was skipped or lost
 *   npm run update:betterleaks -- --check      # exit 1 unless converting the vendored file reproduces the JSON (CI)
 *
 * - Only shapes are taken: id, regex rewritten for JavaScript, flags, lowercased keywords, value group, confidence,
 *   specificity, and an entropy threshold from the rule's filter. Rules are built field by field, so `validate`,
 *   `analyze` and `revoke` (which send a found secret to the provider's API) never reach the JSON.
 * - Regexes are written for Go's engine. `translateRegex` rewrites what JavaScript lacks or reads differently on Node
 *   22 (no `(?i:…)` modifiers there): flag groups, mid-pattern `(?i)`, `(?P<name>`, `\z`, `\A`, POSIX classes, and `.`
 *   and `\s`, which match a little more or less in JavaScript. A rule it cannot rewrite, or whose result does not
 *   compile, is skipped and listed with the reason.
 * - Filters are written in Betterleaks' expression language and mostly not ported. A filter discards a finding when
 *   any of its `||` clauses holds, so an entropy clause is kept on its own (keeping fewer discards never hides a
 *   finding) and the other clauses are listed per rule under `dropped`, as are required components.
 * - Rules that only apply to file paths are skipped: a transcript has no file path. Component-only rules (`skipReport`:
 *   Betterleaks reports them only as part of another rule) are kept and marked `componentOnly`, since some are
 *   secrets (an AWS secret access key) and some are not (a client ID).
 * - Accepts both rule-file shapes, v1 (`secretGroup`, `filter.entropy(…)`) and v2 (`valueGroup`, `entropy(…)`).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = resolve(SCRIPT, "../..");
const VENDOR = resolve(REPO, "vendor/betterleaks");
const OUT = resolve(REPO, "src/redact/betterleaks-rules.json");

export interface Upstream {
  repository: string;
  tag: string;
  commit: string;
  file: string;
  sha256: string;
  released: string;
  fetched: string;
}

export interface ConvertedRule {
  id: string;
  regex: string;
  /** `i` when the whole pattern is case-insensitive, `m` for multi-line anchors; never `g`, which the caller adds. */
  flags: string;
  /** Lowercase; a rule is tried only when the lowercased text holds one of them (all of them, when empty). */
  keywords: string[];
  /** The capture group holding the value; without one, the first non-empty group, else the whole match. */
  valueGroup?: number;
  confidence: "high" | "medium" | "low";
  /** Keep a finding only when the value's Shannon entropy (bits per character) is above, or at least, this. */
  entropy?: [">" | ">=", number];
  /** Betterleaks' precedence between overlapping findings: higher wins. */
  specificity?: number;
  /** Betterleaks reports it only as part of another rule (`skipReport`): a client ID next to its secret, say. */
  componentOnly?: true;
  /** What Betterleaks applies to this rule and the converted rule does not (`filter:tokenRatio`, `component:<id>`). */
  dropped?: string[];
}

export interface SkippedRule {
  id: string;
  reason: string;
}

export interface Conversion {
  rules: ConvertedRule[];
  skipped: SkippedRule[];
  /** Ids of rules whose regex needed more than hoisting a leading `(?i)` to the `i` flag. */
  rewritten: string[];
  /** How many upstream rules carried each of `validate`, `analyze`, `revoke` (all stripped). */
  stripped: Record<string, number>;
  /** Top-level keys that apply to every rule and are not ported (the global `filter`, `prefilter`). */
  global: string[];
}

// ─── TOML ────────────────────────────────────────────────────────────────────────────────────────────────────────────

type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

/**
 * Parses the subset of TOML the rule file uses: comments, `[table]` and `[[array.of.tables]]` headers, bare keys, the
 * four string kinds, integers, floats, booleans, arrays and inline tables. Anything else throws, so a new construct
 * in a later release fails the sync loudly instead of being misread.
 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  let pos = 0;
  const fail = (what: string): never => {
    const line = text.slice(0, pos).split("\n").length;
    throw new Error(`TOML line ${line}: ${what}`);
  };
  const skipBlank = (newlines: boolean) => {
    for (;;) {
      const c = text[pos];
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) pos++;
      else if (c === "#") while (pos < text.length && text[pos] !== "\n") pos++;
      else return;
    }
  };
  const endOfLine = () => {
    skipBlank(false);
    if (pos < text.length && text[pos] !== "\n") fail("expected the end of the line");
  };
  const key = (): string => {
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(pos, pos + 128));
    if (!m) fail("expected a bare key");
    pos += m![0].length;
    return m![0];
  };
  const dotted = (): string[] => {
    const parts = [key()];
    while (text[pos] === ".") {
      pos++;
      parts.push(key());
    }
    return parts;
  };
  const basicString = (multi: boolean): string => {
    const close = multi ? '"""' : '"';
    if (multi && text[pos] === "\n") pos++;
    let out = "";
    for (;;) {
      if (pos >= text.length) fail("unterminated string");
      if (text.startsWith(close, pos)) {
        pos += close.length;
        return out;
      }
      const c = text[pos]!;
      if (c === "\n" && !multi) fail("newline in a string");
      if (c !== "\\") {
        out += c;
        pos++;
        continue;
      }
      const e = text[pos + 1];
      pos += 2;
      const simple: Record<string, string> = { '"': '"', "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (e !== undefined && e in simple) out += simple[e];
      else if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        const hex = text.slice(pos, pos + len);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail("bad unicode escape");
        out += String.fromCodePoint(parseInt(hex, 16));
        pos += len;
      } else if (multi && (e === "\n" || e === " " || e === "\t" || e === "\r")) {
        pos--;
        while (/[ \t\r\n]/.test(text[pos] ?? "")) pos++;
      } else fail(`bad escape \\${e}`);
    }
  };
  const literalString = (multi: boolean): string => {
    const close = multi ? "'''" : "'";
    if (multi && text[pos] === "\n") pos++;
    const end = text.indexOf(close, pos);
    if (end < 0) fail("unterminated string");
    const s = text.slice(pos, end);
    if (!multi && s.includes("\n")) fail("newline in a string");
    pos = end + close.length;
    return s;
  };
  const value = (): TomlValue => {
    if (text.startsWith("'''", pos)) return (pos += 3), literalString(true);
    if (text.startsWith('"""', pos)) return (pos += 3), basicString(true);
    const c = text[pos];
    if (c === "'") return pos++, literalString(false);
    if (c === '"') return pos++, basicString(false);
    if (c === "[") {
      pos++;
      const items: TomlValue[] = [];
      for (;;) {
        skipBlank(true);
        if (text[pos] === "]") return pos++, items;
        items.push(value());
        skipBlank(true);
        if (text[pos] === ",") pos++;
        else if (text[pos] !== "]") fail("expected , or ] in an array");
      }
    }
    if (c === "{") {
      pos++;
      const t: TomlTable = {};
      skipBlank(false);
      if (text[pos] === "}") return pos++, t;
      for (;;) {
        skipBlank(false);
        const k = key();
        skipBlank(false);
        if (text[pos] !== "=") fail("expected = in an inline table");
        pos++;
        skipBlank(false);
        if (k in t) fail(`duplicate key ${k}`);
        t[k] = value();
        skipBlank(false);
        if (text[pos] === "}") return pos++, t;
        if (text[pos] !== ",") fail("expected , or } in an inline table");
        pos++;
      }
    }
    const m = /^(?:true|false|[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,\]}#]|$)/.exec(text.slice(pos, pos + 64));
    if (!m) fail("unsupported value");
    pos += m![0].length;
    return m![0] === "true" ? true : m![0] === "false" ? false : Number(m![0]);
  };
  const descend = (path: string[], array: boolean): TomlTable => {
    let t = root;
    path.forEach((part, i) => {
      const last = i === path.length - 1;
      let next = t[part];
      if (last && array) {
        if (next === undefined) next = t[part] = [];
        if (!Array.isArray(next)) fail(`${part} is not an array of tables`);
        const fresh: TomlTable = {};
        (next as TomlValue[]).push(fresh);
        t = fresh;
        return;
      }
      if (next === undefined) next = t[part] = {};
      // A header inside an array of tables (`[[rules.allowlists]]`) belongs to its last element.
      if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next !== "object" || next === null || Array.isArray(next)) fail(`${part} is not a table`);
      t = next as TomlTable;
    });
    return t;
  };

  for (;;) {
    skipBlank(true);
    if (pos >= text.length) return root;
    if (text[pos] === "[") {
      const array = text[pos + 1] === "[";
      pos += array ? 2 : 1;
      const path = dotted();
      if (!text.startsWith(array ? "]]" : "]", pos)) fail("unterminated table header");
      pos += array ? 2 : 1;
      endOfLine();
      table = descend(path, array);
      continue;
    }
    const k = key();
    if (text[pos] === ".") fail("dotted keys are not supported");
    skipBlank(false);
    if (text[pos] !== "=") fail("expected =");
    pos++;
    skipBlank(false);
    if (k in table) fail(`duplicate key ${k}`);
    table[k] = value();
    endOfLine();
  }
}

// ─── Regex ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** POSIX classes Go accepts inside brackets, as ASCII code point ranges. */
const POSIX: Record<string, [number, number][]> = {
  alnum: [[48, 57], [65, 90], [97, 122]],
  alpha: [[65, 90], [97, 122]],
  ascii: [[0, 127]],
  blank: [[9, 9], [32, 32]],
  digit: [[48, 57]],
  lower: [[97, 122]],
  punct: [[33, 47], [58, 64], [91, 96], [123, 126]],
  space: [[9, 13], [32, 32]],
  upper: [[65, 90]],
  word: [[48, 57], [65, 90], [95, 95], [97, 122]],
  xdigit: [[48, 57], [65, 70], [97, 102]],
};

interface Scope {
  i: boolean;
  s: boolean;
}

/** Thrown when a pattern hoisted to the `i` flag turns case-insensitivity off somewhere: redo it letter by letter. */
class NeedsExpansion extends Error {}

function unsupported(what: string): never {
  throw new Error(`unsupported ${what}`);
}

/** Go's `\s`. JavaScript's also matches `\v` and Unicode spaces (no-break space, line separator…). */
const SPACE: [number, number][] = [9, 10, 12, 13, 32].map((cp) => [cp, cp]);
const NOT_SPACE = "[^\\t\\n\\f\\r ]";

const isLetter = (cp: number) => (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);

/** A literal code point as JavaScript source, inside a class or outside one. */
function literal(cp: number, inClass: boolean): string {
  const ch = String.fromCodePoint(cp);
  const named: Record<number, string> = { 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r" };
  if (named[cp]) return named[cp];
  if (cp < 0x20 || cp === 0x7f) return `\\x${cp.toString(16).padStart(2, "0")}`;
  if (cp > 0x7e) return cp > 0xffff ? unsupported("code point above U+FFFF") : ch;
  if (inClass ? "\\]^-[".includes(ch) : "\\^$.|?*+()[]{}/".includes(ch)) return `\\${ch}`;
  return ch;
}

/** Ranges of the other case for the ASCII letters in [lo, hi]. */
function otherCase(lo: number, hi: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to, shift] of [
    [97, 122, -32],
    [65, 90, 32],
  ] as const) {
    const a = Math.max(lo, from);
    const b = Math.min(hi, to);
    if (a <= b) out.push([a + shift, b + shift]);
  }
  return out;
}

/**
 * Rewrites a Go regex for JavaScript (no `u` flag, Node 22): `(?P<n>` → `(?<n>`; a leading `(?i)` → the `i` flag, or,
 * when case-insensitivity covers only part of the pattern (`p8e-(?i)[a-z]`, `(?i:…)`, `(?-i:…)`), the letters it
 * covers spelled out (`[a-z]` → `[a-zA-Z]`, `k` → `[kK]`); `\z` and `\A` → lookarounds; `[[:alnum:]]` → ranges;
 * `\a` → `\x07`. Where both accept the same syntax with different meanings, Go's is spelled out: `.` → `[^\n]`
 * (`[\s\S]` under `(?s)`; JavaScript's `.` also stops at `\r`), `\s` → `[\t\n\f\r ]` (JavaScript's also matches `\v`
 * and Unicode spaces), `^` and `$` under a leading `(?m)` → `(?<![^\n])` and `(?![^\n])` (the `m` flag also breaks
 * lines at `\r`), and a `]` first in a class is escaped (JavaScript would close the class there). Go's any-character idiom
 * `(?:.|[\n\r])` becomes `[\s\S]`: its branches overlap at `\r`, which backtracks badly in JavaScript. Throws on anything
 * without a faithful rewrite (`\p{…}`, `\Q…\E`, ungreedy mode, multi-line mode set mid-pattern, `\S` mixed into a
 * class, a code point above U+FFFF).
 */
export function translateRegex(go: string): { source: string; flags: string } {
  const lead = /^\(\?([a-zA-Z]+)\)/.exec(go);
  const start = { i: false, s: false, m: false };
  for (const f of lead?.[1] ?? "") {
    if (f !== "i" && f !== "s" && f !== "m") unsupported(`flag ${f}`);
    start[f] = true;
  }
  const body = lead ? go.slice(lead[0].length) : go;
  const flags = (byFlag: boolean) => (byFlag ? "i" : "");
  if (start.i) {
    try {
      return { source: rewrite(body, { i: true, s: start.s }, true, start.m), flags: flags(true) };
    } catch (e) {
      if (!(e instanceof NeedsExpansion)) throw e;
    }
  }
  return { source: rewrite(body, { i: start.i, s: start.s }, false, start.m), flags: flags(false) };
}

const ANY_CHAR = /\(\?:(?:\.\|\[(?:\\n\\r|\\r\\n)\]|\[(?:\\n\\r|\\r\\n)\]\|\.)\)/y;

/** `byFlag`: the `i` flag carries case-insensitivity, so letters are left alone and turning it off is not possible. */
function rewrite(src: string, initial: Scope, byFlag: boolean, multiline: boolean): string {
  let pos = 0;
  let scope: Scope = { ...initial };
  const stack: Scope[] = [];
  let out = "";
  const expand = (s: Scope) => s.i && !byFlag;
  const anyChar = () => ((ANY_CHAR.lastIndex = pos), ANY_CHAR.test(src));

  const setFlags = (on: string, off: string, target: Scope): Scope => {
    const next = { ...target };
    for (const [list, value] of [
      [on, true],
      [off, false],
    ] as const) {
      for (const f of list) {
        if (f === "i") {
          if (byFlag && !value) throw new NeedsExpansion();
          next.i = value;
        } else if (f === "s") next.s = value;
        else if (f === "m") {
          if (value !== multiline) unsupported("multi-line mode inside the pattern");
        } else unsupported(`flag ${f}`);
      }
    }
    return next;
  };

  /**
   * An escape's code point (`\x60`, `\t`, `\.`), undefined for a class escape (`\d`, `\w`, `\s`), and its JavaScript
   * source: as written, except `\a` and `\x{…}`, which JavaScript reads differently or not at all.
   */
  const escape = (inClass: boolean): { cp?: number; text: string } => {
    const e = src[pos + 1];
    if (e === undefined) unsupported("trailing backslash");
    const written = (length: number, cp?: number) => {
      const text = src.slice(pos, pos + length);
      pos += length;
      return { cp, text };
    };
    if (!inClass && e === "s") return (pos += 2), { text: "[\\t\\n\\f\\r ]" };
    if (!inClass && e === "S") return (pos += 2), { text: NOT_SPACE };
    if ("dDwWsS".includes(e!) || (!inClass && "bB".includes(e!))) return written(2);
    const controls: Record<string, number> = { f: 12, n: 10, r: 13, t: 9, v: 11 };
    if (e! in controls) return written(2, controls[e!]);
    if (e === "a") return (pos += 2), { cp: 7, text: literal(7, inClass) };
    if (e === "x") {
      const m = /^\\x(?:([0-9A-Fa-f]{2})|\{([0-9A-Fa-f]{1,6})\})/.exec(src.slice(pos, pos + 10));
      if (!m) unsupported("\\x escape");
      if (m![1]) return written(4, parseInt(m![1], 16));
      pos += m![0].length;
      const cp = parseInt(m![2]!, 16);
      return { cp, text: literal(cp, inClass) };
    }
    if (/[!-/:-@[-`{-~]/.test(e!)) return written(2, e!.charCodeAt(0));
    return unsupported(`escape \\${e}`);
  };

  const charClass = () => {
    const begin = pos;
    pos++;
    const negated = src[pos] === "^";
    if (negated) pos++;
    const ranges: [number, number][] = [];
    const escapes: string[] = [];
    // Copied as is unless something in it reads differently in JavaScript (`\a`, `\x{…}`, `\s`, a POSIX class).
    let rebuild = false;
    let space = false;
    let notSpace = false;
    const point = (): number | undefined => {
      if (src[pos] === "\\") {
        if (src[pos + 1] === "a" || src.startsWith("\\x{", pos)) rebuild = true;
        const e = escape(true);
        if (e.text === "\\s") (space = true), (rebuild = true), ranges.push(...SPACE);
        else if (e.text === "\\S") notSpace = true;
        else if (e.cp === undefined) escapes.push(e.text);
        return e.cp;
      }
      const cp = src.codePointAt(pos);
      if (cp === undefined) unsupported("unterminated class");
      pos += cp! > 0xffff ? 2 : 1;
      return cp;
    };
    for (let first = true; first || src[pos] !== "]"; first = false) {
      if (pos >= src.length) unsupported("unterminated class");
      // Go reads a `]` first in a class as a member; JavaScript would close the class there (`[]a]`, `[^]a]`).
      if (first && src[pos] === "]") rebuild = true;
      const named = /^\[:(\^?)([a-z]+):\]/.exec(src.slice(pos, pos + 12));
      if (named) {
        if (named[1] || !(named[2]! in POSIX)) unsupported(`class [:${named[1]}${named[2]}:]`);
        pos += named[0].length;
        rebuild = true;
        ranges.push(...POSIX[named[2]!]!);
        continue;
      }
      const lo = point();
      if (lo === undefined) continue;
      if (src[pos] === "-" && src[pos + 1] !== "]") {
        pos++;
        const hi = point();
        if (hi === undefined || hi < lo) unsupported("class range");
        ranges.push([lo, hi!]);
      } else ranges.push([lo, lo]);
    }
    pos++;
    if (notSpace) {
      // `[\s\S]` is any character in both engines; a lone `[\S]` is Go's non-space. Mixed with anything else, a class
      // cannot say "not Go's space, or these" without the `v` flag.
      if (space) return void (out += negated ? "[^\\s\\S]" : "[\\s\\S]");
      if (ranges.length || escapes.length) unsupported("\\S in a class with other members");
      return void (out += negated ? "[\\t\\n\\f\\r ]" : NOT_SPACE);
    }
    // Under (?i) Go folds the class before negating it, so the other case joins the set either way.
    const folded = expand(scope) ? ranges.flatMap(([lo, hi]) => otherCase(lo, hi)).filter(([lo, hi]) => !ranges.some(([a, b]) => a <= lo && hi <= b)) : [];
    if (!rebuild && folded.length === 0) {
      out += src.slice(begin, pos);
      return;
    }
    const item = ([lo, hi]: [number, number]) => (lo === hi ? literal(lo, true) : `${literal(lo, true)}-${literal(hi, true)}`);
    out += `[${negated ? "^" : ""}${[...ranges, ...folded].map(item).join("")}${escapes.join("")}]`;
  };

  const group = () => {
    const named = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(src.slice(pos, pos + 80));
    if (named) {
      pos += named[0].length;
      stack.push(scope);
      out += `(?<${named[1]}>`;
      return;
    }
    const flagged = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/.exec(src.slice(pos, pos + 16));
    if (flagged) {
      pos += flagged[0].length;
      const next = setFlags(flagged[1] ?? "", flagged[2] ?? "", scope);
      if (flagged[3] === ")") scope = next;
      else {
        stack.push(scope);
        scope = next;
        out += "(?:";
      }
      return;
    }
    if (src[pos + 1] === "?") unsupported(`group ${src.slice(pos, pos + 4)}`);
    pos++;
    stack.push(scope);
    out += "(";
  };

  while (pos < src.length) {
    const c = src[pos]!;
    if (c === "\\") {
      const e = src[pos + 1];
      if (e === "z") (pos += 2), (out += "(?![\\s\\S])");
      else if (e === "A") (pos += 2), (out += "(?<![\\s\\S])");
      else {
        const { cp, text } = escape(false);
        out += cp !== undefined && expand(scope) && isLetter(cp) ? `[${literal(cp, true)}${literal(cp ^ 32, true)}]` : text;
      }
    } else if (c === "[") charClass();
    // Go's idiom for any character, `(?:.|[\n\r])`: both branches match `\r`, which costs Go nothing and JavaScript a
    // backtracking step per `\r`, exponential under a repeat (`{0,32}?`). One class matches the same and cannot.
    else if (anyChar()) (pos = ANY_CHAR.lastIndex), (out += "[\\s\\S]");
    else if (c === "(") group();
    else if (c === ")") {
      if (stack.length === 0) unsupported("unbalanced )");
      scope = stack.pop()!;
      out += ")";
      pos++;
    } else if (c === ".") (out += scope.s ? "[\\s\\S]" : "[^\\n]"), pos++;
    // Go's multi-line `^` and `$` break lines at `\n` only; JavaScript's `m` flag also breaks at `\r`, U+2028 and U+2029.
    else if (multiline && c === "^") (out += "(?<![^\\n])"), pos++;
    else if (multiline && c === "$") (out += "(?![^\\n])"), pos++;
    else {
      const cp = src.codePointAt(pos)!;
      pos += cp > 0xffff ? 2 : 1;
      if (expand(scope) && isLetter(cp)) out += `[${c}${String.fromCharCode(cp ^ 32)}]`;
      else out += cp > 0x7e ? literal(cp, false) : c;
    }
  }
  if (stack.length > 0) unsupported("unbalanced (");
  return out;
}

// ─── Rules ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const KNOWN_RULE_KEYS = new Set([
  "id",
  "description",
  "regex",
  "path",
  "secretGroup",
  "valueGroup",
  "entropy",
  "keywords",
  "tags",
  "specificity",
  "confidence",
  "filter",
  "validate",
  "analyze",
  "revoke",
  "components",
  "skipReport",
  "required",
  "tokenEfficiency",
  "allowlist",
  "allowlists",
]);
const KNOWN_TOP_KEYS = new Set(["title", "minVersion", "betterleaksMinVersion", "prefilter", "filter", "rules", "allowlist", "allowlists"]);
const NEVER_CONVERTED = ["validate", "analyze", "revoke"] as const;

/**
 * The top-level `||` clauses of a filter expression, or undefined when it is not one `||` chain: statements (`let`,
 * `;`), comments, or a ternary, which binds looser than `||`.
 */
export function filterClauses(expr: string): string[] | undefined {
  const text = expr.trim();
  if (/(^|\n)\s*(let\s|\/\/)/.test(text)) return undefined;
  const clauses: string[] = [];
  let depth = 0;
  let quote = "";
  let begin = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\" && quote !== "`") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && (c === ";" || c === "?")) return undefined;
    else if (depth === 0 && text.startsWith("||", i)) {
      clauses.push(text.slice(begin, i).trim());
      begin = i + 2;
      i++;
    }
  }
  clauses.push(text.slice(begin).trim());
  return clauses;
}

const ENTROPY_CLAUSE = /^(?:filter\.)?entropy\(finding\["secret"\]\)\s*(<=?)\s*(\d+(?:\.\d+)?)$/;

/** What a filter keeps (an entropy threshold) and what it drops, by the functions its other clauses call. */
export function convertFilter(expr: string): { entropy?: [">" | ">=", number]; dropped: string[] } {
  const clauses = filterClauses(expr);
  if (!clauses) return { dropped: ["filter"] };
  let entropy: [">" | ">=", number] | undefined;
  const dropped = new Set<string>();
  for (const clause of clauses) {
    const m = ENTROPY_CLAUSE.exec(clause);
    if (m && !entropy) {
      // Discarded below the threshold means kept at or above it; discarded at or below it, kept above it.
      entropy = [m[1] === "<" ? ">=" : ">", Number(m[2])];
      continue;
    }
    const fn = /^!?\s*(?:filter\.)?([A-Za-z]+)\(/.exec(clause);
    dropped.add(fn ? `filter:${fn[1]}` : "filter");
  }
  return { entropy, dropped: [...dropped] };
}

const asString = (v: TomlValue | undefined, what: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`${what} is not a string`);
  return v;
};

export function convertRules(config: TomlTable): Conversion {
  for (const k of Object.keys(config)) if (!KNOWN_TOP_KEYS.has(k)) throw new Error(`unknown top-level key ${k}; teach the converter about it`);
  const raw = config.rules;
  if (!Array.isArray(raw)) throw new Error("no [[rules]] in the rule file");
  const conversion: Conversion = {
    rules: [],
    skipped: [],
    rewritten: [],
    stripped: { validate: 0, analyze: 0, revoke: 0 },
    global: ["prefilter", "filter", "allowlist", "allowlists"].filter((k) => k in config),
  };
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("a [[rules]] entry is not a table");
    const r = value as TomlTable;
    const id = asString(r.id, "a rule's id");
    if (!id) throw new Error("a rule has no id");
    if (seen.has(id)) throw new Error(`duplicate rule id ${id}`);
    seen.add(id);
    for (const k of Object.keys(r)) if (!KNOWN_RULE_KEYS.has(k)) throw new Error(`${id}: unknown key ${k}; teach the converter about it`);
    for (const k of NEVER_CONVERTED) if (k in r) conversion.stripped[k]!++;
    const skip = (reason: string) => conversion.skipped.push({ id, reason });

    const regex = asString(r.regex, `${id}: regex`);
    const path = asString(r.path, `${id}: path`);
    if (!regex) {
      skip("no content regex: matches file paths only");
      continue;
    }
    if (path) {
      skip(`only applies to files whose path matches ${path}; a transcript has no file path`);
      continue;
    }
    let translated: { source: string; flags: string };
    try {
      translated = translateRegex(regex);
      new RegExp(translated.source, translated.flags);
    } catch (e) {
      skip(`regex: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, "does not compile: ") : String(e)}`);
      continue;
    }
    const hoisted = regex.startsWith("(?i)") ? regex.slice(4) : regex;
    if (translated.source !== hoisted) conversion.rewritten.push(id);

    const confidence = asString(r.confidence, `${id}: confidence`);
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") throw new Error(`${id}: unknown confidence ${confidence}`);
    const group = r.valueGroup ?? r.secretGroup;
    if (group !== undefined && (typeof group !== "number" || !Number.isInteger(group))) throw new Error(`${id}: value group is not an integer`);
    if (r.specificity !== undefined && typeof r.specificity !== "number") throw new Error(`${id}: specificity is not a number`);
    const keywords = r.keywords ?? [];
    if (!Array.isArray(keywords) || keywords.some((k) => typeof k !== "string")) throw new Error(`${id}: keywords is not a list of strings`);

    const rule: ConvertedRule = { id, regex: translated.source, flags: translated.flags, keywords: [...new Set((keywords as string[]).map((k) => k.toLowerCase()))], confidence };
    if (group) rule.valueGroup = group as number;
    const dropped: string[] = [];
    if (typeof r.entropy === "number" && r.entropy > 0) rule.entropy = [">", r.entropy];
    const filter = asString(r.filter, `${id}: filter`);
    if (filter) {
      const f = convertFilter(filter);
      // A rule-level `entropy` and a filter threshold both discard; keep the stricter.
      if (f.entropy && (!rule.entropy || f.entropy[1] > rule.entropy[1])) rule.entropy = f.entropy;
      dropped.push(...f.dropped);
    }
    if (r.specificity !== undefined) rule.specificity = r.specificity as number;
    if (r.tokenEfficiency === true) dropped.push("tokenEfficiency");
    if (r.allowlist !== undefined || r.allowlists !== undefined) dropped.push("allowlists");
    if (r.skipReport === true) rule.componentOnly = true;
    // v1.9 names them `components` (with `optional`); older files `required`, all of them required.
    const components = [r.components ?? [], r.required ?? []].flat();
    for (const c of components) {
      if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error(`${id}: a component is not a table`);
      if (c.optional !== true) dropped.push(`component:${asString(c.id, `${id}: component id`)}`);
    }
    if (dropped.length) rule.dropped = dropped;
    conversion.rules.push(rule);
  }
  return conversion;
}

/** The JSON file: provenance, one rule per line (each sync is a readable diff), then the skipped rules. */
export function formatJson(upstream: Upstream, conversion: Conversion): string {
  const { repository, tag, commit, sha256 } = upstream;
  const lines = (items: unknown[]) => items.map((x, i) => `    ${JSON.stringify(x)}${i < items.length - 1 ? "," : ""}`).join("\n");
  return [
    "{",
    `  "generated": ${JSON.stringify("by scripts/update-betterleaks.ts from vendor/betterleaks/betterleaks.toml; do not edit by hand")},`,
    `  "upstream": ${JSON.stringify({ repository, tag, commit, sha256 })},`,
    `  "rules": [`,
    lines(conversion.rules),
    "  ],",
    `  "skipped": [`,
    lines(conversion.skipped),
    "  ]",
    "}",
    "",
  ].join("\n");
}

/** What the converter reports: counts, then every skipped rule and every rule that lost part of its filtering. */
export function formatReport(upstream: Upstream, total: number, conversion: Conversion): string[] {
  const { rules, skipped, rewritten, stripped, global } = conversion;
  const byConfidence = (["high", "medium", "low"] as const).map((c) => `${rules.filter((r) => r.confidence === c).length} ${c}`).join(", ");
  const lines = [
    `Betterleaks ${upstream.tag} (${upstream.commit.slice(0, 12)}): ${total} rules`,
    `  converted ${rules.length} (${byConfidence}); ${rewritten.length} regexes rewritten beyond hoisting (?i), ${rules.filter((r) => r.entropy).length} with an entropy threshold, ${rules.filter((r) => r.componentOnly).length} component-only`,
    `  stripped: ${NEVER_CONVERTED.map((k) => `${k} from ${stripped[k]} rules`).join(", ")}`,
  ];
  if (global.length) lines.push(`  not ported (apply to every rule): ${global.join(", ")}`);
  lines.push(`  skipped ${skipped.length}:`);
  for (const s of skipped) lines.push(`    ${s.id}: ${s.reason}`);
  const lost = new Map<string, string[]>();
  for (const r of rules) {
    for (const what of new Set((r.dropped ?? []).map((d) => (d.startsWith("component:") ? "required component" : d)))) lost.set(what, [...(lost.get(what) ?? []), r.id]);
  }
  lines.push(`  lost part of their filtering: ${rules.filter((r) => r.dropped).length} rules`);
  for (const [what, ids] of [...lost].sort((a, b) => b[1].length - a[1].length)) lines.push(`    ${what} (${ids.length}): ${ids.join(", ")}`);
  return lines;
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main(): void {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  const upstream = JSON.parse(readFileSync(resolve(VENDOR, "upstream.json"), "utf8")) as Upstream;
  const toml = resolve(VENDOR, "betterleaks.toml");
  const actual = sha256(toml);
  if (actual !== upstream.sha256) throw new Error(`${relative(REPO, toml)} has sha256 ${actual}, not upstream.json's ${upstream.sha256}: was it edited by hand?`);
  const config = parseToml(readFileSync(toml, "utf8"));
  const total = Array.isArray(config.rules) ? config.rules.length : 0;
  const conversion = convertRules(config);
  const json = formatJson(upstream, conversion);
  if (values.check) {
    let committed = "";
    try {
      committed = readFileSync(OUT, "utf8");
    } catch {}
    if (committed !== json) throw new Error(`${relative(REPO, OUT)} is out of date with the vendored rule file; run npm run update:betterleaks`);
    console.log(`${relative(REPO, OUT)} matches ${relative(REPO, toml)} (${upstream.tag}, ${conversion.rules.length} rules)`);
    return;
  }
  writeFileSync(OUT, json);
  for (const line of formatReport(upstream, total, conversion)) console.log(line);
  console.log(`Wrote ${conversion.rules.length} rules to ${relative(REPO, OUT)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    main();
  } catch (e) {
    console.error(`update:betterleaks: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
