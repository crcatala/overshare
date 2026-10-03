import type { NormalizedSession } from "../schema.js";
import { SKIP_KEYS, describeStep, turnLabel } from "./index.js";
import type { KnownSecret } from "./known-values.js";
import { safeLabel, withSafeLabels } from "./labels.js";
import { findSecretPatterns } from "./patterns.js";

/** What the re-scan found, never the value: not a fragment, not a hash. The length is the only detail. */
export interface RescanIssue {
  rule: string;
  /** Length of the match in characters; absent for findings that are not a single value. */
  length?: number;
  /** Where in the payload (see `SuspiciousItem.location`); absent for matches on the raw payload (known values, home path). */
  location?: string;
}

/**
 * A medium-confidence match that is still in the outgoing bytes: it looks like it could be a secret, but not
 * certainly enough to block. Same no-value rule as `RescanIssue`.
 */
export interface SuspiciousItem {
  rule: string;
  length: number;
  /** Names the turn and step as in the browse viewer, plus the field, e.g. `turn 3 · Bash · input (object key)`. */
  location: string;
  /** Places in the payload holding this same value; `location` is the first. */
  occurrences: number;
}

export interface RescanResult {
  /** High-confidence matches and known values: publishing is blocked. */
  issues: RescanIssue[];
  /** Medium-confidence matches left in the payload: publishing needs an explicit confirmation. */
  suspicious: SuspiciousItem[];
}

/**
 * Final safety net over the exact bytes that would be uploaded. Anything in `issues` slipped past redaction,
 * so publishing is blocked until it is allowlisted or fixed. `suspicious` holds what the heuristics flagged at
 * medium confidence and that is still in the payload. The Redactor replaces every medium match in the strings it
 * walks, so what remains sits where it does not look (object keys, fields outside turns). It does not cover a
 * secret with no recognizable format: nothing matches that.
 *
 * Pattern scanning runs per decoded JSON string (and key): the underlying scanner is
 * superlinear on very large single inputs, and decoded strings avoid JSON escaping
 * hiding a match. Exact known-value and home-path checks run on the raw payload.
 */
export function rescanPayload(
  payload: string,
  opts: { knownSecrets?: KnownSecret[]; homeDir?: string; allowlist?: string[] } = {},
): RescanResult {
  const issues: RescanIssue[] = [];
  const suspicious: SuspiciousItem[] = [];
  const allow = new Set(opts.allowlist ?? []);
  for (const k of withSafeLabels(opts.knownSecrets ?? [])) {
    if (!k.value.inSet(allow) && k.value.isIn(payload)) issues.push({ rule: `known-secret:${k.label}`, length: k.value.length });
  }
  const texts: Visit[] = [];
  try {
    collectStrings(JSON.parse(payload), texts);
  } catch {
    texts.push(...payload.split("\n").map((text) => ({ text, location: "payload", meta: false })));
  }
  const seen = new Map<string, SuspiciousItem>();
  const seenHigh = new Set<string>();
  for (const { text, location, meta } of texts) {
    for (const m of findSecretPatterns(text, allow)) {
      const value = text.slice(m.start, m.end);
      if (m.confidence === "high") {
        if (seenHigh.has(value)) continue;
        seenHigh.add(value);
        issues.push({ rule: m.rule, length: value.length, location });
        continue;
      }
      // Identifier fields are never redacted and generic rules fire on ids; high matches there still block.
      if (meta) continue;
      const known = seen.get(value);
      if (known) {
        known.occurrences++;
        continue;
      }
      const item: SuspiciousItem = { rule: m.rule, length: value.length, location, occurrences: 1 };
      seen.set(value, item);
      suspicious.push(item);
    }
  }
  const home = opts.homeDir?.replace(/[\\/]+$/, "");
  if (home && home.length > 1 && new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`).test(payload)) {
    issues.push({ rule: "home-path" });
  }
  return { issues, suspicious };
}

interface Visit {
  text: string;
  location: string;
  /** An identifier field of a turn, step or the session itself, which the Redactor skips on purpose (`SKIP_KEYS`). */
  meta: boolean;
}

/**
 * Every string and object key of the payload with a location that is safe to print: turn and step as in the
 * report's findings, then the field path. Keys come from the data, so they only appear as `safeLabel`s.
 */
function collectStrings(root: unknown, out: Visit[]): void {
  // Session-level fields (`responses[].id`, ...) are our own schema, so an identifier key is one at any depth.
  // Inside a turn it is one only directly on the turn/step: the Redactor skips these keys at any depth, so an `id`
  // inside a tool input is real content and stays covered.
  const walk = (v: unknown, key: string, scope: string, path: string, deepMeta = false): void => {
    const here = (isKey = false) => `${scope}${path ? ` · ${path}` : ""}${isKey ? " (object key)" : ""}`;
    if (typeof v === "string") {
      out.push({ text: v, location: here(), meta: SKIP_KEYS.has(key) && (deepMeta || !path.includes(".")) });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, key, scope, `${path}[${i}]`, deepMeta));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.push({ text: k, location: here(true), meta: false });
        walk(x, k, scope, path ? `${path}.${safeLabel(k, "key")}` : safeLabel(k, "key"), deepMeta);
      }
    }
  };
  const session = root as Partial<NormalizedSession> | null;
  if (!session || typeof session !== "object" || !Array.isArray(session.turns)) return walk(root, "", "payload", "");
  const { turns, ...rest } = session;
  walk(rest, "", "session", "", true);
  turns.forEach((turn, i) => {
    const { user, steps, ...fields } = turn;
    const base = turnLabel(typeof turn.index === "number" ? turn.index : i);
    walk(fields, "", base, "");
    if (user) walk(user, "", `${base} · prompt`, "");
    (Array.isArray(steps) ? steps : []).forEach((step) => walk(step, "", `${base} · ${describeStep(step)}`, ""));
  });
}
