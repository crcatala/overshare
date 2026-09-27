#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { loadConfig } from "./config.js";
import { formatBytes, formatTokens } from "./format.js";
import { prepareShare, type PreparedShare } from "./pipeline.js";
import { GistPublisher } from "./publish/gist.js";
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
    .option("-m, --mode <mode>", "share mode: full | brief | minimal", parseMode, defaultMode);
}

function prepare(arg: string | undefined, opts: SessionOptions): { ref: SessionRef; prepared: PreparedShare } {
  const ref = resolveSession(arg, { current: opts.current, harness: opts.harness });
  const config = loadConfig();
  const raw = readFileSync(ref.path, "utf8");
  const prepared = prepareShare(raw, { mode: opts.mode, config, harness: ref.harness, leafId: opts.leaf });
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

withSessionOptions(program.command("publish"), "brief")
  .description("redact, review and publish a session to a secret gist")
  .option("-y, --yes", "skip confirmation when the report is clean")
  .option("--allow-findings", "with --yes: publish even though secrets were redacted (only after reviewing the report)")
  .option("--json", "print the publish result as JSON")
  .action(async (arg: string | undefined, opts: SessionOptions & { yes?: boolean; allowFindings?: boolean; json?: boolean }) => {
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
      const ok = await confirm(`\nPublish ${formatBytes(report.bytes)} as a secret (unlisted) gist? [y/N] `);
      if (!ok) {
        console.error("Not published.");
        process.exitCode = EXIT.declined;
        return;
      }
    }
    const config = loadConfig();
    const publisher = new GistPublisher({ viewerUrl: config.viewerUrl });
    const s = prepared.session;
    const result = await publisher.publish({
      filename: "session.json",
      content: prepared.json,
      description: `agent-share: ${s.title ?? s.source.sessionId} (${s.harness.name}, ${s.mode}, ${formatTokens(totalTokens(s.stats.tokens))} tokens)`,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nShared: ${result.viewerUrl}`);
      console.log(`Gist:   ${result.url}`);
      console.log(`Local viewer: agent-share serve --open-hash '${result.viewerUrl.split("#")[1] ?? ""}'`);
    }
  });

program
  .command("serve")
  .description("serve the viewer locally (optionally with local share files)")
  .argument("[files...]", "share JSON files to expose as #local:<name>")
  .option("-p, --port <port>", "port", (v) => Number.parseInt(v, 10), 4178)
  .option("--host <host>", "bind address", "127.0.0.1")
  .option("--open-hash <hash>", "print a URL for this hash (e.g. owner/gistId)")
  .action(async (files: string[], opts: { port: number; host: string; openHash?: string }) => {
    const { url, localNames } = await startViewerServer({ port: opts.port, files, host: opts.host });
    console.log(`Viewer: ${url}`);
    for (const name of localNames) console.log(`  ${url}#local:${name}`);
    if (opts.openHash) console.log(`  ${url}#${opts.openHash}`);
    console.log("Ctrl-C to stop.");
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`agent-share: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = EXIT.error;
});
