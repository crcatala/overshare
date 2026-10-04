import type { NormalizedSession, SessionStats, SubagentTotals } from "../schema.js";
import { knownSecret, type KnownSecret } from "./known-values.js";
import { setOwn } from "../own-keys.js";
import { safeLabel, withSafeLabels } from "./labels.js";
import { SENSITIVE_KEY, findSecretPatterns, isLiteralSecretValue } from "./patterns.js";

export type { KnownSecret } from "./known-values.js";

export type RedactionCategory =
  | "known-secret"
  | "secret-pattern"
  | "denylist"
  | "email"
  | "home-path"
  | "username"
  | "hostname";

/** Categories that mean "a secret was in this session"; any of these makes a report not clean. */
export const SECRET_CATEGORIES: ReadonlySet<RedactionCategory> = new Set(["known-secret", "secret-pattern"]);

export interface RedactionFinding {
  category: RedactionCategory;
  rule: string;
  where: string;
}

export interface RedactorOptions {
  homeDir?: string;
  username?: string;
  hostname?: string;
  redactEmails?: boolean;
  redactUsername?: boolean;
  redactHostname?: boolean;
  knownSecrets?: KnownSecret[];
  denylist?: string[];
  allowlist?: string[];
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SAFE_EMAIL = /^(noreply@|no-reply@)|@(users\.noreply\.github\.com|example\.(com|org|net)|anthropic\.com)$/i;
/**
 * Identifier fields of our schema, exempt from redaction by their position in it (not by their key name). They are
 * copied as they are because the email/home-path/username rules could mangle ids and timestamps. The exemption is
 * not a claim that the value is trusted: some are copied from the transcript (a tool or subagent step `id` is the
 * harness call id), so `redactSession` runs `id` and `responseId` through `Redactor.redactIdentifier` (known values and
 * secret patterns only) and the final re-scan stays the backstop for what no pattern recognises (ass-1c07).
 *
 * Everything else is free-form (tool input, tool results, event detail, prompts) and is redacted with no key
 * skipped: an `id`, `kind`, `event` or `action` inside a tool input is the tool's data, and its name must not
 * decide whether it is redacted. Do not add a key here because some free-form object happens to use it.
 *
 * Steps: their direct fields (`StepBase`, the `kind` tag, `ToolStep.action`, `EventStep.event`).
 */
export const OWN_STEP_FIELDS: ReadonlySet<string> = new Set(["id", "responseId", "timestamp", "kind", "event", "action"]);
/** Turns: their direct fields. */
export const OWN_TURN_FIELDS: ReadonlySet<string> = new Set(["timestamp"]);
/**
 * Session-level fields outside `turns`, as dotted paths with array indices dropped. The Redactor never walks them as text
 * (it redacts `title` and `project` as text, and `models`, `responses[].id`/`.model` and the stats keyed by model as
 * identifiers); the final re-scan does, and exempts exactly these from the suspicious tier.
 */
export const OWN_SESSION_FIELDS: ReadonlySet<string> = new Set([
  "schema",
  "startedAt",
  "endedAt",
  "source.sessionId",
  "source.leafId",
  "generator.sharedAt",
  "responses.id",
  "responses.timestamp",
]);

/** Distinct pattern-matched values kept for the fragment check: each costs a scan of the payload. */
const MAX_MATCHED = 200;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
  readonly counts: Partial<Record<RedactionCategory, number>> = {};
  readonly findings: RedactionFinding[] = [];
  private readonly known: KnownSecret[];
  /** High-confidence pattern matches, kept only as `SecretValue`s for the re-scan's fragment check; never reported. A `#` field: `inspect` and `structuredClone` do not see it, and no raw value is a key anywhere. */
  readonly #matched: KnownSecret[] = [];
  /** The surrogate each redacted identifier got, by raw value: the same value is the same token wherever it appears, and a different value never is. A `#` field for the same reason as `#matched`. */
  readonly #surrogates = new Map<string, string>();
  /** How many distinct values each redacted form (`[REDACTED:rule]`) has been given a surrogate for. */
  readonly #perForm = new Map<string, number>();
  /** Every surrogate handed out, so none is ever issued twice. */
  readonly #issued = new Set<string>();
  private readonly allow: Set<string>;
  private readonly deny: RegExp[];
  private readonly homeRes: RegExp[];
  private readonly userRe?: RegExp;
  private readonly hostRe?: RegExp;

  constructor(private readonly opts: RedactorOptions = {}) {
    this.allow = new Set(opts.allowlist ?? []);
    this.known = withSafeLabels((opts.knownSecrets ?? []).filter((k) => !k.value.inSet(this.allow))).sort((a, b) => b.value.length - a.value.length);
    this.deny = (opts.denylist ?? []).filter((d) => d.trim()).map((d) => new RegExp(escapeRe(d), "gi"));
    const home = opts.homeDir?.replace(/[\\/]+$/, "");
    this.homeRes = [];
    if (home && home.length > 1) {
      this.homeRes.push(new RegExp(`${escapeRe(home)}(?![\\w.-])`, "g"));
      // Path slugs used in transcript directory names, e.g. -home-mog-workspace-x
      this.homeRes.push(new RegExp(escapeRe(home.replace(/[^A-Za-z0-9]/g, "-")) + "(?=-|$)", "g"));
    }
    if (opts.redactUsername !== false && opts.username && opts.username.length >= 3) {
      this.userRe = new RegExp(`(?<![\\w.-])${escapeRe(opts.username)}(?![\\w-])`, "g");
    }
    if (opts.redactHostname && opts.hostname && opts.hostname.length >= 3) {
      this.hostRe = new RegExp(`(?<![\\w.-])${escapeRe(opts.hostname)}(?![\\w-])`, "g");
    }
  }

  get secretCount(): number {
    return [...SECRET_CATEGORIES].reduce((n, c) => n + (this.counts[c] ?? 0), 0);
  }

  private count(category: RedactionCategory, n = 1): void {
    this.counts[category] = (this.counts[category] ?? 0) + n;
  }

  /** The values high-confidence patterns matched so far, for the final re-scan to look for their fragments (see `rescanPayload`). */
  matchedSecrets(): KnownSecret[] {
    return [...this.#matched];
  }

  /** Redact one string. `where` labels findings for the report. */
  redactText(text: string, where = ""): string {
    if (!text) return text;
    return this.redactPersonal(this.redactSecrets(text, where));
  }

  /**
   * Redact a value the transcript supplies as an identifier (a call id, a response id, a model id): exact known values and
   * secret patterns, but not the email/home-path/username/hostname rules, which could mangle an id that merely resembles one.
   *
   * Ids are joined on (a response id links a step to its usage; a model id is a key of the stats), so two different
   * values must stay different once redacted: a redacted id gets a surrogate, `[REDACTED:rule]` for the first distinct
   * value and `[REDACTED:rule#2]`, `#3`, ... for the next ones, the same for the same value everywhere (ass-lka8).
   * The index counts values, so it says nothing about the secret.
   *
   * An id that is already shaped like a token (`[REDACTED...`) is the transcript's own text, not ours, and could equal a
   * surrogate issued for a secret, in either order of appearance. It is replaced too, by `[REDACTED:identifier]`, so
   * every token in the payload was issued here and no two values share one.
   */
  redactIdentifier(id: string, where = ""): string {
    if (!id) return id;
    const out = this.redactSecrets(id, where);
    if (out === id) return id.includes("[REDACTED") ? this.surrogate(id, "[REDACTED:identifier]") : id;
    return this.surrogate(id, out);
  }

  /**
   * A record keyed by identifiers (stats by model id), its keys redacted like `redactIdentifier`. Distinct keys give
   * distinct tokens, so no two entries merge, and a key such as `__proto__` stays an own key (`fromEntries` defines it
   * rather than assigning it).
   */
  redactIdentifierKeys<V>(record: Record<string, V>, where = ""): Record<string, V> {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [this.redactIdentifier(key, where), value]));
  }

  private surrogate(raw: string, form: string): string {
    const known = this.#surrogates.get(raw);
    if (known !== undefined) return known;
    // The index goes inside the last token, so the result still reads as one: `[REDACTED:rule#2]`, `msg:[REDACTED:rule#2]`.
    const close = form.lastIndexOf("]");
    let n = this.#perForm.get(form) ?? 0;
    let token: string;
    do {
      n++;
      token = n === 1 ? form : close < 0 ? `${form}#${n}` : `${form.slice(0, close)}#${n}${form.slice(close)}`;
    } while (this.#issued.has(token));
    this.#perForm.set(form, n);
    this.#issued.add(token);
    this.#surrogates.set(raw, token);
    return token;
  }

  /** Known values, the denylist and the secret patterns. */
  private redactSecrets(text: string, where: string): string {
    let out = text;

    for (const k of this.known) {
      const n = k.value.countIn(out);
      if (n === 0) continue;
      out = k.value.replaceIn(out, `[REDACTED:${k.label}]`);
      this.count("known-secret", n);
      this.findings.push({ category: "known-secret", rule: `${k.label} (${k.source})`, where });
    }
    for (const re of this.deny) {
      out = out.replace(re, () => {
        this.count("denylist");
        this.findings.push({ category: "denylist", rule: "denylist", where });
        return "[REDACTED]";
      });
    }
    const matches = findSecretPatterns(out, this.allow);
    if (matches.length) {
      // One pass over the matches, which are ordered and disjoint, with the pieces joined once: splicing the string
      // per match is quadratic when a large string has thousands of them (ass-7x3c measured 21 s for 15k in 5 MB).
      const pieces: string[] = [];
      let pos = 0;
      for (const m of matches) {
        pieces.push(out.slice(pos, m.start), `[REDACTED:${m.rule}]`);
        if (m.confidence === "high" && this.#matched.length < MAX_MATCHED) {
          const value = out.slice(m.start, m.end);
          if (!this.#matched.some((k) => k.value.equals(value))) this.#matched.push(knownSecret(value, m.rule, "pattern"));
        }
        pos = m.end;
        this.count("secret-pattern");
        this.findings.push({ category: "secret-pattern", rule: `${m.rule} (${m.confidence})`, where });
      }
      pieces.push(out.slice(pos));
      out = pieces.join("");
    }
    return out;
  }

  /** Emails, home paths, the user name and the host name. */
  private redactPersonal(text: string): string {
    let out = text;
    if (this.opts.redactEmails !== false) {
      out = out.replace(EMAIL, (email) => {
        if (SAFE_EMAIL.test(email) || this.allow.has(email)) return email;
        this.count("email");
        return "[email]";
      });
    }
    for (const re of this.homeRes) {
      out = out.replace(re, (m) => {
        this.count("home-path");
        return m.startsWith("-") ? "-home-[user]" : "~";
      });
    }
    if (this.userRe) out = out.replace(this.userRe, () => (this.count("username"), "[user]"));
    if (this.hostRe) out = out.replace(this.hostRe, () => (this.count("hostname"), "[host]"));

    return out;
  }

  /** Redact a value assigned to a key; sensitive key names redact literal values outright. */
  redactField(key: string, value: string, where: string): string {
    if (key && SENSITIVE_KEY.test(key) && isLiteralSecretValue(value) && !this.allow.has(value) && !value.startsWith("[REDACTED")) {
      this.count("secret-pattern");
      const label = safeLabel(key, "key");
      this.findings.push({ category: "secret-pattern", rule: `sensitive-key:${label} (medium)`, where });
      return `[REDACTED:${label}]`;
    }
    return this.redactText(value, where);
  }
}

/** Deep-redact every string in a session (in place semantics avoided: returns a copy). */
export function redactSession(session: NormalizedSession, redactor: Redactor): NormalizedSession {
  const walk = (value: unknown, key: string, where: string): unknown => {
    if (typeof value === "string") return redactor.redactField(key, value, where);
    if (Array.isArray(value)) return value.map((v) => walk(v, key, where));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) setOwn(out, k, walk(v, k, where));
      return out;
    }
    return value;
  };
  const walkSubagentUsage = (usage: Record<string, unknown>, where: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(usage)) {
      setOwn(out, k, k === "models" && Array.isArray(v) ? v.map((m) => (typeof m === "string" ? redactor.redactIdentifier(m, where) : walk(m, k, where))) : walk(v, k, where));
    }
    return out;
  };
  // Own identifier fields are exempt only directly on the step; everything below (tool input, results, ...) is walked whole.
  const walkStep = (step: Record<string, unknown>, where: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step)) {
      if (typeof v === "string" && OWN_STEP_FIELDS.has(k)) setOwn(out, k, k === "id" || k === "responseId" ? redactor.redactIdentifier(v, where) : v);
      // Ids and model ids copied from the transcript: one surrogate per value wherever it appears (ass-lka8, ass-gmih).
      else if (typeof v === "string" && k === "model") setOwn(out, k, redactor.redactIdentifier(v, where));
      else if (Array.isArray(v) && k === "responseIds") setOwn(out, k, v.map((id) => (typeof id === "string" ? redactor.redactIdentifier(id, where) : walk(id, k, where))));
      else if (k === "usage" && step.kind === "subagent" && v && typeof v === "object") setOwn(out, k, walkSubagentUsage(v as Record<string, unknown>, where));
      else setOwn(out, k, walk(v, k, where));
    }
    return out;
  };
  const copy: NormalizedSession = { ...session };
  copy.title = session.title ? redactor.redactText(session.title, "title") : session.title;
  copy.project = walk(session.project, "", "project") as NormalizedSession["project"];
  // Model ids, like the response ids below, are copied from the transcript and published as they are in every mode: values of
  // `models` and `responses[].model` and keys of the stats keyed by model (ass-gmih).
  copy.models = session.models.map((m) => redactor.redactIdentifier(m, "models"));
  copy.stats = redactStats(session.stats, redactor);
  // The response ids are the harness's message ids, copied from the transcript like a step's `responseId`.
  copy.responses = session.responses.map((r) => ({
    ...r,
    id: redactor.redactIdentifier(r.id, "responses"),
    ...(r.model !== undefined ? { model: redactor.redactIdentifier(r.model, "responses") } : {}),
  }));
  copy.turns = session.turns.map((turn) => ({
    ...turn,
    user: turn.user ? (walk(turn.user, "", `${turnLabel(turn.index)} · prompt`) as typeof turn.user) : undefined,
    steps: turn.steps.map((step) => walkStep(step as unknown as Record<string, unknown>, `${turnLabel(turn.index)} · ${describeStep(step)}`) as unknown as typeof step),
  }));
  return copy;
}

/** The stats with the model ids that key them redacted; every other figure is a number or a label that `computeStats` already made safe. */
function redactStats(stats: SessionStats, redactor: Redactor): SessionStats {
  const totals = <T extends SubagentTotals>(t: T): T => ({ ...t, byModel: redactor.redactIdentifierKeys(t.byModel, "stats") });
  const sub = stats.subagentUsage;
  return {
    ...stats,
    ...(stats.rates ? { rates: redactor.redactIdentifierKeys(stats.rates, "stats") } : {}),
    ...(sub ? { subagentUsage: { ...totals(sub), ...(sub.unlinked ? { unlinked: totals(sub.unlinked) } : {}) } } : {}),
  };
}

/** 1-based, like the turn numbers in the browse viewer, so a location can be followed there. */
export const turnLabel = (index: number): string => `turn ${index + 1}`;

/** Where a step lives, for reports; printed, so it never includes (unredacted) content. */
export function describeStep(step: NormalizedSession["turns"][number]["steps"][number]): string {
  switch (step.kind) {
    case "tool":
      return safeLabel(step.name, "tool");
    case "subagent":
      return `subagent ${safeLabel(step.tool, "tool")}`;
    default:
      return step.kind;
  }
}
