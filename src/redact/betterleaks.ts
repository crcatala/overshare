import { shannonEntropy } from "./entropy.js";
import enabled from "./betterleaks-enabled.json" with { type: "json" };
import table from "./betterleaks-rules.json" with { type: "json" };
import type { PatternMatch } from "./patterns.js";

/**
 * Betterleaks' high-confidence rules (MIT, https://github.com/betterleaks/betterleaks), from the rule table
 * `scripts/update-betterleaks.ts` converts from the vendored rule file. Only the rules `betterleaks-enabled.json` lists
 * run, so a sync never turns a rule on by itself.
 *
 * What a rule keeps from Betterleaks: its regex, keywords, value group and entropy threshold. Its other filters are not
 * ported (see the table's `dropped`); the caller's obviously-fake, allowlist and placeholder checks apply instead.
 * Nothing here sends a value anywhere: the table carries no `validate` step.
 */
interface Rule {
  id: string;
  re: RegExp;
  keywords: readonly string[];
  /** The capture group that holds the secret; without one, the whole match. */
  group?: number;
  /** Keep a finding only when the value's Shannon entropy is above (`>`) or at least (`>=`) the threshold. */
  entropy?: readonly [string, number];
}

interface TableRule {
  id: string;
  regex: string;
  flags: string;
  keywords: string[];
  valueGroup?: number;
  entropy?: (string | number)[];
}

const ENABLED = new Set(enabled.enabled);

/**
 * Whether a regex's first capture group holds every other one, so that it spans the whole value. Where a rule names no
 * value group, Betterleaks reports its first group that matched, but in a few rules that is only a piece of the token:
 * one of the alternatives jwt-base64 starts with, or one of microsoft-teams-webhook's UUID segments. Redacting that
 * piece would publish the rest, so such a rule redacts its whole match instead.
 */
export function firstGroupHoldsAll(source: string): boolean {
  const open: boolean[] = []; // per open parenthesis: whether it is group 1 or inside it
  let groups = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (c === "[") {
      for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
    } else if (c === "(") {
      const capturing = source[i + 1] !== "?" || (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!");
      const inFirst = open.at(-1) ?? false;
      if (capturing && ++groups > 1 && !inFirst) return false;
      open.push(inFirst || (capturing && groups === 1));
    } else if (c === ")") open.pop();
  }
  return groups > 0;
}

// `d` for the value group's offsets; compiled once, and `matchAll` copies the regex, so no `lastIndex` is shared.
export const RULES: readonly Rule[] = (table.rules as TableRule[])
  .filter((r) => ENABLED.has(r.id))
  .map((r) => ({
    id: r.id,
    re: new RegExp(r.regex, `${r.flags}gd`),
    keywords: r.keywords,
    ...(r.valueGroup ? { group: r.valueGroup } : firstGroupHoldsAll(r.regex) ? { group: 1 } : {}),
    ...(r.entropy ? { entropy: [String(r.entropy[0]), Number(r.entropy[1])] as const } : {}),
  }));

/**
 * A rule runs only when one of its keywords is in the text, ignoring case, as in Betterleaks. Keywords are lowercase
 * ASCII of three or more characters (a test checks), so they are indexed by their first three: one pass over the text
 * finds every keyword in it, where testing each of the ~400 in turn would cost far more on the many short strings of a
 * transcript.
 */
const KEYWORD_RULES = new Map<string, number[]>();
const BY_PREFIX = new Map<number, string[]>();
const prefixKey = (a: number, b: number, c: number) => a * 0x1_0000_0000 + b * 0x1_0000 + c;
for (const [i, rule] of RULES.entries()) {
  for (const k of rule.keywords) {
    const rules = KEYWORD_RULES.get(k);
    if (rules) {
      rules.push(i);
      continue;
    }
    KEYWORD_RULES.set(k, [i]);
    const key = prefixKey(k.charCodeAt(0), k.charCodeAt(1), k.charCodeAt(2));
    BY_PREFIX.set(key, [...(BY_PREFIX.get(key) ?? []), k]);
  }
}

/** ASCII lowercase of the character code at `i`; other characters as they are (no keyword has one). */
const lowerAt = (text: string, i: number) => {
  const c = text.charCodeAt(i);
  return c >= 65 && c <= 90 ? c + 32 : c;
};

/** The indices in `RULES` of the rules with a keyword in `text`, in table order. */
export function rulesFor(text: string): number[] {
  const hit = new Set<number>();
  let b = lowerAt(text, 0);
  let c = lowerAt(text, 1);
  for (let i = 0; i + 3 <= text.length; i++) {
    const a = b;
    b = c;
    c = lowerAt(text, i + 2);
    const candidates = BY_PREFIX.get(prefixKey(a, b, c));
    if (!candidates) continue;
    for (const k of candidates) {
      let j = 3;
      while (j < k.length && lowerAt(text, i + j) === k.charCodeAt(j)) j++;
      if (j === k.length) for (const r of KEYWORD_RULES.get(k)!) hit.add(r);
    }
  }
  return [...hit].sort((x, y) => x - y);
}

/** The span of the secret in a match: the rule's value group (none if it matched nothing), or the whole match. */
function valueSpan(m: RegExpExecArray, group: number | undefined): [number, number] | undefined {
  const indices = m.indices;
  if (!indices) return undefined;
  if (group === undefined) return indices[0];
  const span = indices[group];
  return span && span[1] > span[0] ? span : undefined;
}

function entropyHolds(value: string, [op, n]: readonly [string, number]): boolean {
  const e = shannonEntropy(value);
  return op === ">=" ? e >= n : e > n;
}

/** Matches of the enabled rules in `text`, all high confidence (overlaps are resolved by the caller). */
export function findBetterleaks(text: string): PatternMatch[] {
  const found: PatternMatch[] = [];
  for (const r of rulesFor(text)) {
    const rule = RULES[r]!;
    for (const m of text.matchAll(rule.re)) {
      const span = valueSpan(m, rule.group);
      if (!span) continue;
      const [start, end] = span;
      if (rule.entropy && !entropyHolds(text.slice(start, end), rule.entropy)) continue;
      found.push({ rule: rule.id, start, end, confidence: "high" });
    }
  }
  return found;
}
