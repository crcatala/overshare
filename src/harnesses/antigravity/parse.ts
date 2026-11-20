import { projectFromCwd } from "../../sessions/repo.js";
import type { ToolAction, ToolStep, Usage } from "../../schema.js";
import { TurnBuilder, baseSession, bump, describeTool, estimateCosts, type AdapterOptions, type AdapterResult, type DropCounts } from "../shared.js";
import { lines, parseLine } from "../summary-kit.js";
import { SHORTENED, projectWorkspace, type AntigravitySidecar } from "./files.js";

/**
 * Antigravity's `transcript_full.jsonl` (ACP 1.5.x as T3 Code runs it, plus the step types `agy` 1.0.x wrote), with
 * what only the conversation's database has from the sidecar: working directory, tool-call ids, full outputs of
 * shortened tool results. Format notes: docs/harnesses/antigravity.md.
 *
 * One line per step: `step_index`, `type`, `source`, `status`, `created_at`. A model response (`PLANNER_RESPONSE`)
 * holds its text, thinking, tool calls and usage; each tool result is a step of its own (`GENERIC`), answering a call
 * by an id only the database knows. The transcript can skip steps, so results are never paired by position alone.
 */

type Entry = Record<string, any>;

const isObj = (v: unknown): v is Entry => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const firstLine = (s: string): string => s.trim().split("\n", 1)[0] ?? "";
/** A count as Antigravity writes it: a JSON number, or a numeric string. */
const count = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Step types seen in transcripts: ACP 1.5.x, and the tool steps of `agy` 1.0.x. */
export const STEP_TYPES = new Set(["USER_INPUT", "PLANNER_RESPONSE", "GENERIC", "SYSTEM_MESSAGE", "ERROR_MESSAGE", "CHECKPOINT", "RUN_COMMAND", "VIEW_FILE", "LIST_DIRECTORY"]);
export const STEP_SOURCES = /^(USER_[A-Z_]+|MODEL|SYSTEM)$/;

/** What the user typed, from a `USER_INPUT`, and the settings changes that came with it. */
export function unwrapPrompt(content: string): { text: string; settings: string[] } {
  const request = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)?.[1];
  // Under T3 Code the first prompt starts with T3's instructions, then what the user typed in `<user_request>` (then
  // `<runtime_info>`). Only that shape is unwrapped: a plain prompt that mentions `<user_request>` stays whole.
  let nested: string | undefined;
  const t3 = request?.trimStart().startsWith("<t3_code_instructions>") ? request.slice(request.indexOf("</t3_code_instructions>") + "</t3_code_instructions>".length) : undefined;
  if (t3 !== undefined) {
    const open = t3.indexOf("<user_request>");
    const close = t3.lastIndexOf("</user_request>");
    if (open >= 0 && close > open) nested = t3.slice(open + "<user_request>".length, close);
  }
  const text = (nested ?? request ?? (/<[A-Z_]+>/.test(content) ? "" : content)).trim();
  const settings = [...content.matchAll(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/g)].map((m) => m[1]!.trim()).filter(Boolean);
  return { text, settings };
}

/** A settings change as an event: the model (which in Antigravity includes the thinking level), or a thinking setting. */
function settingEvent(change: string): { event: "model_change" | "thinking_level"; text: string } | undefined {
  const m = /changed setting `([^`]{1,60})` from (.{1,80}?) to (.{1,80}?)\.(\s|$)/.exec(change);
  if (!m) return undefined;
  const [, setting, from, to] = m;
  // The first selection in a conversation is a starting point, not a change.
  if (from === "None") return undefined;
  if (/model/i.test(setting!)) return { event: "model_change", text: `Model → ${to}` };
  if (/thinking|reasoning|effort/i.test(setting!)) return { event: "thinking_level", text: `${setting} → ${to}` };
  return undefined;
}

/** How a tool call reads: Antigravity's own tool names and argument keys, else the generic reading. */
export function describeAntigravityTool(name: string, args: Entry): { action: ToolAction; summary: string; files?: string[] } {
  const path = str(args.Path) ?? str(args.AbsolutePath) ?? str(args.TargetFile) ?? str(args.DirectoryPath);
  const n = name.toLowerCase();
  if (n === "run_command") return { action: "exec", summary: firstLine(str(args.CommandLine) ?? "") };
  if (n === "read_file" || n === "view_file" || n === "view_file_outline") return { action: "read", summary: path ?? "", ...(path ? { files: [path] } : {}) };
  if (n === "edit_file" || n === "replace_file_content" || n === "multi_replace_file_content") return { action: "edit", summary: path ?? "", ...(path ? { files: [path] } : {}) };
  if (n === "write_file" || n === "write_to_file") return { action: "write", summary: path ?? "", ...(path ? { files: [path] } : {}) };
  if (n === "search_web") return { action: "web", summary: firstLine(str(args.query) ?? "") };
  if (n === "read_url" || n === "read_url_content") return { action: "web", summary: firstLine(str(args.Url) ?? str(args.url) ?? "") };
  if (n === "list_dir" || n === "list_directory" || n === "grep_search" || n === "find_by_name") return { action: "search", summary: firstLine([str(args.Query) ?? str(args.Pattern), path].filter(Boolean).join(" in ")) };
  if (n === "manage_task") return { action: "other", summary: firstLine([str(args.Action), str(args.TaskId)].filter(Boolean).join(" ")) };
  // MCP tools (`mcp_<server>_<tool>`) and anything new: the tool's own summary when it gives one.
  const generic = describeTool(name, args);
  return { ...generic, summary: str(args.toolSummary) ? firstLine(args.toolSummary) : generic.summary };
}

/** What replaces a field the shortened `transcript.jsonl` cut (its middle was removed before any redaction). */
export const SHORTENED_FIELD = "[Shortened by Antigravity; not shared]";

/**
 * A step from `transcript.jsonl` (the fallback when `transcript_full.jsonl` is missing) lists the fields it shortened
 * in `truncated_fields`. A cut field can end inside a secret no pattern then matches, so it is replaced, never shared:
 * text by a marker, tool calls by their names alone.
 */
function withoutShortenedFields(e: Entry, dropped: DropCounts): Entry {
  if (!Array.isArray(e.truncated_fields) || !e.truncated_fields.length) return e;
  const out: Entry = { ...e };
  for (const f of e.truncated_fields) {
    if (typeof f !== "string" || !(f in out)) continue;
    if (f === "tool_calls" && Array.isArray(out.tool_calls)) out.tool_calls = out.tool_calls.map((c: unknown) => ({ name: isObj(c) ? c.name : "unknown", args: { note: SHORTENED_FIELD } }));
    else if (typeof out[f] === "string") out[f] = SHORTENED_FIELD;
    else delete out[f];
    bump(dropped, "shortened-field");
  }
  return out;
}

/** A tool result's text without the `Created At` / `Completed At` lines Antigravity puts first. */
const resultBody = (content: string): string => content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, "");

/** The result of a call whose step Antigravity left out of the transcript (status 6: it did not run). */
export const SKIPPED_RESULT = "[Not run: Antigravity cancelled this step]";

/** What replaces a shortened preview whose full output file is gone: the preview may end inside a secret, so it is not shared. */
export const MISSING_OUTPUT = "[Antigravity shortened this output and its full copy is gone; the shortened preview is not shared]";

export function parseAntigravity(raw: string, options: AdapterOptions = {}): AdapterResult {
  const sidecar: AntigravitySidecar & { id?: string } = isObj(options.sidecar) ? (options.sidecar as AntigravitySidecar) : {};
  const dropped: DropCounts = {};
  const b = new TurnBuilder();
  const models: string[] = [];
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  /** Calls of the latest model response still waiting for a result, for pairing by position without the database. */
  let positional: { ids: string[]; at: number } | undefined;
  const hasDb = isObj(sidecar.answers);

  for (const line of lines(raw)) {
    const parsed = parseLine(line);
    if (!isObj(parsed) || typeof parsed.step_index !== "number" || typeof parsed.type !== "string") continue;
    const e = withoutShortenedFields(parsed, dropped);
    const idx = e.step_index;
    const ts = str(e.created_at);
    if (ts) {
      startedAt ??= ts;
      endedAt = ts;
    }
    const content = typeof e.content === "string" ? e.content : "";
    const images = Array.isArray(e.media) ? e.media.filter((m: unknown) => isObj(m) && /^image\//.test(String(m.mime_type))).length : 0;
    // A gap in the step sequence breaks pairing by position.
    if (positional && idx !== positional.at + 1) positional = undefined;
    switch (e.type) {
      case "USER_INPUT": {
        const { text, settings } = unwrapPrompt(content);
        if (!text && !images) {
          bump(dropped, "empty-user");
          break;
        }
        b.startTurn({ text, authored: true, ...(images ? { images } : {}) }, ts);
        for (const s of settings) {
          const ev = settingEvent(s);
          if (ev) b.addEvent(ev.event, ev.text, ts);
        }
        if (content.includes("<ADDITIONAL_METADATA>") || text !== content.trim()) bump(dropped, "injected-context");
        positional = undefined;
        break;
      }
      case "PLANNER_RESPONSE": {
        b.responseStarted();
        const responseId = `step-${idx}`;
        // As written (`gemini-4-neon-high`, the thinking level included); the database's base model when missing.
        const model = str(e.model) ?? sidecar.models?.[idx];
        if (model && !models.includes(model)) models.push(model);
        const thinking = typeof e.thinking === "string" ? e.thinking.trim() : "";
        if (thinking) b.addStep({ kind: "thinking", id: b.nextId("k"), ...(ts ? { timestamp: ts } : {}), responseId, chars: thinking.length, blocks: 1, text: thinking });
        if (content.trim()) b.addStep({ kind: "text", id: b.nextId("t"), ...(ts ? { timestamp: ts } : {}), responseId, text: content.trim(), ...(model ? { model } : {}) });
        const calls: Entry[] = (Array.isArray(e.tool_calls) ? e.tool_calls : []).filter(isObj);
        const ids = sidecar.calls?.[idx] ?? [];
        const callIds = calls.map((_, i) => ids[i] || `${responseId}-call-${i}`);
        calls.forEach((call, i) => {
          const name = str(call.name) ?? "unknown";
          const args: Entry = isObj(call.args) ? call.args : {};
          b.addToolCall(callIds[i]!, name, args, { ...(ts ? { timestamp: ts } : {}), responseId });
          const step = b.current.steps.at(-1);
          if (step?.kind === "tool") Object.assign(step, describeAntigravityTool(name, args));
        });
        positional = !hasDb && calls.length ? { ids: callIds, at: idx } : undefined;
        const usage: Usage = { input: count(e.input_tokens), output: count(e.output_tokens), cacheRead: count(e.cache_read_tokens), cacheWrite: count(e.cache_write_tokens), reasoning: 0 };
        // The database splits the output into thinking and reply and records cache writes (Claude models). Used only
        // when it agrees with the transcript on what both record; otherwise the transcript stands, and the report says so.
        const db = sidecar.usage?.[idx];
        if (db) {
          if (db.input === usage.input && db.output === usage.output && db.cacheRead === usage.cacheRead) {
            usage.reasoning = Math.min(db.thinking, usage.output);
            usage.cacheWrite = Math.max(usage.cacheWrite, db.cacheWrite);
          } else bump(dropped, "db-usage-mismatch");
        }
        if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) b.setResponseUsage(responseId, usage, { model, timestamp: ts });
        b.idle = calls.length === 0;
        break;
      }
      case "GENERIC": {
        b.idle = false;
        // The full output when the transcript shortened it; never the shortened preview (it may end inside a secret).
        let text = resultBody(content);
        if (SHORTENED.test(content)) {
          const full = sidecar.outputs?.[idx];
          text = typeof full === "string" ? full : MISSING_OUTPUT;
          if (typeof full !== "string") bump(dropped, "shortened-output");
        }
        const result = { text, ...(images ? { images } : {}) };
        let callId = sidecar.answers?.[idx];
        if (!callId && positional) {
          callId = positional.ids.shift();
          positional.at = idx;
          if (!positional.ids.length) positional = undefined;
        }
        if (!callId || !b.attachToolResult(callId, result)) {
          // A result whose call is unknown (no database, and the steps around it do not line up): shown on its own.
          const step: ToolStep = { kind: "tool", id: b.nextId("r"), ...(ts ? { timestamp: ts } : {}), name: "tool", action: "other", summary: "result of a call this transcript does not identify", result };
          b.addStep(step);
          bump(dropped, "unpaired-result");
        }
        break;
      }
      case "SYSTEM_MESSAGE": {
        const at = content.lastIndexOf("<SYSTEM_MESSAGE>");
        const inner = (at >= 0 ? content.slice(at + "<SYSTEM_MESSAGE>".length) : content).split("</SYSTEM_MESSAGE>")[0]!.trim();
        // A message to the agent (a background task finished); anything else is an injected reminder.
        const message = /^\[Message\][^\n]*?\bcontent=([\s\S]*)$/.exec(inner)?.[1];
        if (message !== undefined) b.addNotice("notification", firstLine(message) || "Background task message", ts, message.trim() || undefined);
        else bump(dropped, "system-reminder");
        break;
      }
      case "ERROR_MESSAGE":
        b.addEvent("error", firstLine(str(e.error) ?? content) || "Error", ts);
        break;
      case "CHECKPOINT":
        b.addEvent("compaction", "Context compacted", ts, content.trim() || undefined);
        break;
      case "RUN_COMMAND":
      case "VIEW_FILE":
      case "LIST_DIRECTORY": {
        // `agy` 1.0.x wrote each tool use as one step: no call ids, nothing to pair.
        const name = e.type.toLowerCase();
        const args: Entry = Object.fromEntries(Object.entries(e).filter(([k]) => !["step_index", "type", "source", "status", "created_at", "content", "media"].includes(k)));
        const info = name === "view_file" ? describeAntigravityTool("view_file", { Path: args.path ?? args.Path }) : name === "run_command" ? describeAntigravityTool("run_command", { CommandLine: args.command ?? args.CommandLine }) : describeAntigravityTool("list_dir", { DirectoryPath: args.path ?? args.DirectoryPath });
        b.addStep({ kind: "tool", id: b.nextId("c"), ...(ts ? { timestamp: ts } : {}), name, ...info, input: args, result: { text: resultBody(content), ...(images ? { images } : {}) } });
        break;
      }
      default:
        bump(dropped, `step:${/^[A-Z_]{1,40}$/.test(e.type) ? e.type : "unknown"}`);
    }
  }
  // Calls whose result step the transcript left out (status 6 in the database): they did not run.
  for (const skip of Object.values(isObj(sidecar.skipped) ? sidecar.skipped : {})) {
    if (skip?.answers && b.attachToolResult(skip.answers, { text: SKIPPED_RESULT })) bump(dropped, "skipped-step");
  }
  b.finalizeThinking();
  // Antigravity records tokens, not dollars: costs are estimated at list price (by the base model).
  estimateCosts(b.responses);

  const session = baseSession("antigravity", str(sidecar.id) ?? "");
  if (sidecar.title) session.title = sidecar.title;
  const workspace = projectWorkspace(Array.isArray(sidecar.workspaces) ? sidecar.workspaces : []);
  if (workspace) session.project = { cwd: workspace.path, ...projectFromCwd(workspace.path), ...(workspace.branch ? { branch: workspace.branch } : {}) };
  session.startedAt = startedAt;
  session.endedAt = endedAt;
  session.models = models;
  session.turns = b.turns;
  session.responses = b.responses;
  session.stats.costSource = "estimated";
  return { session, dropped };
}
