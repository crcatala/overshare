import { markCacheEvents } from "./cache.js";
import { safeLabel } from "./redact/labels.js";
import { addUsage, contextTokens, emptyUsage, totalsOf, totalTokens, type NormalizedSession, type SessionStats } from "./schema.js";

/**
 * Compute session statistics from a full (unprojected) session.
 *
 * `tokens`, `cost` and `responses` are this session's own spend: calls inherited from a
 * parent session (forks) are reported under `inherited` instead. Adapters pass facts through
 * `session.stats`: `costSource`, `otherBranches` (usage that is in the file but not on the exported
 * branch), `subagentUsage` (usage read from subagent transcripts) and `rates` (prices the harness
 * recorded, for pricing cache misses).
 *
 * Also flags cache misses: sets `cacheEvent` on the calls of `session.responses` it finds them in,
 * so this must run on the full session, before any share-mode projection.
 */
export function computeStats(session: NormalizedSession): SessionStats {
  const own = session.responses.filter((r) => !r.inherited);
  const stats: SessionStats = {
    turns: session.turns.filter((t) => t.user).length,
    userPrompts: session.turns.filter((t) => t.user).length,
    responses: own.length,
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
        const name = safeLabel(step.name, "tool");
        stats.tools[name] = (stats.tools[name] ?? 0) + 1;
        if (step.isError) stats.toolErrors += 1;
        for (const f of step.files ?? []) {
          if (step.action === "read") files.read.add(f);
          else if (step.action === "edit") files.edited.add(f);
          else if (step.action === "write") files.written.add(f);
        }
      } else if (step.kind === "subagent") {
        stats.toolCalls += 1;
        stats.subagents += 1;
        const tool = safeLabel(step.tool, "tool");
        stats.tools[tool] = (stats.tools[tool] ?? 0) + 1;
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
  for (const r of session.responses) {
    // Thinking and peak context describe the conversation shown, inherited or not.
    stats.thinking.tokens += r.usage.reasoning;
    stats.peakContext = Math.max(stats.peakContext, contextTokens(r.usage));
  }
  let costed = 0;
  let unpriced = 0;
  for (const r of own) {
    stats.tokens = addUsage(stats.tokens, r.usage);
    if (r.usage.cost !== undefined) costed += 1;
    else if (totalTokens(r.usage) > 0) unpriced += 1;
  }
  if (costed > 0) {
    stats.cost = stats.tokens.cost;
    stats.costSource = session.stats.costSource ?? "per-response";
    if (unpriced > 0) stats.costPartial = true;
  }
  delete stats.tokens.cost;
  const inherited = totalsOf(session.responses.filter((r) => r.inherited));
  if (inherited) stats.inherited = inherited;
  if (session.stats.otherBranches) stats.otherBranches = session.stats.otherBranches;
  if (session.stats.subagentUsage) stats.subagentUsage = session.stats.subagentUsage;
  if (session.stats.rates) stats.rates = session.stats.rates;
  const cache = markCacheEvents(session);
  if (cache) stats.cache = cache;
  return stats;
}
