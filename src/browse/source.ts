/**
 * What the browser reads and does, behind one interface so the UI can be tested without a disk, a network
 * or the redaction pipeline.
 *
 *   view     the session as a local message list (parse only, unredacted: it is the user's own machine)
 *   review   the real publish pipeline for one share mode: redaction findings, final re-scan, payload size
 *   publish  upload exactly what `review` showed (cached), then remember it in shares.json
 */
import { readFileSync } from "node:fs";
import { parseSession } from "../adapters/index.js";
import type { AgentShareConfig, ShareTarget } from "../config.js";
import { formatDuration, formatSessionCost, formatTokens, plural } from "../format.js";
import { prepareShare, type PreparedShare } from "../pipeline.js";
import { createPublisher, preflightWarnings, publishPrepared } from "../publish/index.js";
import type { Publisher } from "../publish/types.js";
import { totalTokens, type NormalizedSession, type ShareMode } from "../schema.js";
import { shareKey, type SharesFile, loadShares } from "../sessions/shares.js";
import type { SessionSummary } from "../sessions/summary.js";
import { computeStats } from "../stats.js";

export type ViewKind = "user" | "assistant" | "tool" | "thinking" | "subagent" | "event";

/** One row of the viewer's message list, with its full content for the right pane. */
export interface ViewItem {
  kind: ViewKind;
  /** 1-based turn number (a turn starts at a user prompt). */
  turn: number;
  /** One line for the list. */
  label: string;
  /** Full content (truncated for huge tool input/output). */
  body: string;
  /** Short qualifier for the content title: tool name, event kind, model. */
  meta?: string;
  error?: boolean;
}

export interface SessionStatsLine {
  cost?: string;
  tokens: string;
  duration?: string;
  toolCalls: number;
  subagents: number;
  files: { read: number; edited: number; written: number };
}

export interface SessionView {
  items: ViewItem[];
  turns: number;
  /** Tool call counts by name (includes subagent tools). */
  tools: Record<string, number>;
  stats: SessionStatsLine;
}

export interface ShareSummary {
  mode: ShareMode;
  clean: boolean;
  /** The final re-scan found unredacted secrets: publishing must be refused. */
  blocked: boolean;
  findings: Array<{ rule: string; where: string; context: string }>;
  redactions: number;
  bytes: number;
}

export interface Preflight {
  /** Publishing cannot work at all (e.g. missing R2 credentials). */
  error?: string;
  warnings: string[];
}

export interface Source {
  sessions: SessionSummary[];
  /** Live view of shares.json; updated after a successful publish. */
  shares: SharesFile;
  /** Where a publish will go, for confirmation text. */
  destination: string;
  view(s: SessionSummary): SessionView;
  /** May throw (e.g. `PromptsUnavailableError` for legacy pi sessions in prompts mode). */
  review(s: SessionSummary, mode: ShareMode): ShareSummary;
  preflight(): Preflight;
  publish(s: SessionSummary, mode: ShareMode): Promise<{ url: string; warnings: string[] }>;
}

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
  const duration = session.startedAt && session.endedAt ? Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt)) : session.durationMs;
  return {
    items,
    turns: session.turns.length,
    tools: stats.tools,
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

export function loadView(s: Pick<SessionSummary, "path" | "harness">): SessionView {
  return viewFromSession(parseSession(readFileSync(s.path, "utf8"), s.harness).session);
}

// ── review / publish ───────────────────────────────────────────────────────────────────

export function summarizeShare(prepared: PreparedShare): ShareSummary {
  const { report } = prepared;
  return {
    mode: report.mode,
    clean: report.clean,
    blocked: report.blocked,
    findings: report.findings.map((f) => ({ rule: f.rule, where: f.where, context: f.context })),
    redactions: Object.values(report.counts).reduce((a, b) => a + b, 0),
    bytes: report.bytes,
  };
}

export const destinationLabel = (target: ShareTarget): string => (target === "gist" ? "a secret (unlisted) gist" : "the public R2 bucket (unlisted id)");

export interface SourceOptions {
  config: AgentShareConfig;
  sessions: SessionSummary[];
  target?: ShareTarget;
  /** Keep this many reviewed payloads so the publish sends exactly what was reviewed. */
  keepPrepared?: number;
  /** Publisher factory, injectable for tests. */
  publisher?: (config: AgentShareConfig, target: ShareTarget) => Publisher;
}

export function createSource(opts: SourceOptions): Source {
  const { config, sessions } = opts;
  const target = opts.target ?? config.target;
  const shares = loadShares();
  const prepared = new Map<string, PreparedShare>();
  const keep = opts.keepPrepared ?? 4;
  const makePublisher = opts.publisher ?? createPublisher;

  const key = (s: SessionSummary, mode: ShareMode) => `${s.path}|${s.mtimeMs}|${s.size}|${mode}`;
  const prepare = (s: SessionSummary, mode: ShareMode): PreparedShare => {
    const k = key(s, mode);
    const hit = prepared.get(k);
    if (hit) return hit;
    const fresh = prepareShare(readFileSync(s.path, "utf8"), { mode, config, harness: s.harness });
    prepared.set(k, fresh);
    while (prepared.size > keep) prepared.delete(prepared.keys().next().value!);
    return fresh;
  };

  return {
    sessions,
    shares,
    destination: destinationLabel(target),
    view: loadView,
    review: (s, mode) => summarizeShare(prepare(s, mode)),
    preflight() {
      const warnings = preflightWarnings(config, target);
      try {
        makePublisher(config, target);
        return { warnings };
      } catch (err) {
        return { error: (err as Error).message, warnings };
      }
    },
    async publish(s, mode) {
      const share = prepare(s, mode);
      if (share.report.blocked) throw new Error("Refusing to publish: the final re-scan found unredacted secrets.");
      const publisher = makePublisher(config, target);
      const { result, warnings } = await publishPrepared(publisher, config, target, share);
      prepared.delete(key(s, mode));
      // Mirror shares.json in memory so the list marks it as shared right away.
      const fresh = loadShares();
      for (const k of Object.keys(shares)) delete shares[k];
      Object.assign(shares, fresh);
      const k = shareKey(s.harness, s.id);
      if (!(shares[k] ?? []).some((r) => r.url === result.viewerUrl)) (shares[k] ??= []).push({ url: result.viewerUrl, mode, target, sharedAt: new Date().toISOString() });
      return { url: result.viewerUrl, warnings };
    },
  };
}
