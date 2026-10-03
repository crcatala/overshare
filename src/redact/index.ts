import type { NormalizedSession } from "../schema.js";
import type { KnownSecret } from "./known-values.js";
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
 * harness call id), so a secret-shaped one is only caught by the final re-scan (see ass-1c07).
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
 * Session-level fields outside `turns`, as dotted paths with array indices dropped. The Redactor never walks them
 * (only `title` and `project` are); the final re-scan does, and exempts exactly these from the suspicious tier.
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
  readonly counts: Partial<Record<RedactionCategory, number>> = {};
  readonly findings: RedactionFinding[] = [];
  private readonly known: KnownSecret[];
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

  /** Redact one string. `where` labels findings for the report. */
  redactText(text: string, where = ""): string {
    if (!text) return text;
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
        pos = m.end;
        this.count("secret-pattern");
        this.findings.push({ category: "secret-pattern", rule: `${m.rule} (${m.confidence})`, where });
      }
      pieces.push(out.slice(pos));
      out = pieces.join("");
    }
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
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k, where);
      return out;
    }
    return value;
  };
  // Own identifier fields are exempt only directly on the step; everything below (tool input, results, ...) is walked whole.
  const walkStep = (step: Record<string, unknown>, where: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step)) out[k] = typeof v === "string" && OWN_STEP_FIELDS.has(k) ? v : walk(v, k, where);
    return out;
  };
  const copy: NormalizedSession = { ...session };
  copy.title = session.title ? redactor.redactText(session.title, "title") : session.title;
  copy.project = walk(session.project, "", "project") as NormalizedSession["project"];
  copy.turns = session.turns.map((turn) => ({
    ...turn,
    user: turn.user ? (walk(turn.user, "", `${turnLabel(turn.index)} · prompt`) as typeof turn.user) : undefined,
    steps: turn.steps.map((step) => walkStep(step as unknown as Record<string, unknown>, `${turnLabel(turn.index)} · ${describeStep(step)}`) as unknown as typeof step),
  }));
  return copy;
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
