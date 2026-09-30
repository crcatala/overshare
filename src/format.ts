/** Number/duration formatting shared by the CLI report and the viewer (browser-safe). */
import { totalTokens, type SessionStats, type UsageTotals } from "./schema.js";

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
export function formatSessionCost(stats: Pick<SessionStats, "cost" | "costPartial">): string | undefined {
  return stats.cost === undefined ? undefined : `${formatCost(stats.cost)}${stats.costPartial ? "+" : ""}`;
}

/** Usage kept out of the session totals (other branches, inherited history), as one short line. */
export function formatUsageTotals(t: UsageTotals): string {
  return [plural(t.responses, "call"), `${formatTokens(totalTokens(t.tokens))} tokens`, t.cost !== undefined ? formatCost(t.cost) : ""].filter(Boolean).join(" · ");
}

/** What the cost figure means, and what it leaves out. The first line is a title. */
export function describeCost(stats: SessionStats): string[] {
  const how =
    stats.costSource === "estimated"
      ? "Estimated at API list price from the tokens in this transcript."
      : stats.costSource === "session-total"
        ? "The agent's running total for its last process; it can undercount a resumed session."
        : "Recorded by the agent for each model call, at list price.";
  const lines = ["Estimated cost", how, "Not a bill: subscription plans are not charged per token."];
  if (stats.costPartial) lines.push("Some calls used a model with no known price, so this is a lower bound.");
  lines.push("Covers the main conversation on the branch shown. Subagent usage is not included.");
  if (stats.otherBranches) lines.push(`Not included: ${formatUsageTotals(stats.otherBranches)} on other branches.`);
  if (stats.inherited) lines.push(`Not included: ${formatUsageTotals(stats.inherited)} inherited from the parent session.`);
  return lines;
}
