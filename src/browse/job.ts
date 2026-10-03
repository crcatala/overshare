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
import type { AgentShareConfig } from "../config.js";
import { formatDuration, formatSessionCost, formatTokens, plural } from "../format.js";
import { PromptsUnavailableError } from "../modes.js";
import { prepareShare, type PreparedShare } from "../pipeline.js";
import type { PublishInput } from "../publish/index.js";
import { stripControls } from "../sanitize.js";
import { totalTokens, type HarnessName, type NormalizedSession, type ShareMode } from "../schema.js";
import { computeStats } from "../stats.js";
import { loadSubagentFiles } from "../subagent-files.js";
import type { SessionView, ShareReview, ViewItem } from "./source.js";

// ── view ───────────────────────────────────────────────────────────────────────────────

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n… (+${text.length - max} more characters)` : text);
const stripPasteTags = (s: string): string => s.replace(/<\/?pasted_content[^>]*>/g, "").trim();
const firstLine = (text: string): string => stripPasteTags(text).split("\n", 1)[0]!.replace(/\s+/g, " ");

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
          label: `${step.name}  ${step.summary}`,
          meta: step.name,
          error: step.isError,
          body: `${step.summary}\n\n── input ──\n${input}\n\n── result${step.isError ? " (error)" : ""} ──\n${result}`,
        });
      } else if (step.kind === "subagent") {
        items.push({
          kind: "subagent",
          turn,
          label: `${step.tool}  ${step.agents.join(", ")} ${step.description ?? ""}`.trim(),
          meta: step.tool,
          error: step.isError,
          body: `${step.description ?? ""}\n\n${step.result ? cap(step.result.text, 4_000) : "(no result recorded)"}`,
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

export function summarizeShare(prepared: PreparedShare): ShareReview {
  const { report } = prepared;
  return {
    mode: report.mode,
    clean: report.clean,
    blocked: report.blocked,
    findings: report.findings.map((f) => ({ rule: stripControls(f.rule), where: stripControls(f.where) })),
    suspicious: report.suspicious.map((i) => ({ rule: stripControls(i.rule), length: i.length, location: stripControls(i.location), occurrences: i.occurrences })),
    knownSources: report.knownSources,
    redactions: Object.values(report.counts).reduce((a, b) => a + b, 0),
    bytes: report.bytes,
  };
}

// ── jobs ───────────────────────────────────────────────────────────────────────────────

export type JobRequest =
  | { kind: "view"; path: string; harness: HarnessName }
  | { kind: "review"; path: string; harness: HarnessName; mode: ShareMode; config: AgentShareConfig };

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
