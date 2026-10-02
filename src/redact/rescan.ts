import type { KnownSecret } from "./known-values.js";
import { withSafeLabels } from "./labels.js";
import { findSecretPatterns } from "./patterns.js";

/** What the re-scan found, never the value: not a fragment, not a hash. The length is the only detail. */
export interface RescanIssue {
  rule: string;
  /** Length of the match in characters; absent for findings that are not a single value. */
  length?: number;
}

/**
 * Final safety net over the exact bytes that would be uploaded. Anything found here
 * slipped past redaction, so publishing is blocked until it is allowlisted or fixed.
 *
 * Pattern scanning runs per decoded JSON string (and key): the underlying scanner is
 * superlinear on very large single inputs, and decoded strings avoid JSON escaping
 * hiding a match. Exact known-value and home-path checks run on the raw payload.
 */
export function rescanPayload(
  payload: string,
  opts: { knownSecrets?: KnownSecret[]; homeDir?: string; allowlist?: string[] } = {},
): RescanIssue[] {
  const issues: RescanIssue[] = [];
  const allow = new Set(opts.allowlist ?? []);
  for (const k of withSafeLabels(opts.knownSecrets ?? [])) {
    if (!allow.has(k.value) && payload.includes(k.value)) issues.push({ rule: `known-secret:${k.label}`, length: k.value.length });
  }
  const texts: string[] = [];
  try {
    collectStrings(JSON.parse(payload), texts);
  } catch {
    texts.push(...payload.split("\n"));
  }
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of findSecretPatterns(text, allow)) {
      if (m.confidence !== "high") continue;
      const value = text.slice(m.start, m.end);
      if (seen.has(value)) continue;
      seen.add(value);
      issues.push({ rule: m.rule, length: value.length });
    }
  }
  const home = opts.homeDir?.replace(/[\\/]+$/, "");
  if (home && home.length > 1 && new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`).test(payload)) {
    issues.push({ rule: "home-path" });
  }
  return issues;
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === "string") {
    out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      collectStrings(x, out);
    }
  }
}
