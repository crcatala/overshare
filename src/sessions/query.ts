/**
 * Filtering and search over `SessionSummary[]`: pure and in-memory, so a TUI can re-run it per keystroke.
 *
 * Query syntax (free text plus `key:value` tokens, all optional):
 *   harness:pi  project:agent (or repo:agent)  branch:main  model:opus  since:7d  before:2026-09-01  shared:yes|no  tool:Bash  workers:yes
 * Subagent worker sessions are hidden unless `workers:yes`.
 * Remaining words must ALL appear (case-insensitive, any order) in title / project / branch / models / prompts.
 * A word ranks higher when it hits the title or project.
 */
import { HARNESS_META, HARNESS_NAMES, type HarnessName } from "../harnesses/meta.js";
import type { SharesFile } from "./shares.js";
import { sharesFor } from "./shares.js";
import type { SessionSummary } from "./summary.js";

export interface SessionFilter {
  harness?: HarnessName;
  project?: string;
  branch?: string;
  model?: string;
  tool?: string;
  /** Only sessions ending at or after this time (ms). */
  sinceMs?: number;
  beforeMs?: number;
  shared?: boolean;
  /** Include subagent worker sessions (hidden by default). */
  workers?: boolean;
  words: string[];
}

/** `harness:<word>`: a harness's name or any of its aliases. */
const HARNESS_ALIASES = new Map<string, HarnessName>(HARNESS_NAMES.flatMap((n) => [n, ...HARNESS_META[n].aliases].map((w): [string, HarnessName] => [w, n])));

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "7d", "12h", "2w", or an ISO date. */
export function parseSince(value: string, now = Date.now()): number | undefined {
  const rel = /^(\d+)([mhdw])$/.exec(value);
  if (rel) return now - Number(rel[1]) * UNITS[rel[2]!]!;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

export function parseQuery(input: string, now = Date.now()): SessionFilter {
  const f: SessionFilter = { words: [] };
  for (const token of input.split(/\s+/).filter(Boolean)) {
    const m = /^(harness|project|repo|branch|model|tool|since|before|shared|workers):(.*)$/i.exec(token);
    if (!m || !m[2]) {
      f.words.push(token.toLowerCase());
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = m[2].toLowerCase();
    if (key === "harness") f.harness = HARNESS_ALIASES.get(value);
    else if (key === "project" || key === "repo") f.project = value;
    else if (key === "branch") f.branch = value;
    else if (key === "model") f.model = value;
    else if (key === "tool") f.tool = m[2];
    else if (key === "since") f.sinceMs = parseSince(value, now);
    else if (key === "before") f.beforeMs = parseSince(value, now);
    else if (key === "shared") f.shared = /^(y|yes|true|1)$/.test(value);
    else if (key === "workers") f.workers = /^(y|yes|true|1)$/.test(value);
  }
  return f;
}

/** A word shorter than this still matches, but is not highlighted: one letter would light up half of any text. */
export const MIN_HIGHLIGHT = 2;

const wordPatterns = new Map<string, RegExp>();
const patternOf = (word: string): RegExp => {
  let re = wordPatterns.get(word);
  if (!re) wordPatterns.set(word, (re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")));
  return re;
};

/**
 * Where the free words sit in `text`, as merged `[start, end)` ranges: the same case-insensitive substring rule `score`
 * applies to `searchText`, so what is highlighted is what matched. Words under MIN_HIGHLIGHT are left out.
 */
export function hitRanges(text: string, words: readonly string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const word of words) {
    if (word.length < MIN_HIGHLIGHT) continue;
    for (const m of text.matchAll(patternOf(word))) found.push([m.index, m.index + m[0].length]);
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

function score(s: SessionSummary, words: string[]): number {
  if (words.length === 0) return 1;
  const strong = `${s.title ?? ""} ${s.project ?? ""}`.toLowerCase();
  let total = 0;
  for (const w of words) {
    if (strong.includes(w)) total += 3;
    else if (s.searchText.includes(w)) total += 1;
    else return 0;
  }
  return total;
}

export function matches(s: SessionSummary, f: SessionFilter, shares: SharesFile = {}): boolean {
  if (s.worker && !f.workers) return false;
  if (f.harness && s.harness !== f.harness) return false;
  if (f.project && !(s.project ?? s.cwd ?? "").toLowerCase().includes(f.project)) return false;
  if (f.branch && !(s.branch ?? "").toLowerCase().includes(f.branch)) return false;
  if (f.model && !s.models.some((m) => m.toLowerCase().includes(f.model!))) return false;
  if (f.tool && !(f.tool in s.tools)) return false;
  const end = s.endedAt ? Date.parse(s.endedAt) : s.mtimeMs;
  if (f.sinceMs !== undefined && end < f.sinceMs) return false;
  if (f.beforeMs !== undefined && end >= f.beforeMs) return false;
  if (f.shared !== undefined && (sharesFor(shares, s.harness, s.id).length > 0) !== f.shared) return false;
  return score(s, f.words) > 0;
}

/** Filter and order: with free-text words by relevance then recency; otherwise newest first. */
export function searchSessions(all: SessionSummary[], filter: SessionFilter | string, shares: SharesFile = {}): SessionSummary[] {
  const f = typeof filter === "string" ? parseQuery(filter) : filter;
  const hits = all.filter((s) => matches(s, f, shares));
  if (f.words.length === 0) return hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits
    .map((s) => ({ s, score: score(s, f.words) }))
    .sort((a, b) => b.score - a.score || b.s.mtimeMs - a.s.mtimeMs)
    .map((x) => x.s);
}

/** Distinct values for filter pickers, most frequent first. */
export function facet(all: SessionSummary[], pick: (s: SessionSummary) => string | undefined): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of all) {
    const v = pick(s);
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
