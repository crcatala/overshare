/**
 * Subagent usage in the viewer: the session line in the token rail and header, and what a turn's launched subagents
 * add up to. A subagent has its own context window, so none of this feeds the context charts or the cache figures.
 */
import { COST_UNDERCOUNT_NOTE, formatCost, formatDuration, formatSessionCost, formatTokens, formatUsageTotals, plural } from "../../src/format.ts";
import type { SessionStats, SubagentTotals, SubagentUsage, Turn } from "../../src/schema.ts";
import { h, withTooltip } from "./dom.ts";

/** Tokens processed by one subagent: the reported total, else the sum of its token classes; undefined when it reported none. */
export function stepTokens(u: SubagentUsage): number | undefined {
  if (u.totalTokens) return u.totalTokens;
  if (u.input === undefined && u.output === undefined && u.cacheRead === undefined && u.cacheWrite === undefined) return undefined;
  return (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
}

/** What the subagents a turn launched add up to (async ones too: they belong to the turn that launched them). */
export interface TurnSubagents {
  agents: number;
  tokens: number;
  /** Model calls. */
  calls: number;
  toolUses: number;
  /** The longest run; agents in one turn overlap, so their times are not added. */
  durationMs?: number;
  cost?: number;
  /** Some agent had no cost (an unpriced model), so `cost` undercounts. */
  costPartial?: boolean;
}

/** Undefined when no subagent step of the turn carries usage (none launched, pi without child usage, or a prompts view). */
export function turnSubagents(turn: Turn): TurnSubagents | undefined {
  let out: TurnSubagents | undefined;
  for (const s of turn.steps) {
    if (s.kind !== "subagent" || !s.usage) continue;
    const tokens = stepTokens(s.usage);
    if (!tokens) continue;
    out ??= { agents: 0, tokens: 0, calls: 0, toolUses: 0 };
    out.agents += 1;
    out.tokens += tokens;
    out.calls += s.usage.turns ?? 0;
    out.toolUses += s.usage.toolUses ?? 0;
    if (s.usage.durationMs !== undefined) out.durationMs = Math.max(out.durationMs ?? 0, s.usage.durationMs);
    if (s.usage.cost !== undefined) out.cost = (out.cost ?? 0) + s.usage.cost;
    else out.costPartial = true;
  }
  if (out && out.cost === undefined) delete out.costPartial;
  return out;
}

/** "2 subagents · 26k tokens · 6 model calls · 3 tool calls · $0.052", for the turn foot and column tooltips. */
export function turnSubagentsLine(t: TurnSubagents): string {
  return [
    plural(t.agents, "subagent"),
    `${formatTokens(t.tokens)} tokens`,
    t.calls ? plural(t.calls, "model call") : "",
    t.toolUses ? plural(t.toolUses, "tool call") : "",
    t.cost !== undefined ? `${formatCost(t.cost)}${t.costPartial ? "+" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export const turnSubagentsDuration = (t: TurnSubagents): string | undefined => (t.durationMs ? formatDuration(t.durationMs) : undefined);

export const SUBAGENT_HELP = [
  "Model calls made by the subagents this session launched, read from their own transcripts. They are not in the session figures above: a subagent has its own context window, so it is not drawn in Context by turn either.",
  "Each subagent's tokens and cost are also shown on the step that launched it, and on the turn that launched it (even when it finished later).",
  "Prompt cache figures cover the main conversation only, as in Claude Code's own /usage.",
];

export const UNLINKED_WHY = "by subagents that no step on this branch launched (a rewound branch, a forked skill, or a layout this viewer does not know)";

const modelLines = (t: SubagentTotals): string[] =>
  Object.entries(t.byModel)
    .sort((a, b) => b[1].responses - a[1].responses)
    .map(([model, u]) => `${model}: ${formatUsageTotals(u)}`);

/** The subagents' cost, with the basis on hover. */
export function subagentCostNode(t: SubagentTotals): HTMLElement | undefined {
  const text = formatSessionCost(t);
  if (text === undefined) return undefined;
  const el = h("span", { class: "has-tip", tabindex: "0" }, text);
  withTooltip(el, () => [
    "Estimated cost of subagents",
    "Estimated at API list price from each subagent's tokens and model, like the session cost. Not a bill, and not included in it.",
    ...(t.costPartial ? ["Some calls have no cost (a model with no known price), so this is a lower bound."] : []),
    COST_UNDERCOUNT_NOTE,
    ...modelLines(t),
  ]);
  return el;
}

/** Subagent spend that no step on the exported branch launched; shown apart and never folded into the figures above it. */
export function unlinkedSubagentsNode(t: SubagentTotals | undefined): HTMLElement | undefined {
  if (!t) return undefined;
  const cost = formatSessionCost(t);
  const el = h("span", { class: "has-tip", tabindex: "0" }, `${cost ? `${cost} · ` : ""}${plural(t.agents, "agent")}`);
  withTooltip(el, () => ["Not in the subagent figures above", `${formatUsageTotals(t)} ${UNLINKED_WHY}.`, ...(cost ? [COST_UNDERCOUNT_NOTE] : []), ...modelLines(t)]);
  return el;
}

/** The header figure "subagents: 3 (~$0.32)". Without usage (pi, or no transcripts) it is just the launch count. */
export function subagentsHeaderNode(st: SessionStats): HTMLElement | string | undefined {
  const u = st.subagentUsage;
  const agents = (u?.agents ?? 0) + (u?.unlinked?.agents ?? 0);
  if (!u || !agents) return st.subagents ? String(st.subagents) : undefined;
  const buckets = [u.agents ? u : undefined, u.unlinked].filter((b): b is SubagentTotals => b !== undefined);
  const costs = buckets.flatMap((b) => (b.cost !== undefined ? [b.cost] : []));
  const total = costs.length ? costs.reduce((a, b) => a + b, 0) : undefined;
  // A bucket with no cost at all is unpriced, so the sum of the others is a lower bound.
  const partial = buckets.some((b) => b.costPartial || b.cost === undefined);
  const el = h("span", { class: "has-tip", tabindex: "0" }, `${agents}${total !== undefined ? ` (~${formatCost(total)}${partial ? "+" : ""})` : ""}`);
  withTooltip(el, () => [
    "Subagents",
    `${plural(agents, "subagent")} ran in this session. Their usage is read from their transcripts and is not in the tokens or cost of the main conversation.`,
    ...(u.agents ? [`launched here: ${formatUsageTotals(u)}`] : []),
    ...(u.unlinked ? [`not launched on this branch: ${formatUsageTotals(u.unlinked)}`] : []),
    ...(total !== undefined ? [`The cost is estimated at list price. ${COST_UNDERCOUNT_NOTE}`] : []),
  ]);
  return el;
}
