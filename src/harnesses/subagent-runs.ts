/**
 * Subagents that write their own transcripts (Claude Code's `subagents/agent-*.jsonl`, Codex's child rollouts), reduced
 * to numbers and a final message, and linked to the steps that launched them. Each harness reads its own files into
 * `SubagentRun`s; linking and the totals are the same for all.
 */
import { emptyUsage, totalTokens, totalsOf, type ResponseUsage, type SubagentStep, type SubagentTotals, type SubagentUsage, type SubagentUsageStats } from "../schema.js";
import type { TurnBuilder } from "./shared.js";

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
