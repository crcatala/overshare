#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { SHARE_TARGETS, loadConfig, type ShareTarget } from "./config.js";
import { generateFixtures } from "./fixtures/index.js";
import { formatBytes, formatTokens } from "./format.js";
import { prepareShare, type PreparedShare } from "./pipeline.js";
import { createPublisher, parseShareRef } from "./publish/index.js";
import { checkPublicAccess } from "./publish/r2.js";
import { readSecretsFile } from "./redact/known-values.js";
import { formatReport } from "./report.js";
import { defaultRoots, listSessions, resolveSession, type SessionRef } from "./resolve.js";
import { SHARE_MODES, totalTokens, type HarnessName, type ShareMode } from "./schema.js";
import { startViewerServer } from "./serve.js";
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
    .addOption(new Option("--harness <name>", "restrict to one harness").choices(["claude-code", "pi"]))
    .option("--leaf <entryId>", "export the branch ending at this entry (tree-shaped sessions)")
    .option("-m, --mode <mode>", "share mode: full | brief | minimal", parseMode, defaultMode)
    .option("--secrets-file <file...>", "extra values to redact: KEY=VALUE lines or one value per line");
}

function prepare(arg: string | undefined, opts: SessionOptions): { ref: SessionRef; prepared: PreparedShare } {
  const ref = resolveSession(arg, { current: opts.current, harness: opts.harness });
  const config = loadConfig();
  const raw = readFileSync(ref.path, "utf8");
  const extraKnownSecrets = (opts.secretsFile ?? []).flatMap((f) => readSecretsFile(f));
  const prepared = prepareShare(raw, { mode: opts.mode, config, harness: ref.harness, leafId: opts.leaf, extraKnownSecrets });
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
  .version(TOOL_VERSION);

program
  .command("list")
  .description("list recent sessions")
  .addOption(new Option("--harness <name>", "only one harness").choices(["claude-code", "pi"]))
  .option("-n, --limit <n>", "number of sessions", (v) => Number.parseInt(v, 10), 15)
  .action((opts: { harness?: HarnessName; limit: number }) => {
    const roots = defaultRoots();
    const harnesses: HarnessName[] = opts.harness ? [opts.harness] : ["claude-code", "pi"];
    const refs = harnesses.flatMap((h) => listSessions(h, roots)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, opts.limit);
    for (const r of refs) {
      const when = new Date(r.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
      const dir = r.path.split("/").at(-2) ?? "";
      console.log(`${when}  ${r.harness.padEnd(11)}  ${r.id.slice(0, 8)}  ${formatBytes(r.size).padStart(8)}  ${dir}`);
    }
  });

withSessionOptions(program.command("report"), "brief")
  .description("show what would be shared and redacted (writes nothing)")
  .option("--json", "machine-readable report")
  .option("--all-findings", "list every finding")
  .action((arg: string | undefined, opts: SessionOptions & { json?: boolean; allFindings?: boolean }) => {
    const { ref, prepared } = prepare(arg, opts);
    if (opts.json) console.log(JSON.stringify({ path: ref.path, ...prepared.report }, null, 2));
    else console.log(formatReport(prepared.report, { color: !!process.stdout.isTTY && !process.env.NO_COLOR, maxFindings: opts.allFindings ? Infinity : 25 }));
    process.exitCode = prepared.report.blocked ? EXIT.blocked : prepared.report.clean ? EXIT.ok : EXIT.needsReview;
  });

withSessionOptions(program.command("export"), "full")
  .description("write the redacted, normalized share JSON locally")
  .requiredOption("-o, --output <file>", "output file")
  .option("-q, --quiet", "do not print the report")
  .action((arg: string | undefined, opts: SessionOptions & { output: string; quiet?: boolean }) => {
    const { prepared } = prepare(arg, opts);
    if (!opts.quiet) console.error(formatReport(prepared.report, { color: !!process.stderr.isTTY && !process.env.NO_COLOR }));
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
  .option("--json", "print the publish result as JSON")
  .action(
    async (arg: string | undefined, opts: SessionOptions & { target?: ShareTarget; yes?: boolean; allowFindings?: boolean; json?: boolean }) => {
      const config = loadConfig();
      const target = opts.target ?? config.target;
      // Fail on missing target configuration before doing any work.
      const publisher = createPublisher(config, target);
      const { prepared } = prepare(arg, opts);
      const { report } = prepared;
      console.error(formatReport(report, { color: !!process.stderr.isTTY && !process.env.NO_COLOR }));
      if (report.blocked) {
        console.error("\nRefusing to publish: the final re-scan found unredacted secrets.");
        process.exitCode = EXIT.blocked;
        return;
      }
      const autoOk = opts.yes && (report.clean || opts.allowFindings);
      if (!autoOk) {
        if (opts.yes && !report.clean) console.error("\n--yes only applies to clean reports (add --allow-findings after reviewing).");
        if (!process.stdin.isTTY) {
          console.error("Not publishing: review the report and re-run interactively or with --yes.");
          process.exitCode = report.clean ? EXIT.declined : EXIT.needsReview;
          return;
        }
        const where = target === "gist" ? "a secret (unlisted) gist" : "the public R2 bucket (unlisted id)";
        const ok = await confirm(`\nPublish ${formatBytes(report.bytes)} to ${where}? [y/N] `);
        if (!ok) {
          console.error("Not published.");
          process.exitCode = EXIT.declined;
          return;
        }
      }
      const s = prepared.session;
      const result = await publisher.publish({
        filename: "session.json",
        content: prepared.json,
        description: `agent-share: ${s.title ?? s.source.sessionId} (${s.harness.name}, ${s.mode}, ${formatTokens(totalTokens(s.stats.tokens))} tokens)`,
      });
      const warnings: string[] = [];
      if (target === "r2" && result.rawUrl) {
        try {
          const check = await checkPublicAccess(result.rawUrl, new URL(config.viewerUrl).origin);
          if (check.status !== 200) warnings.push(`public URL returned ${check.status} — is public access enabled on the bucket, and does r2.publicUrl match it?`);
          else if (!check.cors) warnings.push(`the bucket's CORS policy does not allow ${new URL(config.viewerUrl).origin}; the viewer will not be able to load it (see README "R2 storage")`);
        } catch (err) {
          warnings.push(`could not verify the public URL: ${(err as Error).message}`);
        }
      }
      if (opts.json) {
        console.log(JSON.stringify({ ...result, warnings }, null, 2));
      } else {
        console.log(`\nShared: ${result.viewerUrl}`);
        console.log(`${target === "gist" ? "Gist:  " : "Data:  "} ${result.url}`);
        console.log(`Local viewer: agent-share serve --open-hash '${result.viewerUrl.split("#")[1] ?? ""}'`);
        for (const w of warnings) console.error(`warning: ${w}`);
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
    const ref = parseShareRef(input, opts.target ?? config.target);
    if (!opts.yes) {
      if (!process.stdin.isTTY) throw new Error("Refusing to delete without confirmation; pass --yes");
      if (!(await confirm(`Delete ${ref.target} share ${ref.id}? [y/N] `))) {
        console.error("Not deleted.");
        process.exitCode = EXIT.declined;
        return;
      }
    }
    await createPublisher(config, ref.target).delete(ref.id);
    console.log(`Deleted ${ref.target} share ${ref.id}.${ref.target === "r2" ? " Edge caches may serve it for up to 5 more minutes." : ""}`);
  });

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
    const rel = (p: string) => relative(process.cwd(), p) || ".";
    console.log(`Transcripts (seed ${opts.seed}):\n  claude-code  ${rel(fx.claudeFile)}\n  pi           ${rel(fx.piFile)}`);
    console.log(`Planted fake secrets: ${fx.secrets.length} → ${rel(fx.secretsFile)}`);
    if (opts.shares) {
      const sharesDir = join(opts.out, "shares");
      mkdirSync(sharesDir, { recursive: true });
      const config = loadConfig();
      const extraKnownSecrets = readSecretsFile(fx.secretsFile);
      console.log("\nShares (redacted with the secrets file):");
      for (const [harness, file] of [["claude-code", fx.claudeFile], ["pi", fx.piFile]] as const) {
        for (const mode of SHARE_MODES) {
          const prepared = prepareShare(readFileSync(file, "utf8"), {
            mode,
            config,
            harness,
            knownSecrets: [],
            extraKnownSecrets,
            machine: { homeDir: fx.home, username: fx.username },
          });
          const out = join(sharesDir, `${harness}-${mode}.json`);
          writeFileSync(out, prepared.json);
          const r = prepared.report;
          console.log(`  ${rel(out).padEnd(44)} ${formatBytes(r.bytes).padStart(9)}  ${r.blocked ? "BLOCKED" : r.clean ? "clean" : "needs review"}`);
        }
      }
      console.log(`\nView them:   agent-share serve ${rel(sharesDir)}/*.json`);
    }
    console.log(`Try the CLI: AGENT_SHARE_CLAUDE_PROJECTS=${rel(fx.roots["claude-code"])} AGENT_SHARE_PI_SESSIONS=${rel(fx.roots.pi)} agent-share list`);
    console.log(`             agent-share report ${rel(fx.claudeFile)} --mode full --secrets-file ${rel(fx.secretsFile)}`);
  });

program
  .command("serve")
  .description("serve the viewer locally (optionally with local share files)")
  .argument("[files...]", "share JSON files to expose as #local:<name>")
  .option("-p, --port <port>", "port", (v) => Number.parseInt(v, 10), 3000)
  .option("--host <host>", "bind address (use 127.0.0.1 to restrict to this machine)", "0.0.0.0")
  .option("--strict-port", "fail if the port is in use instead of trying the next one")
  .option("--open-hash <hash>", "print a URL for this hash (e.g. owner/gistId)")
  .action(async (files: string[], opts: { port: number; host: string; strictPort?: boolean; openHash?: string }) => {
    const { url, port, localNames } = await startViewerServer({ port: opts.port, files, host: opts.host, strictPort: opts.strictPort });
    if (port !== opts.port) console.log(`Port ${opts.port} is in use; using ${port} instead.`);
    console.log(`Viewer: ${url}`);
    for (const name of localNames) console.log(`  ${url}#local:${name}`);
    if (opts.openHash) console.log(`  ${url}#${opts.openHash}`);
    console.log("Ctrl-C to stop.");
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`agent-share: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = EXIT.error;
});
