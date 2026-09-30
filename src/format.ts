/** Number/duration formatting shared by the CLI report and the viewer (browser-safe). */
import { totalTokens, type CacheEvent, type CacheSummary, type SessionStats, type UsageTotals } from "./schema.js";

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatCost(usd: number): string {
  return usd >= 100 ? `$${usd.toFixed(0)}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Session cost for display; a trailing "+" marks a lower bound (some calls had no known price). */
export function formatSessionCost(stats: { cost?: number; costPartial?: boolean }): string | undefined {
  return stats.cost === undefined ? undefined : `${formatCost(stats.cost)}${stats.costPartial ? "+" : ""}`;
}

/** Usage kept out of the session totals (other branches, inherited history), as one short line. */
export function formatUsageTotals(t: UsageTotals): string {
  return [plural(t.responses, "call"), `${formatTokens(totalTokens(t.tokens))} tokens`, formatSessionCost(t) ?? ""].filter(Boolean).join(" · ");
}

/** What the cost figure means, and what it leaves out. The first line is a title. */
export function describeCost(stats: SessionStats): string[] {
  const how =
    stats.costSource === "estimated"
      ? "Estimated at API list price from the tokens in this transcript."
      : "Recorded by the agent for each model call, at list price.";
  const lines = ["Estimated cost", how, "Not a bill: subscription plans are not charged per token."];
  if (stats.costPartial) lines.push("Some calls have no cost (a model with no known price, or none recorded), so this is a lower bound.");
  if (stats.costSource === "estimated") lines.push("Can undercount: long-context, fast-mode and regional price surcharges are not modelled.");
  lines.push("Covers the main conversation on the branch shown.");
  // Claude Code subagents are read from their transcripts and shown on their own lines; a launch with no usage (pi) is not counted anywhere.
  if (stats.subagentUsage) lines.push("Subagent usage is not included; it is shown separately.");
  else if (stats.subagents > 0) lines.push("Subagent usage is not included.");
  if (stats.otherBranches) lines.push(`Not included: ${formatUsageTotals(stats.otherBranches)} on other branches.`);
  if (stats.inherited) lines.push(`Not included: ${formatUsageTotals(stats.inherited)} inherited from the parent session.`);
  return lines;
}

/** "~$3.01", with a trailing "+" for a lower bound. */
const approxCost = (usd: number, partial?: boolean): string => `~${formatCost(usd)}${partial ? "+" : ""}`;

/**
 * What a flagged call was, in Claude Code's vocabulary: a miss (with the idle gap when that is the likely
 * cause), or an expected rebuild after compaction / re-cache after a model switch.
 */
export function cacheEventLabel(e: CacheEvent): string {
  if (e.kind === "rebuild") return "expected rebuild after compaction";
  if (e.kind === "model-switch") return "expected re-cache after model switch";
  return e.idle && e.gapMs !== undefined ? `cache miss after ${formatDuration(e.gapMs)} idle` : "cache miss";
}

/** "385k re-cached, ~$3.01": the size of a flagged call, and what it cost over reading from cache. */
export function cacheEventDetail(e: CacheEvent): string {
  return `${formatTokens(e.recached)} re-cached${e.cost !== undefined ? `, ${approxCost(e.cost)}` : ""}`;
}

/** Claude Code's `/usage` wording: "1 miss · 2 expected rebuilds · ~$3.01 extra". Empty when nothing was flagged. */
export function formatCacheSummary(c: CacheSummary): string {
  return [
    c.misses ? plural(c.misses, "miss", "misses") : "",
    c.rebuilds ? plural(c.rebuilds, "expected rebuild") : "",
    c.modelSwitches ? plural(c.modelSwitches, "model switch", "model switches") : "",
    c.extraCost !== undefined ? `${approxCost(c.extraCost, c.extraCostPartial)} extra` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The short header figure: "3 (~$3.01)". */
export function formatCacheMisses(c: CacheSummary): string {
  return `${c.misses}${c.extraCost !== undefined ? ` (${approxCost(c.extraCost, c.extraCostPartial)})` : ""}`;
}
