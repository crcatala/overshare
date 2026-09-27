/**
 * The normalized, harness-agnostic session format ("agentshare/1").
 *
 * Adapters convert each harness's native transcript into this shape; redaction,
 * mode projection, publishing and the viewer only ever see this shape. This file
 * is shared with the browser viewer, so it must stay free of Node imports.
 */

export const SCHEMA_VERSION = "agentshare/1" as const;

export type ShareMode = "full" | "brief" | "minimal";
export const SHARE_MODES: readonly ShareMode[] = ["full", "brief", "minimal"];

export type HarnessName = "claude-code" | "pi";

export interface Usage {
  /** Uncached prompt tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning/thinking tokens; a subset of `output` for the harnesses we support. */
  reasoning: number;
  /** USD, when the harness records it per response. */
  cost?: number;
}

/** Token usage for one model API response (one assistant message). */
export interface ResponseUsage {
  id: string;
  turn: number;
  model?: string;
  timestamp?: string;
  usage: Usage;
}

export interface SessionStats {
  turns: number;
  userPrompts: number;
  responses: number;
  toolCalls: number;
  /** Tool call counts by tool name, including subagent tools. */
  tools: Record<string, number>;
  toolErrors: number;
  thinking: { blocks: number; chars: number; tokens: number };
  subagents: number;
  compactions: number;
  files: { read: number; edited: number; written: number };
  tokens: Usage;
  /** Largest single-response prompt (input + cacheRead + cacheWrite). */
  peakContext: number;
  cost?: number;
  costSource?: "per-response" | "session-total";
}

export interface RedactionSummary {
  total: number;
  byCategory: Record<string, number>;
  /** Entry kinds dropped wholesale before redaction (system prompts, attachments, ...). */
  dropped: Record<string, number>;
}

export interface NormalizedSession {
  schema: typeof SCHEMA_VERSION;
  mode: ShareMode;
  title?: string;
  harness: { name: HarnessName; version?: string; formatVersion?: number };
  source: { sessionId: string; leafId?: string };
  project?: { cwd?: string; name?: string; branch?: string };
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  models: string[];
  stats: SessionStats;
  responses: ResponseUsage[];
  turns: Turn[];
  redaction?: RedactionSummary;
  generator?: { name: string; version: string; sharedAt: string };
}

export interface UserPrompt {
  text: string;
  /** Present when the prompt was a slash command / skill invocation. */
  command?: { name: string; args?: string };
  /** Prompt text a command expanded into (full mode only). */
  expanded?: string;
  images?: number;
}

export interface Turn {
  index: number;
  timestamp?: string;
  user?: UserPrompt;
  steps: Step[];
}

interface StepBase {
  id: string;
  timestamp?: string;
  /** The API response this step belongs to (links to `responses`). */
  responseId?: string;
}

export interface TextStep extends StepBase {
  kind: "text";
  text: string;
  model?: string;
}

export interface ThinkingStep extends StepBase {
  kind: "thinking";
  /** Thinking text, when the harness stored it and the mode keeps it. */
  text?: string;
  chars: number;
  blocks: number;
  /** Reasoning tokens reported for the response(s) this thinking came from. */
  tokens?: number;
}

export type ToolAction = "read" | "edit" | "write" | "search" | "exec" | "web" | "other";

export interface ToolResult {
  text: string;
  isError?: boolean;
  images?: number;
  truncatedFrom?: number;
}

export interface ToolStep extends StepBase {
  kind: "tool";
  name: string;
  action: ToolAction;
  /** One-line human summary, e.g. the first line of a bash command or a file path. */
  summary: string;
  files?: string[];
  input?: unknown;
  result?: ToolResult;
  isError?: boolean;
}

export interface ToolGroupStep extends StepBase {
  kind: "toolGroup";
  calls: { name: string; count: number; errors: number }[];
  total: number;
  files: { read: string[]; edited: string[]; written: string[] };
  /** One-line summaries of exec-style calls (commands). */
  commands: string[];
  responseIds: string[];
  thinking?: { blocks: number; chars: number; tokens: number };
}

export interface SubagentStep extends StepBase {
  kind: "subagent";
  tool: string;
  agents: string[];
  description?: string;
  mode?: string;
  async?: boolean;
  isError?: boolean;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number; toolUses?: number; durationMs?: number; totalTokens?: number };
  result?: ToolResult;
}

export type EventKind =
  | "model_change"
  | "thinking_level"
  | "compaction"
  | "command"
  | "skill"
  | "subagent_notice"
  | "interrupted"
  | "error";

export interface EventStep extends StepBase {
  kind: "event";
  event: EventKind;
  text: string;
  detail?: string;
}

export type Step = TextStep | ThinkingStep | ToolStep | ToolGroupStep | SubagentStep | EventStep;

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
  if (a.cost !== undefined || b.cost !== undefined) out.cost = (a.cost ?? 0) + (b.cost ?? 0);
  return out;
}

/** Tokens in the prompt for a response: what the context window held. */
export function contextTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

export function totalTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}
