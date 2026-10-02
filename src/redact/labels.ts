import type { KnownSecret } from "./known-values.js";
import { findSecretPatterns, looksLikeSecret } from "./patterns.js";

/**
 * Labels end up in the report and in the published `[REDACTED:<label>]` token. Several come from data
 * (transcript keys, tool names, JSON paths in credential files), so a label may itself be a secret.
 * `safeLabel` only lets a conservative identifier through and otherwise returns the generic `fallback`.
 */
const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
// Needs an underscore: an all-caps/digits run without one (an AWS key id) is not a name.
const ENV_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

// Tool names repeat thousands of times per session and the pattern scan is not cheap.
const verdicts = new Map<string, boolean>();
const MAX_VERDICTS = 2_000;

function isSafe(label: string): boolean {
  if (!LABEL.test(label)) return false;
  let safe = verdicts.get(label);
  if (safe === undefined) {
    // `SOME_ENV_NAME` is high-entropy to the heuristic but is the label we want to show.
    safe = findSecretPatterns(label).length === 0 && (ENV_NAME.test(label) || !looksLikeSecret(label));
    if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
    verdicts.set(label, safe);
  }
  return safe;
}

export function safeLabel(label: string, fallback: string): string {
  return isSafe(label) ? label : fallback;
}

/**
 * Known secrets with report-safe labels. On top of `safeLabel`, a label that appears inside any known
 * value is dropped: whatever produced it, it is then part of a secret, and the label is printed and
 * published in the `[REDACTED:<label>]` token.
 */
export function withSafeLabels(known: readonly KnownSecret[]): KnownSecret[] {
  return known.map((k) => {
    const label = safeLabel(k.label, "secret");
    return known.some((other) => other.value.includes(label)) ? { ...k, label: "secret" } : { ...k, label };
  });
}
