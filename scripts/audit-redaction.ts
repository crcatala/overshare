/**
 * Local audit of redaction: what a change to `src/` does to every Claude Code and pi session on this machine (not run
 * in CI: it needs your own sessions).
 *
 *   npm run audit:redaction -- --base main [--mode brief|full] [--limit 50] [--shape <file>|changed] [--out <dir>]
 *   npm run audit:redaction -- --from out/audit-redaction       # compare saved results again, without rerunning
 *
 * - `prepareShare` runs in brief and full mode over every session, once with the base ref's `src/` and once with the
 *   working tree's. The base is checked out in a temporary git worktree with this checkout's `node_modules` linked in, and
 *   both sides are run by this script (each in its own process), so only `src/` differs.
 * - No known values are read (env, `.env`, credential files) and the config is the default: what changes is what the
 *   pattern, path and email layers do. Only statuses, rule names, counts and times are recorded and printed, never a
 *   value or the text around one. Sessions are named by file.
 * - Each side's results are saved as JSON (`out/audit-redaction/` by default, which git ignores).
 * - Session files are read up to their size when the audit started, on both sides, so the one being written while it
 *   runs (this session, say) is compared on the same text. Sessions that changed on disk meanwhile are labelled.
 * - `--shape <file>` (repeatable; `changed` for every session whose findings changed) describes each pattern match the
 *   working tree finds in that transcript and the base does not, by shape only: rule, key name when it is a plain word,
 *   length, lines, character classes, entropy, whether its quotes were escaped, whether it starts with a placeholder word.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { HARNESS_NAMES, loadSubagentFiles } from "../src/harnesses/index.ts";
import type { HarnessName } from "../src/harnesses/index.ts";
import type { PrepareOptions, PreparedShare } from "../src/pipeline.ts";
import type { PatternMatch } from "../src/redact/patterns.ts";
import { defaultRoots, listSessions } from "../src/resolve.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = resolve(SCRIPT, "../..");
const MODES = ["brief", "full"] as const;
type Mode = (typeof MODES)[number];

/** As `ovs report` puts it: clean, needs review (redacted), needs confirmation (suspicious left), blocked (re-scan). */
export type Status = "clean" | "review" | "confirm" | "blocked" | "error";

export interface ModeResult {
  status: Status;
  ms: number;
  /** Findings by rule, as the report names them (`github-pat (high)`). */
  rules: Record<string, number>;
  /** Rules of what the final re-scan blocks on and of the suspicious values left. */
  rescan: string[];
  suspicious: string[];
  /** The error's class name; its message can quote the transcript, so it is never kept. */
  error?: string;
}

export interface SessionEntry {
  harness: HarnessName;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface Manifest {
  base: string;
  sha: string;
  modes: Mode[];
  sessions: SessionEntry[];
  /** Sessions whose file changed on disk while the audit ran (compared on the text they had when it started). */
  live: string[];
}

export interface SideResults {
  label: string;
  time: Partial<Record<Mode, number>>;
  sessions: Record<string, Partial<Record<Mode, ModeResult>>>;
}

/** The file as it was when the audit started: its first `size` bytes, up to the last complete line. */
export function readSnapshot(path: string, size: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    const text = buf.subarray(0, n).toString("utf8");
    if (n === statSync(path).size) return text;
    const cut = text.lastIndexOf("\n");
    return cut < 0 ? "" : text.slice(0, cut + 1);
  } finally {
    closeSync(fd);
  }
}

type Pipeline = { prepareShare: (raw: string, opts: PrepareOptions) => PreparedShare };

function statusOf(report: PreparedShare["report"]): Status {
  if (report.blocked) return "blocked";
  if (report.suspicious.length) return "confirm";
  return report.clean ? "clean" : "review";
}

const tally = (rules: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rules) out[r] = (out[r] ?? 0) + 1;
  return out;
};

/** Run one side: `src` is the root whose `src/` is imported (the base worktree or this checkout). */
export async function runSide(src: string, label: string, manifest: Manifest, progress = false): Promise<SideResults> {
  const { prepareShare } = (await import(pathToFileURL(join(src, "src/pipeline.ts")).href)) as Pipeline;
  const { DEFAULT_CONFIG } = (await import(pathToFileURL(join(src, "src/config.ts")).href)) as typeof import("../src/config.ts");
  const harnesses = (await import(pathToFileURL(join(src, "src/harnesses/index.ts")).href)) as typeof import("../src/harnesses/index.ts");
  const results: SideResults = { label, time: {}, sessions: {} };
  let done = 0;
  for (const s of manifest.sessions) {
    const out: Partial<Record<Mode, ModeResult>> = (results.sessions[s.path] = {});
    let raw: string | undefined;
    let subagentFiles: ReturnType<typeof loadSubagentFiles>;
    let readError: string | undefined;
    try {
      raw = readSnapshot(s.path, s.size);
      subagentFiles = harnesses.loadSubagentFiles(s.harness, s.path);
    } catch (e) {
      readError = errorName(e);
    }
    for (const mode of manifest.modes) {
      const t = performance.now();
      let r: ModeResult;
      try {
        if (raw === undefined) throw Object.assign(new Error(), { name: readError });
        const { report } = prepareShare(raw, { mode, config: DEFAULT_CONFIG, harness: s.harness, subagentFiles, knownSecrets: [] });
        r = {
          status: statusOf(report),
          ms: 0,
          rules: tally(report.findings.map((f) => f.rule)),
          rescan: [...new Set(report.rescan.map((i) => i.rule))].sort(),
          suspicious: [...new Set(report.suspicious.map((i) => i.rule))].sort(),
        };
      } catch (e) {
        r = { status: "error", ms: 0, rules: {}, rescan: [], suspicious: [], error: errorName(e) };
      }
      r.ms = Math.round(performance.now() - t);
      results.time[mode] = (results.time[mode] ?? 0) + r.ms;
      out[mode] = r;
    }
    done += 1;
    if (progress && (done % 50 === 0 || done === manifest.sessions.length)) process.stderr.write(`  ${label}: ${done}/${manifest.sessions.length}\n`);
  }
  return results;
}

const errorName = (e: unknown): string => (e instanceof Error && /^\w{1,40}$/.test(e.name) ? e.name : "Error");

const sameRules = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? 0) === (b[k] ?? 0));
};

/** A path as printed: relative to the working directory when it is inside it. */
const shown = (path: string): string => {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const pct = (a: number, b: number) => (a > 0 ? ` (${b >= a ? "+" : ""}${(((b - a) / a) * 100).toFixed(1)}%)` : "");
const STATUSES: Status[] = ["clean", "review", "confirm", "blocked", "error"];

/** The paths of the sessions whose status or findings differ between the two sides, in any mode. */
export function changedSessions(manifest: Manifest, base: SideResults, head: SideResults): string[] {
  return manifest.sessions
    .map((s) => s.path)
    .filter((p) =>
      manifest.modes.some((m) => {
        const x = base.sessions[p]?.[m];
        const y = head.sessions[p]?.[m];
        return !x || !y || x.status !== y.status || !sameRules(x.rules, y.rules);
      }),
    );
}

/** The comparison as printed. Built from statuses, rule names, counts, times and session paths only. */
export function formatSummary(manifest: Manifest, base: SideResults, head: SideResults): string[] {
  const lines: string[] = [];
  const byHarness = tally(manifest.sessions.map((s) => s.harness));
  lines.push(`Redaction audit: ${base.label} vs ${head.label}`);
  lines.push(`Sessions: ${manifest.sessions.length} (${HARNESS_NAMES.filter((h) => byHarness[h]).map((h) => `${h} ${byHarness[h]}`).join(", ") || "none"})`);
  const n = manifest.live.length;
  if (n) lines.push(`  ${n} changed on disk during the audit; both sides read ${n === 1 ? "it" : "them"} as ${n === 1 ? "it was" : "they were"} when it started`);
  const live = new Set(manifest.live);
  for (const mode of manifest.modes) {
    lines.push("", `${mode}`);
    const counts = (side: SideResults) => tally(manifest.sessions.map((s) => side.sessions[s.path]?.[mode]?.status ?? "error"));
    const cb = counts(base);
    const ch = counts(head);
    lines.push(`  status:      ${STATUSES.filter((st) => cb[st] || ch[st]).map((st) => `${st} ${cb[st] ?? 0} → ${ch[st] ?? 0}`).join(", ")}`);
    const changes: Record<string, number> = {};
    const deltas: Record<string, { delta: number; sessions: number }> = {};
    let fb = 0;
    let fh = 0;
    for (const s of manifest.sessions) {
      const x = base.sessions[s.path]?.[mode];
      const y = head.sessions[s.path]?.[mode];
      if (!x || !y) continue;
      if (x.status !== y.status) changes[`${x.status} → ${y.status}`] = (changes[`${x.status} → ${y.status}`] ?? 0) + 1;
      for (const r of new Set([...Object.keys(x.rules), ...Object.keys(y.rules)])) {
        fb += x.rules[r] ?? 0;
        fh += y.rules[r] ?? 0;
        const d = (y.rules[r] ?? 0) - (x.rules[r] ?? 0);
        if (!d) continue;
        const e = (deltas[r] ??= { delta: 0, sessions: 0 });
        e.delta += d;
        e.sessions += 1;
      }
    }
    const changeText = Object.entries(changes).map(([k, n]) => `${k} ${n}`).join(", ");
    lines.push(`  changes:     ${changeText || "none"}`);
    lines.push(`  findings:    ${fb} → ${fh}`);
    const sorted = Object.entries(deltas).sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta) || a[0].localeCompare(b[0]));
    for (const [rule, d] of sorted) lines.push(`    ${d.delta > 0 ? "+" : ""}${d.delta} ${rule} in ${d.sessions} session${d.sessions === 1 ? "" : "s"}`);
    const tb = base.time[mode] ?? 0;
    const th = head.time[mode] ?? 0;
    const slowest = (side: SideResults) => Math.max(0, ...manifest.sessions.map((s) => side.sessions[s.path]?.[mode]?.ms ?? 0));
    lines.push(`  time:        ${seconds(tb)} → ${seconds(th)}${pct(tb, th)}; slowest session ${seconds(slowest(base))} → ${seconds(slowest(head))}`);
    // A regex that backtracks badly shows up as one session taking far longer, not as the total moving.
    const slower = manifest.sessions
      .map((s) => ({ path: s.path, a: base.sessions[s.path]?.[mode]?.ms ?? 0, b: head.sessions[s.path]?.[mode]?.ms ?? 0 }))
      .filter((t) => t.b - t.a >= 500 && t.b >= t.a * 1.5)
      .sort((x, y) => y.b - y.a - (x.b - x.a))
      .slice(0, 5);
    for (const t of slower) lines.push(`    slower: ${seconds(t.a)} → ${seconds(t.b)}  ${shown(t.path)}`);
    const errors = (side: SideResults) => tally(manifest.sessions.flatMap((s) => side.sessions[s.path]?.[mode]?.error ?? []));
    for (const side of [base, head]) {
      const e = Object.entries(errors(side));
      if (e.length) lines.push(`  errors (${side.label}): ${e.map(([n, c]) => `${n} ${c}`).join(", ")}`);
    }
  }
  const changed = changedSessions(manifest, base, head);
  lines.push("", `Sessions that changed: ${changed.length ? changed.length : "none"}`);
  for (const p of changed) {
    const parts = manifest.modes.flatMap((m) => {
      const x = base.sessions[p]?.[m];
      const y = head.sessions[p]?.[m];
      if (!x || !y) return [`${m}: missing`];
      const rules = [...new Set([...Object.keys(x.rules), ...Object.keys(y.rules)])]
        .map((r) => [r, (y.rules[r] ?? 0) - (x.rules[r] ?? 0)] as const)
        .filter(([, d]) => d)
        .map(([r, d]) => `${d > 0 ? "+" : ""}${d} ${r}`);
      if (x.status === y.status && !rules.length) return [];
      const blocking = y.status === "blocked" ? ` [re-scan: ${y.rescan.join(", ")}]` : "";
      return [`${m}: ${x.status === y.status ? x.status : `${x.status} → ${y.status}`}${blocking}${rules.length ? `; ${rules.join(", ")}` : ""}`];
    });
    lines.push(`  ${live.has(p) ? "(live) " : ""}${shown(p)}`, ...parts.map((t) => `    ${t}`));
  }
  return lines;
}

// --- --shape ---------------------------------------------------------------------------------------------------------

export type Finder = (text: string) => PatternMatch[];

/** A match described without its value: nothing here is a slice of the text. */
export interface Shape {
  rule: string;
  confidence: string;
  /** The key it was assigned to, only when that is a plain word (letters, `_`, `-`; a word with digits could be part of a value). */
  key?: string;
  length: number;
  lines: number;
  classes: string;
  /** Shannon entropy in bits per character, to one decimal. */
  entropy: number;
  escapedQuote: boolean;
  placeholderPrefix: boolean;
  /** The base found something over part of it (a boundary moved) rather than nothing. */
  overlapsBase: boolean;
}

const PLACEHOLDER_WORD = /^(?:null|none|undefined|true|false|string|number|test|example|your|dummy|placeholder|changeme|redacted|xxx)/i;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return Math.round(h * 10) / 10;
}

/** The matches `head` finds in `text` that `base` does not find at the same place, by shape. */
export function newMatchShapes(text: string, base: Finder, head: Finder): Shape[] {
  const old = base(text);
  const spans = new Set(old.map((m) => `${m.start}:${m.end}`));
  return head(text)
    .filter((m) => !spans.has(`${m.start}:${m.end}`))
    .map((m) => {
      const v = text.slice(m.start, m.end);
      const before = text.slice(Math.max(0, m.start - 48), m.start);
      const key = /(?:^|[^\w-])([A-Za-z_][A-Za-z_-]{0,31})\\*["']?\s*[:=]\s*\\*["'`]?$/.exec(before)?.[1];
      const classes = [/[a-z]/.test(v) && "lower", /[A-Z]/.test(v) && "upper", /\d/.test(v) && "digit", /[^A-Za-z0-9\s]/.test(v) && "symbol"].filter(Boolean).join("+");
      return {
        rule: m.rule,
        confidence: m.confidence,
        ...(key ? { key } : {}),
        length: v.length,
        lines: v.split("\n").length,
        classes,
        entropy: entropy(v),
        escapedQuote: /\\["']\s*$/.test(before),
        placeholderPrefix: PLACEHOLDER_WORD.test(v),
        overlapsBase: old.some((o) => o.start < m.end && m.start < o.end),
      };
    });
}

/** Every string value in a JSONL transcript (keys and lines that are not JSON are skipped). */
export function transcriptStrings(raw: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      walk(JSON.parse(line));
    } catch {
      // not a JSON line
    }
  }
  return out;
}

export function formatShape(s: Shape, count: number): string {
  const flags = [s.escapedQuote && "escaped quotes", s.placeholderPrefix && "placeholder-word prefix", s.overlapsBase && "base matched part of it"].filter(Boolean);
  return `    ${s.rule} (${s.confidence})${s.key ? ` key=${s.key}` : ""} length ${s.length}${s.lines > 1 ? `, ${s.lines} lines` : ""}, ${s.classes || "whitespace"}, entropy ${s.entropy}${flags.length ? `, ${flags.join(", ")}` : ""}${count > 1 ? `  ×${count}` : ""}`;
}

/** The shapes of what `head` finds and `base` does not in one session (its transcript and subagent files), deduplicated. */
export function describeSession(entry: SessionEntry, base: Finder, head: Finder): string[] {
  const texts = [readSnapshot(entry.path, entry.size), ...(loadSubagentFiles(entry.harness, entry.path) ?? []).map((f) => f.raw)];
  const seen = new Map<string, { shape: Shape; count: number }>();
  for (const raw of texts) {
    for (const text of transcriptStrings(raw)) {
      for (const shape of newMatchShapes(text, base, head)) {
        const k = JSON.stringify(shape);
        const e = seen.get(k);
        if (e) e.count += 1;
        else seen.set(k, { shape, count: 1 });
      }
    }
  }
  const lines = [...seen.values()].map((e) => formatShape(e.shape, e.count));
  return lines.length ? lines : ["    nothing new from the pattern layer"];
}

// --- CLI -------------------------------------------------------------------------------------------------------------

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** The base ref checked out in a temporary worktree, with this checkout's `node_modules` linked in. */
function addWorktree(sha: string): { dir: string; remove: () => void } {
  const dir = join(mkdtempSync(join(tmpdir(), "ovs-audit-")), "base");
  git("worktree", "add", "--quiet", "--detach", dir, sha);
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
  return {
    dir,
    remove: () => {
      unlinkSync(join(dir, "node_modules"));
      git("worktree", "remove", "--force", dir);
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    },
  };
}

function runSideProcess(src: string, label: string, manifestFile: string, save: string): void {
  // Ctrl-C reaches the side process too; staying alive until it has exited lets the worktree be removed.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--side", src, "--label", label, "--manifest", manifestFile, "--save", save], { cwd: REPO, stdio: "inherit" });
  process.off("SIGINT", ignore);
  if (r.status !== 0) throw new Error(`the ${label} side failed (${r.signal ?? `exit ${r.status}`})`);
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "main" },
      mode: { type: "string" },
      limit: { type: "string" },
      out: { type: "string", default: join(REPO, "out", "audit-redaction") },
      from: { type: "string" },
      shape: { type: "string", multiple: true },
      // Internal: run one side in this process.
      side: { type: "string" },
      label: { type: "string" },
      manifest: { type: "string" },
      save: { type: "string" },
    },
  });

  if (values.side) {
    const manifest = readJson<Manifest>(values.manifest!);
    writeFileSync(values.save!, JSON.stringify(await runSide(values.side, values.label ?? values.side, manifest, true)));
    return;
  }

  if (values.mode && !(MODES as readonly string[]).includes(values.mode)) throw new Error(`--mode must be one of ${MODES.join(", ")}`);
  const dir = resolve(values.from ?? values.out);
  const files = { manifest: join(dir, "manifest.json"), base: join(dir, "base.json"), head: join(dir, "head.json") };
  let worktree: ReturnType<typeof addWorktree> | undefined;
  try {
    let manifest: Manifest;
    if (values.from) {
      if (!existsSync(files.head)) throw new Error(`no saved results in ${dir}`);
      manifest = readJson<Manifest>(files.manifest);
    } else {
      const sha = git("rev-parse", "--verify", `${values.base}^{commit}`);
      const roots = defaultRoots();
      let sessions = HARNESS_NAMES.flatMap((h) => listSessions(h, roots).map((r): SessionEntry => ({ harness: h, path: resolve(r.path), size: r.size, mtimeMs: r.mtimeMs })));
      sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (values.limit !== undefined) {
        const n = Number(values.limit);
        if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive whole number");
        sessions = sessions.slice(0, n);
      }
      manifest = { base: values.base, sha, modes: values.mode ? [values.mode as Mode] : [...MODES], sessions, live: [] };
      mkdirSync(dir, { recursive: true });
      writeFileSync(files.manifest, JSON.stringify(manifest));
      const label = sha.startsWith(values.base) ? sha.slice(0, 7) : `${values.base} (${sha.slice(0, 7)})`;
      process.stderr.write(`Auditing ${sessions.length} session${sessions.length === 1 ? "" : "s"} (${manifest.modes.join(", ")}): ${label}, then the working tree\n`);
      worktree = addWorktree(sha);
      runSideProcess(worktree.dir, label, files.manifest, files.base);
      runSideProcess(REPO, "working tree", files.manifest, files.head);
      manifest.live = sessions
        .filter((s) => {
          try {
            const st = statSync(s.path);
            return st.size !== s.size || st.mtimeMs !== s.mtimeMs;
          } catch {
            return true;
          }
        })
        .map((s) => s.path);
      writeFileSync(files.manifest, JSON.stringify(manifest));
      process.stderr.write(`Results saved in ${shown(dir)} (compare again with --from)\n\n`);
    }
    const base = readJson<SideResults>(files.base);
    const head = readJson<SideResults>(files.head);
    console.log(formatSummary(manifest, base, head).join("\n"));

    if (values.shape?.length) {
      worktree ??= addWorktree(manifest.sha);
      const baseFind = ((await import(pathToFileURL(join(worktree.dir, "src/redact/patterns.ts")).href)) as typeof import("../src/redact/patterns.ts")).findSecretPatterns;
      const { findSecretPatterns: headFind } = await import("../src/redact/patterns.ts");
      const changed = new Set(changedSessions(manifest, base, head));
      const wanted = values.shape.includes("changed") ? [...changed] : [];
      for (const s of values.shape) if (s !== "changed") wanted.push(s);
      console.log(`\nNew pattern matches by shape (working tree, not ${manifest.base}):`);
      if (!wanted.length) console.log("  no sessions changed");
      for (const p of [...new Set(wanted)]) {
        const entry = manifest.sessions.find((s) => resolve(s.path) === resolve(p));
        console.log(`  ${shown(p)}`);
        console.log(entry ? describeSession(entry, (t) => baseFind(t), (t) => headFind(t)).join("\n") : "    not one of the audited sessions");
      }
    }
  } finally {
    worktree?.remove();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  main().catch((e: unknown) => {
    console.error(`audit:redaction: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
