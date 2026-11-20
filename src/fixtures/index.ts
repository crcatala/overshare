import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type OvershareConfig } from "../config.js";
import { prepareShare, type PreparedShare } from "../pipeline.js";
import { readSecretsFile } from "../redact/known-values.js";
import { projectDir as claudeProjectDir } from "../harnesses/claude-code/index.js";
import { projectDir as piProjectDir } from "../harnesses/pi/index.js";
import { SHARE_MODES, type ShareMode } from "../schema.js";
import { readSession } from "../harnesses/index.js";
import { writeAntigravity } from "./antigravity.js";
import { emitClaudeCode } from "./claude-code.js";
import { emitCodex } from "./codex.js";
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
  /** False emits historical pi sessions without authored-input capture. */
  piInputProvenance?: boolean;
}

export interface GeneratedFixtures {
  claudeFile: string;
  piFile: string;
  codexFile: string;
  /** The conversation's transcript inside a fake Antigravity data folder (its database and annotation beside it). */
  antigravityFile: string;
  /** KEY=VALUE file of planted secrets, for `--secrets-file`. */
  secretsFile: string;
  secrets: PlantedSecret[];
  /** Text that only appears on rewound/abandoned branches. */
  abandonedMarker: string;
  home: string;
  username: string;
  cwd: string;
  /** Directories to point OVERSHARE_CLAUDE_PROJECTS / OVERSHARE_PI_SESSIONS / OVERSHARE_CODEX_SESSIONS / OVERSHARE_ANTIGRAVITY_DIR at. */
  roots: { "claude-code": string; pi: string; codex: string; antigravity: string };
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

  const roots = { "claude-code": join(opts.outDir, "claude", "projects"), pi: join(opts.outDir, "pi", "sessions"), codex: join(opts.outDir, "codex", "sessions"), antigravity: join(opts.outDir, "antigravity") };
  const claudeId = rng.uuid();
  const claudeDir = join(roots["claude-code"], claudeProjectDir(script.cwd));
  const claudeFile = join(claudeDir, `${claudeId}.jsonl`);
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(claudeFile, emitClaudeCode(script, new Rng(seed * 31 + 1), { sessionId: claudeId, start, home, username }));

  const piId = new Rng(seed * 17 + 3).uuid7(start);
  const piDir = join(roots.pi, piProjectDir(script.cwd));
  const piFile = join(piDir, `${new Date(start).toISOString().replace(/[:.]/g, "-")}_${piId}.jsonl`);
  mkdirSync(piDir, { recursive: true });
  writeFileSync(piFile, emitPi(script, new Rng(seed * 31 + 2), { sessionId: piId, start, home, inputProvenance: opts.piInputProvenance }));

  // Their own random streams (seeded apart from the others'), so adding them changes no Claude Code or pi output.
  const codexId = new Rng(seed * 17 + 5).uuid7(start);
  const day = new Date(start).toISOString().slice(0, 10).split("-");
  const codexDir = join(roots.codex, ...day);
  const codexFile = join(codexDir, `rollout-${new Date(start).toISOString().slice(0, 19).replace(/:/g, "-")}-${codexId}.jsonl`);
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(codexFile, emitCodex(script, new Rng(seed * 31 + 3), { sessionId: codexId, start, home }));
  writeFileSync(join(opts.outDir, "codex", "session_index.jsonl"), `${JSON.stringify({ id: codexId, thread_name: script.title, updated_at: new Date(start).toISOString() })}\n`);

  const antigravityFile = writeAntigravity(script, new Rng(seed * 31 + 4), { dataDir: roots.antigravity, conversationId: new Rng(seed * 17 + 7).uuid(), start, home });

  const secretsFile = join(opts.outDir, "secrets.env");
  writeFileSync(secretsFile, secretsEnvFile(secrets), { mode: 0o600 });
  return { claudeFile, piFile, codexFile, antigravityFile, secretsFile, secrets: secrets.list, abandonedMarker: script.abandonedMarker, home, username, cwd: script.cwd, roots };
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "developer";
  }
}

export interface ExportedShare {
  file: string;
  bytes: number;
  status: "clean" | "needs review" | "BLOCKED";
}

/** Where the viewer build puts the example share, relative to the viewer page (open it with `#url:examples/session.json`). */
export const EXAMPLE_SHARE_PATH = "examples/session.json";

/**
 * The example session linked from the landing page: the Claude Code fixture, redacted in full mode by default (so
 * readers can step down to every other mode) with its planted fake secrets as known values, so the share shows real
 * `[REDACTED:…]` replacements. A fixed home, username and the default config keep it the same on every machine.
 */
export function exampleShare(opts: { now?: Date; mode?: ShareMode } = {}): PreparedShare {
  const dir = mkdtempSync(join(tmpdir(), "overshare-example-"));
  try {
    const fx = generateFixtures({ outDir: dir, home: "/home/dana", username: "dana" });
    const share = prepareShare(readFileSync(fx.claudeFile, "utf8"), {
      mode: opts.mode ?? "full",
      config: DEFAULT_CONFIG,
      harness: "claude-code",
      knownSecrets: [],
      extraKnownSecrets: readSecretsFile(fx.secretsFile),
      machine: { homeDir: fx.home, username: fx.username, hostname: "devbox" },
      now: opts.now,
    });
    if (share.report.blocked) throw new Error("the example share failed its final re-scan");
    return share;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Redact and export each fixture transcript in every mode to `<outDir>/shares/<harness>-<mode>.json`. */
export function exportFixtureShares(fx: GeneratedFixtures, outDir: string, config: OvershareConfig): ExportedShare[] {
  const sharesDir = join(outDir, "shares");
  mkdirSync(sharesDir, { recursive: true });
  const extraKnownSecrets = readSecretsFile(fx.secretsFile);
  const out: ExportedShare[] = [];
  for (const [harness, file] of [["claude-code", fx.claudeFile], ["pi", fx.piFile], ["codex", fx.codexFile], ["antigravity", fx.antigravityFile]] as const) {
    // As the CLI reads a session: with what its harness keeps beside the transcript (Antigravity's database).
    const { raw, options } = readSession(harness, file);
    for (const mode of SHARE_MODES) {
      const { json, report } = prepareShare(raw, {
        mode,
        config,
        harness,
        ...options,
        knownSecrets: [],
        extraKnownSecrets,
        machine: { homeDir: fx.home, username: fx.username },
      });
      const target = join(sharesDir, `${harness}-${mode}.json`);
      writeFileSync(target, json);
      out.push({ file: target, bytes: report.bytes, status: report.blocked ? "BLOCKED" : report.clean ? "clean" : "needs review" });
    }
  }
  return out;
}

