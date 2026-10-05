/**
 * The work behind `Source.view` and `Source.review`, as pure functions of a transcript file and the config:
 * parse, project, redact, re-scan. It runs on a worker thread (see `runner.ts`) so the browser keeps handling keys
 * and drawing meanwhile; the same code runs inline in tests.
 *
 * Nothing crosses the thread boundary except plain data: the view, the review (rule, length and location, never
 * values) and the payload bytes. Known secrets are collected inside the worker, from the same config and machine,
 * because `SecretValue` cannot be serialized (and must not be). Errors cross as a `SafeError`, never as the
 * original: their messages can quote the transcript (a JSON syntax error includes a snippet of the file).
 */
import { readFileSync } from "node:fs";
import { parseSession, UnrecognizedFormatError } from "../adapters/index.js";
import type { OvershareConfig } from "../config.js";
import { formatDuration, formatSessionCost, formatTokens, plural } from "../format.js";
import { PromptsUnavailableError } from "../modes.js";
import { formatSourceLines, type SourceLines } from "../redact/source-lines.js";
import { capRedacted } from "../cap.js";
import { prepareShare, SUMMARY_MAX, type PreparedShare } from "../pipeline.js";
import type { PublishInput } from "../publish/index.js";
import { stripControls } from "../sanitize.js";
import { totalTokens, type HarnessName, type NormalizedSession, type ShareMode } from "../schema.js";
import { computeStats } from "../stats.js";
import { loadSubagentFiles } from "../subagent-files.js";
import type { SessionView, ShareReview, ViewBlock, ViewItem } from "./source.js";

// ── view ───────────────────────────────────────────────────────────────────────────────

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n… (+${text.length - max} more characters)` : text);
const stripPasteTags = (s: string): string => s.replace(/<\/?pasted_content[^>]*>/g, "").trim();
const firstLine = (text: string): string => stripPasteTags(text).split("\n", 1)[0]!.replace(/\s+/g, " ");
/** The adapters keep summaries and descriptions whole (the share pipeline caps them after redaction); the list shows them as the share will. */
const shown = (text: string): string => capRedacted(text, SUMMARY_MAX);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const EXT_LANG = /\.([A-Za-z0-9]+)$/;

/** The replacements an edit tool call makes: Claude Code's Edit / MultiEdit and pi's `edit` (one pair, or a list of them). */
function editsOf(input: Record<string, unknown>): Array<{ old: string; new: string }> {
  const pair = (e: Record<string, unknown> | undefined) => {
    const o = str(e?.old_string) ?? str(e?.oldText) ?? str(e?.oldString);
    const n = str(e?.new_string) ?? str(e?.newText) ?? str(e?.newString);
    return o !== undefined && n !== undefined ? { old: cap(o, 4_000), new: cap(n, 4_000) } : undefined;
  };
  const list = Array.isArray(input.edits) ? input.edits.map((e) => pair(record(e))) : [pair(input)];
  return list.filter((e): e is { old: string; new: string } => !!e);
}

/**
 * A tool call as formatted pieces: the command as shell, an edit as a diff, a written file as code, anything else as its
 * JSON input; then the result. Which tool is which is decided by name, for both harnesses (`Bash` / `bash`, `Edit` / `edit`).
 */
function toolBlocks(name: string, summary: string, input: unknown, result: { text: string } | undefined, isError: boolean | undefined): ViewBlock[] {
  const args = record(input);
  const path = str(args?.file_path) ?? str(args?.path) ?? str(args?.filePath);
  const blocks: ViewBlock[] = [];
  let quietResult = false;
  const tool = name.toLowerCase();
  const command = str(args?.command) ?? str(args?.cmd);
  const edits = args ? editsOf(args) : [];
  const content = str(args?.content) ?? str(args?.file_text);
  if (tool === "bash" && command) {
    const why = str(args?.description);
    if (why) blocks.push({ type: "text", text: why, style: "dim" });
    blocks.push({ type: "code", text: cap(command, 3_000), lang: "bash" });
  } else if (edits.length > 0 && /edit/.test(tool)) {
    blocks.push({ type: "edit", path, edits });
    quietResult = true;
  } else if (/^(write|create)/.test(tool) && path && content !== undefined) {
    blocks.push({ type: "label", text: path }, { type: "code", text: cap(content, 4_000), lang: EXT_LANG.exec(path)?.[1] });
    quietResult = true;
  } else if (tool === "read" && path) {
    const range = [args?.offset !== undefined && `from line ${String(args.offset)}`, args?.limit !== undefined && `${String(args.limit)} lines`].filter(Boolean).join(", ");
    blocks.push({ type: "label", text: `${path}${range ? `  (${range})` : ""}` });
  } else {
    blocks.push({ type: "text", text: cap(summary, 2_000) });
    if (args && Object.keys(args).length > 0) blocks.push({ type: "label", text: "input" }, { type: "code", text: cap(JSON.stringify(args, null, 2), 3_000), lang: "json" });
  }
  const call = blocks.length;
  if (!result) blocks.push({ type: "text", text: "(no result recorded)", style: "dim" });
  else if (isError) blocks.push({ type: "label", text: "error", style: "error" }, { type: "code", text: cap(result.text, 4_000) });
  else if (quietResult && result.text.length <= 300) blocks.push({ type: "text", text: result.text, style: "dim" });
  else blocks.push({ type: "label", text: "result" }, { type: "code", text: cap(result.text, 4_000), lang: tool === "read" ? EXT_LANG.exec(path ?? "")?.[1] : undefined });
  for (const b of blocks.slice(call)) b.output = true;
  return blocks;
}

export function viewFromSession(session: NormalizedSession): SessionView {
  const stats = computeStats(session);
  const items: ViewItem[] = [];
  session.turns.forEach((t, i) => {
    const turn = i + 1;
    if (t.user) {
      const text = t.user.command ? `${t.user.command.name}${t.user.command.args ? ` ${t.user.command.args}` : ""}` : t.user.text;
      items.push({ kind: "user", turn, label: firstLine(text), body: cap(stripPasteTags(text), 20_000), meta: t.user.command ? "command" : undefined });
    }
    for (const step of t.steps) {
      if (step.kind === "text") {
        items.push({ kind: "assistant", turn, label: firstLine(step.text), body: cap(stripPasteTags(step.text), 20_000), meta: step.model });
      } else if (step.kind === "thinking") {
        items.push({ kind: "thinking", turn, label: `thinking (${plural(step.chars, "char")})`, body: step.text ? cap(step.text, 8_000) : "(thinking text was not stored)" });
      } else if (step.kind === "tool") {
        const input = step.input === undefined ? "" : cap(JSON.stringify(step.input, null, 2), 3_000);
        const result = step.result ? cap(step.result.text, 4_000) : "(no result recorded)";
        items.push({
          kind: "tool",
          turn,
          label: `${step.name}  ${shown(step.summary)}`,
          meta: step.name,
          error: step.isError,
          blocks: toolBlocks(step.name, step.summary, step.input, step.result, step.isError),
          body: `${cap(step.summary, 2_000)}\n\n── input ──\n${input}\n\n── result${step.isError ? " (error)" : ""} ──\n${result}`,
        });
      } else if (step.kind === "subagent") {
        items.push({
          kind: "subagent",
          turn,
          label: `${step.tool}  ${step.agents.join(", ")} ${shown(step.description ?? "")}`.trim(),
          meta: step.tool,
          error: step.isError,
          blocks: [
            ...(step.description ? [{ type: "label", text: "task" } as const, { type: "text", text: cap(step.description, 2_000) } as const] : []),
            { type: "label", text: "result", output: true },
            step.result ? { type: "markdown", text: cap(step.result.text, 4_000), output: true } : { type: "text", text: "(no result recorded)", style: "dim", output: true },
          ],
          body: `${cap(step.description ?? "", 2_000)}\n\n${step.result ? cap(step.result.text, 4_000) : "(no result recorded)"}`,
        });
      } else if (step.kind === "event") {
        items.push({ kind: "event", turn, label: `${step.event}: ${firstLine(step.text)}`, meta: step.event, error: step.event === "error", body: cap([step.text, step.detail].filter(Boolean).join("\n\n"), 6_000) });
      }
    }
  });
  // Transcript text is untrusted: no terminal control sequences may reach the screen.
  for (const it of items) {
    it.label = stripControls(it.label);
    it.body = stripControls(it.body);
    for (const b of it.blocks ?? []) {
      if (b.type === "edit") {
        if (b.path) b.path = stripControls(b.path);
        for (const e of b.edits) (e.old = stripControls(e.old)), (e.new = stripControls(e.new));
      } else b.text = stripControls(b.text);
      if (b.type === "code" && b.lang) b.lang = stripControls(b.lang);
    }
    if (it.meta) it.meta = stripControls(it.meta);
  }
  const duration = session.startedAt && session.endedAt ? Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt)) : session.durationMs;
  return {
    items,
    turns: session.turns.length,
    tools: Object.fromEntries(Object.entries(stats.tools).map(([name, n]) => [stripControls(name), n])),
    stats: {
      cost: formatSessionCost(stats),
      tokens: formatTokens(totalTokens(stats.tokens)),
      duration: duration !== undefined && Number.isFinite(duration) ? formatDuration(duration) : undefined,
      toolCalls: stats.toolCalls,
      subagents: stats.subagents,
      files: stats.files,
    },
  };
}

// ── review ─────────────────────────────────────────────────────────────────────────────

/** The source lines of a finding, for the screen: `lines: "line 42"`, or nothing when the value was not found in the source. */
const linesOf = (source: SourceLines | undefined): { lines?: string } => (source ? { lines: stripControls(formatSourceLines(source)) } : {});

export function summarizeShare(prepared: PreparedShare): ShareReview {
  const { report } = prepared;
  return {
    mode: report.mode,
    clean: report.clean,
    blocked: report.blocked,
    findings: report.findings.map((f) => ({ rule: stripControls(f.rule), where: stripControls(f.where) })),
    issues: report.rescan.map((i) => ({
      rule: stripControls(i.rule),
      ...(i.length !== undefined ? { length: i.length } : {}),
      ...(i.location ? { location: stripControls(i.location) } : {}),
      ...linesOf(i.source),
    })),
    suspicious: report.suspicious.map((i) => ({ rule: stripControls(i.rule), length: i.length, location: stripControls(i.location), occurrences: i.occurrences, ...linesOf(i.source) })),
    knownSources: report.knownSources,
    redactions: Object.values(report.counts).reduce((a, b) => a + b, 0),
    bytes: report.bytes,
  };
}

// ── jobs ───────────────────────────────────────────────────────────────────────────────

export type JobRequest =
  | { kind: "view"; path: string; harness: HarnessName }
  | { kind: "review"; path: string; harness: HarnessName; mode: ShareMode; config: OvershareConfig };

/** The fields of the prepared session that `publishPrepared` uses to name and record an upload. */
export type PublishSession = PublishInput["session"];

export type JobResult =
  | { kind: "view"; view: SessionView }
  | {
      kind: "review";
      review: ShareReview;
      /** The exact UTF-8 bytes of the payload that was scanned: what will be uploaded if the user says yes. */
      payload: Uint8Array;
      session: PublishSession;
    };

/** An error that is safe to show and to send between threads: fixed text, plus counts or an errno code. */
export interface SafeError {
  code: "prompts-unavailable" | "unrecognized-format" | "read-failed" | "internal";
  message: string;
}

export type JobReply = { ok: true; result: JobResult } | { ok: false; error: SafeError };

/**
 * Reduce any error to a `SafeError`. Only errors whose message this code base writes itself keep it
 * (`PromptsUnavailableError`: a count; `UnrecognizedFormatError`: fixed text). A file-system error keeps its errno
 * code but not its message (which holds the path); everything else keeps only its class name.
 */
export function toSafeError(err: unknown): SafeError {
  if (err instanceof PromptsUnavailableError) return { code: "prompts-unavailable", message: err.message };
  if (err instanceof UnrecognizedFormatError) return { code: "unrecognized-format", message: err.message };
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^E[A-Z0-9]{2,20}$/.test(code)) return { code: "read-failed", message: `could not read the session file (${code})` };
  const name = err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "Error";
  return { code: "internal", message: `internal error in the background reader (${name})` };
}

const publishSession = (p: PreparedShare): PublishSession => ({
  title: p.session.title,
  source: { sessionId: p.session.source.sessionId },
  harness: { name: p.session.harness.name },
  mode: p.session.mode,
  stats: { tokens: p.session.stats.tokens },
});

/** Run one job. Throws the original error; callers turn it into a `SafeError` before it leaves this code. */
export function executeJob(req: JobRequest): JobResult {
  const raw = readFileSync(req.path, "utf8");
  // Claude Code keeps subagent transcripts beside the session; the CLI reads them too, so the browser must.
  const subagentFiles = req.harness === "claude-code" ? loadSubagentFiles(req.path) : undefined;
  if (req.kind === "view") return { kind: "view", view: viewFromSession(parseSession(raw, req.harness, { subagentFiles }).session) };
  const prepared = prepareShare(raw, { mode: req.mode, config: req.config, harness: req.harness, subagentFiles });
  return { kind: "review", review: summarizeShare(prepared), payload: new TextEncoder().encode(prepared.json), session: publishSession(prepared) };
}

/** `executeJob` as a reply message: success, or a `SafeError`. */
export function runJob(req: JobRequest): JobReply {
  try {
    return { ok: true, result: executeJob(req) };
  } catch (err) {
    return { ok: false, error: toSafeError(err) };
  }
}
