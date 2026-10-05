import { createHash } from "node:crypto";
import { isPiInputProvenanceType, totalsOf, type ResponsePurpose, type ResponseUsage, type TokenRates, type Usage } from "../../schema.js";
import {
  TurnBuilder,
  baseSession,
  bump,
  projectNameFromCwd,
  usageTokens,
  type AdapterOptions,
  type AdapterResult,
  type DropCounts,
} from "../shared.js";

/**
 * pi transcripts: `~/.pi/agent/sessions/--<cwd-slug>--/<timestamp>_<id>.jsonl`.
 *
 * The file is a tree (`id` / `parentId`): branching appends new entries whose parent
 * points back into the history. We export the branch ending at `leafId` (the pi
 * extension passes the live leaf) or, by default, at the last entry in the file,
 * which is what pi itself considers the current position after a reload.
 */

type Entry = Record<string, any>;

export function parsePi(raw: string, options: AdapterOptions = {}): AdapterResult {
  const entries: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Tolerate a torn last line.
    }
  }
  const header = entries.find((e) => e.type === "session") ?? {};
  const dropped: DropCounts = {};
  const b = new TurnBuilder();
  const models: string[] = [];
  let title: string | undefined;
  let startedAt: string | undefined = header.timestamp;
  let endedAt: string | undefined;
  let previous: Entry | undefined;
  const inherited = inheritedTest(header);
  const branch = branchEntries(entries, options.leafId);

  for (const e of branch) {
    const timestamp: string | undefined = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (timestamp) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }
    switch (e.type) {
      case "message":
        handleMessage(e, b, models, dropped, timestamp, authoredInput(e, previous), inherited(e));
        break;
      case "model_change":
        if (b.hasPrompt) b.addEvent("model_change", `Model → ${[e.provider, e.modelId].filter(Boolean).join("/")}`, timestamp);
        break;
      case "thinking_level_change":
        if (b.hasPrompt) b.addEvent("thinking_level", `Thinking level → ${e.thinkingLevel}`, timestamp);
        break;
      case "compaction":
        b.addEvent(
          "compaction",
          "Context compacted",
          timestamp,
          [typeof e.tokensBefore === "number" ? `${e.tokensBefore} tokens before` : "", typeof e.summary === "string" ? e.summary : ""]
            .filter(Boolean)
            .join("\n\n") || undefined,
        );
        recordUsage(b, e, inherited(e));
        break;
      case "branch_summary":
        b.addEvent("compaction", "Branch summary", timestamp, typeof e.summary === "string" ? e.summary : undefined);
        recordUsage(b, e, inherited(e));
        break;
      case "usage":
        // Model calls that are not part of the conversation (e.g. cache keep-alives).
        recordUsage(b, e, inherited(e));
        break;
      case "custom_message":
        if (typeof e.customType === "string" && e.customType.startsWith("subagent")) {
          const text = contentText(e.content).trim().split("\n")[0] ?? "";
          b.addEvent("subagent_notice", text || "Subagent update", timestamp);
        } else {
          bump(dropped, `custom_message:${e.customType ?? "?"}`);
        }
        break;
      case "session_info":
        if (typeof e.name === "string" && e.name) title = e.name;
        break;
      case "session":
        break;
      case "custom":
        if (!isPiInputProvenanceType(e.customType)) bump(dropped, `custom:${e.customType ?? "?"}`);
        break;
      default:
        bump(dropped, e.customType ? `${e.type}:${e.customType}` : e.type ?? "unknown");
    }
    previous = e;
  }
  b.finalizeThinking();

  const session = baseSession("pi", String(header.id ?? ""));
  session.title = title;
  session.harness.formatVersion = typeof header.version === "number" ? header.version : undefined;
  session.source.leafId = options.leafId;
  const cwd: string | undefined = header.cwd;
  session.project = { cwd, name: projectNameFromCwd(cwd) };
  session.startedAt = startedAt;
  session.endedAt = endedAt;
  session.models = models;
  session.turns = b.turns;
  session.responses = b.responses;
  // pi records the cost of every call itself (per-response), so nothing is estimated.
  session.stats.costSource = "per-response";
  const otherBranches = totalsOf(offBranchResponses(entries, branch, inherited));
  if (otherBranches) session.stats.otherBranches = otherBranches;
  // The prices behind those recorded costs, so a cache miss can be priced without a price table.
  const rates = recordedRates(entries);
  if (Object.keys(rates).length) session.stats.rates = rates;
  return { session, dropped };
}

/**
 * Per-model token prices (USD per million) implied by the cost breakdowns pi records on each call:
 * cost of a component divided by its tokens. The last call with tokens in a component wins.
 */
function recordedRates(entries: Entry[]): Record<string, TokenRates> {
  const rates = new Map<string, Partial<TokenRates>>();
  for (const e of entries) {
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role !== "assistant" || typeof m.model !== "string" || !m.usage?.cost) continue;
    const u = m.usage;
    const rate = (tokens: unknown, cost: unknown) => (typeof tokens === "number" && tokens > 0 && typeof cost === "number" && cost > 0 ? (cost / tokens) * 1_000_000 : undefined);
    const found = { input: rate(u.input, u.cost.input), cacheRead: rate(u.cacheRead, u.cost.cacheRead), cacheWrite: rate(u.cacheWrite, u.cost.cacheWrite) };
    let into = rates.get(m.model);
    if (!into) rates.set(m.model, (into = {}));
    for (const [k, v] of Object.entries(found)) if (v !== undefined) into[k as keyof TokenRates] = v;
  }
  return Object.fromEntries([...rates].filter((kv): kv is [string, TokenRates] => kv[1].input !== undefined && kv[1].cacheRead !== undefined));
}

/**
 * A fork (`parentSession` in the header) starts from a copy of the parent's history, entries
 * keeping their original timestamps. Anything stamped before the fork itself was inherited:
 * its spend belongs to the parent session, not this one.
 */
function inheritedTest(header: Entry): (e: Entry) => boolean {
  const forkedAt = typeof header.parentSession === "string" ? Date.parse(header.timestamp) : Number.NaN;
  if (!Number.isFinite(forkedAt)) return () => false;
  return (e) => Date.parse(e.timestamp) < forkedAt;
}

/** Verify binding on the selected branch, never by text similarity or file order alone. */
function authoredInput(e: Entry, previous: Entry | undefined): string | undefined {
  if (e.message?.role !== "user" || previous?.type !== "custom" || !isPiInputProvenanceType(previous.customType) ||
      typeof previous.id !== "string" || e.parentId !== previous.id) return;
  const d = previous.data;
  if (!d || d.version !== 1 || typeof d.text !== "string" || (d.source !== "interactive" && d.source !== "rpc") ||
      typeof d.messageTimestamp !== "number" || !Number.isFinite(d.messageTimestamp) || e.message.timestamp !== d.messageTimestamp ||
      typeof d.messageHash !== "string" || d.messageHash !== createHash("sha256").update(contentText(e.message.content)).digest("hex")) return;
  return d.text;
}

function handleMessage(e: Entry, b: TurnBuilder, models: string[], dropped: DropCounts, timestamp: string | undefined, original: string | undefined, inherited: boolean): void {
  const msg = e.message ?? {};
  if (msg.role === "user") {
    const stored = contentText(msg.content).trim();
    const text = (original ?? stored).trim();
    const images = countImages(msg.content);
    if (!text && !images) return void bump(dropped, "empty-user");
    const command = original === undefined ? undefined : /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text);
    b.startTurn({
      text, authored: original !== undefined,
      ...(command ? { command: { name: command[1]!, ...(command[2] ? { args: command[2] } : {}) } } : {}),
      ...(original !== undefined && stored !== text ? { expanded: stored } : {}),
      ...(images ? { images } : {}),
    }, timestamp);
    return;
  }
  if (msg.role === "toolResult") {
    const images = countImages(msg.content);
    b.attachToolResult(
      msg.toolCallId,
      { text: contentText(msg.content), ...(images ? { images } : {}), ...(msg.isError ? { isError: true } : {}) },
      msg.details,
    );
    // Tools that call a model themselves report that usage on their result.
    recordUsage(b, e, inherited);
    return;
  }
  if (msg.role !== "assistant") return void bump(dropped, `message:${msg.role ?? "?"}`);

  const responseId: string = e.id;
  const model: string | undefined = msg.model;
  if (model && !models.includes(model)) models.push(model);
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (block?.type === "text") {
      const text = String(block.text ?? "").trim();
      if (text) b.addStep({ kind: "text", id: b.nextId("t"), timestamp, responseId, text, ...(model ? { model } : {}) });
    } else if (block?.type === "thinking") {
      const text = typeof block.thinking === "string" ? block.thinking : "";
      b.addStep({ kind: "thinking", id: b.nextId("k"), timestamp, responseId, chars: text.length, blocks: 1, ...(text ? { text } : {}) });
    } else if (block?.type === "toolCall") {
      b.addToolCall(block.id, block.name, block.arguments, { timestamp, responseId });
    }
  }
  if (msg.stopReason === "error") b.addEvent("error", String(msg.errorMessage ?? "Model error").split("\n")[0] ?? "Model error", timestamp);
  if (msg.stopReason === "aborted") b.addEvent("interrupted", "Interrupted by user", timestamp);
  const usage = callUsage(msg);
  if (usage) b.setResponseUsage(responseId, usage, { model, timestamp, inherited });
}

/** Usage of an assistant message. Aborted/errored calls that report nothing are not model calls worth counting. */
function callUsage(msg: Entry): Usage | undefined {
  if (!msg.usage) return undefined;
  const usage = mapUsage(msg.usage);
  const empty = usageTokens(usage) === 0;
  return empty && (msg.stopReason === "aborted" || msg.stopReason === "error") ? undefined : usage;
}

/** Usage a non-assistant entry reports for a model call it made itself. */
function sideUsage(e: Entry): { usage: Usage; model?: string; purpose: ResponsePurpose } | undefined {
  const raw = e.type === "message" ? (e.message?.role === "toolResult" ? e.message.usage : undefined) : e.usage;
  if (!raw || typeof raw !== "object") return undefined;
  const usage = mapUsage(raw);
  if (usageTokens(usage) === 0) return undefined;
  const purpose: ResponsePurpose =
    e.type === "compaction" ? "compaction" : e.type === "branch_summary" ? "summary" : e.type === "message" ? "tool" : e.kind === "cache_warm" ? "cache-warm" : "background";
  return { usage, ...(typeof e.model === "string" ? { model: e.model } : {}), purpose };
}

function recordUsage(b: TurnBuilder, e: Entry, inherited: boolean): void {
  const side = sideUsage(e);
  if (side) b.setResponseUsage(e.id, side.usage, { model: side.model, timestamp: e.timestamp, purpose: side.purpose, inherited });
}

/** Model calls in the file that are not on the exported branch: spend the branch view leaves out. */
function offBranchResponses(entries: Entry[], onBranch: Entry[], inherited: (e: Entry) => boolean): ResponseUsage[] {
  const branch = new Set(onBranch);
  const out: ResponseUsage[] = [];
  for (const e of entries) {
    if (typeof e.id !== "string" || e.type === "session" || branch.has(e) || inherited(e)) continue;
    const call = e.type === "message" && e.message?.role === "assistant" ? callUsage(e.message) : undefined;
    if (call) {
      out.push({ id: e.id, turn: 0, model: e.message.model, timestamp: e.timestamp, usage: call });
      continue;
    }
    const side = sideUsage(e);
    if (side) out.push({ id: e.id, turn: 0, model: side.model, timestamp: e.timestamp, usage: side.usage, purpose: side.purpose });
  }
  return out;
}

function mapUsage(u: Entry): Usage {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const usage: Usage = {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    reasoning: num(u.reasoning),
  };
  // When only the provider's total is reported, it is the best available figure for the output.
  const missing = num(u.totalTokens) - usageTokens(usage);
  if (usage.output === 0 && missing > 0) usage.output = missing;
  const write1h = num(u.cacheWrite1h);
  if (write1h > 0) usage.cacheWrite1h = Math.min(write1h, usage.cacheWrite);
  if (typeof u.cost?.total === "number") usage.cost = u.cost.total;
  return usage;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: Entry) => c?.type === "text" && typeof c.text === "string")
    .map((c: Entry) => c.text)
    .join("\n");
}

function countImages(content: unknown): number {
  return Array.isArray(content) ? content.filter((c: Entry) => c?.type === "image").length : 0;
}

function branchEntries(entries: Entry[], leafId?: string): Entry[] {
  const nodes = entries.filter((e) => typeof e.id === "string" && e.type !== "session");
  const byId = new Map<string, Entry>(nodes.map((e) => [e.id, e]));
  const leaf = leafId ? byId.get(leafId) : nodes.at(-1);
  if (!leaf) return nodes;
  const path: Entry[] = [];
  const seen = new Set<string>();
  let cur: Entry | undefined = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}
