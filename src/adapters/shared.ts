import {
  SCHEMA_VERSION,
  emptyUsage,
  type EventKind,
  type HarnessName,
  type NormalizedSession,
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

export interface AdapterOptions {
  /** Export the branch ending at this entry id instead of the last entry (tree-shaped sessions). */
  leafId?: string;
}

/** Counts of native entries dropped on purpose (never shared). */
export type DropCounts = Record<string, number>;

export interface AdapterResult {
  session: NormalizedSession;
  dropped: DropCounts;
}

const firstLine = (s: string, max = 160): string => {
  const line = s.trim().split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

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
  return { action: "other", summary: firstLine(compactJson(args), 120) };
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
      description = firstLine(args.mission, 120);
    }
  } else if (!description && args.mission && typeof args.mission === "object") {
    description = str((args.mission as Record<string, unknown>).title);
  }
  if (!description) description = str(args.task) ? firstLine(String(args.task), 160) : undefined;
  if (!description && typeof args.prompt === "string") description = firstLine(args.prompt, 160);
  return {
    tool: name,
    agents: [...agents],
    description,
    async: args.async === true || args.async === "true" || args.run_in_background === true ? true : undefined,
  };
}

/** Pull numeric usage stats out of a subagent tool result's structured details, if present. */
export function subagentUsageFrom(details: unknown): SubagentStep["usage"] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const child = (d.totalChildUsage ?? d.usage) as Record<string, unknown> | undefined;
  const usage: NonNullable<SubagentStep["usage"]> = {};
  if (child && typeof child === "object") {
    usage.input = num(child.input) ?? num(child.input_tokens);
    usage.output = num(child.output) ?? num(child.output_tokens);
    usage.cacheRead = num(child.cacheRead) ?? num(child.cache_read_input_tokens);
    usage.cacheWrite = num(child.cacheWrite) ?? num(child.cache_creation_input_tokens);
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
  private stepSeq = 0;

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
  addToolCall(callId: string, name: string, input: unknown, meta: { timestamp?: string; responseId?: string }): void {
    if (isSubagentCall(name, input)) {
      const step: SubagentStep = { kind: "subagent", id: callId, ...meta, ...describeSubagent(name, input) };
      this.addStep(step);
      this.pendingTools.set(callId, step);
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
      const usage = subagentUsageFrom(details);
      if (usage) step.usage = usage;
      if (details && typeof details === "object" && typeof (details as Record<string, unknown>).mode === "string") {
        step.mode = (details as Record<string, unknown>).mode as string;
      }
    }
  }

  /** Record (or update) usage for a response; later calls for the same id replace earlier ones. */
  setResponseUsage(id: string, usage: Usage, meta: { model?: string; timestamp?: string }): void {
    const existing = this.responseIndex.get(id);
    if (existing) {
      existing.usage = usage;
      return;
    }
    const entry: ResponseUsage = { id, turn: this.current.index, model: meta.model, timestamp: meta.timestamp, usage };
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
