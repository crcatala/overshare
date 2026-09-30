import { createHash } from "node:crypto";
import { PI_INPUT_PROVENANCE_TYPE, type Usage } from "../schema.js";
import {
  TurnBuilder,
  baseSession,
  bump,
  projectNameFromCwd,
  type AdapterOptions,
  type AdapterResult,
  type DropCounts,
} from "./shared.js";

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

  for (const e of branchEntries(entries, options.leafId)) {
    const timestamp: string | undefined = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (timestamp) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }
    switch (e.type) {
      case "message":
        handleMessage(e, b, models, dropped, timestamp, authoredInput(e, previous));
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
        break;
      case "branch_summary":
        b.addEvent("compaction", "Branch summary", timestamp, typeof e.summary === "string" ? e.summary : undefined);
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
        if (e.customType !== PI_INPUT_PROVENANCE_TYPE) bump(dropped, `custom:${e.customType ?? "?"}`);
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
  return { session, dropped };
}

/** Verify binding on the selected branch, never by text similarity or file order alone. */
function authoredInput(e: Entry, previous: Entry | undefined): string | undefined {
  if (e.message?.role !== "user" || previous?.type !== "custom" || previous.customType !== PI_INPUT_PROVENANCE_TYPE ||
      typeof previous.id !== "string" || e.parentId !== previous.id) return;
  const d = previous.data;
  if (!d || d.version !== 1 || typeof d.text !== "string" || (d.source !== "interactive" && d.source !== "rpc") ||
      typeof d.messageTimestamp !== "number" || !Number.isFinite(d.messageTimestamp) || e.message.timestamp !== d.messageTimestamp ||
      typeof d.messageHash !== "string" || d.messageHash !== createHash("sha256").update(contentText(e.message.content)).digest("hex")) return;
  return d.text;
}

function handleMessage(e: Entry, b: TurnBuilder, models: string[], dropped: DropCounts, timestamp?: string, original?: string): void {
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
  if (msg.usage) b.setResponseUsage(responseId, mapUsage(msg.usage), { model, timestamp });
}

function mapUsage(u: Entry): Usage {
  const usage: Usage = {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    reasoning: u.reasoning ?? 0,
  };
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
