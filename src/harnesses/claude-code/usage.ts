import { emptyUsage, totalTokens, totalsOf, type ResponseUsage, type SubagentStep, type SubagentTotals, type SubagentUsage, type SubagentUsageStats, type Usage } from "../../schema.js";
import { TurnBuilder, estimateCosts, stripInjectedContext, usageTokens, type SubagentFileInput } from "../shared.js";

/**
 * Claude Code usage records, for the main transcript and for subagent transcripts.
 *
 * Subagents write their own files, `<session>/subagents/agent-<id>.jsonl` with an `agent-<id>.meta.json`
 * beside each. Their model calls are real spend that the main transcript never shows, and the tool result
 * of the launching `Agent` call cannot stand in for it: it reports the subagent's last call only, and is
 * absent when the agent ran in the background (the default since Claude Code 2.1.285). Summed over unique
 * message ids, the files reproduce Claude Code's own `cost-state` (see tests/claude-subagent-fixtures.vitest.ts).
 */

type Entry = Record<string, any>;

export function mapClaudeUsage(u: Entry): Usage {
  const cacheWrite: number = u.cache_creation_input_tokens ?? 0;
  const write1h: unknown = u.cache_creation?.ephemeral_1h_input_tokens;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite,
    reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
    // The 1h rate is 2x the 5m rate, so keep the split when the API reports it. Subagents often write
    // 5m entries while the main session writes 1h, so the split is per call, never per session.
    ...(typeof write1h === "number" && write1h > 0 ? { cacheWrite1h: Math.min(write1h, cacheWrite) } : {}),
  };
}

/**
 * What Claude Code's tool result for an Agent call says about the subagent that is worth keeping: its tool count and
 * wall time. Its `totalTokens` and `usage` describe only the subagent's last model call, so they are not read;
 * the totals come from the subagent's transcript.
 */
export function subagentCountsFrom(details: unknown): SubagentUsage | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const usage: SubagentUsage = {};
  const toolUses = num(d.totalToolUseCount);
  const durationMs = num(d.totalDurationMs);
  if (toolUses !== undefined) usage.toolUses = toolUses;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The id a response is deduplicated by: a message split over several lines repeats its `message.id`. */
export const responseKey = (e: Entry): string | undefined => e.message?.id ?? (typeof e.uuid === "string" ? e.uuid : undefined);

/** One subagent transcript, reduced to numbers plus the final message. */
export interface SubagentRun {
  agentId: string;
  toolUseId?: string;
  /** Set on a subagent that another subagent launched. */
  parentAgentId?: string;
  /** Unique model calls, priced; calls already counted in the main transcript or an earlier file are left out. */
  responses: ResponseUsage[];
  toolUses: number;
  /** First to last line of the file, so a resumed agent includes the time it sat idle. */
  durationMs?: number;
  /** The last message, when it is text (an agent cut off mid-tool has no final answer). */
  finalText?: string;
  /** When that message was written (ms); absent when the file has no timestamps. */
  finalAt?: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function parseLines(raw: string): Entry[] {
  const out: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") out.push(e);
    } catch {
      // A torn line from a file still being written, or junk: skip it.
    }
  }
  return out;
}

/**
 * Read subagent transcripts. A model call counts once: the copy in the main transcript wins
 * (`mainKeys`, as in ccusage), then the earlier file; within a file the repeat with the most tokens
 * wins. That also covers a resumed subagent, which appends to its own file. Files with no usable
 * lines still count as an agent, with no calls.
 *
 * `until` (ms) keeps the export in scope: lines after it, or without a timestamp, are ignored, so work a
 * subagent did after the exported point is neither counted nor summarised.
 */
export function readSubagentRuns(files: readonly SubagentFileInput[], mainKeys: ReadonlySet<string>, until?: number): SubagentRun[] {
  const claimed = new Set(mainKeys);
  const runs: SubagentRun[] = [];
  for (const file of [...files].sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))) {
    const entries = parseLines(file.raw);
    const base = file.fileName.split(/[\\/]/).at(-1) ?? file.fileName;
    const agentId = base.replace(/^agent-/, "").replace(/\.jsonl$/, "");

    const calls = new Map<string, ResponseUsage>();
    const tools = new Set<string>();
    const texts = new Map<string, { text: string[]; tool: boolean; at?: number }>();
    let first: number | undefined;
    let last: number | undefined;
    for (const e of entries) {
      const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
      if (until !== undefined && !(at <= until)) continue;
      if (Number.isFinite(at)) {
        first = first === undefined ? at : Math.min(first, at);
        last = last === undefined ? at : Math.max(last, at);
      }
      const msg = e.message;
      const key = responseKey(e);
      if (e.type !== "assistant" || !msg || !key || claimed.has(key) || msg.model === "<synthetic>") continue;
      const blocks: Entry[] = Array.isArray(msg.content) ? msg.content : [];
      const mine = texts.get(key) ?? { text: [], tool: false };
      texts.set(key, mine);
      if (Number.isFinite(at)) mine.at = Math.max(mine.at ?? at, at);
      for (const b of blocks) {
        if (b?.type === "tool_use") {
          mine.tool = true;
          if (str(b.id)) tools.add(b.id);
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          mine.text.push(b.text);
        }
      }
      if (!msg.usage) continue;
      const usage = mapClaudeUsage(msg.usage);
      const existing = calls.get(key);
      if (!existing) calls.set(key, { id: key, turn: 0, model: str(msg.model), timestamp: typeof e.timestamp === "string" ? e.timestamp : undefined, usage });
      else if (usageTokens(usage) >= usageTokens(existing.usage)) existing.usage = usage;
    }
    for (const key of texts.keys()) claimed.add(key);

    const responses = [...calls.values()];
    estimateCosts(responses);
    const lastMessage = [...texts.values()].at(-1);
    const finalText = lastMessage && !lastMessage.tool ? stripInjectedContext(lastMessage.text.join("\n")) : "";
    runs.push({
      agentId,
      toolUseId: str(file.meta?.toolUseId),
      parentAgentId: str(file.meta?.parentAgentId),
      responses,
      toolUses: tools.size,
      ...(first !== undefined && last !== undefined ? { durationMs: last - first } : {}),
      ...(finalText ? { finalText } : {}),
      ...(finalText && lastMessage?.at !== undefined ? { finalAt: lastMessage.at } : {}),
    });
  }
  return runs;
}

function subagentTotals(runs: readonly SubagentRun[]): SubagentTotals {
  const all = runs.flatMap((r) => r.responses);
  const byModel = new Map<string, ResponseUsage[]>();
  for (const r of all) byModel.set(r.model ?? "unknown", [...(byModel.get(r.model ?? "unknown") ?? []), r]);
  return {
    agents: runs.length,
    ...(totalsOf(all) ?? { responses: 0, tokens: emptyUsage() }),
    byModel: Object.fromEntries([...byModel].map(([model, list]) => [model, totalsOf(list)!])),
  };
}

/** Numbers for one launching step: a total over its agent and any agents it launched in turn. */
function stepUsage(runs: readonly SubagentRun[], toolResult: SubagentUsage | undefined): SubagentUsage {
  const { responses, tokens, cost, costPartial } = subagentTotals(runs);
  const models = [...new Set(runs.flatMap((r) => r.responses.flatMap((c) => (c.model ? [c.model] : []))))];
  const usage: SubagentUsage = {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    ...(tokens.cacheWrite1h ? { cacheWrite1h: tokens.cacheWrite1h } : {}),
    // A lower bound would read as a total here, so an unpriced model leaves the cost out.
    ...(cost !== undefined && !costPartial ? { cost } : {}),
    turns: responses,
    toolUses: runs.reduce((n, r) => n + r.toolUses, 0),
    // The tool result's duration is the launch's own wall time; the file's span is the fallback.
    ...(toolResult?.durationMs !== undefined ? { durationMs: toolResult.durationMs } : runs.some((r) => r.durationMs !== undefined) ? { durationMs: Math.max(...runs.map((r) => r.durationMs ?? 0)) } : {}),
    totalTokens: totalTokens(tokens),
    ...(models.length ? { models } : {}),
    ...(runs.length > 1 ? { nested: runs.length - 1 } : {}),
  };
  return usage;
}

/**
 * Attach each run to the step that launched it (by the launching tool call's id in `meta.json`, else by
 * agent id; a nested agent follows `parentAgentId` up to a launched one) and put file-derived totals and
 * the final message on that step. Returns the session-level numbers, with runs that no step on the
 * exported branch launched kept apart in `unlinked`.
 *
 * A final message becomes a step's summary only when it is known to precede `summaryUntil` (ms); leave that
 * unset to offer no file-derived summaries, which is what an export of a cut branch does.
 */
export function linkSubagentRuns(b: TurnBuilder, runs: readonly SubagentRun[], opts: { summaryUntil?: number } = {}): SubagentUsageStats | undefined {
  if (runs.length === 0) return undefined;
  const byAgent = new Map(runs.map((r) => [r.agentId, r]));
  const launched = (run: SubagentRun): SubagentStep | undefined => b.findSubagent(run.toolUseId, run.agentId);
  const stepOf = (run: SubagentRun): SubagentStep | undefined => {
    const seen = new Set<SubagentRun>();
    for (let cur: SubagentRun | undefined = run; cur && !seen.has(cur); cur = cur.parentAgentId ? byAgent.get(cur.parentAgentId) : undefined) {
      seen.add(cur);
      const step = launched(cur);
      if (step) return step;
    }
    return undefined;
  };

  const linked = new Map<SubagentStep, SubagentRun[]>();
  const unlinked: SubagentRun[] = [];
  for (const run of runs) {
    const step = stepOf(run);
    if (step) linked.set(step, [...(linked.get(step) ?? []), run]);
    else unlinked.push(run);
  }
  for (const [step, group] of linked) {
    step.usage = stepUsage(group, step.usage);
    const root = group.find((r) => launched(r) === step);
    if (root?.finalText && opts.summaryUntil !== undefined && root.finalAt !== undefined && root.finalAt <= opts.summaryUntil) b.setSubagentSummary(step, root.finalText);
  }
  return { ...subagentTotals([...linked.values()].flat()), ...(unlinked.length ? { unlinked: subagentTotals(unlinked) } : {}) };
}
