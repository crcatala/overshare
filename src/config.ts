import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { R2Config } from "./publish/r2.js";

export interface AgentShareConfig {
  /** Viewer base URL; shares link to `<viewerUrl>#<owner>/<gistId>`. */
  viewerUrl: string;
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
  };
}

export type ShareTarget = "gist" | "r2";
export const SHARE_TARGETS: readonly ShareTarget[] = ["gist", "r2"];

export const DEFAULT_CONFIG: AgentShareConfig = {
  viewerUrl: "https://agent.nub.sh/session/",
  target: "gist",
  maxToolChars: 20_000,
  redact: { emails: true, username: true, hostname: false, denylist: [], allowlist: [] },
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
    redact: { ...DEFAULT_CONFIG.redact, ...(user.redact ?? {}) },
  };
  if (env.AGENT_SHARE_VIEWER_URL) config.viewerUrl = env.AGENT_SHARE_VIEWER_URL;
  if (env.AGENT_SHARE_TARGET) config.target = env.AGENT_SHARE_TARGET as ShareTarget;
  if (!SHARE_TARGETS.includes(config.target)) throw new Error(`Unknown target "${config.target}" (use ${SHARE_TARGETS.join(" or ")})`);
  return config;
}
