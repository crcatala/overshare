import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { projectDirName } from "../resolve.js";
import { emitClaudeCode } from "./claude-code.js";
import { emitPi } from "./pi.js";
import { Rng } from "./random.js";
import { buildScript } from "./script.js";
import { plantSecrets, secretsEnvFile, type PlantedSecret } from "./secrets.js";

export type { PlantedSecret } from "./secrets.js";

export interface FixtureOptions {
  outDir: string;
  seed?: number;
  /** Extra generic work turns appended to the scripted story (for larger sessions). */
  extraTurns?: number;
  /** Home directory / username used inside transcripts (defaults: this machine's, so redaction applies). */
  home?: string;
  username?: string;
}

export interface GeneratedFixtures {
  claudeFile: string;
  piFile: string;
  /** KEY=VALUE file of planted secrets, for `--secrets-file`. */
  secretsFile: string;
  secrets: PlantedSecret[];
  /** Text that only appears on rewound/abandoned branches. */
  abandonedMarker: string;
  home: string;
  username: string;
  cwd: string;
  /** Directories to point AGENT_SHARE_CLAUDE_PROJECTS / AGENT_SHARE_PI_SESSIONS at. */
  roots: { "claude-code": string; pi: string };
}

/**
 * Generate realistic Claude Code and pi transcripts (native formats, deterministic
 * per seed) that exercise the viewer and every redaction layer. Planted credentials
 * are random, correctly formatted fakes.
 */
export function generateFixtures(opts: FixtureOptions): GeneratedFixtures {
  const seed = opts.seed ?? 1;
  const home = (opts.home ?? homedir()).replace(/\/+$/, "");
  const username = opts.username ?? safeUsername();
  const rng = new Rng(seed);
  const secrets = plantSecrets(rng);
  const script = buildScript(rng, { home, username, secrets, extraTurns: opts.extraTurns ?? 0 });
  const start = Date.UTC(2026, 2, 10, 14, 0, 0) + (seed % 1000) * 60_000;

  const roots = { "claude-code": join(opts.outDir, "claude", "projects"), pi: join(opts.outDir, "pi", "sessions") };
  const claudeId = rng.uuid();
  const claudeDir = join(roots["claude-code"], projectDirName("claude-code", script.cwd));
  const claudeFile = join(claudeDir, `${claudeId}.jsonl`);
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(claudeFile, emitClaudeCode(script, new Rng(seed * 31 + 1), { sessionId: claudeId, start, home, username }));

  const piId = new Rng(seed * 17 + 3).uuid7(start);
  const piDir = join(roots.pi, projectDirName("pi", script.cwd));
  const piFile = join(piDir, `${new Date(start).toISOString().replace(/[:.]/g, "-")}_${piId}.jsonl`);
  mkdirSync(piDir, { recursive: true });
  writeFileSync(piFile, emitPi(script, new Rng(seed * 31 + 2), { sessionId: piId, start, home }));

  const secretsFile = join(opts.outDir, "secrets.env");
  writeFileSync(secretsFile, secretsEnvFile(secrets), { mode: 0o600 });
  return { claudeFile, piFile, secretsFile, secrets: secrets.list, abandonedMarker: script.abandonedMarker, home, username, cwd: script.cwd, roots };
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "developer";
  }
}
