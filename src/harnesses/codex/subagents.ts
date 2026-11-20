import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ResponseUsage } from "../../schema.js";
import { estimateCosts, type SubagentFileInput } from "../shared.js";
import type { SubagentRun } from "../subagent-runs.js";
import { lines, parseLine } from "../summary-kit.js";
import { maxSessionBytes } from "../limits.js";
import { subagentRollouts } from "./files.js";
import { codexUsage } from "./parse.js";

type Entry = Record<string, any>;

const isObj = (v: unknown): v is Entry => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Read the rollouts of the agents a session spawned (see `subagentRollouts`); an unreadable or too-large one is skipped. */
export function loadCodexSubagents(sessionPath: string): SubagentFileInput[] {
  const files: SubagentFileInput[] = [];
  for (const f of subagentRollouts(sessionPath)) {
    try {
      if (statSync(f).size > maxSessionBytes()) continue;
      files.push({ fileName: basename(f), raw: readFileSync(f, "utf8") });
    } catch {
      // vanished or unreadable
    }
  }
  return files;
}

export const countCodexSubagents = (sessionPath: string): number => subagentRollouts(sessionPath).length;

/**
 * One child rollout as a `SubagentRun`: its own model calls (estimated cost), commands and final answer. A child starts
 * with a replay of its parent's history up to `subagent_history_start_ordinal`; those lines are the parent's, so only
 * lines from that ordinal on count. Older builds replayed `token_count` events too, which counted that way would
 * multiply the parent's usage (ccusage issue 950).
 */
export function readCodexRun(file: SubagentFileInput): SubagentRun | undefined {
  let header: Entry | undefined;
  let start = 0;
  let model: string | undefined;
  const responses: ResponseUsage[] = [];
  const fallback: ResponseUsage[] = [];
  // Only a record that parses counts: a torn last line (the child still writing) must not turn the fallback off.
  const hasRecords = file.raw.includes('"type":"token_usage_record"') && [...lines(file.raw)].some((l) => l.includes('"type":"token_usage_record"') && isObj(parseLine(l)));
  let lastTotal: string | undefined;
  let toolUses = 0;
  let first: number | undefined;
  let last: number | undefined;
  let finalText: string | undefined;
  let finalAt: number | undefined;
  for (const line of lines(file.raw)) {
    const e = parseLine(line);
    if (!isObj(e)) continue;
    const p: Entry = isObj(e.payload) ? e.payload : {};
    if (e.type === "session_meta" && !header) {
      header = p;
      if (typeof p.subagent_history_start_ordinal === "number") start = p.subagent_history_start_ordinal;
      continue;
    }
    if (e.type === "turn_context") model = str(p.model) ?? model;
    // The parent's replayed history.
    if (typeof e.ordinal === "number" && e.ordinal < start) continue;
    const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
    if (Number.isFinite(at)) {
      first = first === undefined ? at : Math.min(first, at);
      last = last === undefined ? at : Math.max(last, at);
    }
    if (e.type === "token_usage_record" && isObj(p.usage)) {
      responses.push({ id: str(p.response_id) ?? `${file.fileName}:${responses.length}`, turn: 0, model, timestamp: str(e.timestamp), usage: codexUsage(p.usage) });
    } else if (e.type === "event_msg" && p.type === "token_count" && !hasRecords && isObj(p.info) && isObj(p.info.last_token_usage)) {
      const total = JSON.stringify(p.info.total_token_usage ?? null);
      if (total !== lastTotal) {
        lastTotal = total;
        fallback.push({ id: `${file.fileName}:tc${fallback.length}`, turn: 0, model, timestamp: str(e.timestamp), usage: codexUsage(p.info.last_token_usage) });
      }
    } else if (e.type === "event_msg" && p.type === "item_completed" && isObj(p.item) && p.item.type === "CommandExecution") {
      toolUses += 1;
    } else if (e.type === "response_item" && (p.type === "function_call" || (p.type === "custom_tool_call" && p.name !== "exec"))) {
      toolUses += 1;
      finalText = undefined;
    } else if (e.type === "response_item" && p.type === "custom_tool_call") {
      finalText = undefined;
    } else if (e.type === "response_item" && p.type === "message" && p.role === "assistant" && !(isObj(e.metadata) && e.metadata.compaction_output === true)) {
      const text = (Array.isArray(p.content) ? p.content : []).filter((c: Entry) => isObj(c) && typeof c.text === "string").map((c: Entry) => c.text as string).join("\n").trim();
      // Progress notes (`phase: commentary`) are not an answer: an agent interrupted after one has none.
      if (p.phase === "commentary") finalText = undefined;
      else if (text) {
        finalText = text;
        finalAt = Number.isFinite(at) ? at : undefined;
      }
    }
  }
  if (!header || typeof header.id !== "string") return undefined;
  const calls = responses.length ? responses : fallback;
  estimateCosts(calls);
  return {
    agentId: header.id,
    ...(str(header.parent_thread_id) ? { parentAgentId: header.parent_thread_id } : {}),
    responses: calls,
    toolUses,
    ...(first !== undefined && last !== undefined ? { durationMs: last - first } : {}),
    ...(finalText ? { finalText } : {}),
    ...(finalText && finalAt !== undefined ? { finalAt } : {}),
  };
}
