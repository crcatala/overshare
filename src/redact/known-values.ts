import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SENSITIVE_KEY, isLiteralSecretValue, looksLikeSecret } from "./patterns.js";

/**
 * Exact secret values present on this machine. Replacing these verbatim catches
 * secrets in any format, including ones no regex knows about. Values never leave
 * this process: reports show only the label and source.
 */
export interface KnownSecret {
  value: string;
  label: string;
  source: string;
}

export interface KnownValueSources {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Directory whose `.env*` files are read (usually the session's cwd). */
  projectDir?: string;
  /** Run `gh auth token`; disabled in tests. */
  ghToken?: boolean;
  /** Extra JSON credential files to read (tests). Defaults to known agent/CLI locations. */
  credentialFiles?: string[];
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

export function collectKnownSecrets(sources: KnownValueSources = {}): KnownSecret[] {
  const env = sources.env ?? process.env;
  const home = sources.home ?? homedir();
  const out = new Map<string, KnownSecret>();
  const add = (value: unknown, label: string, source: string) => {
    if (typeof value !== "string" || !acceptable(value)) return;
    const v = value.trim();
    if (!out.has(v)) out.set(v, { value: v, label, source });
  };

  for (const [name, value] of Object.entries(env)) {
    if (value && ENV_NAME.test(name) && !ENV_NAME_IGNORE.test(name)) add(value, name, "env");
  }

  const credentialFiles = sources.credentialFiles ?? [
    join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "auth.json"),
    join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"),
    join(home, ".codex", "auth.json"),
  ];
  for (const file of credentialFiles) {
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

  if (sources.ghToken !== false) {
    try {
      const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      add(token, "GH_TOKEN", "gh auth token");
    } catch {
      // gh missing or logged out
    }
  }

  if (sources.projectDir && existsSync(sources.projectDir)) {
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
        if (ENV_NAME.test(key) || looksLikeSecret(value)) add(value, key, name);
      }
    }
  }
  return [...out.values()].sort((a, b) => b.value.length - a.value.length);
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
