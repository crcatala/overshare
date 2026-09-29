/**
 * Matching for the contents rail's filter. Pure string logic, so it stays testable without a DOM.
 *
 * The filter is deliberately not fuzzy: punctuation and case are ignored, the query is split
 * into words, and every word has to appear (as a substring, in any order). That covers
 * "fix auth" vs "auth: fix login" and "pre-commit" vs "pre commit" without a scoring model.
 */

/** Anything that is not a letter or digit separates words: spaces, hyphens, slashes, dots, ×, … */
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/** Lowercased, with each run of separators collapsed to one space. Fold labels once, not per keystroke. */
export function fold(text: string): string {
  return text.toLowerCase().replace(SEPARATORS, " ").trim();
}

/** The distinct words of a query, folded. Empty when the query holds nothing to match. */
export function queryTokens(query: string): string[] {
  const folded = fold(query);
  return folded ? [...new Set(folded.split(" "))] : [];
}

/** Whether a folded label contains every token. No tokens matches everything. */
export function matchesAll(folded: string, tokens: readonly string[]): boolean {
  return tokens.every((t) => folded.includes(t));
}

/**
 * Where the tokens sit in the original text, as merged `[start, end)` ranges. A token holds
 * only letters and digits, so it can only match inside one word: the ranges agree with what
 * `matchesAll` saw in the folded text, whatever punctuation the original has.
 */
export function hitRanges(text: string, tokens: readonly string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const token of tokens) {
    for (const m of text.matchAll(new RegExp(token, "giu"))) found.push([m.index, m.index + m[0].length]);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of found) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The text cut into alternating plain and highlighted pieces (`hit` marks the highlighted ones). */
export function splitByRanges(text: string, ranges: readonly [number, number][]): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}
