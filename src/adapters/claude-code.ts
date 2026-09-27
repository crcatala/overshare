import type { Usage } from "../schema.js";
import {
  TurnBuilder,
  baseSession,
  bump,
  projectNameFromCwd,
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
  let sessionCost: number | undefined;
  for (const e of entries) {
    if (!sessionId && typeof e.sessionId === "string") sessionId = e.sessionId;
    if (typeof e.version === "string") version = e.version;
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    if (typeof e.gitBranch === "string" && e.gitBranch && e.gitBranch !== "HEAD") branch = e.gitBranch;
    if (e.type === "ai-title" && typeof e.aiTitle === "string") title = e.aiTitle;
    if (e.type === "summary" && typeof e.summary === "string") summaryTitle = e.summary;
    if (e.type === "cost-state" && typeof e.totalCostUSD === "number") sessionCost = e.totalCostUSD;
  }

  const ordered = branchEntries(entries, options.leafId);
  const b = new TurnBuilder();
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
    if (msg.usage) b.setResponseUsage(responseId, mapUsage(msg.usage), { model, timestamp });
  }
  if (pendingCommand) b.addEvent("command", pendingCommand.name, pendingCommand.timestamp);
  b.finalizeThinking();

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
  if (sessionCost !== undefined) {
    session.stats.cost = sessionCost;
    session.stats.costSource = "session-total";
  }
  return { session, dropped };
}

function mapUsage(u: Entry): Usage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
  };
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
  const conversational = (list: Entry[]) => list.filter((e) => (e.type === "user" || e.type === "assistant") && !e.isSidechain).length;
  if (!leafId && conversational(path) < conversational(withId) * 0.5) return withId;
  return path;
}
