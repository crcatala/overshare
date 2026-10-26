/**
 * `overshare archive`: redacted sessions as markdown files on this machine.
 *
 * Each session goes through `prepareShare` exactly as for publishing, and the projected, redacted session is rendered
 * by `renderMarkdown`. Nothing waits for a confirmation: redacted secrets and suspicious values are written and listed
 * in the run summary, and only a session the final re-scan blocked is held back (unless forced).
 *
 * A file is `<project>/<start date>_<harness>_<project>_<id8>.md`, the project being the repository the session ran in
 * (a worktree's main checkout, see `sessions/repo.ts`). Its frontmatter records the session file's mtime and size and
 * the options it was rendered with, so a later run skips it before parsing anything when none of them changed.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir, hostname as osHostname, userInfo } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { OvershareConfig } from "./config.js";
import { plural } from "./format.js";
import { renderMarkdown, type FrontmatterValue } from "./markdown.js";
import type { PreparedShare } from "./pipeline.js";
import { Redactor, SECRET_CATEGORIES } from "./redact/index.js";
import type { SuspiciousItem } from "./redact/rescan.js";
import { formatSourceLines } from "./redact/source-lines.js";
import type { SessionRef } from "./resolve.js";
import { stripControls } from "./sanitize.js";
import type { ShareMode } from "./schema.js";
import { writePrivateFile } from "./sessions/private-files.js";
import { TOOL_VERSION } from "./version.js";

export const ARCHIVE_REPORT = "_archive-report.md";
/** The folder for sessions with no project (no working directory recorded). */
export const NO_PROJECT = "_no-project";
/** The one folder for sessions in throwaway workspaces, which would otherwise each get a folder of their own. */
export const SCRATCH = "_scratch";
/** Bump when where files go or how they are named changes, so every file is rewritten (and moved) on the next run. */
const ARCHIVE_LAYOUT = 3;

/** `$OVERSHARE_ARCHIVE_DIR`, else config `archive.dir`, else `$XDG_DATA_HOME/overshare/archive`. */
export function defaultArchiveDir(config: OvershareConfig, env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  const configured = env.OVERSHARE_ARCHIVE_DIR ?? config.archive?.dir;
  if (configured) return configured.replace(/^~(?=\/|$)/, home);
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "overshare", "archive");
}

export interface ArchiveOptions {
  mode: ShareMode;
  tools: boolean;
  frontmatter: boolean;
  overwrite: boolean;
  force: boolean;
  dryRun: boolean;
  /** `--all`: sessions whose last activity is before this are left out. */
  sinceMs?: number;
  /** `settingsHash` of what else shapes the content; a file made with other settings is rewritten. */
  settings: string;
}

/**
 * A short hash of the inputs besides the session, mode and tools that change what a file holds: the overshare version
 * (redaction rules improve), the archive layout, the redact config, the `--secrets-file` contents, `--leaf` and `--include-system-prompt`.
 * Only the hash is written, never the values. Known values read from the environment and `.env` files are not in it:
 * collecting them for every session would cost the skip its speed; `--overwrite` picks up a new one.
 */
export function settingsHash(config: OvershareConfig, extra: { secretsFiles?: string[]; leaf?: string; includeSystemPrompt?: boolean }): string {
  const input = JSON.stringify([TOOL_VERSION, ARCHIVE_LAYOUT, config.redact, extra.secretsFiles ?? [], extra.leaf ?? null, !!extra.includeSystemPrompt]);
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export type ArchiveStatus = "written" | "updated" | "up-to-date" | "held-back" | "failed";

export interface ArchiveEntry {
  status: ArchiveStatus;
  /** The session file. */
  source: string;
  /** The markdown file (absent when it failed before a name was known). */
  output?: string;
  /** `output` as shown: relative to the archive folder (`<project>/<file>.md`). */
  name?: string;
  /** The file this session had before, when it was moved to a new name (a worktree session now under its repository, say). */
  movedFrom?: string;
  title?: string;
  /** Secrets redacted in the file, and the rules that found them (labels only). */
  secrets: number;
  rules: string[];
  /** Medium-confidence values still in the file. */
  suspicious: SuspiciousItem[];
  /** Final re-scan issues: the reason a session is held back. */
  blocked: number;
  /** `source` redacted with the session's own rules, for the report file. */
  redactedSource?: string;
  error?: string;
}

export interface ArchiveTarget {
  dir: string;
  /** A `.md` path given with `-o` for a single session. */
  file?: string;
}

export interface ArchiveContext {
  target: ArchiveTarget;
  opts: ArchiveOptions;
  config: OvershareConfig;
  prepare: (ref: SessionRef) => PreparedShare;
  now?: Date;
}

/** Archive one session. Errors are returned as a `failed` entry, so a sweep goes on. */
export function archiveSession(ref: SessionRef, ctx: ArchiveContext, existing = existingArchives(ctx.target.dir)): ArchiveEntry | undefined {
  const { opts, target } = ctx;
  const base: ArchiveEntry = { status: "failed", source: ref.path, secrets: 0, rules: [], suspicious: [], blocked: 0 };
  const previous = target.file ?? existing.get(archiveKey(ref.harness, ref.id));
  // A loose file at the top of the archive is from before project folders: never up to date, so it is moved even
  // without frontmatter (whose up-to-date check is only the file's mtime).
  const loose = !target.file && previous !== undefined && dirname(previous) === target.dir;
  if (previous && !loose && !opts.overwrite && existsSync(previous) && upToDate(previous, ref, opts)) return { ...base, status: "up-to-date", output: previous, name: shownName(target, previous) };
  let prepared: PreparedShare;
  try {
    prepared = ctx.prepare(ref);
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
  const { session, report } = prepared;
  // mtime is never earlier than the last entry, so the caller's mtime filter let through every session that can match.
  const ended = session.endedAt ? Date.parse(session.endedAt) : Number.NaN;
  if (opts.sinceMs !== undefined && Number.isFinite(ended) && ended < opts.sinceMs) return undefined;

  // A rewritten file takes the session's current name: one whose project now resolves differently is moved to it. (An
  // up-to-date file is skipped above without parsing anything, so it keeps its name until the session changes.)
  const output = target.file ?? join(target.dir, archiveFileName(prepared, ref));
  const movedFrom = previous && previous !== output && existsSync(previous) ? previous : undefined;
  const rules = [...new Set(report.findings.filter((f) => SECRET_CATEGORIES.has(f.category)).map((f) => f.rule))];
  const entry: ArchiveEntry = {
    ...base,
    output,
    name: shownName(target, output),
    title: session.title,
    secrets: [...SECRET_CATEGORIES].reduce((n, c) => n + (report.counts[c] ?? 0), 0),
    rules,
    suspicious: report.suspicious,
    blocked: report.rescan.length,
    redactedSource: prepared.redactText(ref.path),
  };
  if (report.blocked && !opts.force) return { ...entry, status: "held-back" };

  const status: ArchiveStatus = existsSync(output) || movedFrom ? "updated" : "written";
  const moved = movedFrom && shownName(target, movedFrom);
  if (opts.dryRun) return { ...entry, status, movedFrom: moved };
  const fields = opts.frontmatter ? frontmatterFields(prepared, ref, entry, ctx) : undefined;
  try {
    writePrivateFile(output, renderMarkdown(session, { tools: opts.tools, frontmatter: fields }));
  } catch (err) {
    return { ...entry, status: "failed", error: (err as Error).message };
  }
  if (movedFrom) {
    // Left in place, the old file would keep its old name (perhaps one the denylist now redacts): say so.
    const error = removeOld(movedFrom, target.dir);
    if (error) return { ...entry, status: "failed", movedFrom: moved, error: `wrote the new file, but could not remove ${moved}: ${error}` };
  }
  return { ...entry, status, movedFrom: moved };
}

const shownName = (target: ArchiveTarget, path: string) => (target.file ? basename(path) : relative(target.dir, path));

/** Remove the file a session moved away from, and its project folder once that is empty. Returns why it could not. */
function removeOld(path: string, dir: string): string | undefined {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    return (err as Error).message;
  }
  try {
    if (dirname(path) !== dir) rmdirSync(dirname(path));
  } catch {
    // a folder that still holds files stays
  }
  return undefined;
}

// --- Names ---------------------------------------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Eight characters of the session id that tell sessions apart. From a UUID, wherever it is in the id (a pi session
 * started by a tool can be `<name>-<uuid>`, and the name is shared): a UUIDv7 (pi) starts with a timestamp, so sessions
 * begun within a minute share their first eight, and its last eight are random; other UUIDs (Claude Code's v4) keep
 * their first eight, as `overshare list` shows them. An id with no UUID is used as it is when it fits, else hashed:
 * its first eight could be shared too.
 */
function safeId(id: string): string {
  const uuid = UUID.exec(id);
  if (uuid) return uuid[1] === "7" ? uuid[0].replace(/-/g, "").slice(-8).toLowerCase() : uuid[0].slice(0, 8).toLowerCase();
  const clean = id.replace(/[^A-Za-z0-9-]/g, "");
  if (clean && clean.length <= 8) return clean;
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

const archiveKey = (harness: string, id: string) => `${harness}:${safeId(id)}`;
const NAME = /^(?:\d{4}-\d{2}-\d{2}|undated)_([a-z-]+)_[^_]*_([A-Za-z0-9-]{1,8})\.md$/;

/**
 * Files already in the archive (in its project folders, or loose at the top from before there were any) by harness and
 * short id: a session whose name changes is found under its old one, to be moved rather than copied.
 */
export function existingArchives(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const scan = (folder: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && depth === 0) scan(join(folder, e.name), 1);
      const m = e.isFile() ? NAME.exec(e.name) : null;
      if (m) found.set(`${m[1]}:${m[2]}`, join(folder, e.name));
    }
  };
  scan(dir, 0);
  return found;
}

/**
 * `<project>/<YYYY-MM-DD>_<harness>_<project>_<id8>.md`, relative to the archive folder (`_scratch/` for a scratch
 * folder's sessions, all together). The project is in the file name
 * too, so a file still says where it is from when copied out of its folder. The start date, not the last activity, so a
 * growing session keeps its name.
 */
export function archiveFileName(prepared: PreparedShare, ref: SessionRef): string {
  const { session } = prepared;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(session.startedAt ?? "")?.[0] ?? "undated";
  // The redacted project name: `[user]` and the like come out as plain words.
  const project = (session.project?.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const folder = session.project?.scratch ? SCRATCH : project || NO_PROJECT;
  return join(folder, `${date}_${ref.harness}_${project || folder.slice(1)}_${safeId(ref.id)}.md`);
}

// --- Up-to-date check ------------------------------------------------------------------------------------------------

/** What a file was made from and with, read back from its frontmatter. */
interface Stamp {
  sourceMtime?: string;
  sourceSize?: number;
  mode?: string;
  tools?: boolean;
  settings?: string;
}

const STAMP_BYTES = 16 * 1024;

function readStamp(path: string): Stamp | undefined {
  const fd = openSync(path, "r");
  let head: string;
  try {
    const buf = Buffer.alloc(STAMP_BYTES);
    head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(head)?.[1];
  if (block === undefined) return;
  const value = (key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(block)?.[1];
  const json = (raw: string | undefined) => {
    try {
      return raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  return { sourceMtime: json(value("source_mtime")), sourceSize: json(value("source_size")), mode: json(value("mode")), tools: json(value("tools")), settings: json(value("settings")) };
}

/**
 * The file was made from this version of the session, with these options. Without frontmatter there is no record of
 * either, so the file's own mtime stands in: it is up to date when it is not older than the session file.
 */
function upToDate(path: string, ref: SessionRef, opts: ArchiveOptions): boolean {
  try {
    const stamp = readStamp(path);
    if (!stamp) return !opts.frontmatter && statSync(path).mtimeMs >= ref.mtimeMs;
    return stamp.sourceMtime === new Date(ref.mtimeMs).toISOString() && stamp.sourceSize === ref.size && stamp.mode === opts.mode && stamp.tools === opts.tools && stamp.settings === opts.settings;
  } catch {
    return false;
  }
}

// --- Frontmatter -----------------------------------------------------------------------------------------------------

function frontmatterFields(prepared: PreparedShare, ref: SessionRef, entry: ArchiveEntry, ctx: ArchiveContext): Record<string, FrontmatterValue> {
  const { session } = prepared;
  const { config, opts } = ctx;
  // The session's own fields are redacted already; what comes from this machine goes through the same rules.
  const tokens = session.stats.tokens;
  const cost = session.stats.cost;
  return {
    title: session.title,
    session_id: session.source.sessionId,
    harness: session.harness.name,
    harness_version: session.harness.version,
    mode: opts.mode,
    tools: opts.tools,
    settings: opts.settings,
    project: session.project?.name,
    worktree: session.project?.worktree,
    scratch: session.project?.scratch || undefined,
    cwd: session.project?.cwd,
    branch: session.project?.branch,
    // Left out when hostname redaction is on, rather than written as a placeholder.
    machine: config.redact.hostname ? undefined : prepared.redactText(osHostname()),
    started_at: session.startedAt,
    last_activity_at: session.endedAt ?? new Date(ref.mtimeMs).toISOString(),
    exported_at: (ctx.now ?? new Date()).toISOString(),
    overshare_version: TOOL_VERSION,
    source_path: entry.redactedSource,
    source_mtime: new Date(ref.mtimeMs).toISOString(),
    source_size: ref.size,
    models: session.models.length ? session.models : undefined,
    turns: session.stats.turns,
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_tokens: tokens.cacheRead,
      cache_write_tokens: tokens.cacheWrite,
      cost_usd: cost === undefined ? undefined : Math.round(cost * 10_000) / 10_000,
      cost_estimated: cost === undefined ? undefined : session.stats.costSource === "estimated",
    },
    redactions: { secrets: entry.secrets, suspicious: entry.suspicious.length },
  };
}

/**
 * Home paths, username, emails, (when configured) hostname and the denylist, as redaction replaces them in a share: for
 * paths of sessions that were not prepared (each prepared one has its own `redactText`, with its known values too).
 */
export function personalRedactor(config: OvershareConfig): Redactor {
  return new Redactor({
    denylist: config.redact.denylist,
    homeDir: homedir(),
    username: safeUsername(),
    hostname: osHostname(),
    redactEmails: config.redact.emails,
    redactUsername: config.redact.username,
    redactHostname: config.redact.hostname,
    allowlist: config.redact.allowlist,
  });
}

function safeUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER;
  }
}

// --- Summary ---------------------------------------------------------------------------------------------------------

/** Exit codes, shared with the other commands: 0 ok, 1 an error, 2 suspicious values to review, 3 a session held back. */
export function archiveExitCode(entries: ArchiveEntry[]): number {
  if (entries.some((e) => e.status === "failed")) return 1;
  if (entries.some((e) => e.status === "held-back")) return 3;
  if (entries.some((e) => (e.status === "written" || e.status === "updated") && e.suspicious.length)) return 2;
  return 0;
}

const LABEL: Record<ArchiveStatus, string> = { written: "written", updated: "updated", "up-to-date": "up to date", "held-back": "held back", failed: "failed" };
const DRY_LABEL: Partial<Record<ArchiveStatus, string>> = { written: "would write", updated: "would update" };

const label = (e: ArchiveEntry, dryRun: boolean) => (dryRun ? DRY_LABEL[e.status] : undefined) ?? LABEL[e.status];
const fileOf = (e: ArchiveEntry) => stripControls(e.name ?? (e.output ? basename(e.output) : e.source));

const MAX_RULES = 4;

/** `github-pat, jwt +3 more`: rule names without their confidence, which the summary does not need. */
function ruleList(rules: string[]): string {
  const names = [...new Set(rules.map((r) => stripControls(r).replace(/ \((?:high|medium|low)\)$/, "")))];
  return names.length > MAX_RULES ? `${names.slice(0, MAX_RULES).join(", ")} +${names.length - MAX_RULES} more` : names.join(", ");
}

/** What a file holds, in a few words: `2 secrets redacted (github-pat) · 1 suspicious value`. */
function findingsText(e: ArchiveEntry, dryRun = false): string {
  const parts: string[] = [];
  if (e.secrets) parts.push(`${plural(e.secrets, "secret")} redacted${e.rules.length ? ` (${ruleList(e.rules)})` : ""}`);
  if (e.suspicious.length) parts.push(`${plural(e.suspicious.length, "suspicious value")} left in`);
  if (e.status === "held-back") parts.push(`blocked: the final re-scan found ${plural(e.blocked, "unredacted secret")} (--force writes it anyway)`);
  if (e.movedFrom) parts.push(`${dryRun ? "would move" : "moved"} from ${stripControls(e.movedFrom)}`);
  if (e.error) parts.push(stripControls(e.error).split("\n", 1)[0]!);
  return parts.join(" · ");
}

/** The line printed as a session is done (up-to-date sessions are only counted). */
export function formatEntry(e: ArchiveEntry, dryRun: boolean): string | undefined {
  if (e.status === "up-to-date") return;
  const findings = findingsText(e, dryRun);
  return `  ${label(e, dryRun).padEnd(12)} ${fileOf(e)}${findings ? `  ${findings}` : ""}`;
}

function totals(entries: ArchiveEntry[], dryRun: boolean): string {
  const order: ArchiveStatus[] = ["written", "updated", "up-to-date", "held-back", "failed"];
  const parts = order.map((s) => [s, entries.filter((e) => e.status === s).length] as const).filter(([, n]) => n > 0);
  if (!parts.length) return "No sessions to archive.";
  return `${parts.map(([s, n]) => `${n} ${dryRun ? (DRY_LABEL[s] ?? LABEL[s]) : LABEL[s]}`).join(", ")}.`;
}

function suspiciousLines(e: ArchiveEntry): string[] {
  return e.suspicious.map((i) => `    ? ${stripControls(i.rule)} (${plural(i.length, "char")}${i.occurrences > 1 ? `, ×${i.occurrences}` : ""}) @ ${stripControls(i.location)}${i.source ? ` · ${formatSourceLines(i.source)}` : ""}`);
}

/** The end-of-run summary for the terminal: files needing a look, then the totals. */
export function formatSummary(entries: ArchiveEntry[], target: ArchiveTarget, { dryRun, report }: { dryRun: boolean; report: boolean }): string {
  const lines: string[] = [];
  const review = entries.filter((e) => e.suspicious.length && (e.status === "written" || e.status === "updated"));
  if (review.length) {
    lines.push("", `Review: ${plural(review.length, "file")} still ${review.length === 1 ? "contains" : "contain"} suspicious values (line numbers are of the session file):`);
    for (const e of review) lines.push(`  ${fileOf(e)}`, `    from ${stripControls(e.source)}`, ...suspiciousLines(e));
    lines.push("  A value that is fine can be added to redact.allowlist.");
  }
  lines.push("", `${dryRun ? "Dry run, nothing written: " : ""}${totals(entries, dryRun)}`, `Archive: ${stripControls(target.file ?? target.dir)}`);
  if (report && !dryRun && entries.some((e) => e.status !== "up-to-date")) lines.push(`Report:  ${stripControls(join(target.dir, ARCHIVE_REPORT))}`);
  return lines.join("\n");
}

/**
 * `_archive-report.md`: the last sweep, for reviewing after the terminal output is gone. It sits in the archive with the
 * redacted files, so session paths and errors are redacted (the terminal shows paths as they are, to open them).
 */
export function formatReportFile(entries: ArchiveEntry[], redact: (text: string) => string, now = new Date()): string {
  const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
  const lines = [`# overshare archive report`, "", `Run at ${now.toISOString()} with overshare ${TOOL_VERSION}. ${totals(entries, false)}`, ""];
  const listed = entries.filter((e) => e.status !== "up-to-date");
  if (listed.length) {
    lines.push("| Status | File | Findings |", "|---|---|---|");
    for (const e of listed) lines.push(`| ${LABEL[e.status]} | ${code(fileOf(e))} | ${stripControls(redact(findingsText(e))).replace(/\|/g, "\\|") || "clean"} |`);
  }
  const review = listed.filter((e) => e.suspicious.length && e.status !== "failed");
  if (review.length) {
    lines.push("", "## Suspicious values to review", "", "Line numbers are of the session file.", "");
    for (const e of review) lines.push(`### ${code(fileOf(e))}`, "", `From ${code(stripControls(e.redactedSource ?? redact(e.source)))}`, "", ...suspiciousLines(e).map((l) => `- ${l.trim().replace(/^\? /, "")}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The run summary as JSON (`--json`). */
export function summaryJson(entries: ArchiveEntry[], target: ArchiveTarget, dryRun: boolean): string {
  const count = (s: ArchiveStatus) => entries.filter((e) => e.status === s).length;
  return JSON.stringify(
    {
      archive: target.file ?? target.dir,
      dryRun,
      totals: { written: count("written"), updated: count("updated"), upToDate: count("up-to-date"), heldBack: count("held-back"), failed: count("failed") },
      entries: entries.map((e) => ({ ...e, suspicious: e.suspicious.length, suspiciousItems: e.suspicious })),
    },
    null,
    2,
  );
}
