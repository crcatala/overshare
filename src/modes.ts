/**
 * Share modes. Projection happens *before* upload so that data a mode omits is never
 * published (hiding it in the viewer alone would still leak it). The viewer reuses
 * these functions to step down from a richer shared mode (full → brief → minimal).
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
} from "./schema.js";

export interface ProjectOptions {
  /** Max characters kept per tool result / large tool input string in full mode. */
  maxToolChars?: number;
}

const RANK: Record<ShareMode, number> = { full: 2, brief: 1, minimal: 0 };

/** Modes that can be derived from a session shared in `mode`. */
export function availableModes(mode: ShareMode): ShareMode[] {
  return (["full", "brief", "minimal"] as ShareMode[]).filter((m) => RANK[m] <= RANK[mode]);
}

/** The result's `mode` is `mode`, not the mode `session` was published in; keep that if you need it. */
export function projectSession(session: NormalizedSession, mode: ShareMode, opts: ProjectOptions = {}): NormalizedSession {
  if (RANK[mode] > RANK[session.mode]) throw new Error(`Cannot project a ${session.mode} session up to ${mode}`);
  const project = mode === "full" ? (t: Turn) => fullTurn(t, opts.maxToolChars ?? 20_000) : mode === "brief" ? briefTurn : minimalTurn;
  return { ...session, mode, turns: session.turns.map(project) };
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
