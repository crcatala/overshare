import type { NormalizedSession } from "../schema.js";
import { OWN_SESSION_FIELDS, OWN_STEP_FIELDS, OWN_TURN_FIELDS, describeStep, turnLabel } from "./index.js";
import { knownSecret, type KnownSecret } from "./known-values.js";
import { safeLabel, withSafeLabels } from "./labels.js";
import { findSecretPatterns } from "./patterns.js";
import type { FragmentPolicy } from "./secret-value.js";
import type { SourceLines, SourceLocator } from "./source-lines.js";

/** What the re-scan found, never the value: not a fragment, not a hash. The length is the only detail. */
export interface RescanIssue {
  rule: string;
  /** Length of the match in characters; absent for findings that are not a single value. */
  length?: number;
  /** Where in the payload (see `SuspiciousItem.location`); absent for matches on the raw payload (known values, home path). */
  location?: string;
  /** Lines of the source transcript holding the value (see `source-lines.ts`); absent when no locator was given or the value is not in the source verbatim. */
  source?: SourceLines;
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
  /** Lines of the source transcript holding the value; absent when it is not in the source verbatim. */
  source?: SourceLines;
}

export interface RescanResult {
  /** High-confidence matches and known values: publishing is blocked. */
  issues: RescanIssue[];
  /** Medium-confidence matches left in the payload: publishing needs an explicit confirmation. */
  suspicious: SuspiciousItem[];
}

/**
 * What counts as a leaked fragment of a secret. Chosen from the measurement in ass-uho0: no would-block case on the
 * fixture sessions in any mode, on values shaped like URLs, DSNs, webhooks, ARNs and JWTs whose ordinary start and end
 * the transcript repeats, or on this machine's own recent sessions, while a long prefix or suffix of a random token
 * (github, anthropic, stripe, age, hex, base64) is still found. The bounds are the filters; see `FragmentPolicy`.
 */
export const FRAGMENT_POLICY: FragmentPolicy = { minValueLength: 24, ratio: 0.5, minFragment: 20, maxFragment: 32, minRun: 16, minEntropy: 3, maxWordRatio: 0.4 };

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
  opts: {
    knownSecrets?: KnownSecret[];
    /** Values the patterns matched (`Redactor.matchedSecrets`); only their fragments are looked for. */
    matchedSecrets?: KnownSecret[];
    homeDir?: string;
    allowlist?: string[];
    /** Finds a finding's value in the source transcript, for its line numbers. Gets a matcher, never the value. */
    locate?: SourceLocator;
  } = {},
): RescanResult {
  const issues: RescanIssue[] = [];
  const suspicious: SuspiciousItem[] = [];
  const allow = new Set(opts.allowlist ?? []);
  const known = withSafeLabels(opts.knownSecrets ?? []);
  const whole = new Set<KnownSecret>();
  const texts: Visit[] = [];
  try {
    collectStrings(JSON.parse(payload), texts);
  } catch {
    texts.push(...payload.split("\n").map((text) => ({ text, location: "payload", meta: false })));
  }
  // Findings are rare, so a lookup is a full pass over the source only when there is something to report; the cap keeps a
  // pathological payload (hundreds of distinct values) from turning that into hundreds of passes.
  let budget = MAX_LOOKUPS;
  const where = (match: (text: string) => boolean): { source?: SourceLines } => {
    const source = budget > 0 ? (budget--, opts.locate?.(match)) : undefined;
    return source ? { source } : {};
  };
  /** The first place in the payload whose text satisfies `match`. */
  const firstLocation = (match: (text: string) => boolean): { location?: string } => {
    const at = texts.find((t) => match(t.text))?.location;
    return at ? { location: at } : {};
  };
  for (const k of known) {
    if (!k.value.inSet(allow) && k.value.isIn(payload)) {
      const has = (text: string) => k.value.isIn(text);
      issues.push({ rule: `known-secret:${k.label}`, length: k.value.length, ...firstLocation(has), ...where(has) });
      whole.add(k);
    }
  }
  // Defense in depth, never the guard for a truncation: a long prefix or suffix of a secret that survived because the
  // secret was cut in two before redaction matches no rule of its own. The whole value is already gone, so only a
  // fragment can be left. A known value blocks (it can be allowlisted); a value a pattern matched only asks for a
  // confirmation, because its measured rate on real sessions is not zero and the allowlist cannot name it (ass-uho0).
  const haystack = texts.map((t) => t.text).join("\n");
  for (const k of known) {
    if (whole.has(k) || k.value.inSet(allow)) continue;
    const end = k.value.hasFragmentIn(haystack, FRAGMENT_POLICY);
    if (!end) continue;
    const has = (text: string) => k.value.hasFragmentIn(text, FRAGMENT_POLICY) !== undefined;
    issues.push({ rule: `secret-${end}:${k.label}`, length: k.value.fragmentLength(FRAGMENT_POLICY), ...firstLocation(has), ...where(has) });
  }
  for (const k of withSafeLabels(opts.matchedSecrets ?? [])) {
    const end = k.value.hasFragmentIn(haystack, FRAGMENT_POLICY);
    if (!end) continue;
    const has = (text: string) => k.value.hasFragmentIn(text, FRAGMENT_POLICY) !== undefined;
    const at = texts.filter((t) => has(t.text));
    suspicious.push({ rule: `secret-${end}:${k.label}`, length: k.value.fragmentLength(FRAGMENT_POLICY), location: at[0]?.location ?? "payload", occurrences: Math.max(1, at.length), ...where(has) });
  }
  // The value is wrapped before it leaves this function: the locator only ever sees a matcher over text.
  const locatePattern = (value: string, rule: string): { source?: SourceLines } => {
    if (!opts.locate || budget <= 0) return {};
    const secret = knownSecret(value, rule, "pattern");
    return where((text) => secret.value.isIn(text));
  };
  const seen = new Map<string, SuspiciousItem>();
  const seenHigh = new Set<string>();
  for (const { text, location, meta } of texts) {
    for (const m of findSecretPatterns(text, allow)) {
      const value = text.slice(m.start, m.end);
      if (m.confidence === "high") {
        if (seenHigh.has(value)) continue;
        seenHigh.add(value);
        issues.push({ rule: m.rule, length: value.length, location, ...locatePattern(value, m.rule) });
        continue;
      }
      // Our own identifier fields are copied, not redacted, and generic rules fire on ids; high matches there still block.
      if (meta) continue;
      const known = seen.get(value);
      if (known) {
        known.occurrences++;
        continue;
      }
      const item: SuspiciousItem = { rule: m.rule, length: value.length, location, occurrences: 1, ...locatePattern(value, m.rule) };
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
  /** One of our schema's identifier fields (`OWN_STEP_FIELDS` and friends), which the Redactor copies on purpose. Copied is not trusted: some come from the transcript, so high-confidence matches here still block. */
  meta: boolean;
}

const NONE: ReadonlySet<string> = new Set();

/** Findings whose lines are looked up per scan; the report shows far fewer. */
const MAX_LOOKUPS = 50;

/**
 * Every string and object key of the payload with a location that is safe to print: turn and step as in the
 * report's findings, then the field path. Keys come from the data, so they only appear as `safeLabel`s.
 */
function collectStrings(root: unknown, out: Visit[]): void {
  // `own` names the identifier fields of the object being walked (the same sets the Redactor uses), matched by the
  // key path from that object, array indices dropped. A string is one only when it sits directly on its key, as the
  // Redactor requires; an `id` inside a tool input (`input.id`) is content and stays covered.
  const walk = (v: unknown, scope: string, path: string, route: string[], own: ReadonlySet<string>, direct = false): void => {
    const here = (isKey = false) => `${scope}${path ? ` · ${path}` : ""}${isKey ? " (object key)" : ""}`;
    if (typeof v === "string") {
      out.push({ text: v, location: here(), meta: direct && own.has(route.join(".")) });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, scope, `${path}[${i}]`, route, own));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.push({ text: k, location: here(true), meta: false });
        walk(x, scope, path ? `${path}.${safeLabel(k, "key")}` : safeLabel(k, "key"), [...route, k], own, true);
      }
    }
  };
  const session = root as Partial<NormalizedSession> | null;
  if (!session || typeof session !== "object" || !Array.isArray(session.turns)) return walk(root, "payload", "", [], NONE);
  const { turns, ...rest } = session;
  walk(rest, "session", "", [], OWN_SESSION_FIELDS);
  turns.forEach((turn, i) => {
    const { user, steps, ...fields } = turn;
    const base = turnLabel(typeof turn.index === "number" ? turn.index : i);
    walk(fields, base, "", [], OWN_TURN_FIELDS);
    if (user) walk(user, `${base} · prompt`, "", [], NONE);
    (Array.isArray(steps) ? steps : []).forEach((step) => walk(step, `${base} · ${describeStep(step)}`, "", [], OWN_STEP_FIELDS));
  });
}
