import type { ResponseUsage, SubagentUsage, Usage } from "../../schema.js";
import { estimateCosts, stripInjectedContext, usageTokens, type SubagentFileInput } from "../shared.js";
import type { SubagentRun } from "../subagent-runs.js";

export { linkSubagentRuns, type SubagentRun } from "../subagent-runs.js";

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
