/**
 * Share modes. Projection happens *before* upload so that data a mode omits is never
 * published (hiding it in the viewer alone would still leak it). The viewer reuses
 * these functions to step down from a richer shared mode (full → brief → minimal → prompts).
 * Browser-safe: no Node imports.
 */
import type {
  NormalizedSession,
  ShareMode,
  Step,
  ThinkingStep,
  ToolGroupStep,
  ToolResult,
  Turn,
  TurnActivity,
} from "./schema.js";
import { SHARE_MODES } from "./schema.js";

export interface ProjectOptions {
  /** Max characters kept per tool result / large tool input string in full mode. */
  maxToolChars?: number;
}

const RANK: Record<ShareMode, number> = { full: 3, brief: 2, minimal: 1, prompts: 0 };

export class PromptsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptsUnavailableError";
  }
}

/** Legacy pi user messages may be template expansions with no recoverable authored input. */
export function promptsUnavailableReason(session: NormalizedSession): string | undefined {
  if (session.harness.name !== "pi") return;
  const unknown = session.turns.filter((t) => t.user && t.user.authored !== true).length;
  if (!unknown) return;
  return `Cannot use prompts mode: ${unknown} pi user prompt(s) have no verified pre-expansion input. ` +
    "Private template/skill instructions may be stored as user text. Install or reload the updated pi share extension before submitting new idle prompts; existing inputs or queued expansions cannot be recovered reliably. Other modes require reviewing the stored prompt text.";
}

/** Modes that can be derived from a session shared in `mode`. */
export function availableModes(mode: ShareMode, promptsAllowed = true): ShareMode[] {
  return SHARE_MODES.filter((m) => RANK[m] <= RANK[mode] && (m !== "prompts" || promptsAllowed));
}

/** The result's `mode` is `mode`, not the mode `session` was published in; keep that if you need it. */
export function projectSession(session: NormalizedSession, mode: ShareMode, opts: ProjectOptions = {}): NormalizedSession {
  if (RANK[mode] > RANK[session.mode]) throw new Error(`Cannot project a ${session.mode} session up to ${mode}`);
  const reason = mode === "prompts" ? promptsUnavailableReason(session) : undefined;
  if (reason) throw new PromptsUnavailableError(reason);
  const project = mode === "full" ? (t: Turn) => fullTurn(t, opts.maxToolChars ?? 20_000) : mode === "brief" ? briefTurn : mode === "minimal" ? minimalTurn : promptsTurn;
  return { ...session, mode, turns: session.turns.map((turn) => project({ ...turn, activity: turn.activity ?? turnActivity(turn) })) };
}

/** Counts from the full session's steps; every projection carries the result, so it is computed once, before any steps are collapsed. */
function turnActivity(turn: Turn): TurnActivity {
  let toolCalls = 0;
  let toolErrors = 0;
  const files = { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() };
  for (const s of turn.steps) {
    if (s.kind === "tool") {
      toolCalls++;
      if (s.isError || s.result?.isError) toolErrors++;
      const action = s.action === "edit" ? "edited" : s.action === "write" ? "written" : s.action === "read" ? "read" : undefined;
      if (action) for (const file of s.files ?? []) files[action].add(file);
    } else if (s.kind === "subagent") {
      toolCalls++;
      if (s.isError || s.result?.isError) toolErrors++;
    }
  }
  return { toolCalls, toolErrors, files: { read: files.read.size, edited: files.edited.size, written: files.written.size } };
}

/** Only authored user prompts and numeric counts survive; no work or expanded skill text. */
function promptsTurn(turn: Turn): Turn {
  const u = turn.user;
  return {
    index: turn.index,
    timestamp: turn.timestamp,
    user: u ? { text: u.text, authored: u.authored, command: u.command, images: u.images } : undefined,
    activity: turn.activity,
    steps: [],
  };
}

function truncate(text: string, max: number): { text: string; truncatedFrom?: number } {
  if (text.length <= max) return { text };
  return { text: `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`, truncatedFrom: text.length };
}

function truncateDeep(value: unknown, max: number): unknown {
  if (typeof value === "string") return truncate(value, max).text;
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateDeep(v, max)]));
  return value;
}

function truncateResult(result: ToolResult | undefined, max: number): ToolResult | undefined {
  if (!result) return result;
  const t = truncate(result.text, max);
  return { ...result, text: t.text, ...(t.truncatedFrom ? { truncatedFrom: t.truncatedFrom } : {}) };
}

function fullTurn(turn: Turn, max: number): Turn {
  return {
    ...turn,
    steps: turn.steps.map((s): Step => {
      if (s.kind === "tool") return { ...s, input: truncateDeep(s.input, max), result: truncateResult(s.result, max) };
      if (s.kind === "subagent") return { ...s, result: truncateResult(s.result, max) };
      return s;
    }),
  };
}

function emptyGroup(id: string): ToolGroupStep {
  return { kind: "toolGroup", id, calls: [], total: 0, files: { read: [], edited: [], written: [] }, commands: [], responseIds: [] };
}

function addToGroup(g: ToolGroupStep, name: string, count: number, errors: number): void {
  const existing = g.calls.find((c) => c.name === name);
  if (existing) {
    existing.count += count;
    existing.errors += errors;
  } else {
    g.calls.push({ name, count, errors });
  }
  g.total += count;
}

const pushUnique = (list: string[], items: string[]) => {
  for (const i of items) if (i && !list.includes(i)) list.push(i);
};

/** Merge a run of work steps (thinking + tool calls) into at most one thinking summary and one tool group. */
function collapseWork(steps: Step[], keepCommands: boolean): Step[] {
  if (steps.length === 0) return [];
  const group = emptyGroup(`g-${steps[0]!.id}`);
  const thinking = { blocks: 0, chars: 0, tokens: 0 };
  let thinkingFirst: ThinkingStep | undefined;
  for (const s of steps) {
    if (s.responseId && !group.responseIds.includes(s.responseId)) group.responseIds.push(s.responseId);
    if (s.kind === "thinking") {
      thinkingFirst ??= s;
      thinking.blocks += s.blocks;
      thinking.chars += s.chars;
      thinking.tokens += s.tokens ?? 0;
    } else if (s.kind === "tool") {
      addToGroup(group, s.name, 1, s.isError ? 1 : 0);
      const files = s.files ?? [];
      if (s.action === "read") pushUnique(group.files.read, files);
      if (s.action === "edit") pushUnique(group.files.edited, files);
      if (s.action === "write") pushUnique(group.files.written, files);
      if (keepCommands && s.action === "exec" && s.summary) group.commands.push(s.summary);
    } else if (s.kind === "toolGroup") {
      for (const c of s.calls) addToGroup(group, c.name, c.count, c.errors);
      pushUnique(group.files.read, s.files.read);
      pushUnique(group.files.edited, s.files.edited);
      pushUnique(group.files.written, s.files.written);
      if (keepCommands) group.commands.push(...s.commands);
      pushUnique(group.responseIds, s.responseIds);
      if (s.thinking) {
        thinking.blocks += s.thinking.blocks;
        thinking.chars += s.thinking.chars;
        thinking.tokens += s.thinking.tokens;
      }
    }
  }
  const out: Step[] = [];
  if (thinking.blocks > 0 && group.total === 0) {
    out.push({
      kind: "thinking",
      id: thinkingFirst?.id ?? `${group.id}-k`,
      timestamp: thinkingFirst?.timestamp,
      responseId: thinkingFirst?.responseId,
      blocks: thinking.blocks,
      chars: thinking.chars,
      ...(thinking.tokens ? { tokens: thinking.tokens } : {}),
    });
  }
  if (group.total > 0) {
    if (thinking.blocks > 0) group.thinking = thinking;
    group.timestamp = steps[0]!.timestamp;
    out.push(group);
  }
  return out;
}

const isWork = (s: Step) => s.kind === "thinking" || s.kind === "tool" || s.kind === "toolGroup";

function briefTurn(turn: Turn): Turn {
  const steps: Step[] = [];
  let run: Step[] = [];
  const flush = () => {
    steps.push(...collapseWork(run, true));
    run = [];
  };
  for (const s of turn.steps) {
    if (isWork(s)) {
      run.push(s);
      continue;
    }
    flush();
    if (s.kind === "subagent") {
      const { result: _result, ...meta } = s;
      steps.push(meta);
    } else if (s.kind === "event") {
      const { detail: _detail, ...rest } = s;
      steps.push(rest);
    } else {
      steps.push(s);
    }
  }
  flush();
  const user = turn.user ? { ...turn.user, expanded: undefined } : undefined;
  return { ...turn, user, steps };
}

function minimalTurn(turn: Turn): Turn {
  const lastText = [...turn.steps].reverse().find((s) => s.kind === "text");
  const work = collapseWork(
    turn.steps.filter((s) => isWork(s)),
    false,
  ).filter((s) => s.kind === "toolGroup");
  const subagents = turn.steps
    .filter((s) => s.kind === "subagent")
    .map((s) => {
      const { result: _result, ...meta } = s as Extract<Step, { kind: "subagent" }>;
      return meta;
    });
  const compactions = turn.steps.filter((s) => s.kind === "event" && s.event === "compaction").map((s) => {
    const { detail: _detail, ...rest } = s as Extract<Step, { kind: "event" }>;
    return rest;
  });
  const steps: Step[] = [...compactions, ...work, ...subagents];
  if (lastText) steps.push(lastText);
  const user = turn.user ? { ...turn.user, expanded: undefined } : undefined;
  return { ...turn, user, steps };
}
