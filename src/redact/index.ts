import type { NormalizedSession } from "../schema.js";
import type { KnownSecret } from "./known-values.js";
import { safeLabel } from "./labels.js";
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
// Keys whose values are identifiers/metadata, never user content.
const SKIP_KEYS = new Set(["schema", "id", "responseId", "timestamp", "kind", "event", "action", "sessionId", "leafId", "startedAt", "endedAt", "sharedAt"]);

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
    this.known = (opts.knownSecrets ?? [])
      .filter((k) => !this.allow.has(k.value))
      .map((k) => ({ ...k, label: safeLabel(k.label, "secret") }))
      .sort((a, b) => b.value.length - a.value.length);
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
      if (!out.includes(k.value)) continue;
      const token = `[REDACTED:${k.label}]`;
      const n = out.split(k.value).length - 1;
      out = out.split(k.value).join(token);
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
    for (const m of [...matches].reverse()) {
      const token = `[REDACTED:${m.rule}]`;
      out = out.slice(0, m.start) + token + out.slice(m.end);
      this.count("secret-pattern");
      this.findings.push({ category: "secret-pattern", rule: `${m.rule} (${m.confidence})`, where });
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
    if (typeof value === "string") return SKIP_KEYS.has(key) ? value : redactor.redactField(key, value, where);
    if (Array.isArray(value)) return value.map((v) => walk(v, key, where));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k, where);
      return out;
    }
    return value;
  };
  const copy: NormalizedSession = { ...session };
  copy.title = session.title ? redactor.redactText(session.title, "title") : session.title;
  copy.project = walk(session.project, "", "project") as NormalizedSession["project"];
  copy.turns = session.turns.map((turn) => ({
    ...turn,
    user: turn.user ? (walk(turn.user, "", `turn ${turn.index} · prompt`) as typeof turn.user) : undefined,
    steps: turn.steps.map((step) => walk(step, "", `turn ${turn.index} · ${describeStep(step)}`) as typeof step),
  }));
  return copy;
}

function describeStep(step: NormalizedSession["turns"][number]["steps"][number]): string {
  switch (step.kind) {
    // Labels are printed in reports, so they must never include (unredacted) content.
    case "tool":
      return safeLabel(step.name, "tool");
    case "subagent":
      return `subagent ${safeLabel(step.tool, "tool")}`;
    default:
      return step.kind;
  }
}
