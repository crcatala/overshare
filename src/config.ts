import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { R2Config } from "./publish/r2.js";
import { DEFAULT_KNOWN_SOURCES, KNOWN_SOURCES, type KnownSourceSettings } from "./redact/known-values.js";

export interface AgentShareConfig {
  /** Viewer base URL; shares link to `<viewerUrl>#<owner>/<gistId>`. */
  viewerUrl: string;
  /** Where viewerUrl came from (not a config-file setting). */
  viewerUrlSource?: "default" | "config" | "env";
  /** Default publish target (override with --target or AGENT_SHARE_TARGET). */
  target: ShareTarget;
  /** Public R2 bucket settings for `target: "r2"`. Credentials come from env vars. */
  r2?: R2Config;
  /** Max characters per tool result / large tool input string in full mode. */
  maxToolChars: number;
  redact: {
    emails: boolean;
    username: boolean;
    hostname: boolean;
    /** Extra literal strings to always redact (case-insensitive). */
    denylist: string[];
    /** Literal strings that must never be redacted (e.g. a known-public test key). */
    allowlist: string[];
    /** Which machine sources supply exact secret values to redact (see README "What this tool reads and why"). */
    knownSources: KnownSourceSettings;
  };
}

export type ShareTarget = "gist" | "r2";
export const SHARE_TARGETS: readonly ShareTarget[] = ["gist", "r2"];

export const DEFAULT_CONFIG: AgentShareConfig = {
  viewerUrl: "https://agent.nub.sh/session/",
  target: "gist",
  maxToolChars: 20_000,
  redact: { emails: true, username: true, hostname: false, denylist: [], allowlist: [], knownSources: DEFAULT_KNOWN_SOURCES },
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_SHARE_CONFIG) return env.AGENT_SHARE_CONFIG;
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-share", "config.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentShareConfig {
  let user: Partial<AgentShareConfig> = {};
  const path = configPath(env);
  try {
    user = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid config at ${path}: ${(err as Error).message}`);
  }
  const config: AgentShareConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    redact: { ...DEFAULT_CONFIG.redact, ...(user.redact ?? {}), knownSources: parseKnownSources(user.redact?.knownSources, path) },
  };
  config.viewerUrlSource = user.viewerUrl ? "config" : "default";
  if (env.AGENT_SHARE_VIEWER_URL) {
    config.viewerUrl = env.AGENT_SHARE_VIEWER_URL;
    config.viewerUrlSource = "env";
  }
  if (env.AGENT_SHARE_TARGET) config.target = env.AGENT_SHARE_TARGET as ShareTarget;
  if (!SHARE_TARGETS.includes(config.target)) throw new Error(`Unknown target "${config.target}" (use ${SHARE_TARGETS.join(" or ")})`);
  return config;
}

/** A typo in a security setting must not be silently ignored, so unknown keys and non-booleans are errors. */
function parseKnownSources(user: unknown, path: string): KnownSourceSettings {
  if (user === undefined) return { ...DEFAULT_KNOWN_SOURCES };
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error(`Invalid config at ${path}: redact.knownSources must be an object of booleans (${KNOWN_SOURCES.join(", ")})`);
  const out = { ...DEFAULT_KNOWN_SOURCES };
  for (const [key, value] of Object.entries(user)) {
    if (!(KNOWN_SOURCES as readonly string[]).includes(key)) throw new Error(`Invalid config at ${path}: unknown redact.knownSources.${key} (use ${KNOWN_SOURCES.join(", ")})`);
    if (typeof value !== "boolean") throw new Error(`Invalid config at ${path}: redact.knownSources.${key} must be true or false`);
    out[key as keyof KnownSourceSettings] = value;
  }
  return out;
}
