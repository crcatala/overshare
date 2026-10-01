import { totalsOf, type ResponseUsage } from "../schema.js";
import { linkSubagentRuns, mapClaudeUsage, readSubagentRuns, responseKey, subagentCountsFrom } from "./claude-usage.js";
import {
  TurnBuilder,
  baseSession,
  bump,
  estimateCosts,
  projectNameFromCwd,
  usageTokens,
  stripInjectedContext,
  type AdapterOptions,
  type AdapterResult,
  type DropCounts,
} from "./shared.js";

/**
 * Claude Code transcripts: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`.
 *
 * Notes on the format that matter here:
 * - One API response is split across several lines (one per content block), each
 *   repeating the same `message.usage`; usage is keyed by `message.id` to avoid
 *   double counting.
 * - Lines form a tree through `parentUuid` (rewinds fork it; compaction links via
 *   `logicalParentUuid`); we follow the branch that ends at the last entry.
 * - `attachment` lines carry injected context (CLAUDE.md, environment, credentials
 *   org, reminders) and are dropped wholesale.
 */

type Entry = Record<string, any>;

/**
 * Only lines a person authored may start a turn (and so survive prompts mode). `origin` is absent
 * on older transcripts and `{kind: "human"}` on current ones; any other kind (task-notification,
 * and whatever Claude Code adds next) is harness-generated text, so an unknown kind fails closed.
 */
function isHumanOrigin(origin: unknown): boolean {
  if (origin === undefined || origin === null) return true;
  return typeof origin === "object" && (origin as Entry).kind === "human";
}

const originLabel = (origin: unknown): string => {
  const kind = origin && typeof origin === "object" ? (origin as Entry).kind : undefined;
  return typeof kind === "string" && kind ? kind : "unknown";
};

/** Background subagent completion: `<task-notification>` with the agent's final answer in `<result>`. */
function parseTaskNotification(text: string): { toolUseId?: string; agentId?: string; result: string } {
  const at = text.indexOf("<result>");
  // Read ids only from the header so text inside the answer cannot redirect it to another step.
  const header = at === -1 ? text : text.slice(0, at);
  const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(header)?.[1];
  const agentId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(header)?.[1];
  const result = at === -1 ? "" : (/^<result>([\s\S]*)<\/result>/.exec(text.slice(at))?.[1] ?? "");
  return { toolUseId, agentId, result: stripInjectedContext(result) };
}

const CONVERSATION_TYPES = new Set(["user", "assistant", "system"]);

export function parseClaudeCode(raw: string, options: AdapterOptions = {}): AdapterResult {
  const entries: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Tolerate a torn last line from a session that is still being written.
    }
  }

  const dropped: DropCounts = {};
  let sessionId = "";
  let version: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let title: string | undefined;
  let summaryTitle: string | undefined;
  for (const e of entries) {
    if (!sessionId && typeof e.sessionId === "string") sessionId = e.sessionId;
    if (typeof e.version === "string") version = e.version;
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    if (typeof e.gitBranch === "string" && e.gitBranch && e.gitBranch !== "HEAD") branch = e.gitBranch;
    if (e.type === "ai-title" && typeof e.aiTitle === "string") title = e.aiTitle;
    if (e.type === "summary" && typeof e.summary === "string") summaryTitle = e.summary;
    // `cost-state` (Claude Code's own cost total) is deliberately not read: it is per process, so a
    // resumed session only reports its last segment, and it includes calls the transcript never shows.
  }

  const ordered = branchEntries(entries, options.leafId);
  // The tool result of an Agent call reports the subagent's last model call, not a total, so its token
  // figures are not shown as one; the totals come from the subagent transcripts (see claude-usage.ts).
  const b = new TurnBuilder({ subagentUsage: subagentCountsFrom });
  const models: string[] = [];
  let pendingCommand: { name: string; args?: string; timestamp?: string } | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  const promptFromCommand = (expanded?: string) => {
    if (!pendingCommand) return;
    const { name, args, timestamp } = pendingCommand;
    pendingCommand = undefined;
    b.startTurn(
      { text: args ? `${name} ${args}` : name, command: { name, ...(args ? { args } : {}) }, ...(expanded ? { expanded } : {}) },
      timestamp,
    );
  };

  const handleCommandMarkup = (text: string, timestamp?: string): boolean => {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
    if (name) {
      if (pendingCommand) b.addEvent("command", pendingCommand.name, pendingCommand.timestamp);
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
      pendingCommand = { name: name.startsWith("/") ? name : `/${name}`, args: args || undefined, timestamp };
      return true;
    }
    const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
    if (stdout) {
      const label = pendingCommand?.name ?? "command";
      pendingCommand = undefined;
      b.addEvent("command", label, timestamp, stdout[1]?.trim() || undefined);
      return true;
    }
    return false;
  };

  for (const e of ordered) {
    const timestamp: string | undefined = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (e.isSidechain) {
      bump(dropped, "sidechain");
      continue;
    }
    if (e.type === "attachment") {
      const a = e.attachment ?? {};
      // Prompts typed while the agent was busy arrive as queued_command attachments.
      if (a.type === "queued_command" && a.commandMode === "prompt" && typeof a.prompt === "string" && a.prompt.trim()) {
        if (!isHumanOrigin(a.origin)) {
          bump(dropped, `origin:${originLabel(a.origin)}`);
          continue;
        }
        promptFromCommand();
        b.startTurn({ text: stripInjectedContext(a.prompt) }, timestamp);
        continue;
      }
      bump(dropped, `attachment${a.type ? `:${a.type}` : ""}`);
      continue;
    }
    if (!CONVERSATION_TYPES.has(e.type)) {
      bump(dropped, e.type ?? "unknown");
      continue;
    }
    if (timestamp) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }

    if (e.type === "system") {
      if (e.subtype === "compact_boundary") {
        const pre = e.compactMetadata?.preTokens;
        b.addEvent("compaction", "Context compacted", timestamp, typeof pre === "number" ? `${pre} tokens before` : undefined);
      } else if (e.subtype === "local_command" && typeof e.content === "string") {
        if (!handleCommandMarkup(e.content, timestamp)) bump(dropped, "system:local_command");
      } else if (e.subtype === "api_error") {
        b.addEvent("error", "API error", timestamp);
      } else {
        bump(dropped, `system:${e.subtype ?? "other"}`);
      }
      continue;
    }

    if (e.type === "user") {
      const content = e.message?.content;
      if (Array.isArray(content) && content.some((c: Entry) => c?.type === "tool_result")) {
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          const { text, images } = flattenContent(block.content);
          b.attachToolResult(
            block.tool_use_id,
            { text: stripInjectedContext(text), ...(images ? { images } : {}), ...(block.is_error ? { isError: true } : {}) },
            e.toolUseResult,
          );
        }
        continue;
      }
      const { text: rawText, images } = flattenContent(content);
      if (e.isCompactSummary) {
        b.addEvent("compaction", "Compaction summary", timestamp, rawText);
        continue;
      }
      if (e.isMeta) {
        if (rawText.startsWith("Base directory for this skill:")) {
          promptFromCommand();
          const skill = /Base directory for this skill:\s*(\S+)/.exec(rawText)?.[1]?.split("/").filter(Boolean).at(-1);
          b.addEvent("skill", `Skill loaded: ${skill ?? "unknown"}`, timestamp);
        } else if (pendingCommand && rawText.trim() && !rawText.startsWith("<local-command-caveat>")) {
          promptFromCommand(stripInjectedContext(rawText));
        } else {
          bump(dropped, "meta");
        }
        continue;
      }
      // Harness-generated user lines (background subagent completions) are not prompts.
      if (!isHumanOrigin(e.origin)) {
        const kind = originLabel(e.origin);
        const notification = kind === "task-notification" ? parseTaskNotification(rawText) : undefined;
        if (notification && b.completeSubagent(notification, notification.result)) bump(dropped, "task-notification");
        else bump(dropped, notification ? "task-notification:unmatched" : `origin:${kind}`);
        continue;
      }
      if (handleCommandMarkup(rawText, timestamp)) continue;
      if (/^\[Request interrupted by user/.test(rawText.trim())) {
        b.addEvent("interrupted", "Interrupted by user", timestamp);
        continue;
      }
      const text = stripInjectedContext(rawText);
      if (!text && !images) {
        bump(dropped, "empty-user");
        continue;
      }
      if (pendingCommand) {
        b.addEvent("command", pendingCommand.name, pendingCommand.timestamp);
        pendingCommand = undefined;
      }
      b.startTurn({ text, ...(images ? { images } : {}) }, timestamp);
      continue;
    }

    // assistant
    promptFromCommand();
    const msg = e.message ?? {};
    const responseId: string = msg.id ?? e.uuid;
    const model: string | undefined = msg.model;
    const blocks: Entry[] = Array.isArray(msg.content) ? msg.content : [];
    if (model === "<synthetic>") {
      const text = blocks.filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim();
      if (text) b.addEvent(e.isApiErrorMessage ? "error" : "interrupted", text.split("\n")[0] ?? text, timestamp);
      continue;
    }
    if (model && !models.includes(model)) models.push(model);
    for (const block of blocks) {
      if (block?.type === "text") {
        const text = String(block.text ?? "").trim();
        if (text) b.addStep({ kind: "text", id: b.nextId("t"), timestamp, responseId, text, ...(model ? { model } : {}) });
      } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        b.addStep({ kind: "thinking", id: b.nextId("k"), timestamp, responseId, chars: text.length, blocks: 1, ...(text ? { text } : {}) });
      } else if (block?.type === "tool_use") {
        b.addToolCall(block.id, block.name, block.input, { timestamp, responseId });
      }
    }
    if (msg.usage) b.setResponseUsage(responseId, mapClaudeUsage(msg.usage), { model, timestamp });
  }
  if (pendingCommand) b.addEvent("command", pendingCommand.name, pendingCommand.timestamp);
  b.finalizeThinking();
  estimateCosts(b.responses);
  // A call the main transcript also holds is counted there, not again from a subagent file.
  const mainKeys = new Set<string>();
  for (const e of entries) {
    const key = e.type === "assistant" && !e.isSidechain ? responseKey(e) : undefined;
    if (key) mainKeys.add(key);
  }
  // A subagent file spans the whole session, so it can hold work from after the exported point or from a
  // discarded branch. With an explicit leaf nothing timestamped after the branch end is read; and the file's
  // last message is offered as a step's summary only for a plain export, never when the branch was cut.
  const otherBranches = totalsOf(offBranchResponses(entries, ordered));
  const endMs = endedAt ? Date.parse(endedAt) : Number.NaN;
  const cut = options.leafId !== undefined || otherBranches !== undefined;
  const subagentRuns = readSubagentRuns(options.subagentFiles ?? [], mainKeys, options.leafId !== undefined ? (Number.isFinite(endMs) ? endMs : -Infinity) : undefined);
  const subagentUsage = linkSubagentRuns(b, subagentRuns, { summaryUntil: cut || !Number.isFinite(endMs) ? undefined : endMs });
  // Subagent transcripts are never shared: only their numbers and each agent's last message are read.
  if (subagentRuns.length) bump(dropped, "subagent-transcript", subagentRuns.length);

  const session = baseSession("claude-code", sessionId);
  session.title = title ?? summaryTitle;
  session.harness.version = version;
  session.source.leafId = options.leafId;
  session.project = { cwd, name: projectNameFromCwd(cwd), ...(branch ? { branch } : {}) };
  session.startedAt = startedAt;
  session.endedAt = endedAt;
  session.models = models;
  session.turns = b.turns;
  session.responses = b.responses;
  // Nothing in Claude Code transcripts identifies history copied from another session (pi forks
  // say so in the header), so unlike pi nothing is ever marked `inherited` here.
  // Claude Code records tokens, not dollars: costs are estimated at list price.
  session.stats.costSource = "estimated";
  if (otherBranches) session.stats.otherBranches = otherBranches;
  if (subagentUsage) session.stats.subagentUsage = subagentUsage;
  return { session, dropped };
}

/**
 * Model calls in the file that are not on the exported branch (rewound or abandoned
 * branches): real spend the branch view leaves out. Subagent (sidechain) lines are not
 * branches and stay out of every total.
 */
function offBranchResponses(entries: Entry[], onBranch: Entry[]): ResponseUsage[] {
  const branch = new Set(onBranch);
  const onBranchIds = new Set(onBranch.filter((e) => e.type === "assistant").map((e) => e.message?.id ?? e.uuid));
  const found = new Map<string, ResponseUsage>();
  for (const e of entries) {
    if (e.type !== "assistant" || e.isSidechain || branch.has(e) || typeof e.uuid !== "string") continue;
    const msg = e.message ?? {};
    if (!msg.usage || msg.model === "<synthetic>") continue;
    const id: string = msg.id ?? e.uuid;
    if (onBranchIds.has(id)) continue;
    const usage = mapClaudeUsage(msg.usage);
    const existing = found.get(id);
    if (existing) {
      if (usageTokens(usage) >= usageTokens(existing.usage)) existing.usage = usage;
    } else {
      found.set(id, { id, turn: 0, model: msg.model, timestamp: typeof e.timestamp === "string" ? e.timestamp : undefined, usage });
    }
  }
  const list = [...found.values()];
  estimateCosts(list);
  return list;
}

function flattenContent(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const c of content as Entry[]) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c?.type === "image") images += 1;
    else if (c?.type === "tool_reference") parts.push(`[tool reference: ${c.tool_name ?? c.name ?? "?"}]`);
  }
  return { text: parts.join("\n"), images };
}

/**
 * Entries on the branch ending at `leafId` (default: the last conversation entry),
 * in chronological order. Falls back to file order if the chain looks broken.
 */
function branchEntries(entries: Entry[], leafId?: string): Entry[] {
  const withId = entries.filter((e) => typeof e.uuid === "string");
  const byId = new Map<string, Entry>(withId.map((e) => [e.uuid, e]));
  const leaf = leafId
    ? byId.get(leafId)
    : [...withId].reverse().find((e) => (CONVERSATION_TYPES.has(e.type) || e.type === "attachment") && !e.isSidechain);
  if (!leaf) return withId;
  const path: Entry[] = [];
  const seen = new Set<string>();
  let cur: Entry | undefined = leaf;
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    path.push(cur);
    const parent: string | undefined = cur.parentUuid ?? cur.logicalParentUuid;
    cur = parent ? byId.get(parent) : undefined;
  }
  path.reverse();
  const withResults = withSiblingToolResults(path, entries);
  const conversational = (list: Entry[]) => list.filter((e) => (e.type === "user" || e.type === "assistant") && !e.isSidechain).length;
  if (!leafId && conversational(path) < conversational(withId) * 0.5) return withId;
  return withResults;
}

const toolUseIds = (e: Entry): string[] =>
  e.type === "assistant" && Array.isArray(e.message?.content)
    ? e.message.content.filter((c: Entry) => c?.type === "tool_use" && typeof c.id === "string").map((c: Entry) => c.id as string)
    : [];

const toolResultIds = (e: Entry): string[] =>
  e.type === "user" && Array.isArray(e.message?.content)
    ? e.message.content.filter((c: Entry) => c?.type === "tool_result" && typeof c.tool_use_id === "string").map((c: Entry) => c.tool_use_id as string)
    : [];

/**
 * Claude Code chains the results of parallel tool calls as siblings: each result's parent is its own
 * tool_use line, so only the last one lies on the parent chain from the leaf. Re-add the results that
 * answer a tool call on the branch but hang off it, placed just before the first user line that
 * follows the call (or at the end when nothing follows).
 */
function withSiblingToolResults(path: Entry[], entries: Entry[]): Entry[] {
  const callIndex = new Map<string, number>();
  const answered = new Set<string>();
  path.forEach((e, i) => {
    for (const id of toolUseIds(e)) callIndex.set(id, i);
    for (const id of toolResultIds(e)) answered.add(id);
  });
  const onPath = new Set(path);
  const extras = new Map<number, Entry[]>();
  for (const e of entries) {
    if (onPath.has(e) || e.isSidechain) continue;
    const ids = toolResultIds(e);
    const open = ids.filter((id) => callIndex.has(id) && !answered.has(id));
    if (!open.length) continue;
    for (const id of open) answered.add(id);
    const callAt = Math.max(...open.map((id) => callIndex.get(id)!));
    let at = path.findIndex((p, i) => i > callAt && p.type === "user");
    if (at < 0) at = path.length;
    extras.set(at, [...(extras.get(at) ?? []), e]);
  }
  if (!extras.size) return path;
  return [...path.flatMap((e, i) => [...(extras.get(i) ?? []), e]), ...(extras.get(path.length) ?? [])];
}
