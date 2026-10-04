#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { SHARE_TARGETS, loadConfig, type ShareTarget } from "./config.js";
import { exportFixtureShares, generateFixtures } from "./fixtures/index.js";
import { formatBytes, plural } from "./format.js";
import { prepareShare, type PreparedShare } from "./pipeline.js";
import { PromptsUnavailableError } from "./modes.js";
import { createPublisher, forgetShare, parseShareRef, preflightWarnings, publishPrepared } from "./publish/index.js";
import { SECRET_CATEGORIES } from "./redact/index.js";
import { readSecretsFile } from "./redact/known-values.js";
import { formatReport } from "./report.js";
import { stripControls } from "./sanitize.js";
import { defaultRoots, listSessions, resolveSession, type SessionRef } from "./resolve.js";
import { HARNESS_NAMES, loadSubagentFiles } from "./harnesses/index.js";
import { SHARE_MODES, type HarnessName, type ShareMode } from "./schema.js";
import { DEFAULT_HOST, startViewerServer } from "./serve.js";
import { TOOL_VERSION } from "./version.js";

/** Exit codes, stable for wrappers (skill / pi extension). */
const EXIT = { ok: 0, error: 1, needsReview: 2, blocked: 3, declined: 4 } as const;

interface SessionOptions {
  current?: boolean;
  harness?: HarnessName;
  leaf?: string;
  mode: ShareMode;
  secretsFile?: string[];
}

const parseMode = (value: string): ShareMode => {
  if (!(SHARE_MODES as readonly string[]).includes(value)) throw new InvalidArgumentError(`expected one of ${SHARE_MODES.join(", ")}`);
  return value as ShareMode;
};

function withSessionOptions(cmd: Command, defaultMode: ShareMode): Command {
  return cmd
    .argument("[session]", "session file path, session id, or id prefix")
    .option("-c, --current", "use the current session (Claude Code: $CLAUDE_CODE_SESSION_ID; else newest for this directory)")
    .addOption(new Option("--harness <name>", "restrict to one harness").choices(HARNESS_NAMES))
    .option("--leaf <entryId>", "export the branch ending at this entry (tree-shaped sessions)")
    .option("-m, --mode <mode>", `share mode: ${SHARE_MODES.join(" | ")}`, parseMode, defaultMode)
    .option("--secrets-file <file...>", "extra values to redact: KEY=VALUE lines or one value per line");
}

function prepare(arg: string | undefined, opts: SessionOptions): { ref: SessionRef; prepared: PreparedShare } {
  const ref = resolveSession(arg, { current: opts.current, harness: opts.harness });
  const config = loadConfig();
  const raw = readFileSync(ref.path, "utf8");
  const extraKnownSecrets = (opts.secretsFile ?? []).flatMap((f) => readSecretsFile(f, (msg) => console.error(`warning: ${msg}`)));
  const subagentFiles = loadSubagentFiles(ref.harness, ref.path);
  const prepared = prepareShare(raw, { mode: opts.mode, config, harness: ref.harness, leafId: opts.leaf, subagentFiles, extraKnownSecrets });
  return { ref, prepared };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const program = new Command();
program
  .name("agent-share")
  .description("Share coding-agent session transcripts with redaction, share modes and a static viewer")
  .version(TOOL_VERSION)
  .addHelpText(
    "after",
    `
Redaction reads secret-looking environment variables and the session project's .env files by default.
Credential files (pi/Claude/Codex auth, gh hosts.yml, ~/.npmrc, ~/.netrc) and \`gh auth token\` are opt-in:
set redact.knownSources.credentialFiles / .ghToken to true in ~/.config/agent-share/config.json (or $AGENT_SHARE_CONFIG). 'agent-share report' shows which
sources were read. Use --secrets-file for values you know are sensitive. See README: "What this tool reads and why".`,
  );

program
  .command("list")
  .description("list recent sessions")
  .addOption(new Option("--harness <name>", "only one harness").choices(HARNESS_NAMES))
  .option("-n, --limit <n>", "number of sessions", (v) => Number.parseInt(v, 10), 15)
  .action((opts: { harness?: HarnessName; limit: number }) => {
    const roots = defaultRoots();
    const harnesses: HarnessName[] = opts.harness ? [opts.harness] : HARNESS_NAMES;
    const refs = harnesses.flatMap((h) => listSessions(h, roots)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, opts.limit);
    for (const r of refs) {
      const when = new Date(r.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
      const dir = r.path.split("/").at(-2) ?? "";
      console.log(`${when}  ${r.harness.padEnd(11)}  ${r.id.slice(0, 8)}  ${formatBytes(r.size).padStart(8)}  ${dir}`);
    }
  });

program
  .command("browse")
  .description("browse, search and share local sessions interactively (press ? for keys)")
  .addOption(new Option("--harness <name>", "start filtered to one harness").choices(HARNESS_NAMES))
  .option("-q, --query <text>", "start with this search (e.g. 'harness:pi since:7d refactor')")
  .action(async (opts: { harness?: HarnessName; query?: string }) => {
    // Loaded on demand: the TUI stack is not needed by any other command.
    const { runBrowse } = await import("./browse/index.js");
    runBrowse({ config: loadConfig(), harness: opts.harness, query: opts.query });
  });

withSessionOptions(program.command("report"), "brief")
  .description("show what would be shared and redacted (writes nothing)")
  .option("--json", "machine-readable report")
  .option("--all-findings", "list every finding")
  .action((arg: string | undefined, opts: SessionOptions & { json?: boolean; allFindings?: boolean }) => {
    const { ref, prepared } = prepare(arg, opts);
    if (opts.json) console.log(JSON.stringify({ path: ref.path, ...prepared.report }, null, 2));
    else console.log(formatReport(prepared.report, { color: !!process.stdout.isTTY && !process.env.NO_COLOR, maxFindings: opts.allFindings ? Infinity : 25, transcriptPath: ref.path }));
    process.exitCode = prepared.report.blocked ? EXIT.blocked : prepared.report.clean ? EXIT.ok : EXIT.needsReview;
  });

withSessionOptions(program.command("export"), "full")
  .description("write the redacted, normalized share JSON locally")
  .requiredOption("-o, --output <file>", "output file")
  .option("-q, --quiet", "do not print the report")
  .action((arg: string | undefined, opts: SessionOptions & { output: string; quiet?: boolean }) => {
    const { ref, prepared } = prepare(arg, opts);
    if (!opts.quiet) console.error(formatReport(prepared.report, { color: !!process.stderr.isTTY && !process.env.NO_COLOR, transcriptPath: ref.path }));
    writeFileSync(opts.output, prepared.json, { mode: 0o600 });
    console.error(`\nWrote ${opts.output} (${formatBytes(prepared.report.bytes)})`);
  });

const parseTarget = (value: string): ShareTarget => {
  if (!(SHARE_TARGETS as readonly string[]).includes(value)) throw new InvalidArgumentError(`expected one of ${SHARE_TARGETS.join(", ")}`);
  return value as ShareTarget;
};

withSessionOptions(program.command("publish"), "brief")
  .description("redact, review and publish a session (secret gist or public R2 bucket)")
  .option("-t, --target <target>", "where to store the share: gist | r2 (default from config)", parseTarget)
  .option("-y, --yes", "skip confirmation when the report is clean")
  .option("--allow-findings", "with --yes: publish even though secrets were redacted (only after reviewing the report)")
  .option("--allow-suspicious", "with --yes: publish even though suspicious values are still in the payload (only after inspecting them in the transcript)")
  .option("--json", "print the publish result as JSON")
  .action(
    async (arg: string | undefined, opts: SessionOptions & { target?: ShareTarget; yes?: boolean; allowFindings?: boolean; allowSuspicious?: boolean; json?: boolean }) => {
      const config = loadConfig();
      const target = opts.target ?? config.target;
      // Fail on missing target configuration before doing any work.
      const publisher = createPublisher(config, target);
      const warnings = preflightWarnings(config, target);
      for (const w of warnings) console.error(`warning: ${w}`);
      const { ref, prepared } = prepare(arg, opts);
      const { report } = prepared;
      console.error(formatReport(report, { color: !!process.stderr.isTTY && !process.env.NO_COLOR, transcriptPath: ref.path }));
      if (report.blocked) {
        console.error("\nRefusing to publish: the final re-scan found unredacted secrets.");
        process.exitCode = EXIT.blocked;
        return;
      }
      // Two independent gates for --yes: redacted secrets (safe in the payload) and suspicious values (still in it).
      const redactedSecrets = [...SECRET_CATEGORIES].some((c) => (report.counts[c] ?? 0) > 0);
      const suspicious = report.suspicious.length > 0;
      const autoOk = opts.yes && (!redactedSecrets || opts.allowFindings) && (!suspicious || opts.allowSuspicious);
      if (!autoOk) {
        if (opts.yes && redactedSecrets && !opts.allowFindings) console.error("\n--yes only applies to clean reports (add --allow-findings after reviewing).");
        if (opts.yes && suspicious && !opts.allowSuspicious) {
          console.error(`\n--yes does not cover suspicious values that are still in the payload. Inspect ${stripControls(ref.path)} at the locations listed above, then allowlist what is fine or add --allow-suspicious.`);
        }
        if (!process.stdin.isTTY) {
          console.error("Not publishing: review the report and re-run interactively or with --yes.");
          process.exitCode = report.clean ? EXIT.declined : EXIT.needsReview;
          return;
        }
        const where = target === "gist" ? "a secret (unlisted) gist" : "the public R2 bucket (unlisted id)";
        const question = suspicious
          ? `\n${plural(report.suspicious.length, "suspicious value")} may be a secret and ${report.suspicious.length === 1 ? "is" : "are"} still in the payload. Have you inspected ${report.suspicious.length === 1 ? "it" : "them"}? Publish ${formatBytes(report.bytes)} to ${where} anyway? [y/N] `
          : `\nPublish ${formatBytes(report.bytes)} to ${where}? [y/N] `;
        const ok = await confirm(question);
        if (!ok) {
          console.error("Not published.");
          process.exitCode = EXIT.declined;
          return;
        }
      }
      const { result, warnings: postWarnings } = await publishPrepared(publisher, config, target, prepared);
      // Always on stderr (also in --json mode) so wrappers and humans both see them.
      for (const w of postWarnings) console.error(`warning: ${w}`);
      warnings.push(...postWarnings);
      if (opts.json) {
        console.log(JSON.stringify({ ...result, warnings }, null, 2));
      } else {
        console.log(`\nShared: ${result.viewerUrl}`);
        console.log(`${target === "gist" ? "Gist:  " : "Data:  "} ${result.url}`);
        console.log(`Local viewer: agent-share serve --open-hash '${result.viewerUrl.split("#")[1] ?? ""}'`);
      }
    },
  );

program
  .command("delete")
  .description("delete a published share (viewer link, gist URL, r2:<id>, or id)")
  .argument("<share>", "share link or id")
  .option("-t, --target <target>", "target for a bare id that is not a gist id", parseTarget)
  .option("-y, --yes", "do not ask for confirmation")
  .action(async (input: string, opts: { target?: ShareTarget; yes?: boolean }) => {
    const config = loadConfig();
    const ref = parseShareRef(input, opts.target ?? config.target, config.r2);
    if (!opts.yes) {
      if (!process.stdin.isTTY) throw new Error("Refusing to delete without confirmation; pass --yes");
      if (!(await confirm(`Delete ${ref.target} share ${ref.id}? [y/N] `))) {
        console.error("Not deleted.");
        process.exitCode = EXIT.declined;
        return;
      }
    }
    await createPublisher(config, ref.target).delete(ref.id);
    // Only after the remote delete succeeded; the browser's ✓ must not outlive the share.
    if (!forgetShare(ref)) console.error("warning: could not update shares.json, so the browser may still mark this session as shared");
    console.log(`Deleted ${ref.target} share ${ref.id}.${ref.target === "r2" ? " Edge caches may serve it for up to 5 more minutes." : ""}`);
  });

const rel = (p: string) => relative(process.cwd(), p) || ".";

program
  .command("fixtures")
  .description("generate realistic fake Claude Code + pi sessions (with planted fake secrets) for testing")
  .option("-o, --out <dir>", "output directory", "fixtures-out")
  .option("-s, --seed <n>", "random seed (same seed → same output)", (v) => Number.parseInt(v, 10), 1)
  .option("--turns <n>", "extra generic work turns to append (bigger sessions)", (v) => Number.parseInt(v, 10), 0)
  .option("--home <dir>", "home directory used inside transcripts (default: yours, so home-path redaction applies)")
  .option("--user <name>", "username used inside transcripts (default: yours)")
  .option("--no-shares", "only write transcripts; skip exporting share JSON for the viewer")
  .action((opts: { out: string; seed: number; turns: number; home?: string; user?: string; shares: boolean }) => {
    const fx = generateFixtures({ outDir: opts.out, seed: opts.seed, extraTurns: opts.turns, home: opts.home, username: opts.user });
    console.log(`Transcripts (seed ${opts.seed}):\n  claude-code  ${rel(fx.claudeFile)}\n  pi           ${rel(fx.piFile)}`);
    console.log(`Planted fake secrets: ${fx.secrets.length} → ${rel(fx.secretsFile)}`);
    if (opts.shares) {
      console.log("\nShares (redacted with the secrets file):");
      for (const r of exportFixtureShares(fx, opts.out, loadConfig())) {
        console.log(`  ${rel(r.file).padEnd(44)} ${formatBytes(r.bytes).padStart(9)}  ${r.status}`);
      }
      console.log(`\nView them:   agent-share serve ${rel(join(opts.out, "shares"))}/*.json   (or: agent-share demo)`);
    }
    console.log(`Try the CLI: AGENT_SHARE_CLAUDE_PROJECTS=${rel(fx.roots["claude-code"])} AGENT_SHARE_PI_SESSIONS=${rel(fx.roots.pi)} agent-share list`);
    console.log(`             agent-share report ${rel(fx.claudeFile)} --mode full --secrets-file ${rel(fx.secretsFile)}`);
  });

program
  .command("demo")
  .description("generate fake sessions and open them in the local viewer (nothing is uploaded)")
  .option("-o, --out <dir>", "output directory for the generated fixtures", "fixtures-out")
  .option("-s, --seed <n>", "random seed", (v) => Number.parseInt(v, 10), 1)
  .option("--turns <n>", "extra generic work turns (bigger sessions)", (v) => Number.parseInt(v, 10), 0)
  .option("-p, --port <port>", "port", (v) => Number.parseInt(v, 10), 3000)
  .option("--host <host>", "bind address (0.0.0.0 to expose on your network)", DEFAULT_HOST)
  .action(async (opts: { out: string; seed: number; turns: number; port: number; host: string }) => {
    const fx = generateFixtures({ outDir: opts.out, seed: opts.seed, extraTurns: opts.turns });
    const files = exportFixtureShares(fx, opts.out, loadConfig()).map((r) => r.file);
    const { url, port } = await startViewerServer({ port: opts.port, files, host: opts.host });
    if (port !== opts.port) console.log(`Port ${opts.port} is in use; using ${port} instead.`);
    console.log(`Generated fake Claude Code + pi sessions (seed ${opts.seed}) in ${rel(opts.out)} — nothing is uploaded.\n`);
    console.log(`All sessions:  ${url}`);
    console.log(`Claude Code:   ${url}#local:claude-code-full.json`);
    console.log(`pi:            ${url}#local:pi-full.json`);
    console.log("\nCtrl-C to stop.");
  });

program
  .command("serve")
  .description("serve the viewer locally (optionally with local share files)")
  .argument("[files...]", "share JSON files to expose as #local:<name>")
  .option("-p, --port <port>", "port", (v) => Number.parseInt(v, 10), 3000)
  .option("--host <host>", "bind address (0.0.0.0 to expose on your network)", DEFAULT_HOST)
  .option("--strict-port", "fail if the port is in use instead of trying the next one")
  .option("--open-hash <hash>", "print a URL for this hash (e.g. owner/gistId)")
  .action(async (files: string[], opts: { port: number; host: string; strictPort?: boolean; openHash?: string }) => {
    const { url, port, localNames } = await startViewerServer({ port: opts.port, files, host: opts.host, strictPort: opts.strictPort });
    if (port !== opts.port) console.log(`Port ${opts.port} is in use; using ${port} instead.`);
    console.log(`Viewer: ${url}${localNames.length ? "  (lists the local files)" : ""}`);
    for (const name of localNames) console.log(`  ${url}#local:${name}`);
    if (opts.openHash) console.log(`  ${url}#${opts.openHash}`);
    console.log("Ctrl-C to stop.");
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`agent-share: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = err instanceof PromptsUnavailableError ? EXIT.blocked : EXIT.error;
});
