import { addUsage, contextTokens, emptyUsage, type NormalizedSession, type SessionStats } from "./schema.js";

/** Compute session statistics from a full (unprojected) session. */
export function computeStats(session: NormalizedSession): SessionStats {
  const stats: SessionStats = {
    turns: session.turns.filter((t) => t.user).length,
    userPrompts: session.turns.filter((t) => t.user).length,
    responses: session.responses.length,
    toolCalls: 0,
    tools: {},
    toolErrors: 0,
    thinking: { blocks: 0, chars: 0, tokens: 0 },
    subagents: 0,
    compactions: 0,
    files: { read: 0, edited: 0, written: 0 },
    tokens: emptyUsage(),
    peakContext: 0,
  };
  const files = { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() };
  for (const turn of session.turns) {
    for (const step of turn.steps) {
      if (step.kind === "tool") {
        stats.toolCalls += 1;
        stats.tools[step.name] = (stats.tools[step.name] ?? 0) + 1;
        if (step.isError) stats.toolErrors += 1;
        for (const f of step.files ?? []) {
          if (step.action === "read") files.read.add(f);
          else if (step.action === "edit") files.edited.add(f);
          else if (step.action === "write") files.written.add(f);
        }
      } else if (step.kind === "subagent") {
        stats.toolCalls += 1;
        stats.subagents += 1;
        stats.tools[step.tool] = (stats.tools[step.tool] ?? 0) + 1;
        if (step.isError) stats.toolErrors += 1;
      } else if (step.kind === "thinking") {
        stats.thinking.blocks += step.blocks;
        stats.thinking.chars += step.chars;
      } else if (step.kind === "event" && step.event === "compaction") {
        stats.compactions += 1;
      }
    }
  }
  stats.files = { read: files.read.size, edited: files.edited.size, written: files.written.size };
  let perResponseCost = false;
  for (const r of session.responses) {
    stats.tokens = addUsage(stats.tokens, r.usage);
    stats.thinking.tokens += r.usage.reasoning;
    stats.peakContext = Math.max(stats.peakContext, contextTokens(r.usage));
    if (r.usage.cost !== undefined) perResponseCost = true;
  }
  if (perResponseCost) {
    stats.cost = stats.tokens.cost;
    stats.costSource = "per-response";
  } else if (session.stats.cost !== undefined) {
    stats.cost = session.stats.cost;
    stats.costSource = session.stats.costSource ?? "session-total";
  }
  delete stats.tokens.cost;
  return stats;
}
