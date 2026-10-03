import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeLabel } from "./labels.js";
import { SENSITIVE_KEY, isLiteralSecretValue, looksLikeSecret } from "./patterns.js";
import { SecretValue } from "./secret-value.js";

/**
 * Exact secret values present on this machine. Replacing these verbatim catches
 * secrets in any format, including ones no regex knows about. Values never leave
 * this process: reports show only the label and source, and `SecretValue` refuses
 * to be printed or serialized.
 */
export interface KnownSecret {
  value: SecretValue;
  label: string;
  source: string;
}

export function knownSecret(value: string, label: string, source: string): KnownSecret {
  return { value: new SecretValue(value), label, source };
}

/**
 * Where exact secret values are harvested from. Each source is a switch in `redact.knownSources`:
 * `env` and `projectEnv` are on by default (the session very likely touched them); the rest read
 * credential stores the user may not expect a share tool to open, so they are opt-in.
 */
export const KNOWN_SOURCES = ["env", "projectEnv", "credentialFiles", "ghToken"] as const;
export type KnownSourceId = (typeof KNOWN_SOURCES)[number];
export type KnownSourceSettings = Record<KnownSourceId, boolean>;

export const DEFAULT_KNOWN_SOURCES: KnownSourceSettings = { env: true, projectEnv: true, credentialFiles: false, ghToken: false };

/** Short names for reports. `credentialFiles` covers pi/Claude/Codex auth JSON, `gh hosts.yml`, `~/.npmrc` and `~/.netrc`. */
export const KNOWN_SOURCE_LABELS: Record<KnownSourceId | "secrets-file" | "provided", string> = {
  env: "env",
  projectEnv: "project .env",
  credentialFiles: "credential files",
  ghToken: "gh auth token",
  "secrets-file": "secrets file",
  provided: "provided",
};

/** What one source contributed to a publish. Counts only: values never appear here. */
export interface KnownSourceUse {
  id: KnownSourceId | "secrets-file" | "provided";
  /** Switched on in config (always true for the ids that are not switches). */
  enabled: boolean;
  /** Distinct values this source added. */
  count: number;
}

export interface KnownValueSources {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Directory whose `.env*` files are read (usually the session's cwd). */
  projectDir?: string;
  /** Which sources to read; unset ones follow `DEFAULT_KNOWN_SOURCES`. */
  enabled?: Partial<KnownSourceSettings>;
  /** JSON credential files to read instead of the pi/Claude/Codex locations (tests). */
  jsonCredentialFiles?: string[];
}

export interface CollectedKnownSecrets {
  secrets: KnownSecret[];
  /** One entry per switchable source, in `KNOWN_SOURCES` order. */
  sources: KnownSourceUse[];
}

const ENV_NAME = /(KEY|TOKEN|SECRET|PASS(WORD|WD)?|CREDENTIAL|AUTH|PRIVATE|DSN|COOKIE|WEBHOOK)/i;
const ENV_NAME_IGNORE = /^(STARSHIP_SESSION_KEY|SSH_AUTH_SOCK|GPG_AGENT_INFO|.*_(DIR|PATH|FILE|HOST|PORT|URL_BASE|MODE|ID))$/i;

function acceptable(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return false;
  if (/^\d+$/.test(v) || /^(true|false|yes|no|on|off)$/i.test(v)) return false;
  if (/^[/~.]/.test(v) || /^[A-Za-z]:\\/.test(v)) return false; // paths
  if (/^https?:\/\/[^@\s]*$/.test(v)) return false; // plain URLs
  if (/\s/.test(v)) return false;
  return true;
}

export function collectKnownSecrets(sources: KnownValueSources = {}): CollectedKnownSecrets {
  const env = sources.env ?? process.env;
  const home = sources.home ?? homedir();
  const enabled: KnownSourceSettings = { ...DEFAULT_KNOWN_SOURCES, ...sources.enabled };
  const out = new Map<string, { value: string; label: string; source: string }>();
  const counts: Record<KnownSourceId, number> = { env: 0, projectEnv: 0, credentialFiles: 0, ghToken: 0 };
  const adder = (id: KnownSourceId) => (value: unknown, label: string, source: string) => {
    if (typeof value !== "string" || !acceptable(value)) return;
    const v = value.trim();
    if (out.has(v)) return;
    out.set(v, { value: v, label, source });
    counts[id]++;
  };

  if (enabled.env) {
    const add = adder("env");
    for (const [name, value] of Object.entries(env)) {
      if (value && ENV_NAME.test(name) && !ENV_NAME_IGNORE.test(name)) add(value, name, "env");
    }
  }

  if (enabled.credentialFiles) {
    const add = adder("credentialFiles");
    const jsonFiles = sources.jsonCredentialFiles ?? [
      join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "auth.json"),
      join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"),
      join(home, ".codex", "auth.json"),
    ];
    for (const file of jsonFiles) {
      const json = readJson(file);
      if (json !== undefined) walkJson(json, [], (path, value) => add(value, path.join(".") || "value", file.replace(home, "~")));
    }

    for (const [file, re] of [
      [join(home, ".config", "gh", "hosts.yml"), /oauth_token:\s*(\S+)/g],
      [join(home, ".npmrc"), /_authToken=(\S+)/g],
      [join(home, ".netrc"), /password\s+(\S+)/g],
    ] as const) {
      const text = readText(file);
      if (text) for (const m of text.matchAll(re)) add(m[1], "token", file.replace(home, "~"));
    }
  }

  if (enabled.ghToken) {
    try {
      const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      adder("ghToken")(token, "GH_TOKEN", "gh auth token");
    } catch {
      // gh missing or logged out
    }
  }

  if (enabled.projectEnv && sources.projectDir && existsSync(sources.projectDir)) {
    const add = adder("projectEnv");
    let names: string[] = [];
    try {
      names = readdirSync(sources.projectDir).filter((n) => /^\.env(\..+)?$/.test(n) && !/\.(example|sample|template)$/.test(n));
    } catch {
      names = [];
    }
    for (const name of names) {
      const text = readText(join(sources.projectDir, name));
      if (!text) continue;
      for (const line of text.split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1] ?? "";
        const value = (m[2] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
        if (ENV_NAME.test(key) || looksLikeSecret(value)) add(value, key, safeLabel(name, ".env"));
      }
    }
  }
  return {
    secrets: [...out.values()].map((k) => knownSecret(k.value, k.label, k.source)).sort((a, b) => b.value.length - a.value.length),
    sources: KNOWN_SOURCES.map((id) => ({ id, enabled: enabled[id], count: counts[id] })),
  };
}

/** Values shorter than this would redact common substrings everywhere, so they are skipped. */
const MIN_SECRET_LENGTH = 4;
const ENV_NAME_KEY = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Read extra secret values from a file: `KEY=VALUE` lines (the key becomes the label) or
 * one bare value per line. Blank lines and `#` comments are ignored.
 *
 * Only env-style keys (`UPPER_SNAKE`) are split at `=`. Anything else — a base64 value
 * ending in `==`, or a password like `abc=def` — is redacted as a whole line (and, when
 * long enough, also the part after `=`), so a bare secret is never dropped or partly
 * revealed. Skipped lines are reported via `warn`.
 */
export function readSecretsFile(path: string, warn: (message: string) => void = () => {}): KnownSecret[] {
  const out: KnownSecret[] = [];
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2");
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const withoutExport = trimmed.replace(/^export\s+/, "");
      const eq = withoutExport.indexOf("=");
      const key = eq > 0 ? withoutExport.slice(0, eq).trim() : "";
      if (ENV_NAME_KEY.test(key)) {
        const value = unquote(withoutExport.slice(eq + 1));
        if (value.length >= MIN_SECRET_LENGTH) out.push(knownSecret(value, key, "secrets-file"));
        else warn(`${path}:${i + 1}: value for ${key} is shorter than ${MIN_SECRET_LENGTH} characters; skipped`);
        return;
      }
      const value = unquote(trimmed);
      if (value.length >= MIN_SECRET_LENGTH) out.push(knownSecret(value, "secret", "secrets-file"));
      else warn(`${path}:${i + 1}: value is shorter than ${MIN_SECRET_LENGTH} characters; skipped`);
      // Ambiguous `name=value` (e.g. a lowercase key): also redact the part after `=` on its
      // own. Over-redacting a substring is harmless; missing a password is not. The "name" may be
      // part of the password, so it is never used as a label.
      const after = eq > 0 ? unquote(withoutExport.slice(eq + 1)) : "";
      if (after.length >= 8 && after !== value) out.push(knownSecret(after, "secret", "secrets-file"));
    });
  return out;
}

function walkJson(v: unknown, path: string[], visit: (path: string[], value: string) => void): void {
  if (typeof v === "string") {
    const key = path.at(-1) ?? "";
    if (SENSITIVE_KEY.test(key) || /^(access|refresh|key|token|id_token)$/i.test(key) || isLiteralSecretValue(v)) visit(path, v);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => walkJson(x, [...path, String(i)], visit));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) walkJson(x, [...path, k], visit);
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
