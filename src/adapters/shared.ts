import { estimateCost } from "../pricing.js";
import {
  SCHEMA_VERSION,
  emptyUsage,
  type EventKind,
  type HarnessName,
  type NormalizedSession,
  type ResponsePurpose,
  type ResponseUsage,
  type Step,
  type SubagentStep,
  type ToolAction,
  type ToolResult,
  type ToolStep,
  type Turn,
  type Usage,
  type UserPrompt,
} from "../schema.js";

/** One subagent transcript that sits next to a session file (Claude Code: `<session>/subagents/agent-*.jsonl`). */
export interface SubagentFileInput {
  fileName: string;
  raw: string;
  /** The parsed `agent-*.meta.json` beside it, when there was one. */
  meta?: Record<string, unknown>;
}

export interface AdapterOptions {
  /** Export the branch ending at this entry id instead of the last entry (tree-shaped sessions). */
  leafId?: string;
  /** Subagent transcripts of the session (Claude Code only); the adapter stays pure, the caller reads them from disk. */
  subagentFiles?: SubagentFileInput[];
}

/** Counts of native entries dropped on purpose (never shared). */
export type DropCounts = Record<string, number>;

export interface AdapterResult {
  session: NormalizedSession;
  dropped: DropCounts;
}

/**
 * The first line, whole. An adapter never cuts text it hands on: the cut would happen before redaction, and a secret
 * that straddles it leaves a prefix no rule recognises (ass-7x3c). The pipeline caps it after redaction (`capRedacted`).
 */
const firstLine = (s: string): string => s.trim().split("\n", 1)[0] ?? "";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Remove harness-injected context blocks that users never typed (may contain env details). */
export function stripInjectedContext(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .trim();
}

interface ToolInfo {
  action: ToolAction;
  summary: string;
  files?: string[];
}

/** Classify a tool call by name and arguments into an action, one-line summary and touched files. */
export function describeTool(name: string, input: unknown): ToolInfo {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const n = name.toLowerCase();
  const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
  if (n === "bash" || n === "shell" || n === "exec_command") {
    return { action: "exec", summary: firstLine(str(args.command) ?? str(args.cmd) ?? "") };
  }
  if (n === "read" || n === "view") return { action: "read", summary: path ?? "", files: path ? [path] : undefined };
  if (n === "edit" || n === "multiedit" || n === "notebookedit" || n === "apply_patch") {
    return { action: "edit", summary: path ?? "", files: path ? [path] : undefined };
  }
  if (n === "write") return { action: "write", summary: path ?? "", files: path ? [path] : undefined };
  if (n === "grep" || n === "glob" || n === "find" || n === "ls" || n === "toolsearch") {
    const what = str(args.pattern) ?? str(args.query) ?? "";
    const where = path ?? "";
    return { action: "search", summary: firstLine([what, where].filter(Boolean).join(" in ")) };
  }
  if (n === "webfetch" || n === "websearch" || /web_(search|fetch)/.test(n)) {
    const target = str(args.url) ?? str(args.query) ?? (Array.isArray(args.urls) ? String(args.urls[0] ?? "") : "");
    return { action: "web", summary: firstLine(target) };
  }
  if (n === "skill") return { action: "other", summary: str(args.skill) ?? str(args.name) ?? "" };
  if (n === "todowrite") return { action: "other", summary: "update todo list" };
  return { action: "other", summary: firstLine(compactJson(args)) };
}

function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * Subagent detection. Only calls that actually launch work count; management calls
 * (e.g. pi `subagent` with `action: "list"`) stay ordinary tool calls.
 */
export function isSubagentCall(name: string, input: unknown): boolean {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name === "Agent" || name === "Task") return true;
  if (name === "subagent") {
    if (typeof args.action === "string") return false;
    return ["workflowScript", "agent", "agents", "task", "tasks", "chain", "mission"].some((k) => k in args);
  }
  return false;
}

export function describeSubagent(name: string, input: unknown): Omit<SubagentStep, "id" | "kind"> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const agents = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) agents.add(v.trim());
  };
  add(args.subagent_type);
  add(args.agent);
  if (Array.isArray(args.agents)) args.agents.forEach((a) => add(typeof a === "object" && a ? (a as Record<string, unknown>).agent ?? (a as Record<string, unknown>).name : a));
  if (Array.isArray(args.tasks)) args.tasks.forEach((t) => add(t && typeof t === "object" ? (t as Record<string, unknown>).agent : undefined));
  if (typeof args.workflowScript === "string") {
    for (const m of args.workflowScript.matchAll(/\bagent\s*:\s*['"`]([\w:.-]+)['"`]/g)) add(m[1]);
  }
  let description = str(args.description);
  if (!description && typeof args.mission === "string") {
    try {
      const mission = JSON.parse(args.mission) as Record<string, unknown>;
      description = str(mission.title);
    } catch {
      description = firstLine(args.mission);
    }
  } else if (!description && args.mission && typeof args.mission === "object") {
    description = str((args.mission as Record<string, unknown>).title);
  }
  if (!description) description = str(args.task) ? firstLine(String(args.task)) : undefined;
  if (!description && typeof args.prompt === "string") description = firstLine(args.prompt);
  return {
    tool: name,
    agents: [...agents],
    description,
    async: args.async === true || args.async === "true" || args.run_in_background === true ? true : undefined,
  };
}

/** Pull numeric usage stats out of a pi subagent tool result's structured details (`totalChildUsage`), if present. */
export function subagentUsageFrom(details: unknown): SubagentStep["usage"] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const child = d.totalChildUsage as Record<string, unknown> | undefined;
  const usage: NonNullable<SubagentStep["usage"]> = {};
  if (child && typeof child === "object") {
    usage.input = num(child.input);
    usage.output = num(child.output);
    usage.cacheRead = num(child.cacheRead);
    usage.cacheWrite = num(child.cacheWrite);
    usage.cost = num(child.cost);
    usage.turns = num(child.turns);
  }
  usage.totalTokens = num(d.totalTokens);
  usage.toolUses = num(d.totalToolUseCount);
  usage.durationMs = num(d.totalDurationMs);
  const cleaned = Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined));
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Accumulates turns/steps/responses while an adapter walks native entries in order.
 * Steps before the first user prompt land in a prompt-less turn 0.
 */
export class TurnBuilder {
  readonly turns: Turn[] = [];
  readonly responses: ResponseUsage[] = [];
  private readonly responseIndex = new Map<string, ResponseUsage>();
  private readonly pendingTools = new Map<string, ToolStep | SubagentStep>();
  private readonly subagentSteps = new Map<string, SubagentStep>();
  private readonly subagentsByAgentId = new Map<string, SubagentStep>();
  /** Steps whose answer came from a task-notification, which is the subagent's real final message. */
  private readonly answered = new Set<SubagentStep>();
  private stepSeq = 0;

  constructor(private readonly opts: { subagentUsage?: (details: unknown) => SubagentStep["usage"] | undefined } = {}) {}

  startTurn(user: UserPrompt, timestamp?: string): Turn {
    const turn: Turn = { index: this.turns.length, timestamp, user, steps: [] };
    this.turns.push(turn);
    return turn;
  }

  get current(): Turn {
    const last = this.turns.at(-1);
    if (last) return last;
    const turn: Turn = { index: 0, steps: [] };
    this.turns.push(turn);
    return turn;
  }

  get hasPrompt(): boolean {
    return this.turns.some((t) => t.user);
  }

  nextId(prefix: string): string {
    this.stepSeq += 1;
    return `${prefix}${this.stepSeq}`;
  }

  addStep<S extends Step>(step: S): S {
    this.current.steps.push(step);
    return step;
  }

  addEvent(event: EventKind, text: string, timestamp?: string, detail?: string): void {
    this.addStep({ kind: "event", id: this.nextId("e"), event, text, timestamp, ...(detail ? { detail } : {}) });
  }

  /** Register a tool call (or subagent launch) so its result can be attached later. */
  addToolCall(callId: string, rawName: unknown, input: unknown, meta: { timestamp?: string; responseId?: string }): void {
    // A transcript can carry any JSON here; a name that is not a string is a malformed call, kept under a generic name (ass-3llz).
    const name = typeof rawName === "string" ? rawName : "unknown";
    if (isSubagentCall(name, input)) {
      const step: SubagentStep = { kind: "subagent", id: callId, ...meta, ...describeSubagent(name, input) };
      this.addStep(step);
      this.pendingTools.set(callId, step);
      this.subagentSteps.set(callId, step);
      return;
    }
    const info = describeTool(name, input);
    const step: ToolStep = { kind: "tool", id: callId, ...meta, name, ...info, input };
    this.addStep(step);
    this.pendingTools.set(callId, step);
  }

  attachToolResult(callId: string, result: ToolResult, details?: unknown): void {
    const step = this.pendingTools.get(callId);
    if (!step) return;
    this.pendingTools.delete(callId);
    step.result = result;
    if (result.isError) step.isError = true;
    if (step.kind === "subagent") {
      const usage = (this.opts.subagentUsage ?? subagentUsageFrom)(details);
      if (usage) step.usage = usage;
      if (details && typeof details === "object") {
        const d = details as Record<string, unknown>;
        if (typeof d.mode === "string") step.mode = d.mode;
        // Claude Code's background launch: the result is only an acknowledgement, the answer comes later.
        if (d.status === "async_launched") step.async = true;
        if (typeof d.agentId === "string" && d.agentId) this.subagentsByAgentId.set(d.agentId, step);
      }
    }
  }

  /** The subagent step a transcript file belongs to: by the launching tool call's id, else by the agent's id. */
  findSubagent(toolUseId: string | undefined, agentId: string | undefined): SubagentStep | undefined {
    return (toolUseId ? this.subagentSteps.get(toolUseId) : undefined) ?? (agentId ? this.subagentsByAgentId.get(agentId) : undefined);
  }

  /**
   * Give a subagent's step the final message from its own transcript when nothing better is known:
   * a background launch whose notification never came (the result is only "launched"), or a step whose
   * result is missing. Never replaces a real answer (a foreground result, a task-notification).
   */
  setSubagentSummary(step: SubagentStep, text: string): void {
    if (this.answered.has(step) || (step.result && !step.async)) return;
    const body = text.trim();
    if (body) step.result = { text: body };
  }

  /**
   * A background subagent finished: attach its final answer, whole (the share pipeline bounds it after redaction) to the step that launched
   * it, replacing the "launched" acknowledgement. The launch is found by tool call id, else by agent
   * id; the notification names both, so the agent id is also remembered for linking its transcript
   * file when the launch's own tool result is not on the branch. Returns false when no launch is known.
   */
  completeSubagent(ids: { toolUseId?: string; agentId?: string }, text: string): boolean {
    const step = this.findSubagent(ids.toolUseId, ids.agentId);
    if (!step) return false;
    if (ids.agentId && !this.subagentsByAgentId.has(ids.agentId)) this.subagentsByAgentId.set(ids.agentId, step);
    step.async = true;
    const body = text.trim();
    if (body) {
      step.result = { text: body };
      this.answered.add(step);
    }
    return true;
  }

  /**
   * Record (or update) usage for a response. A message streamed across several lines repeats
   * its usage, and older Claude Code versions wrote growing snapshots (`output_tokens: 1`
   * first), so the repeat with the most tokens wins.
   */
  setResponseUsage(id: string, usage: Usage, meta: { model?: string; timestamp?: string; purpose?: ResponsePurpose; inherited?: boolean }): void {
    const existing = this.responseIndex.get(id);
    if (existing) {
      if (usageTokens(usage) >= usageTokens(existing.usage)) existing.usage = usage;
      return;
    }
    const entry: ResponseUsage = {
      id,
      turn: this.current.index,
      model: meta.model,
      timestamp: meta.timestamp,
      usage,
      ...(meta.purpose ? { purpose: meta.purpose } : {}),
      ...(meta.inherited ? { inherited: true as const } : {}),
    };
    this.responseIndex.set(id, entry);
    this.responses.push(entry);
  }

  /** Assign each thinking step the reasoning tokens reported for its response. */
  finalizeThinking(): void {
    const seen = new Set<string>();
    for (const turn of this.turns) {
      for (const step of turn.steps) {
        if (step.kind !== "thinking" || !step.responseId || seen.has(step.responseId)) continue;
        const r = this.responseIndex.get(step.responseId);
        if (r && r.usage.reasoning > 0) {
          step.tokens = r.usage.reasoning;
          seen.add(step.responseId);
        }
      }
    }
  }
}

export const usageTokens = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheWrite;

/**
 * Fill in a list-price cost for each call from its tokens and model. Calls whose model has
 * no price are left without a cost (never 0), which `computeStats` reports as partial.
 */
export function estimateCosts(list: ResponseUsage[]): void {
  for (const r of list) {
    const cost = estimateCost(r.model, r.usage);
    if (cost !== undefined) r.usage.cost = cost;
  }
}

export function baseSession(harness: HarnessName, sessionId: string): NormalizedSession {
  return {
    schema: SCHEMA_VERSION,
    mode: "full",
    harness: { name: harness },
    source: { sessionId },
    models: [],
    stats: {
      turns: 0,
      userPrompts: 0,
      responses: 0,
      toolCalls: 0,
      tools: {},
      toolErrors: 0,
      thinking: { blocks: 0, chars: 0, tokens: 0 },
      subagents: 0,
      compactions: 0,
      files: { read: 0, edited: 0, written: 0 },
      tokens: emptyUsage(),
      peakContext: 0,
    },
    responses: [],
    turns: [],
  };
}

export function bump(counts: DropCounts, key: string, n = 1): void {
  counts[key] = (counts[key] ?? 0) + n;
}

export function projectNameFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1);
}
