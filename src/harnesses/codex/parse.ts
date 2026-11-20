import { posix } from "node:path";
import { projectFromCwd } from "../../sessions/repo.js";
import type { EventKind, Step, SubagentStep, ToolAction, ToolStep, Usage } from "../../schema.js";
import { TurnBuilder, UnsupportedFormatError, baseSession, bump, estimateCosts, type AdapterOptions, type AdapterResult, type DropCounts } from "../shared.js";
import { linkSubagentRuns, type SubagentRun } from "../subagent-runs.js";
import { lines, parseLine } from "../summary-kit.js";
import type { CodexSidecar } from "./files.js";
import { readCodexRun } from "./subagents.js";

/**
 * Codex rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`), history mode `paginated` (current
 * CLIs). Format notes: docs/harnesses/codex.md.
 *
 * Every turn is written twice: `response_item` lines are what the model saw, `event_msg` `item_completed` lines the
 * display stream. Prompts come from the display stream (what the user typed: `UserMessage`), the model's text,
 * reasoning and tool calls from `response_item`, and the commands a code-mode `exec` call ran from the display
 * stream's `CommandExecution` items, one tool step each. Usage is one `token_usage_record` per model response.
 *
 * Never copied: the header's base instructions and account ids, `world_state`, `turn_context` beyond model and effort,
 * developer messages, injected context (AGENTS.md, environment, skill bodies), `additional_tools`, and every encrypted
 * blob (reasoning, a spawned agent's message). The final re-scan cannot tell an encrypted blob from text, so they are
 * dropped here.
 */

type Entry = Record<string, any>;

/** A Fernet token: how Codex stores encrypted reasoning and the messages agents send each other. */
export const ENCRYPTED_BLOB = /^gAAAA[\w-]{20,}={0,2}$/;

const isObj = (v: unknown): v is Entry => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const firstLine = (s: string): string => s.trim().split("\n", 1)[0] ?? "";
/** A word from the transcript that ends up in a fixed message: only a plain identifier, else a placeholder. */
const word = (v: unknown, fallback: string): string => (typeof v === "string" && /^[\w.:/-]{1,60}$/.test(v) ? v : fallback);

/** A Fernet token inside other text (a command's output that printed a rollout, a script that quotes one). */
const EMBEDDED_BLOB = /gAAAAA[\w-]{40,}={0,2}/g;

/** Every string in `v` with embedded encrypted blobs replaced by `[encrypted]`; `found.n` counts them. */
export function scrubEmbedded<T>(v: T, found: { n: number }): T {
  if (typeof v === "string") {
    return v.replace(EMBEDDED_BLOB, () => {
      found.n++;
      return "[encrypted]";
    }) as T;
  }
  if (Array.isArray(v)) return v.map((x) => scrubEmbedded(x, found)) as T;
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubEmbedded(x, found)])) as T;
  return v;
}

/** The legacy history format (CLI before paginated history): not read yet (ove-l2s7). */
export const LEGACY_MESSAGE = "This Codex rollout uses the legacy history format (older Codex CLIs), which overshare does not read yet.";

/** `v` without any encrypted blob (an object loses the key, an array the item); `found.n` counts what was removed. */
export function withoutEncrypted(v: unknown, found: { n: number }): unknown {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      if (typeof x === "string" && ENCRYPTED_BLOB.test(x)) found.n++;
      else out.push(withoutEncrypted(x, found));
    }
    return out;
  }
  if (isObj(v)) {
    const out: Entry = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && ENCRYPTED_BLOB.test(x)) found.n++;
      else out[k] = withoutEncrypted(x, found);
    }
    return out;
  }
  return v;
}

/** The text of a content list (`input_text` / `output_text` / `text` items), or a plain string. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => isObj(c) && typeof c.text === "string" && /^(input_|output_)?text$/.test(String(c.type)))
    .map((c) => c.text as string)
    .join("\n");
}

/** A tool output: a string, a content list, or `{ content, success }`. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return contentText(output);
  if (isObj(output)) return typeof output.content === "string" ? output.content : contentText(output.content);
  return "";
}

/** `input_tokens` includes the cached ones; reasoning is part of the output (our convention too). */
export function codexUsage(u: Entry): Usage {
  const cached = num(u.cached_input_tokens);
  return {
    input: Math.max(0, num(u.input_tokens) - cached),
    output: num(u.output_tokens),
    cacheRead: cached,
    cacheWrite: num(u.cache_write_input_tokens),
    reasoning: num(u.reasoning_output_tokens),
  };
}

/** The shell command a `CommandExecution` ran: the script given to `bash -lc`, else the argv joined. */
function commandText(item: Entry): string {
  const argv = Array.isArray(item.command) ? item.command.filter((a: unknown): a is string => typeof a === "string") : [];
  if (argv.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv.slice(2).join(" ");
  if (argv.length) return argv.join(" ");
  if (typeof item.command === "string") return item.command;
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
  return parsed.map((p: Entry) => str(p?.cmd) ?? "").filter(Boolean).join(" && ");
}

const SKILL_FILE = "SKILL.md";

/**
 * One command as a tool step. `parsed_cmd` says what it did: only reads is a `read` of those files, reads and searches
 * a `search`, anything else (`unknown`) an `exec`. A non-zero exit code is an error.
 */
function commandStep(item: Entry, timestamp: string | undefined, cwd: string | undefined): ToolStep {
  const cmd = commandText(item);
  const parsed: Entry[] = (Array.isArray(item.parsed_cmd) ? item.parsed_cmd : []).filter(isObj);
  const types = parsed.map((p) => p.type);
  const base = str(item.cwd) ?? cwd;
  const files = parsed
    .filter((p) => p.type === "read" && str(p.path))
    .map((p) => (posix.isAbsolute(p.path) || !base ? (p.path as string) : posix.join(base, p.path)));
  const action: ToolAction =
    types.length && types.every((t) => t === "read") && files.length ? "read" : types.length && types.every((t) => t === "read" || t === "search" || t === "list_files") ? "search" : "exec";
  const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
  const isError = (exit !== undefined && exit !== 0) || item.status === "failed" || item.status === "declined";
  const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
  return {
    kind: "tool",
    id: str(item.id) ?? `cmd-${cmd.length}`,
    ...(timestamp ? { timestamp } : {}),
    name: "exec_command",
    action,
    summary: action === "read" ? files.join(", ") : firstLine(cmd),
    ...(action === "read" ? { files } : {}),
    input: { cmd },
    result: { text: output, ...(isError ? { isError: true } : {}) },
    ...(isError ? { isError: true } : {}),
  };
}

/** A web search (`Extension`, kind `web.search`): the query, and the titles and links it found. */
function webStep(item: Entry, timestamp: string | undefined): ToolStep {
  const action = isObj(item.action) ? item.action : {};
  const target = str(item.query) ?? str(action.query) ?? str(action.url) ?? "";
  const results = (Array.isArray(item.results) ? item.results : []).filter(isObj).map((r) => [str(r.title), str(r.url)].filter(Boolean).join(" — "));
  return {
    kind: "tool",
    id: str(item.id) ?? `web-${target.length}`,
    ...(timestamp ? { timestamp } : {}),
    name: "web_search",
    action: "web",
    summary: firstLine(target),
    input: { ...(str(action.type) ? { action: action.type } : {}), query: target },
    result: { text: results.join("\n") },
  };
}

/** The files an `apply_patch` touches, from its `*** Update File:` / `*** Add File:` / `*** Delete File:` headers. */
function patchFiles(patch: string): { files: string[]; adds: boolean; edits: boolean } {
  const files: string[] = [];
  let adds = false;
  let edits = false;
  for (const m of patch.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)) {
    files.push(m[2]!.trim());
    if (m[1] === "Add") adds = true;
    else edits = true;
  }
  return { files, adds, edits };
}

/** Commands a non-code-mode session runs through a function call; their `CommandExecution` items repeat them. */
const SHELL_TOOLS = new Set(["shell", "shell_command", "local_shell", "exec_command", "container.exec"]);

interface ExecCall {
  step: ToolStep;
  /** Commands and searches it ran: when it ran none, the call itself is shown. */
  children: number;
}

export function parseCodex(raw: string, options: AdapterOptions = {}): AdapterResult {
  const sidecar: CodexSidecar = isObj(options.sidecar) ? (options.sidecar as CodexSidecar) : {};
  // A continuation (or fork) rollout keeps history from earlier rollouts: read it first, then this file's own lines.
  const history = (Array.isArray(sidecar.history) ? sidecar.history : []).filter((h) => isObj(h) && typeof h.raw === "string");
  const text = history.length ? `${history.map((h) => h.raw).join("\n")}\n${raw}` : raw;
  const dropped: DropCounts = {};
  const b = new TurnBuilder();
  const models: string[] = [];
  let meta: Entry | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  /** Model output since the last usage record: the next record names the response it came from. */
  let unassigned: Step[] = [];
  /** `exec` calls whose output has not arrived; the commands they run are reported in between. */
  const openExec = new Map<string, ExecCall>();
  let latestExec: ExecCall | undefined;
  /** Shell function calls still waiting for their output (their `CommandExecution` items are not shown twice). */
  const openShell = new Set<string>();
  /** Spawned agents, by call id, for their output. */
  const spawns = new Map<string, SubagentStep>();
  /** Spawn steps not yet matched to the thread they started (`SubAgentActivity` names it), with their task name. */
  const unmatchedSpawns: { step: SubagentStep; task?: string }[] = [];
  /** A child replays its parent's history before this ordinal: that part is the parent's (its usage is inherited). */
  let ownFrom = 0;
  let inherited = false;
  /** A usage record with no step of its own: the call a compaction that follows was made with. */
  let bareRecord: { id: string } | undefined;
  /** Calls checkpoints name as the ones they were made with (`compaction_response_id`). */
  const compactionCalls = new Set<string>();
  /** Rollouts with `compacted` lines also mark the compaction as an item; one of the two is enough. */
  const hasCompactedLines = text.includes('"type":"compacted"');
  /** Events read before the prompt of the turn they belong to (a model switch is recorded first). */
  let pending: { event: EventKind; text: string; timestamp?: string }[] = [];
  /**
   * Older files have only `token_count` events; current ones repeat in them what `token_usage_record` says. Only a
   * record that parses counts: a torn last line must not turn the fallback off.
   */
  const hasRecords = text.includes('"type":"token_usage_record"') && [...lines(text)].some((l) => l.includes('"type":"token_usage_record"') && isObj(parseLine(l)));
  let lastTotal: string | undefined;
  let records = 0;

  const flushPending = () => {
    for (const p of pending) b.addEvent(p.event, p.text, p.timestamp);
    pending = [];
  };
  const output = (step: Step) => {
    bareRecord = undefined;
    flushPending();
    b.responseStarted();
    b.addStep(step);
    unassigned.push(step);
  };
  const encrypted = (v: unknown): unknown => {
    const found = { n: 0 };
    const out = withoutEncrypted(v, found);
    if (found.n) bump(dropped, "encrypted-blob", found.n);
    return out;
  };
  const recordUsage = (id: string, usage: Usage, timestamp: string | undefined) => {
    records += 1;
    bareRecord = unassigned.length === 0 ? { id } : undefined;
    for (const s of unassigned) s.responseId ??= id;
    unassigned = [];
    b.setResponseUsage(id, usage, { model, timestamp, ...(inherited ? { inherited: true } : {}) });
  };
  const compaction = (detail: string | undefined, ts: string | undefined) => {
    flushPending();
    // The summary call itself, when its usage was recorded before the checkpoint with no reply of its own.
    const call = bareRecord ? b.responses.find((r) => r.id === bareRecord!.id) : undefined;
    if (call) call.purpose = "compaction";
    bareRecord = undefined;
    b.addEvent("compaction", "Context compacted", ts, detail);
  };
  /** A command or search a call ran: under the open `exec` call, with its response. */
  const addChild = (step: ToolStep) => {
    bareRecord = undefined;
    flushPending();
    const parent = latestExec;
    if (parent) {
      parent.children += 1;
      if (parent.step.responseId) step.responseId = parent.step.responseId;
      else unassigned.push(step);
    } else unassigned.push(step);
    b.addStep(step);
    if (step.action === "read" && !step.isError) {
      for (const f of step.files ?? []) {
        const parts = f.split("/").filter(Boolean);
        if (parts.at(-1) === SKILL_FILE && parts.length >= 2 && parts.at(-2) !== "." && parts.at(-2) !== "..") b.addSkill(parts.at(-2)!, "model", step.timestamp);
      }
    }
  };

  /** Every line to read, with whether it is another thread's history: this rollout's header, the kept history, the rest. */
  function* source(): Generator<{ line: string; from?: { inherited: boolean } }> {
    const own = lines(raw);
    const first = own.next();
    if (!first.done) yield { line: first.value };
    for (const h of history) for (const line of lines(h.raw)) yield { line, from: { inherited: h.inherited } };
    for (const line of own) yield { line };
  }

  for (const { line, from } of source()) {
    const e = parseLine(line);
    if (!isObj(e)) continue;
    const ts = str(e.timestamp);
    if (ts) {
      startedAt ??= ts;
      endedAt = ts;
    }
    const p: Entry = isObj(e.payload) ? e.payload : {};
    // Kept history from another thread (a fork's parent) is inherited; so is what a subagent replays before its own part.
    inherited = from ? from.inherited : typeof e.ordinal === "number" && e.ordinal < ownFrom;
    // The kept history's own headers are the earlier rollouts': this rollout's comes first and is the one used.
    if (from && e.type === "session_meta") continue;
    switch (e.type) {
      case "session_meta":
        // A subagent's rollout has a second one, its parent's: the first is this thread's.
        if (!meta) {
          meta = p;
          if (typeof p.subagent_history_start_ordinal === "number") ownFrom = p.subagent_history_start_ordinal;
        }
        break;
      case "compacted":
        // A checkpoint: `message` is the summary that replaced the history (`replacement_history`, never copied).
        // `compaction_response_id` names the call that made it, which may be recorded before or after this line.
        if (str(p.compaction_response_id)) compactionCalls.add(p.compaction_response_id);
        compaction(str(p.message), ts);
        if (p.replacement_history !== undefined) bump(dropped, "compacted-history");
        break;
      case "turn_context": {
        const settings = isObj(p.collaboration_mode) && isObj(p.collaboration_mode.settings) ? p.collaboration_mode.settings : {};
        const m = str(p.model) ?? str(settings.model);
        const eff = str(p.effort) ?? str(settings.reasoning_effort);
        if (m) {
          if (model && m !== model) pending.push({ event: "model_change", text: `Model → ${m}`, timestamp: ts });
          model = m;
          if (!models.includes(m)) models.push(m);
        }
        if (eff) {
          if (effort && eff !== effort) pending.push({ event: "thinking_level", text: `Reasoning effort → ${word(eff, "changed")}`, timestamp: ts });
          effort = eff;
        }
        break;
      }
      case "response_item":
        // Output a compaction generated (its summary) is not a reply the user saw; Codex marks it in the line's metadata.
        if (isObj(e.metadata) && e.metadata.compaction_output === true) {
          bump(dropped, "compaction-output");
          break;
        }
        responseItem(p, ts);
        break;
      case "event_msg":
        eventMsg(p, ts);
        break;
      case "token_usage_record":
        if (isObj(p.usage)) recordUsage(str(p.response_id) ?? `r${records + 1}`, codexUsage(p.usage), ts);
        break;
      case "world_state":
        bump(dropped, "world_state");
        break;
      case "inter_agent_communication_metadata":
        break;
      default:
        bump(dropped, `line:${word(e.type, "unknown")}`);
    }
  }

  function responseItem(p: Entry, ts: string | undefined): void {
    switch (p.type) {
      case "message": {
        if (p.role === "assistant") {
          const text = contentText(p.content).trim();
          if (text) output({ kind: "text", id: b.nextId("t"), ...(ts ? { timestamp: ts } : {}), text, ...(model ? { model } : {}) });
        } else if (p.role === "developer" || p.role === "system") bump(dropped, "developer-message");
        else if (p.role === "user") {
          // What the user typed is the `UserMessage` item; the rest is context Codex injected (AGENTS.md, the
          // environment, a skill's body, an abort notice).
          const kinds: unknown[] = Array.isArray(p.internal_chat_message_metadata_passthrough?.content_item_kinds) ? p.internal_chat_message_metadata_passthrough.content_item_kinds : [];
          if (!(kinds.length > 0 && kinds.every((k) => k === "user.text"))) bump(dropped, "injected-context");
        } else bump(dropped, `message:${word(p.role, "other")}`);
        break;
      }
      case "reasoning": {
        // Usually only `encrypted_content`, with an empty summary: a block with no text.
        const summary = (Array.isArray(p.summary) ? p.summary : []).filter(isObj).map((s) => str(s.text) ?? "");
        const content = (Array.isArray(p.content) ? p.content : []).filter(isObj).map((s) => str(s.text) ?? "");
        const text = (summary.some(Boolean) ? summary : content).filter(Boolean).join("\n\n");
        if (p.encrypted_content) bump(dropped, "encrypted-reasoning");
        output({ kind: "thinking", id: b.nextId("k"), ...(ts ? { timestamp: ts } : {}), chars: text.length, blocks: 1, ...(text ? { text } : {}) });
        break;
      }
      case "custom_tool_call": {
        const callId = str(p.call_id) ?? b.nextId("c");
        const input = typeof p.input === "string" ? p.input : "";
        if (p.name === "exec") {
          // Code mode: JavaScript calling the real tools. Its commands are shown; the script only when it ran none.
          const step: ToolStep = { kind: "tool", id: callId, ...(ts ? { timestamp: ts } : {}), name: "exec", action: "other", summary: firstLine(input), input: { code: input } };
          const call: ExecCall = { step, children: 0 };
          openExec.set(callId, call);
          latestExec = call;
          flushPending();
          b.responseStarted();
          unassigned.push(step);
          break;
        }
        flushPending();
        b.responseStarted();
        b.addToolCall(callId, p.name, encrypted({ input }), { ...(ts ? { timestamp: ts } : {}) });
        const step = b.current.steps.at(-1);
        if (step?.kind === "tool") {
          unassigned.push(step);
          if (p.name === "apply_patch") {
            const { files, adds, edits } = patchFiles(input);
            step.action = adds && !edits ? "write" : "edit";
            step.summary = files.join(", ");
            if (files.length) step.files = files;
            step.input = { patch: input };
          }
        }
        break;
      }
      case "custom_tool_call_output": {
        const callId = str(p.call_id) ?? "";
        const call = openExec.get(callId);
        if (call) {
          openExec.delete(callId);
          if (latestExec === call) latestExec = undefined;
          // The commands' own outputs are already shown; this repeats them (or is a script's own result).
          if (call.children === 0) {
            call.step.result = { text: outputText(p.output) };
            b.addStep(call.step);
          }
        } else b.attachToolResult(callId, { text: outputText(p.output) });
        break;
      }
      case "function_call": {
        const callId = str(p.call_id) ?? b.nextId("c");
        let args: unknown;
        try {
          args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
        } catch {
          args = { arguments: p.arguments };
        }
        args = encrypted(args);
        flushPending();
        b.responseStarted();
        if (p.name === "spawn_agent") {
          const a = isObj(args) ? args : {};
          const agent = str(a.task_name) ?? str(a.agent_type) ?? str(a.name);
          // The agent runs in the background; the call's output only says where it is.
          const step: SubagentStep = { kind: "subagent", id: callId, ...(ts ? { timestamp: ts } : {}), tool: "spawn_agent", agents: agent ? [agent] : [], async: true };
          b.addStep(step);
          b.trackSubagent(step);
          spawns.set(callId, step);
          unmatchedSpawns.push({ step, task: str(a.task_name) });
          unassigned.push(step);
          bareRecord = undefined;
          break;
        }
        b.addToolCall(callId, p.name, args, { ...(ts ? { timestamp: ts } : {}) });
        const step = b.current.steps.at(-1);
        if (step && step.kind !== "event") unassigned.push(step);
        if (SHELL_TOOLS.has(String(p.name))) openShell.add(callId);
        break;
      }
      case "function_call_output": {
        const callId = str(p.call_id) ?? "";
        const text = outputText(p.output);
        const failed = isObj(p.output) && p.output.success === false;
        openShell.delete(callId);
        const spawn = spawns.get(callId);
        if (spawn) {
          spawns.delete(callId);
          spawn.result = { text, ...(failed ? { isError: true } : {}) };
          if (failed) spawn.isError = true;
        } else b.attachToolResult(callId, { text, ...(failed ? { isError: true } : {}) });
        break;
      }
      case "agent_message": {
        // A message from another agent (a subagent's result). Its body is encrypted; who sent it is not.
        bump(dropped, "agent-message");
        b.addNotice("subagent_notice", `Message from ${word(p.author, "an agent")}`, ts);
        break;
      }
      case "additional_tools":
        bump(dropped, "additional_tools");
        break;
      case "compaction":
      case "compaction_summary":
        // An opaque (encrypted) compaction item.
        bump(dropped, "compaction-output");
        break;
      default:
        bump(dropped, `response_item:${word(p.type, "unknown")}`);
    }
  }

  function eventMsg(p: Entry, ts: string | undefined): void {
    switch (p.type) {
      case "item_completed":
        if (isObj(p.item)) completedItem(p.item, ts);
        break;
      case "turn_aborted":
        flushPending();
        b.addEvent("interrupted", p.reason === "interrupted" ? "Interrupted by user" : `Turn aborted (${word(p.reason, "unknown reason")})`, ts);
        b.idle = true;
        break;
      case "task_complete":
        if (isObj(p.error)) {
          flushPending();
          b.addEvent("error", firstLine(str(p.error.message) ?? "") || "Error", ts);
        }
        b.idle = true;
        break;
      case "token_count": {
        // Only for files without usage records: each change of the running total is one response.
        if (hasRecords || !isObj(p.info) || !isObj(p.info.last_token_usage)) break;
        const total = JSON.stringify(p.info.total_token_usage ?? null);
        if (total === lastTotal) break;
        lastTotal = total;
        recordUsage(`tc${records + 1}`, codexUsage(p.info.last_token_usage), ts);
        break;
      }
      default:
    }
  }

  function completedItem(item: Entry, ts: string | undefined): void {
    switch (item.type) {
      case "UserMessage": {
        const content: Entry[] = (Array.isArray(item.content) ? item.content : []).filter(isObj);
        const text = content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n")
          .trim();
        const images = content.filter((c) => /image/i.test(String(c.type))).length;
        const skills = content.filter((c) => c.type === "skill" && str(c.name)).map((c) => c.name as string);
        if (!text && !images) {
          bump(dropped, "empty-user");
          return;
        }
        const command = skills.length ? /^(\$[\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text) : null;
        b.startTurn(
          {
            text,
            authored: true,
            ...(command ? { command: { name: command[1]!, ...(command[2]?.trim() ? { args: command[2].trim() } : {}) } } : {}),
            ...(images ? { images } : {}),
          },
          ts,
        );
        flushPending();
        for (const s of skills) b.addSkill(s, "user", ts);
        return;
      }
      case "CommandExecution":
        // A shell function call's command is already its own step (its output comes as the call's output).
        if (!latestExec && openShell.size > 0) return;
        addChild(commandStep(item, ts, str(meta?.cwd)));
        return;
      case "Extension":
        if (item.kind === "web.search") addChild(webStep(item, ts));
        return;
      case "SubAgentActivity": {
        // A spawned agent started: which thread it is, so its rollout links to the spawn step.
        const thread = str(item.agent_thread_id);
        if (item.kind !== "started" || !thread) return;
        // The item's id is the spawn call's id. Older or other builds: the spawn whose task name is the last part of
        // the agent's path (`/root/explorer`), else the latest one.
        const name = str(item.agent_path)?.split("/").at(-1);
        let at = unmatchedSpawns.findIndex((s) => s.step.id === item.id);
        for (let i = unmatchedSpawns.length - 1; at < 0 && i >= 0; i--) {
          if (unmatchedSpawns[i]!.task !== undefined && unmatchedSpawns[i]!.task === name) at = i;
        }
        if (at < 0) at = unmatchedSpawns.length - 1;
        const spawn = at >= 0 ? unmatchedSpawns.splice(at, 1)[0] : undefined;
        if (spawn) b.trackSubagent(spawn.step, thread);
        return;
      }
      case "ContextCompaction":
        if (!hasCompactedLines) compaction(undefined, ts);
        return;
      default:
      // AgentMessage and Reasoning repeat response items.
    }
  }

  // Legacy rollouts write `user_message` / `agent_message` events instead of display items: read as paginated, they
  // would give a share without prompts. Refuse them plainly instead.
  if (meta?.history_mode === "legacy" || (!text.includes('"type":"item_completed"') && /"type":"event_msg","payload":\{"type":"(user_message|agent_message)"/.test(text))) {
    throw new UnsupportedFormatError(LEGACY_MESSAGE);
  }
  flushPending();
  b.finalizeThinking();
  // Codex records tokens, not dollars: costs are estimated at list price.
  estimateCosts(b.responses);
  for (const r of b.responses) if (compactionCalls.has(r.id)) r.purpose = "compaction";
  // The spawned agents' own rollouts: their spend, linked to the steps that spawned them.
  const runs = (options.subagentFiles ?? []).map(readCodexRun).filter((r): r is SubagentRun => r !== undefined);
  const endMs = endedAt ? Date.parse(endedAt) : Number.NaN;
  const subagentUsage = linkSubagentRuns(b, runs, { summaryUntil: Number.isFinite(endMs) ? endMs : undefined });

  const session = baseSession("codex", str(meta?.id) ?? "");
  if (sidecar.title) session.title = sidecar.title;
  if (str(meta?.cli_version)) session.harness.version = meta!.cli_version;
  const cwd = str(meta?.cwd);
  const branch = isObj(meta?.git) ? str(meta.git.branch) : undefined;
  session.project = { cwd, ...projectFromCwd(cwd), ...(branch ? { branch } : {}) };
  session.startedAt = startedAt;
  session.endedAt = endedAt;
  session.models = models;
  // Encrypted blobs can also arrive inside other text (a command that printed a rollout): none may reach a share.
  const embedded = { n: 0 };
  session.turns = scrubEmbedded(b.turns, embedded);
  if (embedded.n) bump(dropped, "encrypted-blob", embedded.n);
  session.responses = b.responses;
  session.stats.costSource = "estimated";
  if (subagentUsage) session.stats.subagentUsage = subagentUsage;
  return { session, dropped };
}
